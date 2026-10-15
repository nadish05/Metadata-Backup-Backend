'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');

const { ensureSfdxProject } = require('../sfdxProject.service');
const {
    refreshAccessToken,
    loginSfOrg,
    shellQuote
} = require('../checkOnlyDeployment.service');
const {
    packMemberFiles,
    unpackMemberFiles
} = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    parseVersionQualifiedFlowMember,
    FLOW_META_SUFFIX,
    FLOWS_DIR_PREFIX,
    applyCanonicalFlowSnapshotPackPaths,
    buildCanonicalFlowArtifactRelativePath
} = require('../flowMetadata/flowMemberIdentity.service');
const {
    discoverFlowVersions,
    findExactFlowVersion
} = require('../retrieval/flowVersionDiscovery.service');
const {
    retrieveSingleFlowVersion
} = require('../retrieval/flowVersionRetrieval.service');

const mkdir = util.promisify(fs.mkdir);
const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);
const stat = util.promisify(fs.stat);
const rm = util.promisify(fs.rm);
const defaultExecAsync = util.promisify(exec);

const SKIP_DIR_NAMES = new Set(['.sf', '.sfdx', '.git', 'node_modules']);
const SKIP_FILE_NAMES = new Set(['sfdx-project.json']);
const MAX_DIAGNOSTIC_TEXT_LENGTH = 4096;

const SECRET_REDACTION_PATTERNS = [
    /SF_ACCESS_TOKEN\s*=\s*["'][^"']*["']/gi,
    /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    /\brefresh[_-]?token["']?\s*[:=]\s*["'][^"']*["']/gi,
    /\baccess[_-]?token["']?\s*[:=]\s*["'][^"']*["']/gi,
    /\bclient[_-]?secret["']?\s*[:=]\s*["'][^"']*["']/gi,
    /\bAuthorization:\s*[^\s"']+/gi
];

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function redactDiagnosticText(value) {
    let text = String(value || '');

    for (const pattern of SECRET_REDACTION_PATTERNS) {
        text = text.replace(pattern, '[REDACTED]');
    }

    if (text.length > MAX_DIAGNOSTIC_TEXT_LENGTH) {
        return `${text.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}...[truncated]`;
    }

    return text;
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

function summarizeRetrieveCliOutput(stdout) {
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

    const result =
        payload.result && typeof payload.result === 'object'
            ? payload.result
            : payload;
    const files = result.files || result.fileProperties || [];
    const failures =
        result.failures ||
        (Array.isArray(result.messages) ? result.messages : null) ||
        payload.warnings ||
        [];

    return {
        parsed: true,
        status: payload.status,
        message:
            typeof payload.message === 'string' ? payload.message : null,
        fileCount: collectRetrieveFileStrings(files).length,
        failureCount: Array.isArray(failures) ? failures.length : 0,
        failures: Array.isArray(failures) ? failures.slice(0, 25) : failures
    };
}

function extractCliFailureMessages(summary, stderr) {
    const messages = [];

    if (summary?.parsed) {
        if (summary.message) {
            messages.push(summary.message);
        }

        if (Array.isArray(summary.failures)) {
            for (const failure of summary.failures) {
                if (!failure) {
                    continue;
                }

                if (typeof failure === 'string') {
                    messages.push(failure);
                    continue;
                }

                if (failure.message) {
                    messages.push(String(failure.message));
                    continue;
                }

                if (failure.problem) {
                    messages.push(String(failure.problem));
                    continue;
                }

                messages.push(JSON.stringify(failure));
            }
        }
    }

    const stderrText = String(stderr || '').trim();

    if (!messages.length && stderrText) {
        messages.push(stderrText);
    }

    return messages
        .map((message) => redactDiagnosticText(message).trim())
        .filter(Boolean);
}

function buildExpectedMemberSourcePaths(metadataType, metadataName) {
    if (metadataType === 'ApexClass') {
        const base = `force-app/main/default/classes/${metadataName}`;

        return {
            cls: `${base}.cls`,
            metaXml: `${base}.cls-meta.xml`
        };
    }

    if (metadataType === 'CustomObject' && metadataName) {
        return {
            logical: `force-app/main/default/objects/${metadataName}/${metadataName}.object-meta.xml`
        };
    }

    if (
        (metadataType === 'CustomField' || metadataType === 'ListView') &&
        metadataName
    ) {
        const separator = metadataName.indexOf('.');
        const objectName =
            separator > 0 ? metadataName.slice(0, separator) : null;
        const memberName =
            separator > 0 ? metadataName.slice(separator + 1) : null;

        if (!objectName || !memberName) {
            return null;
        }

        const folder = metadataType === 'CustomField' ? 'fields' : 'listViews';
        const extension =
            metadataType === 'CustomField'
                ? '.field-meta.xml'
                : '.listView-meta.xml';

        return {
            logical: `force-app/main/default/objects/${objectName}/${folder}/${memberName}${extension}`
        };
    }

    if (metadataType === 'ValidationRule' && metadataName) {
        const separator = metadataName.indexOf('.');
        const objectName =
            separator > 0 ? metadataName.slice(0, separator) : null;
        const ruleName =
            separator > 0 ? metadataName.slice(separator + 1) : null;

        if (!objectName || !ruleName) {
            return null;
        }

        return {
            logical: `force-app/main/default/objects/${objectName}/validationRules/${ruleName}.validationRule-meta.xml`
        };
    }

    if (metadataType === 'RecordType' && metadataName) {
        const separator = metadataName.indexOf('.');
        const objectName =
            separator > 0 ? metadataName.slice(0, separator) : null;
        const recordTypeName =
            separator > 0 ? metadataName.slice(separator + 1) : null;

        if (!objectName || !recordTypeName) {
            return null;
        }

        return {
            logical: `force-app/main/default/objects/${objectName}/recordTypes/${recordTypeName}.recordType-meta.xml`
        };
    }

    if (metadataType === 'StandardValueSet' && metadataName) {
        const setName = String(metadataName).trim();

        if (!setName) {
            return null;
        }

        return {
            logical: `force-app/main/default/standardValueSets/${setName}.standardValueSet-meta.xml`
        };
    }

    if (metadataType === 'BusinessProcess' && metadataName) {
        const separator = metadataName.indexOf('.');
        const objectName =
            separator > 0 ? metadataName.slice(0, separator) : null;
        const processName =
            separator > 0 ? metadataName.slice(separator + 1) : null;

        if (!objectName || !processName) {
            return null;
        }

        return {
            logical: `force-app/main/default/objects/${objectName}/businessProcesses/${processName}.businessProcess-meta.xml`
        };
    }

    if (metadataType === 'CompactLayout' && metadataName) {
        const separator = metadataName.indexOf('.');
        const objectName =
            separator > 0 ? metadataName.slice(0, separator) : null;
        const layoutName =
            separator > 0 ? metadataName.slice(separator + 1) : null;

        if (!objectName || !layoutName) {
            return null;
        }

        return {
            logical: `force-app/main/default/objects/${objectName}/compactLayouts/${layoutName}.compactLayout-meta.xml`
        };
    }

    if (metadataType === 'NamedCredential' && metadataName) {
        const developerName = String(metadataName).trim();

        if (!developerName) {
            return null;
        }

        return {
            logical: `force-app/main/default/namedCredentials/${developerName}.namedCredential-meta.xml`
        };
    }

    if (metadataType === 'ExternalCredential' && metadataName) {
        const developerName = String(metadataName).trim();

        if (!developerName) {
            return null;
        }

        return {
            logical: `force-app/main/default/externalCredentials/${developerName}.externalCredential-meta.xml`
        };
    }

    if (metadataType === 'CustomMetadata' && metadataName) {
        const memberName = String(metadataName).trim();

        if (!memberName) {
            return null;
        }

        return {
            logical: `force-app/main/default/customMetadata/${memberName}.md-meta.xml`
        };
    }

    if (metadataType === 'Flow' && metadataName) {
        const memberName = String(metadataName).trim();

        if (!memberName) {
            return null;
        }

        return {
            logical: `force-app/main/default/flows/${memberName}.flow-meta.xml`
        };
    }

    return null;
}

function normalizeRetrieveRelativePath(relativePath) {
    return String(relativePath || '').replace(/\\/g, '/');
}

function isFlowsFlowMetaRelativePath(relativePath) {
    const normalized = normalizeRetrieveRelativePath(relativePath);

    return (
        normalized.includes('/flows/') &&
        normalized.endsWith(FLOW_META_SUFFIX)
    );
}

function flowMetaBasenameFromRelativePath(relativePath) {
    const normalized = normalizeRetrieveRelativePath(relativePath);

    return normalized.split('/').pop() || '';
}

function buildFlowLogicalRelativePath(metadataName) {
    const memberName = String(metadataName || '').trim();

    if (!memberName) {
        return null;
    }

    return `${FLOWS_DIR_PREFIX}${memberName}${FLOW_META_SUFFIX}`;
}

/**
 * Flow destination retrieve may return a version-qualified filename or, for a
 * version-qualified member request, an unversioned definition filename. Exact
 * versioned path wins; unversioned fallback is allowed only when flow artifacts
 * are unambiguous (no wrong version, no unrelated flows).
 */
function selectLogicalFlowMemberFiles(
    retrievedFiles,
    metadataName,
    options = {}
) {
    const memberName = String(metadataName || '').trim();
    const parsed = parseVersionQualifiedFlowMember(memberName);
    const failMessage = `Destination snapshot retrieve did not return the logical file for Flow:${metadataName}.`;

    if (!parsed) {
        throw new Error(failMessage);
    }

    const primaryLogical = buildFlowLogicalRelativePath(memberName);

    if (!primaryLogical) {
        throw new Error(failMessage);
    }

    const normalizedFiles = retrievedFiles.map((file) => ({
        ...file,
        relativePath: normalizeRetrieveRelativePath(file.relativePath)
    }));

    const primaryMatches = normalizedFiles.filter(
        (file) => file.relativePath === primaryLogical
    );

    if (primaryMatches.length > 0) {
        return primaryMatches;
    }

    if (!parsed.isVersionQualified) {
        throw new Error(failMessage);
    }

    if (options.requireExactVersionQualifiedFlowArtifact === true) {
        throw new Error(failMessage);
    }

    const definitionDeveloperName = parsed.definitionDeveloperName;
    const requestedVersion = parsed.sourceVersionNumber;
    const unversionedBasename = `${definitionDeveloperName}${FLOW_META_SUFFIX}`;
    const flowMetaFiles = normalizedFiles.filter((file) =>
        isFlowsFlowMetaRelativePath(file.relativePath)
    );

    const hasConflictingVersionedFile = flowMetaFiles.some((file) => {
        const stem = flowMetaBasenameFromRelativePath(file.relativePath).slice(
            0,
            -FLOW_META_SUFFIX.length
        );
        const stemParsed = parseVersionQualifiedFlowMember(stem);

        if (!stemParsed || !stemParsed.isVersionQualified) {
            return false;
        }

        return (
            stemParsed.definitionDeveloperName === definitionDeveloperName &&
            stemParsed.sourceVersionNumber !== requestedVersion
        );
    });

    if (hasConflictingVersionedFile) {
        throw new Error(failMessage);
    }

    const unversionedMatches = flowMetaFiles.filter(
        (file) =>
            flowMetaBasenameFromRelativePath(file.relativePath) ===
            unversionedBasename
    );

    const unrelatedFlowFiles = flowMetaFiles.filter((file) => {
        const basename = flowMetaBasenameFromRelativePath(file.relativePath);

        if (basename === unversionedBasename) {
            return false;
        }

        const stem = basename.slice(0, -FLOW_META_SUFFIX.length);
        const stemParsed = parseVersionQualifiedFlowMember(stem);

        if (
            stemParsed.isVersionQualified &&
            stemParsed.definitionDeveloperName === definitionDeveloperName &&
            stemParsed.sourceVersionNumber === requestedVersion
        ) {
            return false;
        }

        if (
            !stemParsed.isVersionQualified &&
            stemParsed.definitionDeveloperName === definitionDeveloperName
        ) {
            return false;
        }

        return true;
    });

    if (unrelatedFlowFiles.length > 0 || unversionedMatches.length !== 1) {
        throw new Error(failMessage);
    }

    return unversionedMatches;
}

function selectLogicalMemberFiles(
    retrievedFiles,
    metadataType,
    metadataName,
    options = {}
) {
    const expectedPaths = buildExpectedMemberSourcePaths(
        metadataType,
        metadataName
    );

    if (
        !expectedPaths ||
        ![
            'CustomObject',
            'CustomField',
            'ListView',
            'ValidationRule',
            'RecordType',
            'BusinessProcess',
            'CompactLayout',
            'NamedCredential',
            'ExternalCredential',
            'CustomMetadata',
            'StandardValueSet',
            'Flow'
        ].includes(metadataType)
    ) {
        return retrievedFiles;
    }

    const selected =
        metadataType === 'Flow'
            ? selectLogicalFlowMemberFiles(
                  retrievedFiles,
                  metadataName,
                  options
              )
            : retrievedFiles.filter((file) =>
                  Object.values(expectedPaths).includes(
                      normalizeRetrieveRelativePath(file.relativePath)
                  )
              );

    if (selected.length === 0) {
        throw new Error(
            `Destination snapshot retrieve did not return the logical file for ${metadataType}:${metadataName}.`
        );
    }

    console.log(
        'ROLLBACK_LOGICAL_FILE_SELECTION',
        JSON.stringify({
            metadataType,
            metadataName,
            expectedLogicalPath:
                Object.values(expectedPaths).length === 1
                    ? Object.values(expectedPaths)[0]
                    : Object.values(expectedPaths),
            rawRetrievedFileCount: retrievedFiles.length,
            rawRetrievedFilePaths: retrievedFiles.map(
                (file) => file.relativePath
            ),
            selectedLogicalFilePaths: selected.map(
                (file) => file.relativePath
            ),
            selectedLogicalFileCount: selected.length
        })
    );

    return selected;
}

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch (error) {
        return false;
    }
}

async function listWorkspaceTopLevel(workspacePath) {
    if (!(await pathExists(workspacePath))) {
        return [];
    }

    const entries = await readdir(workspacePath, { withFileTypes: true });

    return entries.map((entry) => entry.name).sort();
}

async function buildExpectedPathChecks({
    workspacePath,
    metadataType,
    metadataName,
    retrievedFiles
}) {
    const expectedPaths = buildExpectedMemberSourcePaths(
        metadataType,
        metadataName
    );

    if (!expectedPaths) {
        return null;
    }

    const retrievedPathSet = new Set(
        retrievedFiles.map((file) => file.relativePath)
    );
    const checks = {};

    for (const [key, relativePath] of Object.entries(expectedPaths)) {
        checks[key] = {
            relativePath,
            exists:
                retrievedPathSet.has(relativePath) ||
                (await pathExists(path.join(workspacePath, relativePath)))
        };
    }

    return checks;
}

function buildRetrieveDiagnosticRecord({
    metadataType,
    metadataName,
    alias,
    workspacePath,
    retrieveCommand,
    sourceApiVersion,
    exitCode,
    stdout,
    stderr,
    summary,
    retrievedFiles,
    workspaceTopLevel,
    expectedPathChecks
}) {
    const failureMessages = extractCliFailureMessages(summary, stderr);

    return {
        metadataType,
        metadataName,
        alias,
        workspacePath,
        sourceApiVersion: sourceApiVersion || null,
        retrieveCommand: redactDiagnosticText(retrieveCommand),
        exitCode: exitCode ?? null,
        stdoutLength: String(stdout || '').length,
        stderrLength: String(stderr || '').length,
        cliParsed: summary?.parsed === true,
        cliStatus: summary?.parsed ? summary.status ?? null : null,
        cliFailureCount: summary?.parsed ? summary.failureCount ?? 0 : 0,
        cliFailureMessages: failureMessages,
        stderrSnippet: stderr
            ? redactDiagnosticText(stderr)
            : null,
        retrievedFileCount: retrievedFiles.length,
        retrievedFilePaths: retrievedFiles.map((file) => file.relativePath),
        workspaceTopLevel,
        expectedSourcePaths: expectedPathChecks
    };
}

function logDestinationRetrieveDiagnostic(diagnostic) {
    logSection('Destination Snapshot Retrieve Diagnostic');
    console.log(JSON.stringify(diagnostic, null, 2));
}

function normalizeLoggedRelativePath(relativePath) {
    return String(relativePath || '').replace(/\\/g, '/');
}

function buildRollbackDestinationArtifactDiagnostic({
    metadataType,
    metadataName,
    workspacePath,
    retrievedFiles,
    logicalMemberFiles,
    artifactBytes,
    artifactDiagnosticContext,
    requestedSourceApiVersion,
    effectiveSourceApiVersion,
    exactVersionRecovery = null
} = {}) {
    const context = artifactDiagnosticContext || {};
    const selectedFiles = (logicalMemberFiles || []).map((file) => ({
        relativePath: normalizeLoggedRelativePath(file.relativePath),
        contentLength: file.bytes.length,
        rawContentHash: hashBytes(file.bytes)
    }));
    const packedFiles = unpackMemberFiles(artifactBytes);

    return {
        memberKey: context.memberKey || null,
        operationId: context.operationId || null,
        snapshotId: context.snapshotId || null,
        metadataType,
        metadataName,
        workspacePath: workspacePath || null,
        retrievedFileCount: Array.isArray(retrievedFiles)
            ? retrievedFiles.length
            : 0,
        logicalSelectedFileCount: selectedFiles.length,
        selectedFiles,
        packedArtifactSize: artifactBytes.length,
        packedFileCount: packedFiles.length,
        packedRelativePaths: packedFiles.map((file) =>
            normalizeLoggedRelativePath(file.relativePath)
        ),
        packedArtifactHash: hashBytes(artifactBytes),
        requestedSourceApiVersion: requestedSourceApiVersion ?? null,
        effectiveSourceApiVersion: effectiveSourceApiVersion ?? null,
        exactVersionRecovery: exactVersionRecovery || null
    };
}

function logRollbackDestinationArtifactDiagnostic(payload) {
    console.log(
        'ROLLBACK_DESTINATION_ARTIFACT_DIAGNOSTIC',
        JSON.stringify(payload)
    );
}

function buildExecFailureError(metadataType, metadataName, diagnostic) {
    const prefix = `Destination snapshot capture failed for ${metadataType}:${metadataName}:`;
    const details = [];

    if (diagnostic.exitCode != null) {
        details.push(`exit code ${diagnostic.exitCode}`);
    }

    if (diagnostic.cliStatus != null) {
        details.push(`CLI status ${diagnostic.cliStatus}`);
    }

    if (diagnostic.cliFailureMessages?.length) {
        details.push(diagnostic.cliFailureMessages.join('; '));
    } else if (diagnostic.stderrSnippet) {
        details.push(diagnostic.stderrSnippet);
    } else {
        details.push('retrieve command failed');
    }

    return new Error(`${prefix} ${details.join(' — ')}`);
}

const FLOW_DESTINATION_VERSION_NOT_RETRIEVED =
    'FLOW_DESTINATION_VERSION_NOT_RETRIEVED';

function cliIndicatesMetadataMemberNotFound(
    metadataType,
    metadataName,
    cliFailureMessages
) {
    if (!Array.isArray(cliFailureMessages) || cliFailureMessages.length === 0) {
        return false;
    }

    const combined = cliFailureMessages.join(' ').toLowerCase();

    if (!combined.includes('cannot be found')) {
        return false;
    }

    const memberName = String(metadataName || '').toLowerCase();
    const typeName = String(metadataType || '').toLowerCase();

    if (memberName && combined.includes(memberName)) {
        return true;
    }

    return typeName.length > 0 && combined.includes(typeName);
}

function buildFlowVersionZeroFilesError(metadataName, diagnostic, parsed) {
    const prefix = `Destination snapshot capture failed for Flow:${metadataName}:`;
    const definitionDeveloperName = parsed.definitionDeveloperName;
    const sourceFlowVersionNumber = parsed.sourceVersionNumber;
    const details = [
        `code=${FLOW_DESTINATION_VERSION_NOT_RETRIEVED}`,
        `the requested destination Flow version could not be retrieved (${definitionDeveloperName} version ${sourceFlowVersionNumber})`,
        'snapshot capture was blocked because the org reported this Flow version as missing and zero metadata files were written to the retrieve workspace'
    ];

    if (diagnostic.cliStatus != null) {
        details.push(`CLI status ${diagnostic.cliStatus}`);
    }

    if (diagnostic.cliFailureMessages?.length) {
        details.push(
            `CLI failures: ${diagnostic.cliFailureMessages.join('; ')}`
        );
    }

    if (diagnostic.expectedSourcePaths?.logical) {
        details.push(
            `expected logical path: ${diagnostic.expectedSourcePaths.logical.relativePath} (${diagnostic.expectedSourcePaths.logical.exists ? 'found' : 'missing'})`
        );
    }

    const error = new Error(`${prefix} ${details.join(' — ')}`);
    error.code = FLOW_DESTINATION_VERSION_NOT_RETRIEVED;
    error.metadataType = 'Flow';
    error.metadataName = metadataName;
    error.flowDefinitionDeveloperName = definitionDeveloperName;
    error.sourceFlowVersionNumber = sourceFlowVersionNumber;

    return error;
}

function buildExactVersionRecoveryDiagnostic({
    metadataName,
    parsed,
    exactVersion,
    retrieved,
    recoveryOutcome
}) {
    return {
        exactVersionRecoveryInvoked: true,
        metadataName: metadataName || null,
        flowDefinitionDeveloperName:
            parsed?.definitionDeveloperName ||
            exactVersion?.flowDefinitionDeveloperName ||
            null,
        requestedVersionNumber:
            parsed?.sourceVersionNumber ??
            exactVersion?.sourceFlowVersionNumber ??
            null,
        sourceFlowVersionId: exactVersion?.sourceFlowVersionId || null,
        flowIsLatestVersion:
            exactVersion?.flowIsLatestVersion === true ||
            exactVersion?.flowIsLatestVersion === false
                ? exactVersion.flowIsLatestVersion
                : null,
        flowIsActiveVersion:
            exactVersion?.flowIsActiveVersion === true ||
            exactVersion?.flowIsActiveVersion === false
                ? exactVersion.flowIsActiveVersion
                : null,
        retrievedArtifactPath: retrieved?.retrievedArtifactPath || null,
        retrievedArtifactCorrelation:
            retrieved?.retrievedArtifactCorrelation || null,
        recoveryOutcome: recoveryOutcome || null
    };
}

function logExactVersionRecoveryDiagnostic(payload) {
    console.log(
        'FLOW_EXACT_VERSION_RECOVERY_DIAGNOSTIC',
        JSON.stringify(payload)
    );
}

function buildFlowExactVersionArtifactError(
    metadataName,
    parsed,
    reason,
    detail = null
) {
    const prefix = `Destination snapshot capture failed for Flow:${metadataName}:`;
    const definitionDeveloperName = parsed.definitionDeveloperName;
    const sourceFlowVersionNumber = parsed.sourceVersionNumber;
    const details = [
        `code=${FLOW_DESTINATION_VERSION_NOT_RETRIEVED}`,
        `exact Flow version artifact required for rollback drift verification (${definitionDeveloperName} version ${sourceFlowVersionNumber})`,
        reason
    ];

    if (detail) {
        details.push(detail);
    }

    const error = new Error(`${prefix} ${details.join(' — ')}`);
    error.code = FLOW_DESTINATION_VERSION_NOT_RETRIEVED;
    error.metadataType = 'Flow';
    error.metadataName = metadataName;
    error.flowDefinitionDeveloperName = definitionDeveloperName;
    error.sourceFlowVersionNumber = sourceFlowVersionNumber;

    return error;
}

async function retrieveExactVersionQualifiedFlowArtifact({
    workspacePath,
    alias,
    metadataName,
    accessToken,
    instanceUrl,
    execAsync,
    discoverFlowVersionsFn = discoverFlowVersions,
    retrieveSingleFlowVersionFn = retrieveSingleFlowVersion
}) {
    const parsed = parseVersionQualifiedFlowMember(metadataName);

    if (!parsed?.isVersionQualified) {
        throw new Error(
            `Exact Flow version artifact retrieval requires a version-qualified member name (Flow:${metadataName}).`
        );
    }

    let discovery;

    try {
        discovery = await discoverFlowVersionsFn({
            instanceUrl,
            accessToken
        });
    } catch (error) {
        logExactVersionRecoveryDiagnostic(
            buildExactVersionRecoveryDiagnostic({
                metadataName,
                parsed,
                exactVersion: null,
                retrieved: null,
                recoveryOutcome: 'FAILED_TOOLING_DISCOVERY'
            })
        );
        throw buildFlowExactVersionArtifactError(
            metadataName,
            parsed,
            'Flow version discovery via Tooling API failed',
            error.message || String(error)
        );
    }

    const exactVersion = findExactFlowVersion(
        discovery.versions,
        parsed.definitionDeveloperName,
        parsed.sourceVersionNumber
    );

    if (!exactVersion) {
        logExactVersionRecoveryDiagnostic(
            buildExactVersionRecoveryDiagnostic({
                metadataName,
                parsed,
                exactVersion: null,
                retrieved: null,
                recoveryOutcome: 'FAILED_VERSION_ABSENT'
            })
        );
        throw buildFlowExactVersionArtifactError(
            metadataName,
            parsed,
            'requested Flow version is not present on the destination'
        );
    }

    let retrieved;

    try {
        retrieved = await retrieveSingleFlowVersionFn({
            projectPath: workspacePath,
            alias,
            versionDescriptor: exactVersion,
            execAsync,
            requireVersionedFilenameCorrelation: true
        });
    } catch (error) {
        logExactVersionRecoveryDiagnostic(
            buildExactVersionRecoveryDiagnostic({
                metadataName,
                parsed,
                exactVersion,
                retrieved: {
                    retrievedArtifactPath: error.retrievedArtifactPath || null,
                    retrievedArtifactCorrelation:
                        error.retrievedArtifactCorrelation || null
                },
                recoveryOutcome: 'FAILED_RETRIEVE'
            })
        );
        throw buildFlowExactVersionArtifactError(
            metadataName,
            parsed,
            'version-aware Flow retrieve did not produce an exact version artifact',
            error.message || String(error)
        );
    }

    if (retrieved.retrievedArtifactCorrelation !== 'versioned_filename') {
        logExactVersionRecoveryDiagnostic(
            buildExactVersionRecoveryDiagnostic({
                metadataName,
                parsed,
                exactVersion,
                retrieved,
                recoveryOutcome: 'FAILED_AMBIGUOUS_CORRELATION'
            })
        );
        throw buildFlowExactVersionArtifactError(
            metadataName,
            parsed,
            'unversioned Flow filename correlation cannot establish exact version identity for rollback drift verification',
            `correlation=${retrieved.retrievedArtifactCorrelation || 'unknown'}`
        );
    }

    const canonicalRelative =
        retrieved.workspaceArtifactPath ||
        buildCanonicalFlowArtifactRelativePath(metadataName);

    if (!canonicalRelative) {
        throw buildFlowExactVersionArtifactError(
            metadataName,
            parsed,
            'version-aware Flow retrieve did not report a canonical artifact path'
        );
    }

    const absolutePath = path.join(
        workspacePath,
        ...canonicalRelative.split('/')
    );
    let sourceBytes;

    try {
        sourceBytes = await readFile(absolutePath);
    } catch (error) {
        throw buildFlowExactVersionArtifactError(
            metadataName,
            parsed,
            'version-aware Flow retrieve artifact is missing on disk',
            error.message || String(error)
        );
    }

    const snapshotPackFiles = applyCanonicalFlowSnapshotPackPaths(
        [{ relativePath: canonicalRelative, bytes: sourceBytes }],
        metadataName
    );

    const artifactBytes = packMemberFiles(snapshotPackFiles);

    logExactVersionRecoveryDiagnostic(
        buildExactVersionRecoveryDiagnostic({
            metadataName,
            parsed,
            exactVersion,
            retrieved,
            recoveryOutcome: 'SUCCEEDED'
        })
    );

    return {
        artifactBytes,
        exactVersionRecovery: buildExactVersionRecoveryDiagnostic({
            metadataName,
            parsed,
            exactVersion,
            retrieved,
            recoveryOutcome: 'SUCCEEDED'
        })
    };
}

function buildZeroFilesError(metadataType, metadataName, diagnostic) {
    if (metadataType === 'Flow') {
        const parsed = parseVersionQualifiedFlowMember(metadataName);

        if (
            parsed?.isVersionQualified &&
            cliIndicatesMetadataMemberNotFound(
                metadataType,
                metadataName,
                diagnostic.cliFailureMessages
            )
        ) {
            return buildFlowVersionZeroFilesError(
                metadataName,
                diagnostic,
                parsed
            );
        }
    }

    const prefix = `Destination snapshot capture failed for ${metadataType}:${metadataName}:`;
    const details = [
        'retrieve completed but zero files were collected from workspace',
        `retrieved file count = 0`
    ];

    if (diagnostic.cliStatus != null) {
        details.push(`CLI status ${diagnostic.cliStatus}`);
    }

    if (diagnostic.workspaceTopLevel?.length) {
        details.push(
            `workspace entries: ${diagnostic.workspaceTopLevel.join(', ')}`
        );
    } else {
        details.push('workspace entries: (empty)');
    }

    if (diagnostic.cliFailureMessages?.length) {
        details.push(
            `CLI failures: ${diagnostic.cliFailureMessages.join('; ')}`
        );
    }

    if (diagnostic.expectedSourcePaths) {
        const expectedSummary = Object.entries(diagnostic.expectedSourcePaths)
            .map(
                ([key, value]) =>
                    `${key}=${value.exists ? 'found' : 'missing'} (${value.relativePath})`
            )
            .join(', ');
        details.push(`expected source paths: ${expectedSummary}`);
    }

    return new Error(`${prefix} ${details.join(' — ')}`);
}

async function collectProjectFiles(rootPath, currentPath = rootPath, acc = []) {
    if (!(await pathExists(currentPath))) {
        return acc;
    }

    const entries = await readdir(currentPath, { withFileTypes: true });

    for (const entry of entries) {
        const absolutePath = path.join(currentPath, entry.name);

        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) {
                continue;
            }

            await collectProjectFiles(rootPath, absolutePath, acc);
            continue;
        }

        if (SKIP_FILE_NAMES.has(entry.name)) {
            continue;
        }

        const relativePath = path
            .relative(rootPath, absolutePath)
            .replace(/\\/g, '/');
        const bytes = await readFile(absolutePath);

        acc.push({ relativePath, bytes });
    }

    return acc;
}

async function logoutAlias(alias, execAsync) {
    if (!alias) {
        return;
    }

    try {
        await execAsync(
            `sf org logout --target-org ${shellQuote(alias)} --noprompt`
        );
    } catch (error) {
        console.warn(
            'Destination snapshot retrieve logout failed:',
            error.message || error
        );
    }
}

async function deleteWorkspace(workspacePath, rmFn) {
    if (!workspacePath) {
        return;
    }

    try {
        if (await pathExists(workspacePath)) {
            await rmFn(workspacePath, { recursive: true, force: true });
        }
    } catch (error) {
        console.warn(
            'Destination snapshot retrieve workspace cleanup failed:',
            error.message || error
        );
    }
}

function buildRetrieveCommand({
    projectPath,
    alias,
    metadataType,
    metadataName
}) {
    const member = `${metadataType}:${metadataName}`;

    return (
        `cd ${shellQuote(projectPath)} && ` +
        `sf project retrieve start ` +
        `--target-org ${shellQuote(alias)} ` +
        `-m ${shellQuote(member)} ` +
        `--json`
    );
}

function createDestinationMetadataRetriever(dependencies = {}) {
    const execAsync = dependencies.execAsync || defaultExecAsync;
    const refreshTokenFn = dependencies.refreshAccessToken || refreshAccessToken;
    const loginFn = dependencies.loginSfOrg || loginSfOrg;
    const ensureProjectFn = dependencies.ensureSfdxProject || ensureSfdxProject;
    const mkdirFn = dependencies.mkdir || mkdir;
    const rmFn = dependencies.rm || rm;
    const tmpdirFn = dependencies.tmpdir || os.tmpdir;
    const discoverFlowVersionsFn =
        dependencies.discoverFlowVersions || discoverFlowVersions;
    const retrieveSingleFlowVersionFn =
        dependencies.retrieveSingleFlowVersion || retrieveSingleFlowVersion;

    async function retrieveDestinationMember({
        refreshToken,
        instanceUrl,
        metadataType,
        metadataName,
        sourceApiVersion,
        artifactDiagnosticContext,
        requireExactVersionQualifiedFlowArtifact = false
    }) {
        if (!refreshToken || !instanceUrl) {
            throw new Error(
                `Destination snapshot capture failed for ${metadataType}:${metadataName}: ` +
                    'missing destination org credentials.'
            );
        }

        if (!metadataType || !metadataName) {
            throw new Error(
                'Destination snapshot capture failed: metadata identity is required.'
            );
        }

        const workspacePath = path.join(
            tmpdirFn(),
            `dest-snapshot-${crypto.randomUUID()}`
        );
        const alias = `dest-snapshot-${Date.now()}`;
        let retrievedFiles = [];

        try {
            logSection('Destination Snapshot Retrieve Started');
            console.log(`Member: ${metadataType}:${metadataName}`);

            await mkdirFn(workspacePath, { recursive: true });

            const bootstrap = await ensureProjectFn(workspacePath, {
                sourceApiVersion
            });

            if (!bootstrap?.success) {
                throw new Error(
                    `Destination snapshot capture failed for ${metadataType}:${metadataName}: ` +
                        'unable to create isolated retrieve project.'
                );
            }

            const tokenResult = await refreshTokenFn(refreshToken);
            await loginFn(
                tokenResult.accessToken,
                tokenResult.instanceUrl || instanceUrl,
                alias
            );

            const command = buildRetrieveCommand({
                projectPath: workspacePath,
                alias,
                metadataType,
                metadataName
            });

            let cliStdout = '';
            let cliStderr = '';
            let exitCode = 0;
            let cliSummary = summarizeRetrieveCliOutput('');

            try {
                const commandResult = await execAsync(command, {
                    maxBuffer: 50 * 1024 * 1024
                });

                cliStdout = commandResult.stdout || '';
                cliStderr = commandResult.stderr || '';
                exitCode = 0;
                cliSummary = summarizeRetrieveCliOutput(cliStdout);
            } catch (error) {
                exitCode = typeof error.code === 'number' ? error.code : 1;
                cliStdout = error.stdout || '';
                cliStderr = error.stderr || error.message || '';
                cliSummary = summarizeRetrieveCliOutput(cliStdout);

                const diagnostic = buildRetrieveDiagnosticRecord({
                    metadataType,
                    metadataName,
                    alias,
                    workspacePath,
                    retrieveCommand: command,
                    sourceApiVersion:
                        bootstrap?.sourceApiVersion || sourceApiVersion || null,
                    exitCode,
                    stdout: cliStdout,
                    stderr: cliStderr,
                    summary: cliSummary,
                    retrievedFiles: [],
                    workspaceTopLevel: await listWorkspaceTopLevel(workspacePath),
                    expectedPathChecks: await buildExpectedPathChecks({
                        workspacePath,
                        metadataType,
                        metadataName,
                        retrievedFiles: []
                    })
                });

                logDestinationRetrieveDiagnostic(diagnostic);
                throw buildExecFailureError(
                    metadataType,
                    metadataName,
                    diagnostic
                );
            }

            retrievedFiles = await collectProjectFiles(workspacePath);

            const diagnostic = buildRetrieveDiagnosticRecord({
                metadataType,
                metadataName,
                alias,
                workspacePath,
                retrieveCommand: command,
                sourceApiVersion:
                    bootstrap?.sourceApiVersion || sourceApiVersion || null,
                exitCode,
                stdout: cliStdout,
                stderr: cliStderr,
                summary: cliSummary,
                retrievedFiles,
                workspaceTopLevel: await listWorkspaceTopLevel(workspacePath),
                expectedPathChecks: await buildExpectedPathChecks({
                    workspacePath,
                    metadataType,
                    metadataName,
                    retrievedFiles
                })
            });

            logDestinationRetrieveDiagnostic(diagnostic);

            if (!retrievedFiles.length) {
                throw buildZeroFilesError(
                    metadataType,
                    metadataName,
                    diagnostic
                );
            }

            const selectionOptions =
                requireExactVersionQualifiedFlowArtifact === true
                    ? { requireExactVersionQualifiedFlowArtifact: true }
                    : {};

            let logicalMemberFiles;
            let artifactBytes;
            let exactVersionRecovery = null;

            try {
                logicalMemberFiles = selectLogicalMemberFiles(
                    retrievedFiles,
                    metadataType,
                    metadataName,
                    selectionOptions
                );

                const snapshotPackFiles =
                    metadataType === 'Flow'
                        ? applyCanonicalFlowSnapshotPackPaths(
                              logicalMemberFiles,
                              metadataName
                          )
                        : logicalMemberFiles;
                artifactBytes = packMemberFiles(snapshotPackFiles);
            } catch (selectionError) {
                if (
                    metadataType === 'Flow' &&
                    requireExactVersionQualifiedFlowArtifact === true
                ) {
                    const recoveryResult =
                        await retrieveExactVersionQualifiedFlowArtifact({
                            workspacePath,
                            alias,
                            metadataName,
                            accessToken: tokenResult.accessToken,
                            instanceUrl:
                                tokenResult.instanceUrl || instanceUrl,
                            execAsync,
                            discoverFlowVersionsFn,
                            retrieveSingleFlowVersionFn
                        });
                    artifactBytes = recoveryResult.artifactBytes;
                    exactVersionRecovery =
                        recoveryResult.exactVersionRecovery || null;
                    logicalMemberFiles = [];
                } else {
                    throw selectionError;
                }
            }

            if (artifactDiagnosticContext) {
                const artifactDiagnostic = buildRollbackDestinationArtifactDiagnostic(
                    {
                        metadataType,
                        metadataName,
                        workspacePath,
                        retrievedFiles,
                        logicalMemberFiles,
                        artifactBytes,
                        artifactDiagnosticContext,
                        requestedSourceApiVersion: sourceApiVersion ?? null,
                        effectiveSourceApiVersion:
                            bootstrap?.sourceApiVersion ?? null,
                        exactVersionRecovery
                    }
                );
                logRollbackDestinationArtifactDiagnostic(artifactDiagnostic);
            }

            return {
                files: retrievedFiles,
                artifactBytes
            };
        } finally {
            await logoutAlias(alias, execAsync);
            await deleteWorkspace(workspacePath, rmFn);
            logSection('Destination Snapshot Retrieve Cleanup Complete');
        }
    }

    return {
        retrieveDestinationMember,
        buildRetrieveCommand,
        collectProjectFiles,
        deleteWorkspace
    };
}

const defaultRetriever = createDestinationMetadataRetriever();

module.exports = {
    createDestinationMetadataRetriever,
    retrieveDestinationMember: defaultRetriever.retrieveDestinationMember,
    buildRetrieveCommand: defaultRetriever.buildRetrieveCommand,
    buildExpectedMemberSourcePaths,
    selectLogicalMemberFiles,
    retrieveExactVersionQualifiedFlowArtifact,
    buildExactVersionRecoveryDiagnostic,
    logExactVersionRecoveryDiagnostic,
    summarizeRetrieveCliOutput,
    redactDiagnosticText,
    buildRetrieveDiagnosticRecord,
    logDestinationRetrieveDiagnostic,
    buildRollbackDestinationArtifactDiagnostic,
    logRollbackDestinationArtifactDiagnostic,
    buildZeroFilesError,
    FLOW_DESTINATION_VERSION_NOT_RETRIEVED
};
