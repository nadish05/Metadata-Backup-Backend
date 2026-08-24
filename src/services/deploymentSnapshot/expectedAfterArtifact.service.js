'use strict';

const fs = require('fs');
const path = require('path');
const util = require('util');

const {
    isBundleMetadataType,
    getMetadataTypeRule
} = require('../../config/metadataTypes');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');

const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);
const stat = util.promisify(fs.stat);

const SKIP_DIR_NAMES = new Set(['.sf', '.sfdx', '.git', 'node_modules']);

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch (error) {
        return false;
    }
}

function toPosix(relativePath) {
    return String(relativePath || '').replace(/\\/g, '/');
}

function buildMissingExpectedAfterReason(metadataType, metadataName, detail) {
    return (
        `Destination snapshot capture failed for ${metadataType}:${metadataName}: ` +
        (detail || 'expected-after workspace artifact is missing.')
    );
}

async function collectDirectoryFiles(workspacePath, directoryRelative, acc = []) {
    const absoluteDirectory = path.join(workspacePath, directoryRelative);
    const entries = await readdir(absoluteDirectory, { withFileTypes: true });

    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIR_NAMES.has(entry.name)) {
                continue;
            }

            await collectDirectoryFiles(
                workspacePath,
                path.join(directoryRelative, entry.name),
                acc
            );
            continue;
        }

        const relativePath = toPosix(path.join(directoryRelative, entry.name));
        const bytes = await readFile(
            path.join(workspacePath, ...relativePath.split('/'))
        );
        acc.push({ relativePath, bytes });
    }

    return acc;
}

async function collectWorkspaceMemberFiles(workspacePath, member) {
    const metadataType = member?.metadataType;
    const metadataName = member?.metadataName;
    const relativeFilePath = toPosix(member?.filePath);

    if (!workspacePath) {
        throw new Error(
            buildMissingExpectedAfterReason(
                metadataType,
                metadataName,
                'final deployment workspace is not available.'
            )
        );
    }

    if (!relativeFilePath) {
        throw new Error(
            buildMissingExpectedAfterReason(
                metadataType,
                metadataName,
                'final deployment member has no workspace filePath.'
            )
        );
    }

    const absolutePath = path.join(workspacePath, relativeFilePath);

    if (!(await pathExists(absolutePath))) {
        throw new Error(
            buildMissingExpectedAfterReason(metadataType, metadataName)
        );
    }

    const fileStat = await stat(absolutePath);
    const files = [];

    if (fileStat.isDirectory() || isBundleMetadataType(metadataType)) {
        const collected = await collectDirectoryFiles(
            workspacePath,
            relativeFilePath
        );

        if (!collected.length) {
            throw new Error(
                buildMissingExpectedAfterReason(metadataType, metadataName)
            );
        }

        return collected;
    }

    files.push({
        relativePath: relativeFilePath,
        bytes: await readFile(absolutePath)
    });

    const rule = getMetadataTypeRule(metadataType);

    if (rule?.requiresMetaXml) {
        const companionRelative = `${relativeFilePath}-meta.xml`;
        const companionAbsolute = path.join(workspacePath, companionRelative);

        if (await pathExists(companionAbsolute)) {
            files.push({
                relativePath: companionRelative,
                bytes: await readFile(companionAbsolute)
            });
        }
    }

    return files;
}

async function collectExpectedAfterArtifact({ workspacePath, member } = {}) {
    const files = await collectWorkspaceMemberFiles(workspacePath, member);
    const artifactBytes = packMemberFiles(files);

    return {
        files,
        artifactBytes,
        expectedAfterHash: hashBytes(artifactBytes)
    };
}

module.exports = {
    collectExpectedAfterArtifact,
    collectWorkspaceMemberFiles,
    buildMissingExpectedAfterReason
};
