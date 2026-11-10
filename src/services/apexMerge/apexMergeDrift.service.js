'use strict';

const { unpackMemberFiles } = require('../deploymentSnapshot/destinationMemberArtifact.service');
const {
    buildExpectedMemberSourcePaths
} = require('../deploymentSnapshot/destinationMetadataRetriever.service');
const { hashBytes } = require('../deploymentSnapshot/snapshotIntegrity.service');
const {
    showBlobAtRef,
    revParseOriginHead
} = require('./apexMergeGit.service');
const { defaultClassPath } = require('./apexMergePaths.util');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');

const {
    retrieveDestinationMember
} = require('../deploymentSnapshot/destinationMetadataRetriever.service');

function extractClsBytesFromPack(artifactBytes, metadataName) {
    const paths = buildExpectedMemberSourcePaths('ApexClass', metadataName);
    const expectedCls = paths.cls.replace(/\\/g, '/');
    const files = unpackMemberFiles(artifactBytes);

    const clsFile =
        files.find((file) => file.relativePath === expectedCls) ||
        files.find((file) => file.relativePath.endsWith(`/${metadataName}.cls`));

    if (!clsFile) {
        return null;
    }

    return clsFile.bytes;
}

function gitClsContentToBuffer(content) {
    return Buffer.from(String(content ?? ''), 'utf8');
}

/**
 * Compare pinned destination Git .cls content with live destination org retrieve.
 */
async function assertNoDestinationDrift({
    repoPath,
    destinationBranch,
    metadataName,
    filePath = null,
    refreshToken,
    instanceUrl,
    destinationHeadSha = null,
    retrieveMember = retrieveDestinationMember
} = {}) {
    if (!refreshToken || !instanceUrl) {
        throw new ApexMergeError(
            MERGE_ERROR.INVALID_REQUEST,
            'refreshToken and instanceUrl are required for destination drift checks.'
        );
    }

    const clsPath = filePath || defaultClassPath(metadataName);
    const headSha =
        destinationHeadSha ||
        (await revParseOriginHead(repoPath, destinationBranch));
    const gitBlob = await showBlobAtRef(repoPath, headSha, clsPath);

    if (!gitBlob.exists) {
        throw new ApexMergeError(
            MERGE_ERROR.MISSING_TARGET_FILE,
            `Destination Git branch is missing ${clsPath}.`
        );
    }

    const retrieved = await retrieveMember({
        refreshToken,
        instanceUrl,
        metadataType: 'ApexClass',
        metadataName
    });

    if (!retrieved?.artifactBytes?.length) {
        throw new ApexMergeError(
            MERGE_ERROR.DESTINATION_DRIFT_DETECTED,
            `Live destination org does not contain ApexClass ${metadataName}.`,
            { metadataName, reason: 'ORG_MISSING' }
        );
    }

    const orgClsBytes = extractClsBytesFromPack(
        retrieved.artifactBytes,
        metadataName
    );

    if (!orgClsBytes) {
        throw new ApexMergeError(
            MERGE_ERROR.DESTINATION_DRIFT_DETECTED,
            `Unable to read .cls bytes from destination org retrieve for ${metadataName}.`
        );
    }

    const gitClsBytes = gitClsContentToBuffer(gitBlob.content);
    const orgHash = hashBytes(orgClsBytes);
    const gitHash = hashBytes(gitClsBytes);

    if (orgHash !== gitHash) {
        throw new ApexMergeError(
            MERGE_ERROR.DESTINATION_DRIFT_DETECTED,
            'Destination Git branch content differs from live destination org.',
            {
                metadataName,
                orgHash,
                gitHash,
                destinationHeadSha: headSha
            }
        );
    }

    return {
        status: 'MATCH',
        orgHash,
        gitHash,
        destinationHeadSha: headSha
    };
}

module.exports = {
    assertNoDestinationDrift,
    extractClsBytesFromPack,
    gitClsContentToBuffer
};
