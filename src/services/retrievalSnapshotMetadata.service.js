const fs = require('fs');
const path = require('path');
const util = require('util');

const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);

const SNAPSHOT_DIRECTORY = '.metadata-backup';
const SNAPSHOT_FILENAME = 'retrieval-metadata.json';
const SNAPSHOT_RELATIVE_PATH = path.join(
    SNAPSHOT_DIRECTORY,
    SNAPSHOT_FILENAME
);

function buildRetrievalSnapshotMetadata({
    sourceOrgId = null,
    instanceUrl = null,
    sourceMetadataApiVersion = null,
    retrievedAt = null
} = {}) {
    void instanceUrl;

    return {
        snapshotVersion: 1,
        sourceOrgId: sourceOrgId || null,
        sourceMetadataApiVersion: sourceMetadataApiVersion || null,
        retrievedAt: retrievedAt || new Date().toISOString()
    };
}

async function writeRetrievalSnapshotMetadata(
    projectPath,
    snapshotMetadata
) {
    const snapshotDirectory = path.join(
        projectPath,
        SNAPSHOT_DIRECTORY
    );
    const snapshotPath = path.join(projectPath, SNAPSHOT_RELATIVE_PATH);

    await mkdir(snapshotDirectory, { recursive: true });
    await writeFile(
        snapshotPath,
        `${JSON.stringify(snapshotMetadata, null, 4)}\n`,
        'utf8'
    );

    return snapshotPath;
}

/**
 * Discovery and persistence are deliberately fail-safe: retrieval must
 * continue even when Salesforce API discovery or local snapshot writing fails.
 */
async function persistRetrievalSnapshotMetadata({
    projectPath,
    sourceOrgId = null,
    instanceUrl = null,
    accessToken = null,
    retrievedAt = null,
    getLatestApiVersionFn = null
} = {}) {
    let sourceMetadataApiVersion = null;

    try {
        if (
            instanceUrl &&
            accessToken &&
            typeof getLatestApiVersionFn === 'function'
        ) {
            sourceMetadataApiVersion = await getLatestApiVersionFn(
                instanceUrl,
                accessToken
            );
        }
    } catch (error) {
        sourceMetadataApiVersion = null;
    }

    const snapshotMetadata = buildRetrievalSnapshotMetadata({
        sourceOrgId,
        instanceUrl,
        sourceMetadataApiVersion,
        retrievedAt
    });

    try {
        const snapshotPath = await writeRetrievalSnapshotMetadata(
            projectPath,
            snapshotMetadata
        );

        return {
            snapshotMetadata,
            snapshotPath,
            written: true,
            error: null
        };
    } catch (error) {
        return {
            snapshotMetadata,
            snapshotPath: path.join(
                projectPath || '',
                SNAPSHOT_RELATIVE_PATH
            ),
            written: false,
            error
        };
    }
}

module.exports = {
    SNAPSHOT_DIRECTORY,
    SNAPSHOT_FILENAME,
    SNAPSHOT_RELATIVE_PATH,
    buildRetrievalSnapshotMetadata,
    writeRetrievalSnapshotMetadata,
    persistRetrievalSnapshotMetadata
};
