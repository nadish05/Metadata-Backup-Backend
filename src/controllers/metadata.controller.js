const axios = require('axios');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

const {
    setStatus
} = require('../status.store');

const {
    cleanupRetrievalResources
} = require('../services/retrievalCleanup.service');
const {
    persistRetrievalSnapshotMetadata
} = require('../services/retrievalSnapshotMetadata.service');
const {
    getLatestApiVersion
} = require('../services/destinationInventory/destinationInventoryBuilder.service');

const RETRIEVAL_CLI_ALIAS = 'temporg';

/**
 * Metadata types requested by retrieveMetadataInternal via `-m <Type>`.
 * Keep in sync with the migrate backup retrieve path only.
 */
const RETRIEVAL_METADATA_TYPES = [
    'ApexClass',
    'ApexTrigger',
    'LightningComponentBundle',
    'AuraDefinitionBundle',
    'FlexiPage',
    'ApexPage',
    'ApexComponent',
    'CustomObject',
    'CustomField',
    'CustomTab',
    'ValidationRule',
    'RecordType',
    'Flow',
    'Workflow',
    'AssignmentRules',
    'EscalationRules',
    'PermissionSet',
    'CustomPermission',
    'Profile',
    'NamedCredential',
    'ExternalCredential',
    'CustomLabel',
    'CustomMetadata'
];

/**
 * Standard-object members required so Profile RecordTypes on Account /
 * Opportunity are retrieved. Bare `-m CustomObject` does not return these.
 * Do NOT add Equipment__c (Equipment label maps to Product2).
 */
const RETRIEVAL_STANDARD_OBJECT_MEMBERS = [
    'CustomObject:Account',
    'CustomObject:Opportunity'
];

const RETRIEVE_RESULT_PROBES = [
    'Equipment_Maintenance_Item__c',
    'Maintenance_Request__c'
];

function buildRetrieveMetadataMembers() {
    return [
        ...RETRIEVAL_METADATA_TYPES,
        ...RETRIEVAL_STANDARD_OBJECT_MEMBERS
    ];
}

function buildRetrieveMetadataArgs(members = buildRetrieveMetadataMembers()) {
    return members.map((member) => `-m ${member}`).join(' ');
}

function normalizeDiscoveredCustomObjectName(entry) {
    if (typeof entry === 'string') {
        return entry.trim();
    }

    if (!entry || typeof entry !== 'object') {
        return '';
    }

    const raw = entry.fullName
        || entry.full_name
        || entry.member
        || entry.fileName
        || '';

    return String(raw).trim();
}

/**
 * Convert Metadata API / CLI list-metadata entries into bare CustomObject
 * API names (e.g. Equipment_Maintenance_Item__c). Does not invent members.
 */
function parseDiscoveredListMetadataNames(stdout, typePrefix = null) {
    const payload = extractJsonPayload(stdout);
    if (!payload) {
        return {
            names: [],
            status: null,
            parsed: false,
            reason: 'invalid_json'
        };
    }

    const rows = Array.isArray(payload.result)
        ? payload.result
        : Array.isArray(payload.result?.metadata)
          ? payload.result.metadata
          : [];

    const names = [];
    const seen = new Set();
    const prefix = typePrefix ? `${typePrefix}:` : null;

    for (const entry of rows) {
        let name = normalizeDiscoveredCustomObjectName(entry);
        if (!name) {
            continue;
        }

        if (prefix && name.startsWith(prefix)) {
            name = name.slice(prefix.length).trim();
        }

        if (!name || seen.has(name)) {
            continue;
        }

        seen.add(name);
        names.push(name);
    }

    return {
        names,
        status: payload.status,
        parsed: true,
        reason: null
    };
}

function parseDiscoveredCustomObjectNames(stdout) {
    return parseDiscoveredListMetadataNames(stdout, 'CustomObject');
}

function parseDiscoveredStandardValueSetNames(stdout) {
    return parseDiscoveredListMetadataNames(stdout, 'StandardValueSet');
}

function toExplicitCustomObjectMembers(names = []) {
    return (Array.isArray(names) ? names : [])
        .map((name) => String(name || '').trim())
        .filter(Boolean)
        .map((name) => (
            name.startsWith('CustomObject:')
                ? name
                : `CustomObject:${name}`
        ));
}

function toExplicitStandardValueSetMembers(names = []) {
    return (Array.isArray(names) ? names : [])
        .map((name) => String(name || '').trim())
        .filter(Boolean)
        .map((name) => (
            name.startsWith('StandardValueSet:')
                ? name
                : `StandardValueSet:${name}`
        ));
}

/**
 * Merge base retrieve members with discovered CustomObject and
 * StandardValueSet members. Preserves order, removes duplicates, never
 * invents Maintenance_Request__c or StandardValueSet names unless discovery
 * returned them.
 */
function mergeRetrieveMetadataMembers({
    baseMembers = buildRetrieveMetadataMembers(),
    discoveredCustomObjectNames = [],
    discoveredStandardValueSetNames = []
} = {}) {
    const explicitDiscovered = [
        ...toExplicitCustomObjectMembers(discoveredCustomObjectNames),
        ...toExplicitStandardValueSetMembers(discoveredStandardValueSetNames)
    ];
    const merged = [];
    const seen = new Set();

    for (const member of [...baseMembers, ...explicitDiscovered]) {
        if (!member || seen.has(member)) {
            continue;
        }
        seen.add(member);
        merged.push(member);
    }

    return merged;
}

function buildRetrieveMetadataMembersWithDiscovery(
    discoveredCustomObjectNames = [],
    discoveredStandardValueSetNames = []
) {
    return mergeRetrieveMetadataMembers({
        baseMembers: buildRetrieveMetadataMembers(),
        discoveredCustomObjectNames,
        discoveredStandardValueSetNames
    });
}

function logCustomObjectDiscoveryDebug({
    strategy,
    discoveredCount = 0,
    explicitMembersAdded = 0,
    discoveredIncludesEmi = false,
    discoveredIncludesMaintenanceRequestObject = false,
    errorMessage = null
} = {}) {
    console.log('====================================================');
    console.log('CUSTOM OBJECT DISCOVERY DEBUG');
    console.log('====================================================');
    console.log(JSON.stringify({
        strategy,
        discoveredCount,
        explicitMembersAdded,
        discoveredIncludesEmi,
        discoveredIncludesMaintenanceRequestObject,
        errorMessage
    }, null, 2));
    console.log('====================================================');
}

/**
 * Discover CustomObject members from the already-authenticated temporg
 * session. On failure, returns empty names so callers can fall back to the
 * existing wildcard CustomObject retrieve behavior.
 */
async function discoverCustomObjectNames(alias = RETRIEVAL_CLI_ALIAS) {
    try {
        const listResult = await execAsync(
            `sf org list metadata -m CustomObject -o ${alias} --json`,
            {
                maxBuffer: 50 * 1024 * 1024
            }
        );

        const parsed = parseDiscoveredCustomObjectNames(listResult.stdout || '');
        if (!parsed.parsed) {
            return {
                names: [],
                strategy: 'discovery_failed_fallback',
                errorMessage: parsed.reason || 'invalid_json'
            };
        }

        if (
            typeof parsed.status === 'number'
            && parsed.status !== 0
        ) {
            return {
                names: [],
                strategy: 'discovery_failed_fallback',
                errorMessage: `list metadata status ${parsed.status}`
            };
        }

        if (parsed.names.length === 0) {
            return {
                names: [],
                strategy: 'discovery_empty_fallback',
                errorMessage: null
            };
        }

        return {
            names: parsed.names,
            strategy: 'explicit_discovered_custom_objects',
            errorMessage: null
        };
    } catch (error) {
        return {
            names: [],
            strategy: 'discovery_failed_fallback',
            errorMessage: error.message || String(error)
        };
    }
}

const STANDARD_VALUE_SET_STDOUT_PREVIEW_LIMIT = 5000;
const STANDARD_VALUE_SET_NAMES_PREVIEW_LIMIT = 20;

function describeJsType(value) {
    if (value === null) {
        return 'null';
    }

    if (Array.isArray(value)) {
        return 'array';
    }

    return typeof value;
}

function buildStandardValueSetRawResponseDebug({
    command,
    exitStatus = null,
    stdout = '',
    stderr = ''
} = {}) {
    const stdoutText = String(stdout || '');
    const stderrText = String(stderr || '');
    const truncated =
        stdoutText.length > STANDARD_VALUE_SET_STDOUT_PREVIEW_LIMIT;

    return {
        command,
        exitStatus,
        stdoutLength: stdoutText.length,
        stderrLength: stderrText.length,
        rawStdoutTruncated: truncated,
        rawStdoutPreview: truncated
            ? stdoutText.slice(0, STANDARD_VALUE_SET_STDOUT_PREVIEW_LIMIT)
            : stdoutText
    };
}

function summarizeListMetadataPayloadShape(stdout) {
    const payload = extractJsonPayload(stdout);

    if (!payload) {
        return {
            parsed: false
        };
    }

    const summary = {
        parsed: true,
        topLevelType: describeJsType(payload)
    };

    if (!Object.prototype.hasOwnProperty.call(payload, 'result')) {
        return summary;
    }

    const result = payload.result;
    summary.resultType = describeJsType(result);
    summary.resultIsArray = Array.isArray(result);

    if (Array.isArray(result)) {
        summary.resultLength = result.length;

        if (result.length > 0) {
            const firstItem = result[0];

            if (firstItem && typeof firstItem === 'object') {
                summary.firstItemKeys = Object.keys(firstItem);
                summary.firstItem = firstItem;
            } else {
                summary.firstItem = firstItem;
            }
        }

        return summary;
    }

    if (result && typeof result === 'object') {
        summary.resultKeys = Object.keys(result);

        if (Object.prototype.hasOwnProperty.call(result, 'metadata')) {
            summary.metadataIsArray = Array.isArray(result.metadata);

            if (Array.isArray(result.metadata)) {
                summary.metadataLength = result.metadata.length;
            }
        }
    }

    return summary;
}

function buildStandardValueSetParserDebug({
    names = [],
    strategy = null,
    errorMessage = null
} = {}) {
    const parsedNames = Array.isArray(names) ? names : [];

    return {
        strategy,
        errorMessage,
        parsedNameCount: parsedNames.length,
        parsedNamesPreview: parsedNames.slice(
            0,
            STANDARD_VALUE_SET_NAMES_PREVIEW_LIMIT
        )
    };
}

function logStandardValueSetDiscoveryDebug({
    strategy,
    discoveredCount = 0,
    explicitMembersAdded = 0,
    errorMessage = null
} = {}) {
    console.log('====================================================');
    console.log('STANDARD VALUE SET DISCOVERY DEBUG');
    console.log('====================================================');
    console.log(JSON.stringify({
        strategy,
        discoveredCount,
        explicitMembersAdded,
        errorMessage
    }, null, 2));
    console.log('====================================================');
}

function logStandardValueSetRawResponseDebug(debugPayload) {
    console.log('====================================================');
    console.log('STANDARD VALUE SET RAW RESPONSE DEBUG');
    console.log('====================================================');
    console.log(JSON.stringify(debugPayload, null, 2));
    console.log('====================================================');
}

function logStandardValueSetParsedShapeDebug(shapePayload) {
    console.log('====================================================');
    console.log('STANDARD VALUE SET PARSED SHAPE DEBUG');
    console.log('====================================================');
    console.log(JSON.stringify(shapePayload, null, 2));
    console.log('====================================================');
}

function logStandardValueSetParserDebug(debugPayload) {
    console.log('====================================================');
    console.log('STANDARD VALUE SET PARSER DEBUG');
    console.log('====================================================');
    console.log(JSON.stringify(debugPayload, null, 2));
    console.log('====================================================');
}

/**
 * Discover StandardValueSet members from the already-authenticated temporg
 * session. Wildcard StandardValueSet retrieve is not supported; explicit
 * members are required. On failure, returns empty names so callers preserve
 * existing retrieve behavior for all other metadata types.
 */
async function discoverStandardValueSetNames(alias = RETRIEVAL_CLI_ALIAS) {
    const command =
        `sf org list metadata -m StandardValueSet -o ${alias} --json`;

    try {
        const listResult = await execAsync(
            command,
            {
                maxBuffer: 50 * 1024 * 1024
            }
        );
        const stdout = listResult.stdout || '';
        const stderr = listResult.stderr || '';

        logStandardValueSetRawResponseDebug(
            buildStandardValueSetRawResponseDebug({
                command,
                exitStatus: 0,
                stdout,
                stderr
            })
        );
        logStandardValueSetParsedShapeDebug(
            summarizeListMetadataPayloadShape(stdout)
        );

        const parsed = parseDiscoveredStandardValueSetNames(stdout);
        if (!parsed.parsed) {
            const outcome = {
                names: [],
                strategy: 'discovery_failed_fallback',
                errorMessage: parsed.reason || 'invalid_json'
            };
            logStandardValueSetParserDebug(
                buildStandardValueSetParserDebug(outcome)
            );
            return outcome;
        }

        if (
            typeof parsed.status === 'number'
            && parsed.status !== 0
        ) {
            const outcome = {
                names: [],
                strategy: 'discovery_failed_fallback',
                errorMessage: `list metadata status ${parsed.status}`
            };
            logStandardValueSetParserDebug(
                buildStandardValueSetParserDebug(outcome)
            );
            return outcome;
        }

        if (parsed.names.length === 0) {
            const outcome = {
                names: [],
                strategy: 'discovery_empty_fallback',
                errorMessage: null
            };
            logStandardValueSetParserDebug(
                buildStandardValueSetParserDebug(outcome)
            );
            return outcome;
        }

        const outcome = {
            names: parsed.names,
            strategy: 'explicit_discovered_standard_value_sets',
            errorMessage: null
        };
        logStandardValueSetParserDebug(
            buildStandardValueSetParserDebug(outcome)
        );
        return outcome;
    } catch (error) {
        const outcome = {
            names: [],
            strategy: 'discovery_failed_fallback',
            errorMessage: error.message || String(error)
        };
        logStandardValueSetParserDebug(
            buildStandardValueSetParserDebug(outcome)
        );
        return outcome;
    }
}

function extractJsonPayload(stdout) {
    const text = String(stdout || '').trim();
    if (!text) {
        return null;
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) {
        return null;
    }

    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch (error) {
        return null;
    }
}

function collectRetrieveFileStrings(files) {
    if (!Array.isArray(files)) {
        return [];
    }

    return files.map((file) => {
        if (typeof file === 'string') {
            return file;
        }
        if (!file || typeof file !== 'object') {
            return String(file);
        }

        return [
            file.filePath,
            file.path,
            file.fullName,
            file.type,
            file.state
        ]
            .filter(Boolean)
            .join(' ');
    });
}

function summarizeRetrieveResultJson(stdout) {
    const text = String(stdout || '').trim();
    if (!text) {
        return {
            parsed: false,
            reason: 'empty_stdout'
        };
    }

    const payload = extractJsonPayload(text);
    if (!payload) {
        return {
            parsed: false,
            reason: 'invalid_json',
            stdoutLength: text.length
        };
    }

    const result = payload.result && typeof payload.result === 'object'
        ? payload.result
        : payload;
    const files = result.files || result.fileProperties || [];
    const failures = result.failures
        || (Array.isArray(result.messages) ? result.messages : null)
        || payload.warnings
        || [];
    const fileStrings = collectRetrieveFileStrings(files);
    const searchText = `${fileStrings.join('\n')}\n${JSON.stringify(failures)}`;

    const probes = {};
    for (const name of RETRIEVE_RESULT_PROBES) {
        probes[name] = searchText.includes(name);
    }

    return {
        parsed: true,
        status: payload.status,
        fileCount: fileStrings.length,
        failureCount: Array.isArray(failures) ? failures.length : 0,
        failures: Array.isArray(failures) ? failures.slice(0, 25) : failures,
        sampleFiles: fileStrings.slice(0, 40),
        probes
    };
}

function logRetrieveResultDebug(stdout) {
    const summary = summarizeRetrieveResultJson(stdout);

    console.log('========================================');
    console.log('METADATA RETRIEVE RESULT DEBUG');
    console.log('========================================');

    if (!summary.parsed) {
        console.log('parsed: false');
        console.log('reason:', summary.reason);
        if (summary.stdoutLength != null) {
            console.log('stdoutLength:', summary.stdoutLength);
        }
        console.log('========================================');
        return summary;
    }

    console.log('status:', summary.status);
    console.log('fileCount:', summary.fileCount);
    console.log('failureCount:', summary.failureCount);
    console.log('probes:', JSON.stringify(summary.probes, null, 2));

    if (summary.failureCount > 0) {
        console.log('failures (truncated):');
        console.log(JSON.stringify(summary.failures, null, 2));
    }

    if (summary.sampleFiles.length > 0) {
        console.log('sampleFiles (truncated):');
        for (const file of summary.sampleFiles) {
            console.log(' -', file);
        }
        if (summary.fileCount > summary.sampleFiles.length) {
            console.log(
                ` - ... ${summary.fileCount - summary.sampleFiles.length} more file(s)`
            );
        }
    } else {
        console.log('sampleFiles: (none)');
    }

    console.log('========================================');
    return summary;
}

function toPosixRelative(projectPath, absolutePath) {
    return path
        .relative(projectPath, absolutePath)
        .split(path.sep)
        .join('/');
}

function collectFilesUnderDirectory(rootDir, projectPath) {
    const files = [];

    function walk(currentDir) {
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (error) {
            return;
        }

        for (const entry of entries) {
            const absolutePath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(absolutePath);
            } else if (entry.isFile()) {
                files.push(toPosixRelative(projectPath, absolutePath));
            }
        }
    }

    walk(rootDir);
    return files;
}

function collectPathMatches(rootDir, projectPath, needle) {
    const matches = [];

    function walk(currentDir) {
        let entries;
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch (error) {
            return;
        }

        for (const entry of entries) {
            const absolutePath = path.join(currentDir, entry.name);
            if (entry.isDirectory()) {
                walk(absolutePath);
                continue;
            }
            if (!entry.isFile()) {
                continue;
            }

            const relativePath = toPosixRelative(projectPath, absolutePath);
            if (relativePath.includes(needle) || entry.name.includes(needle)) {
                matches.push(relativePath);
            }
        }
    }

    walk(rootDir);
    return matches;
}

/**
 * TEMP DIAGNOSTIC — filesystem probe only. Does not retrieve, copy, delete,
 * or filter metadata. Must run after CLI retrieve and before Git.
 */
function collectEmiPostRetrieveDebug(projectPath) {
    const resolvedProjectPath = path.resolve(projectPath);
    const emiObjectDirectory = path.join(
        resolvedProjectPath,
        'force-app',
        'main',
        'default',
        'objects',
        'Equipment_Maintenance_Item__c'
    );
    const forceAppRoot = path.join(
        resolvedProjectPath,
        'force-app'
    );

    let emiObjectDirectoryExists = false;
    try {
        emiObjectDirectoryExists = fs.existsSync(emiObjectDirectory)
            && fs.statSync(emiObjectDirectory).isDirectory();
    } catch (error) {
        emiObjectDirectoryExists = false;
    }

    return {
        projectPath: resolvedProjectPath,
        emiObjectDirectoryExists,
        emiObjectDirectory,
        emiFiles: emiObjectDirectoryExists
            ? collectFilesUnderDirectory(emiObjectDirectory, resolvedProjectPath)
            : [],
        maintenanceRequestMatches: fs.existsSync(forceAppRoot)
            ? collectPathMatches(
                forceAppRoot,
                resolvedProjectPath,
                'Maintenance_Request__c'
            )
            : []
    };
}

function logEmiPostRetrieveDebug(projectPath) {
    let debug;

    try {
        debug = collectEmiPostRetrieveDebug(projectPath);
    } catch (error) {
        console.log('====================================================');
        console.log('EMI POST-RETRIEVE DEBUG');
        console.log('====================================================');
        console.log('diagnostic failed:', error.message || String(error));
        console.log('====================================================');
        return null;
    }

    console.log('====================================================');
    console.log('EMI POST-RETRIEVE DEBUG');
    console.log('====================================================');
    console.log(
        'EMI object directory:',
        debug.emiObjectDirectoryExists ? 'FOUND' : 'NOT FOUND'
    );
    console.log('Expected path:');
    console.log(debug.emiObjectDirectory);
    console.log('emiFileCount:', debug.emiFiles.length);
    console.log('maintenanceRequestMatchCount:', debug.maintenanceRequestMatches.length);
    console.log(JSON.stringify({
        projectPath: debug.projectPath,
        emiObjectDirectoryExists: debug.emiObjectDirectoryExists,
        emiObjectDirectory: debug.emiObjectDirectory,
        emiFiles: debug.emiFiles,
        maintenanceRequestMatches: debug.maintenanceRequestMatches
    }, null, 2));
    console.log('====================================================');

    return debug;
}

const EXPLICIT_EMI_RETRIEVE_MEMBER =
    'CustomObject:Equipment_Maintenance_Item__c';

function extractOrgIdFromOrgDisplayJson(stdout) {
    const payload = extractJsonPayload(stdout);
    if (!payload) {
        return null;
    }

    const result = payload.result && typeof payload.result === 'object'
        ? payload.result
        : payload;

    return result.id || result.orgId || null;
}

function inspectExplicitEmiRetrieveFilesystem(projectPath) {
    const resolvedProjectPath = path.resolve(projectPath);
    const objectDirectory = path.join(
        resolvedProjectPath,
        'force-app',
        'main',
        'default',
        'objects',
        'Equipment_Maintenance_Item__c'
    );
    const objectFile = path.join(
        objectDirectory,
        'Equipment_Maintenance_Item__c.object-meta.xml'
    );
    const objectDirectoryExists = (() => {
        try {
            return fs.existsSync(objectDirectory)
                && fs.statSync(objectDirectory).isDirectory();
        } catch (error) {
            return false;
        }
    })();
    const objectFileExists = (() => {
        try {
            return fs.existsSync(objectFile)
                && fs.statSync(objectFile).isFile();
        } catch (error) {
            return false;
        }
    })();
    const retrievedFiles = objectDirectoryExists
        ? collectFilesUnderDirectory(objectDirectory, resolvedProjectPath)
        : [];

    return {
        objectDirectory,
        objectDirectoryExists,
        objectFileExists,
        retrievedFiles,
        fieldFileCount: retrievedFiles.filter((file) =>
            file.includes('/fields/')
        ).length
    };
}

function buildExplicitEmiRetrieveDebugPayload({
    orgId = null,
    exitCode = null,
    stdout = '',
    projectPath
} = {}) {
    const summary = summarizeRetrieveResultJson(stdout);
    const filesystem = inspectExplicitEmiRetrieveFilesystem(
        projectPath || process.cwd()
    );
    const succeeded = filesystem.objectDirectoryExists
        || filesystem.objectFileExists
        || filesystem.retrievedFiles.length > 0;

    return {
        orgId: orgId || null,
        alias: RETRIEVAL_CLI_ALIAS,
        metadataType: 'CustomObject',
        metadataMember: 'Equipment_Maintenance_Item__c',
        exitCode,
        status: summary.parsed ? summary.status : null,
        fileCount: summary.parsed
            ? summary.fileCount
            : filesystem.retrievedFiles.length,
        failureCount: summary.parsed ? summary.failureCount : null,
        failures: summary.parsed ? summary.failures : [],
        objectDirectoryExists: filesystem.objectDirectoryExists,
        objectFileExists: filesystem.objectFileExists,
        objectDirectory: filesystem.objectDirectory,
        retrievedFiles: filesystem.retrievedFiles,
        fieldFileCount: filesystem.fieldFileCount,
        conclusion: succeeded
            ? 'Explicit member retrieval succeeds.'
            : 'Explicit member retrieval does not succeed.'
    };
}

function logExplicitEmiRetrieveDebug(payload) {
    console.log('====================================================');
    console.log('EXPLICIT EMI RETRIEVAL DEBUG');
    console.log('====================================================');
    console.log(JSON.stringify({
        orgId: payload.orgId,
        alias: payload.alias,
        metadataType: payload.metadataType,
        metadataMember: payload.metadataMember,
        exitCode: payload.exitCode,
        status: payload.status,
        fileCount: payload.fileCount,
        failureCount: payload.failureCount,
        objectDirectoryExists: payload.objectDirectoryExists,
        objectFileExists: payload.objectFileExists,
        objectDirectory: payload.objectDirectory,
        retrievedFiles: payload.retrievedFiles
    }, null, 2));
    if (payload.failureCount > 0) {
        console.log('failures (truncated):');
        console.log(JSON.stringify(payload.failures, null, 2));
    }
    console.log('fieldFileCount:', payload.fieldFileCount);
    console.log(payload.conclusion);
    console.log('====================================================');
}

/**
 * TEMP DIAGNOSTIC — isolated explicit EMI retrieve using the same temporg
 * session. Must not change production retrieve args, files, or Git.
 */
async function runExplicitEmiRetrieveDiagnostic() {
    const diagRoot = fs.mkdtempSync(
        path.join(os.tmpdir(), 'emi-explicit-diag-')
    );

    try {
        await execAsync(
            `cd ${diagRoot} && sf project generate --name emi-diag-project`
        );

        const projectPath = path.join(diagRoot, 'emi-diag-project');
        let orgId = null;

        try {
            const displayResult = await execAsync(
                `sf org display -o ${RETRIEVAL_CLI_ALIAS} --json`
            );
            orgId = extractOrgIdFromOrgDisplayJson(displayResult.stdout);
        } catch (error) {
            orgId = extractOrgIdFromOrgDisplayJson(error.stdout);
        }

        let exitCode = 0;
        let stdout = '';

        try {
            const retrieveResult = await execAsync(
                `cd ${projectPath} && ` +
                `sf project retrieve start ` +
                `-o ${RETRIEVAL_CLI_ALIAS} ` +
                `-m ${EXPLICIT_EMI_RETRIEVE_MEMBER} ` +
                `--json`,
                {
                    maxBuffer: 50 * 1024 * 1024
                }
            );
            stdout = retrieveResult.stdout || '';
        } catch (error) {
            exitCode = typeof error.code === 'number' ? error.code : 1;
            stdout = error.stdout || '';
        }

        logExplicitEmiRetrieveDebug(
            buildExplicitEmiRetrieveDebugPayload({
                orgId,
                exitCode,
                stdout,
                projectPath
            })
        );
    } catch (error) {
        console.log('====================================================');
        console.log('EXPLICIT EMI RETRIEVAL DEBUG');
        console.log('====================================================');
        console.log('diagnostic failed:', error.message || String(error));
        console.log('====================================================');
    } finally {
        try {
            fs.rmSync(diagRoot, { recursive: true, force: true });
        } catch (error) {
            // Diagnostic cleanup must not affect production retrieval.
        }
    }
}

exports.RETRIEVAL_METADATA_TYPES = RETRIEVAL_METADATA_TYPES;
exports.RETRIEVAL_STANDARD_OBJECT_MEMBERS = RETRIEVAL_STANDARD_OBJECT_MEMBERS;
exports.buildRetrieveMetadataMembers = buildRetrieveMetadataMembers;
exports.buildRetrieveMetadataArgs = buildRetrieveMetadataArgs;
exports.parseDiscoveredCustomObjectNames = parseDiscoveredCustomObjectNames;
exports.parseDiscoveredStandardValueSetNames =
    parseDiscoveredStandardValueSetNames;
exports.buildStandardValueSetRawResponseDebug =
    buildStandardValueSetRawResponseDebug;
exports.summarizeListMetadataPayloadShape = summarizeListMetadataPayloadShape;
exports.buildStandardValueSetParserDebug = buildStandardValueSetParserDebug;
exports.STANDARD_VALUE_SET_STDOUT_PREVIEW_LIMIT =
    STANDARD_VALUE_SET_STDOUT_PREVIEW_LIMIT;
exports.toExplicitCustomObjectMembers = toExplicitCustomObjectMembers;
exports.toExplicitStandardValueSetMembers = toExplicitStandardValueSetMembers;
exports.mergeRetrieveMetadataMembers = mergeRetrieveMetadataMembers;
exports.buildRetrieveMetadataMembersWithDiscovery =
    buildRetrieveMetadataMembersWithDiscovery;
exports.summarizeRetrieveResultJson = summarizeRetrieveResultJson;
exports.collectEmiPostRetrieveDebug = collectEmiPostRetrieveDebug;
exports.EXPLICIT_EMI_RETRIEVE_MEMBER = EXPLICIT_EMI_RETRIEVE_MEMBER;
exports.extractOrgIdFromOrgDisplayJson = extractOrgIdFromOrgDisplayJson;
exports.inspectExplicitEmiRetrieveFilesystem = inspectExplicitEmiRetrieveFilesystem;
exports.buildExplicitEmiRetrieveDebugPayload = buildExplicitEmiRetrieveDebugPayload;

function resolveSourceOrgId(identityUrl) {
    try {
        const segments = new URL(identityUrl).pathname
            .split('/')
            .filter(Boolean);

        return segments[0] === 'id' ? segments[1] || null : null;
    } catch (error) {
        return null;
    }
}

async function createRetrievalSnapshot({
    projectPath,
    tokenResponse,
    instanceUrl,
    accessToken
}) {
    const sourceOrgId = resolveSourceOrgId(tokenResponse?.data?.id);
    let result;

    try {
        result = await persistRetrievalSnapshotMetadata({
            projectPath,
            sourceOrgId,
            instanceUrl,
            accessToken,
            retrievedAt: new Date().toISOString(),
            getLatestApiVersionFn: getLatestApiVersion
        });
    } catch (error) {
        result = {
            snapshotMetadata: {
                sourceOrgId,
                sourceMetadataApiVersion: null
            },
            written: false
        };
    }

    console.log('================================================');
    console.log('RETRIEVAL SNAPSHOT METADATA');
    console.log('================================================');
    console.log('');
    console.log(
        'Source Org:',
        result.snapshotMetadata.sourceOrgId || '(unknown)'
    );
    console.log('');
    console.log(
        'Metadata API:',
        result.snapshotMetadata.sourceMetadataApiVersion || '(unknown)'
    );
    console.log('');
    console.log(
        'Snapshot File:',
        '.metadata-backup/retrieval-metadata.json'
    );
    console.log('');
    console.log('Written:', result.written ? 'YES' : 'NO');

    return result;
}

exports.retrieveMetadataInternal = async (
    refreshToken,
    instanceUrl
) => {

    let workspace;
    let deferCleanup = false;

    try {
 
        console.log('STEP 1 - Generating token');
        setStatus('Generating token');
 
        const tokenResponse =
        await axios.post(
            'https://login.salesforce.com/services/oauth2/token',
            null,
            {
                params: {
                    grant_type: 'refresh_token',
                    client_id: process.env.SF_CLIENT_ID,
                    client_secret: process.env.SF_CLIENT_SECRET,
                    refresh_token: refreshToken
                }
            }
        );

        console.log(
    JSON.stringify(
        tokenResponse.data,
        null,
        2
    )
);
 
        console.log('STEP 1 COMPLETE');
 
        const accessToken =
        tokenResponse.data.access_token;

        console.log('TOKEN RESPONSE');

console.log(
    JSON.stringify(
        tokenResponse.data,
        null,
        2
    )
);
 
        console.log('STEP 2 - Creating workspace');
        setStatus('Creating workspace');
 
        workspace =
        `/tmp/workspace-${Date.now()}`;
 
        fs.mkdirSync(
            workspace,
            { recursive: true }
        );
 
        console.log('STEP 2 COMPLETE');
 
        console.log('STEP 3 - Generating project');
        setStatus('Generating project');
        await execAsync(
            `cd ${workspace} && sf project generate --name backup-project`
        );
 
        console.log('STEP 3 COMPLETE');

        await createRetrievalSnapshot({
            projectPath: `${workspace}/backup-project`,
            tokenResponse,
            instanceUrl,
            accessToken
        });
 
        console.log('STEP 4 - CLI Login');
        setStatus('CLI Login');
 
        const loginCommand =
`export SF_ACCESS_TOKEN="${accessToken}" && ` +
`sf org login access-token ` +
`-r ${instanceUrl} ` +
`--alias temporg ` +
`--no-prompt`;

try {

    const loginResult =
        await execAsync(loginCommand);

    console.log('LOGIN STDOUT');
    console.log(loginResult.stdout);

    console.log('LOGIN STDERR');
    console.log(loginResult.stderr);

}
catch(error) {

    console.log('LOGIN FAILED');

    console.log('STDOUT');
    console.log(error.stdout);

    console.log('STDERR');
    console.log(error.stderr);

    throw error;

}

console.log('STEP 4 COMPLETE');

        // TEMP DIAGNOSTIC — explicit EMI retrieve in an isolated DX project
        // using the same temporg session. Does not change production retrieve.
        await runExplicitEmiRetrieveDiagnostic();
 
        console.log('STEP 5 - Retrieving ApexClass');
        setStatus('Retrieving ApexClass');

const [discovery, standardValueSetDiscovery] = await Promise.all([
    discoverCustomObjectNames(RETRIEVAL_CLI_ALIAS),
    discoverStandardValueSetNames(RETRIEVAL_CLI_ALIAS)
]);
const discoveredCustomObjectNames = discovery.names || [];
const discoveredStandardValueSetNames =
    standardValueSetDiscovery.names || [];
const retrieveMembers = buildRetrieveMetadataMembersWithDiscovery(
    discoveredCustomObjectNames,
    discoveredStandardValueSetNames
);
const explicitDiscoveredMembers = toExplicitCustomObjectMembers(
    discoveredCustomObjectNames
);
const explicitStandardValueSetMembers = toExplicitStandardValueSetMembers(
    discoveredStandardValueSetNames
);
const baseMemberSet = new Set(buildRetrieveMetadataMembers());
const explicitMembersAdded = explicitDiscoveredMembers.filter(
    (member) => !baseMemberSet.has(member)
).length;
const explicitStandardValueSetMembersAdded =
    explicitStandardValueSetMembers.filter(
        (member) => !baseMemberSet.has(member)
    ).length;

logCustomObjectDiscoveryDebug({
    strategy: discovery.strategy,
    discoveredCount: discoveredCustomObjectNames.length,
    explicitMembersAdded,
    discoveredIncludesEmi: discoveredCustomObjectNames.includes(
        'Equipment_Maintenance_Item__c'
    ),
    discoveredIncludesMaintenanceRequestObject:
        discoveredCustomObjectNames.includes('Maintenance_Request__c'),
    errorMessage: discovery.errorMessage || null
});

logStandardValueSetDiscoveryDebug({
    strategy: standardValueSetDiscovery.strategy,
    discoveredCount: discoveredStandardValueSetNames.length,
    explicitMembersAdded: explicitStandardValueSetMembersAdded,
    errorMessage: standardValueSetDiscovery.errorMessage || null
});

const metadataArgs = buildRetrieveMetadataArgs(retrieveMembers);

console.log(
 'Retrieving Full Metadata...'
);
console.log('Retrieve metadata args:', metadataArgs);
console.log(
    'Retrieve strategy:',
    discovery.strategy
);
setStatus('Retrieving Full Metadata');

let retrieveStdout = '';
let retrieveStderr = '';

try {
    const retrieveCliResult = await execAsync(
        `cd ${workspace}/backup-project && ` +
        `sf project retrieve start ` +
        `-o temporg ` +
        `${metadataArgs} ` +
        `--json`,
        {
            maxBuffer: 50 * 1024 * 1024
        }
    );

    retrieveStdout = retrieveCliResult.stdout || '';
    retrieveStderr = retrieveCliResult.stderr || '';
} catch (error) {
    retrieveStdout = error.stdout || '';
    retrieveStderr = error.stderr || '';

    logRetrieveResultDebug(retrieveStdout);

    if (retrieveStderr) {
        console.log('RETRIEVE STDERR');
        console.log(retrieveStderr);
    }

    // Preserve existing behavior: CLI non-zero exit still fails the migrate.
    throw error;
}

const retrieveSummary = logRetrieveResultDebug(retrieveStdout);

if (retrieveStderr) {
    console.log('RETRIEVE STDERR');
    console.log(retrieveStderr);
}

// Narrow check only: Salesforce CLI reported a non-zero JSON status
// even though the process may have returned stdout. Do not change
// behavior for status 0 / unparsable stdout (continue as before).
if (
    retrieveSummary.parsed &&
    typeof retrieveSummary.status === 'number' &&
    retrieveSummary.status !== 0
) {
    throw new Error(
        `Salesforce CLI retrieve reported status ${retrieveSummary.status}`
    );
}

console.log(
 'Full Metadata Retrieval Complete'
);
setStatus('Full Metadata Retrieval Complete');

        // TEMP DIAGNOSTIC — log-only filesystem probe after CLI retrieve
        // and before Git (git add runs later in runMigration).
        logEmiPostRetrieveDebug(`${workspace}/backup-project`);

        console.log('STEP 5 COMPLETE');

        deferCleanup = true;

        return {
            workspace,
            accessToken
        };
 
    } catch (error) {
 
        console.error(
            'retrieveMetadataInternal FAILED:',
            error
        );
 
        throw error;
    } finally {
        await cleanupRetrievalResources({
            workspacePath: deferCleanup ? null : workspace,
            alias: deferCleanup ? null : RETRIEVAL_CLI_ALIAS
        });
    }
};
 
 

exports.checkSfCli = async (req, res) => {

    exec('sf --version', (error, stdout, stderr) => {

        if (error) {
            return res.status(500).json({
                success: false,
                error: stderr || error.message
            });
        }

        res.json({
            success: true,
            version: stdout
        });

    });

};

exports.testSfAuth = async (req, res) => {

    try {

        const { accessToken, instanceUrl } = req.body;

        const command =
            `export SF_ACCESS_TOKEN="${accessToken}" && ` +
            `sf org login access-token ` +
            `--instance-url ${instanceUrl} ` +
            `--alias backuporg ` +
            `--no-prompt`;

        exec(
            command,
            (error, stdout, stderr) => {

                if (error) {

                    return res.status(500).json({
                        success: false,
                        error: stderr || error.message
                    });

                }

                res.json({
                    success: true,
                    output: stdout
                });

            }
        );

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });

    }

};

exports.retrieveMetadata = async (req, res) => {

    let workspacePath = null;

    try {
 
        const {
            refreshToken,
            instanceUrl
        } = req.body;
 
        const result =
            await exports.retrieveMetadataInternal(
                refreshToken,
                instanceUrl
            );

        workspacePath = result.workspace;
 
        return res.json({
            success: true,
            workspace: result.workspace
        });
 
    } catch (error) {
 
        return res.status(500).json({
            success: false,
            error:
                error.stderr ||
                error.stdout ||
                error.message
        });
 
    } finally {
        await cleanupRetrievalResources({
            workspacePath,
            alias: RETRIEVAL_CLI_ALIAS
        });
    }
 
};
 

exports.retrieveAllMetadata = async (req, res) => {

    let workspace = null;

    try {

        console.log('===== RETRIEVE ALL STARTED =====');

        const {
            refreshToken,
            instanceUrl
        } = req.body;
        console.log('Instance URL:', instanceUrl);
        // STEP 1
        console.log('Generating access token...');
        const tokenResponse =
            await axios.post(
                'https://login.salesforce.com/services/oauth2/token',
                null,
                {
                    params: {
                        grant_type: 'refresh_token',
                        client_id: process.env.SF_CLIENT_ID,
                        client_secret: process.env.SF_CLIENT_SECRET,
                        refresh_token: refreshToken
                    }
                }
            );

        const accessToken =
            tokenResponse.data.access_token;

        console.log('Access token generated');

        // STEP 2
        workspace =
            `/tmp/workspace-${Date.now()}`;

        console.log('Workspace:', workspace);

        fs.mkdirSync(
            workspace,
            { recursive: true }
        );

        // STEP 3

        console.log('Generating Salesforce project...');
        await execAsync(
            `cd ${workspace} && sf project generate --name backup-project`
        );

        console.log('Project generated');

        await createRetrievalSnapshot({
            projectPath: `${workspace}/backup-project`,
            tokenResponse,
            instanceUrl,
            accessToken
        });

        // STEP 4
        console.log('Logging into Salesforce CLI...');
        const loginCommand =
            `export SF_ACCESS_TOKEN="${accessToken}" && ` +
            `sf org login access-token ` +
            `-r ${instanceUrl} ` +
            `--alias temporg ` +
            `--no-prompt`;

        await execAsync(loginCommand);

        console.log('CLI login successful');

// STEP 5
// STEP 5
console.log('Retrieving metadata...');
 
const metadataTypes = [
  'ApexClass',
  'ApexTrigger',
  'CustomObject',
  'CustomTab',
  'NamedCredential',
  'ExternalCredential',
  'CustomLabel',
  'CustomMetadata'
];

const metadataArgs =
metadataTypes
.map(type => `-m ${type}`)
.join(' ');

console.time('retrieve');
 
const retrieveResult =
await execAsync(
  `cd ${workspace}/backup-project && ` +
  `sf project retrieve start ` +
  `-o temporg ` +
  `${metadataArgs} ` +
  `--json`
);

console.timeEnd('retrieve');
 
console.log('Metadata retrieval completed');

// STEP 6 - GIT INIT

console.log('Initializing Git...');

await execAsync(
  `cd ${workspace}/backup-project && git init`
);

await execAsync(
  `cd ${workspace}/backup-project && git config user.email "backup@system.com"`
);

await execAsync(
  `cd ${workspace}/backup-project && git config user.name "Metadata Backup"`
);

console.log('Git initialized');

// STEP 7 - COMMIT

console.log('Adding files...');

await execAsync(
  `cd ${workspace}/backup-project && git add .`
);

console.log('Creating commit...');

await execAsync(
  `cd ${workspace}/backup-project && git commit -m "Metadata Backup"`
);

console.log('Commit completed');

const githubToken = process.env.GITHUB_TOKEN;

const authenticatedRepoUrl =
`https://${githubToken}@github.com/nadish05/New-salesforce-Backup.git`;

console.log('Adding GitHub remote...');

await execAsync(
  `cd ${workspace}/backup-project && git branch -M main`
);

await execAsync(
  `cd ${workspace}/backup-project && git remote add origin ${authenticatedRepoUrl}`
);

console.log('Pushing to GitHub...');

await execAsync(
  `cd ${workspace}/backup-project && git push origin main --force`
);

console.log('GitHub push completed');



// STEP 8 - FILE COUNT

const fileCount =
await execAsync(
  `find ${workspace}/backup-project -type f | wc -l`
);

console.log(
  'Total Files Retrieved:',
  fileCount.stdout
);

const filesResult =
await execAsync(
  `find ${workspace}/backup-project -type f | head -200`
);

console.log(filesResult.stdout);
 

        return res.json({
            success: true,
            workspace,
            files: filesResult.stdout,
            retrieveOutput: JSON.parse(
                retrieveResult.stdout
            )
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            error:
                error.stderr ||
                error.stdout ||
                error.message
        });

    } finally {
        await cleanupRetrievalResources({
            workspacePath: workspace,
            alias: RETRIEVAL_CLI_ALIAS
        });
    }

};