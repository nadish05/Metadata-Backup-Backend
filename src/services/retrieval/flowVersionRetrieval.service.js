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
    FLOWS_DIR_PREFIX,
    buildCanonicalFlowArtifactRelativePath
} = require('../flowMetadata/flowMemberIdentity.service');

const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);
const stat = util.promisify(fs.stat);

const FLOW_VERSION_MANIFEST_DIR = '.metadata-backup';
const FLOW_VERSION_MANIFEST_FILE = 'flow-version-artifacts.json';

function hashBytes(buffer) {
    return crypto.createHash('sha256').update(buffer).digest('hex');
}

function flowsDirectory(projectPath) {
    return path.join(projectPath, 'force-app', 'main', 'default', 'flows');
}

async function listFlowFiles(projectPath) {
    const directory = flowsDirectory(projectPath);

    try {
        const entries = await readdir(directory);
        const files = new Map();

        for (const entry of entries) {
            if (!entry.endsWith(FLOW_META_SUFFIX)) {
                continue;
            }

            const absolute = path.join(directory, entry);
            const fileStat = await stat(absolute);

            if (!fileStat.isFile()) {
                continue;
            }

            const bytes = await readFile(absolute);
            files.set(entry, {
                relativePath: `${FLOWS_DIR_PREFIX}${entry}`,
                bytes,
                sha256: hashBytes(bytes)
            });
        }

        return files;
    } catch (error) {
        if (error.code === 'ENOENT') {
            return new Map();
        }

        throw error;
    }
}

function diffFlowSnapshots(before, after) {
    const changed = [];

    for (const [name, afterEntry] of after.entries()) {
        const beforeEntry = before.get(name);

        if (!beforeEntry || beforeEntry.sha256 !== afterEntry.sha256) {
            changed.push({
                fileName: name,
                ...afterEntry
            });
        }
    }

    for (const name of before.keys()) {
        if (!after.has(name)) {
            changed.push({
                fileName: name,
                removed: true
            });
        }
    }

    return changed;
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

function correlateRetrieveResult({
    developerName,
    versionNumber,
    changedFiles,
    beforeSnapshot,
    flowIsLatestVersion = false
}) {
    const materialChanges = changedFiles.filter((file) => !file.removed);

    if (materialChanges.length > 1) {
        return null;
    }

    const versionedBase = expectedVersionedBasename(developerName, versionNumber);
    const unversionedBase = expectedUnversionedBasename(developerName);

    const versionedChange = materialChanges.find(
        (file) => file.fileName === versionedBase
    );
    const unversionedChange = materialChanges.find(
        (file) => file.fileName === unversionedBase
    );

    if (versionedChange) {
        return {
            sourceBytes: versionedChange.bytes,
            retrievedRelativePath: versionedChange.relativePath,
            correlation: 'versioned_filename'
        };
    }

    // Salesforce may return the unversioned filename for the latest version only.
    if (
        unversionedChange &&
        materialChanges.length === 1 &&
        flowIsLatestVersion === true
    ) {
        return {
            sourceBytes: unversionedChange.bytes,
            retrievedRelativePath: unversionedChange.relativePath,
            correlation: 'unversioned_filename'
        };
    }

    return null;
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

async function retrieveSingleFlowVersion({
    projectPath,
    alias,
    versionDescriptor,
    execAsync
}) {
    const {
        flowDefinitionDeveloperName,
        sourceFlowVersionNumber,
        requestedMetadataMember
    } = versionDescriptor;

    const beforeSnapshot = await listFlowFiles(projectPath);
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

    const afterSnapshot = await listFlowFiles(projectPath);
    const changedFiles = diffFlowSnapshots(beforeSnapshot, afterSnapshot);
    const correlation = correlateRetrieveResult({
        developerName: flowDefinitionDeveloperName,
        versionNumber: sourceFlowVersionNumber,
        changedFiles,
        beforeSnapshot,
        flowIsLatestVersion: versionDescriptor.flowIsLatestVersion === true
    });

    if (!correlation?.sourceBytes) {
        const failure = new Error(
            `Unable to correlate retrieved artifact for ${member}. ` +
                `Changed flow files: ${changedFiles.map((f) => f.fileName).join(', ') || '(none)'}`
        );
        failure.member = member;
        failure.versionDescriptor = versionDescriptor;
        throw failure;
    }

    const persisted = await persistVersionArtifact({
        projectPath,
        developerName: flowDefinitionDeveloperName,
        versionNumber: sourceFlowVersionNumber,
        sourceBytes: correlation.sourceBytes
    });

    return {
        ...versionDescriptor,
        requestedMetadataMember: member,
        retrievedArtifactPath: correlation.retrievedRelativePath,
        retrievedArtifactCorrelation: correlation.correlation,
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
    listFlowFiles,
    diffFlowSnapshots,
    correlateRetrieveResult,
    persistVersionArtifact,
    retrieveSingleFlowVersion,
    runFlowVersionRetrievalExtension,
    writeFlowVersionManifest
};
