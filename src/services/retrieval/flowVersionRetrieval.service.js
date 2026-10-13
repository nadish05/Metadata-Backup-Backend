'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');

const {
    discoverFlowVersions
} = require('./flowVersionDiscovery.service');
const {
    FLOW_META_SUFFIX,
    buildCanonicalFlowArtifactRelativePath
} = require('../flowMetadata/flowMemberIdentity.service');

const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);
const stat = util.promisify(fs.stat);

const FLOW_VERSION_MANIFEST_DIR = '.metadata-backup';
const FLOW_VERSION_MANIFEST_FILE = 'flow-version-artifacts.json';

function hashBytes(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function buildRetrieveMember(developerName, versionNumber) {
    return `Flow:${developerName}-${versionNumber}`;
}

function expectedVersionedBasename(developerName, versionNumber) {
    return `${developerName}-${versionNumber}${FLOW_META_SUFFIX}`;
}

function expectedUnversionedBasename(developerName) {
    return `${developerName}${FLOW_META_SUFFIX}`;
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

function normalizeRetrieveRelativePath(fileEntry) {
    if (typeof fileEntry === 'string') {
        return String(fileEntry).replace(/\\/g, '/');
    }

    if (!fileEntry || typeof fileEntry !== 'object') {
        return null;
    }

    const candidate =
        fileEntry.filePath || fileEntry.path || fileEntry.fullPath || null;

    if (!candidate) {
        return null;
    }

    return String(candidate).replace(/\\/g, '/');
}

function basenameFromRelativePath(relativePath) {
    const normalized = String(relativePath || '').replace(/\\/g, '/');

    return normalized.split('/').pop() || null;
}

function parseRetrieveCliStdout(stdout) {
    const payload = extractJsonPayload(stdout);

    if (!payload) {
        return {
            ok: false,
            reason: 'invalid_json'
        };
    }

    if (typeof payload.status === 'number' && payload.status !== 0) {
        return {
            ok: false,
            reason: 'cli_status',
            status: payload.status,
            message: payload.message || null
        };
    }

    const result =
        payload.result && typeof payload.result === 'object'
            ? payload.result
            : payload;
    const files = result.files || result.fileProperties || [];

    return {
        ok: true,
        files: Array.isArray(files) ? files : []
    };
}

/**
 * Pick the CLI-reported path for this retrieve. Only accepts filenames that
 * match the requested version (or unversioned for latest only).
 */
function resolveRetrievedFlowPath({
    retrievedFiles,
    developerName,
    versionNumber,
    flowIsLatestVersion
}) {
    const versionedBasename = expectedVersionedBasename(
        developerName,
        versionNumber
    );
    const unversionedBasename = expectedUnversionedBasename(developerName);
    const paths = [];

    for (const entry of retrievedFiles) {
        const relativePath = normalizeRetrieveRelativePath(entry);

        if (!relativePath) {
            continue;
        }

        paths.push(relativePath);
    }

    const versionedPath = paths.find(
        (relativePath) =>
            basenameFromRelativePath(relativePath) === versionedBasename
    );

    if (versionedPath) {
        return {
            relativePath: versionedPath,
            correlation: 'versioned_filename'
        };
    }

    if (flowIsLatestVersion === true) {
        const unversionedPath = paths.find(
            (relativePath) =>
                basenameFromRelativePath(relativePath) === unversionedBasename
        );

        if (unversionedPath) {
            return {
                relativePath: unversionedPath,
                correlation: 'unversioned_filename'
            };
        }
    }

    return null;
}

function resolveReportedPathWithinProject(projectPath, reportedPath) {
    if (!projectPath || !reportedPath) {
        return null;
    }

    const projectRoot = path.resolve(projectPath);
    const absolute = path.isAbsolute(reportedPath)
        ? path.resolve(reportedPath)
        : path.resolve(projectRoot, reportedPath);

    const relativeToProject = path.relative(projectRoot, absolute);

    if (
        !relativeToProject ||
        relativeToProject.startsWith('..') ||
        path.isAbsolute(relativeToProject)
    ) {
        return null;
    }

    return absolute;
}

async function readProjectFile(projectPath, reportedPath) {
    const absolute = resolveReportedPathWithinProject(
        projectPath,
        reportedPath
    );

    if (!absolute) {
        return null;
    }

    try {
        const fileStat = await stat(absolute);

        if (!fileStat.isFile()) {
            return null;
        }

        return await readFile(absolute);
    } catch (error) {
        if (error.code === 'ENOENT') {
            return null;
        }

        throw error;
    }
}

async function persistVersionArtifact({
    projectPath,
    developerName,
    versionNumber,
    sourceBytes
}) {
    const canonicalRelative = buildCanonicalFlowArtifactRelativePath(
        `${developerName}-${versionNumber}`
    );
    const absolute = path.join(projectPath, ...canonicalRelative.split('/'));

    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, sourceBytes);

    return {
        workspaceArtifactPath: canonicalRelative,
        artifactSha256: hashBytes(sourceBytes)
    };
}

function buildRetrieveSuccessJson(relativePath) {
    return JSON.stringify({
        status: 0,
        result: {
            files: [{ filePath: relativePath, state: 'Changed' }]
        }
    });
}

async function retrieveSingleFlowVersion({
    projectPath,
    alias,
    versionDescriptor,
    execAsync
}) {
    const {
        flowDefinitionDeveloperName,
        sourceFlowVersionNumber
    } = versionDescriptor;

    const member = buildRetrieveMember(
        flowDefinitionDeveloperName,
        sourceFlowVersionNumber
    );
    const command =
        `cd ${projectPath} && ` +
        `sf project retrieve start -o ${alias} -m "${member}" --json`;

    let stdout = '';

    try {
        const result = await execAsync(command, {
            maxBuffer: 50 * 1024 * 1024
        });
        stdout = result.stdout || '';
    } catch (error) {
        const failure = new Error(
            `Flow version retrieve failed for ${member}: ` +
                (error.stderr || error.message || String(error))
        );
        failure.member = member;
        failure.versionDescriptor = versionDescriptor;
        throw failure;
    }

    const parsed = parseRetrieveCliStdout(stdout);

    if (!parsed.ok) {
        const failure = new Error(
            `Flow version retrieve CLI result invalid for ${member}: ` +
                (parsed.message || parsed.reason || 'unknown')
        );
        failure.member = member;
        failure.versionDescriptor = versionDescriptor;
        throw failure;
    }

    const resolved = resolveRetrievedFlowPath({
        retrievedFiles: parsed.files,
        developerName: flowDefinitionDeveloperName,
        versionNumber: sourceFlowVersionNumber,
        flowIsLatestVersion: versionDescriptor.flowIsLatestVersion === true
    });

    if (!resolved) {
        const failure = new Error(
            `Retrieve for ${member} did not report an acceptable flow file. ` +
                'Expected a version-qualified filename' +
                (versionDescriptor.flowIsLatestVersion
                    ? ' or unversioned filename for the latest version.'
                    : '.')
        );
        failure.member = member;
        failure.versionDescriptor = versionDescriptor;
        throw failure;
    }

    const sourceBytes = await readProjectFile(
        projectPath,
        resolved.relativePath
    );

    if (!sourceBytes) {
        const failure = new Error(
            `Retrieve for ${member} reported ${resolved.relativePath} but the file is missing on disk.`
        );
        failure.member = member;
        failure.versionDescriptor = versionDescriptor;
        throw failure;
    }

    const persisted = await persistVersionArtifact({
        projectPath,
        developerName: flowDefinitionDeveloperName,
        versionNumber: sourceFlowVersionNumber,
        sourceBytes
    });

    return {
        ...versionDescriptor,
        requestedMetadataMember: member,
        retrievedArtifactPath: resolved.relativePath,
        retrievedArtifactCorrelation: resolved.correlation,
        workspaceArtifactPath: persisted.workspaceArtifactPath,
        artifactSha256: persisted.artifactSha256
    };
}

async function writeFlowVersionManifest(projectPath, payload) {
    const directory = path.join(projectPath, FLOW_VERSION_MANIFEST_DIR);
    await mkdir(directory, { recursive: true });
    const manifestPath = path.join(directory, FLOW_VERSION_MANIFEST_FILE);

    await writeFile(
        manifestPath,
        `${JSON.stringify(payload, null, 2)}\n`,
        'utf8'
    );

    return manifestPath;
}

async function runFlowVersionRetrievalExtension({
    projectPath,
    instanceUrl,
    accessToken,
    alias,
    execAsync,
    discoverFlowVersionsFn = discoverFlowVersions
} = {}) {
    if (!projectPath || !instanceUrl || !accessToken || !alias || !execAsync) {
        throw new Error(
            'Flow version retrieval extension requires projectPath, credentials, alias, and execAsync.'
        );
    }

    const discovery = await discoverFlowVersionsFn({
        instanceUrl,
        accessToken
    });

    const artifacts = [];
    const failures = [];

    for (const versionDescriptor of discovery.versions) {
        try {
            const artifact = await retrieveSingleFlowVersion({
                projectPath,
                alias,
                versionDescriptor,
                execAsync
            });
            artifacts.push(artifact);
        } catch (error) {
            failures.push({
                requestedMetadataMember:
                    error.member ||
                    versionDescriptor.requestedMetadataMember ||
                    null,
                flowDefinitionDeveloperName:
                    versionDescriptor.flowDefinitionDeveloperName,
                sourceFlowVersionNumber:
                    versionDescriptor.sourceFlowVersionNumber,
                message: error.message || String(error)
            });
        }
    }

    const manifest = {
        manifestVersion: 1,
        retrievedAt: new Date().toISOString(),
        toolingApiVersion: discovery.apiVersion,
        artifactCount: artifacts.length,
        failureCount: failures.length,
        artifacts,
        failures
    };

    await writeFlowVersionManifest(projectPath, manifest);

    if (failures.length > 0) {
        const error = new Error(
            `Flow version retrieval completed with ${failures.length} failure(s). ` +
                failures.map((f) => f.requestedMetadataMember).join(', ')
        );
        error.code = 'FLOW_VERSION_RETRIEVAL_PARTIAL_FAILURE';
        error.failures = failures;
        error.artifacts = artifacts;
        throw error;
    }

    return manifest;
}

module.exports = {
    FLOW_VERSION_MANIFEST_DIR,
    FLOW_VERSION_MANIFEST_FILE,
    hashBytes,
    buildRetrieveMember,
    expectedVersionedBasename,
    expectedUnversionedBasename,
    parseRetrieveCliStdout,
    resolveRetrievedFlowPath,
    resolveReportedPathWithinProject,
    readProjectFile,
    persistVersionArtifact,
    retrieveSingleFlowVersion,
    runFlowVersionRetrievalExtension,
    writeFlowVersionManifest,
    buildRetrieveSuccessJson
};
