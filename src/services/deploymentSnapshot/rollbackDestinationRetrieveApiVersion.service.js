'use strict';

const { DEFAULT_API_VERSION } = require('../../config/salesforce');
const {
    minApiVersion,
    normalizeApiVersion
} = require('../deploymentApiNegotiation.service');
const { getLatestApiVersion } = require('../destinationInventory/destinationInventoryBuilder.service');
const {
    createRepositoryFileReader
} = require('../deploymentWorkspace.service');
const {
    readRepositorySnapshotMetadata
} = require('../repositorySnapshotMetadata.service');

const RETRIEVE_API_VERSION_SOURCE = Object.freeze({
    SNAPSHOT: 'SNAPSHOT',
    REPOSITORY_RETRIEVAL_METADATA: 'REPOSITORY_RETRIEVAL_METADATA',
    DEPLOYMENT_HISTORY: 'DEPLOYMENT_HISTORY',
    DEFAULT_FALLBACK: 'DEFAULT_FALLBACK'
});

function effectiveRetrieveApiVersionWithCap(version, destinationMax) {
    if (!version) {
        return null;
    }

    return destinationMax ? minApiVersion(version, destinationMax) : version;
}

function buildResolution({
    snapshotSourceMetadataApiVersion = null,
    repositorySourceMetadataApiVersion = null,
    deploymentApiVersion = null,
    destinationMaxApiVersion = null,
    effectiveRetrieveApiVersion = null,
    retrieveApiVersionSelection = null,
    sourceMetadataApiVersionSource = null
} = {}) {
    return {
        snapshotSourceMetadataApiVersion,
        repositorySourceMetadataApiVersion,
        deploymentApiVersion,
        destinationMaxApiVersion,
        effectiveRetrieveApiVersion,
        retrieveApiVersionSelection,
        sourceMetadataApiVersionSource,
        defaultApiVersion: DEFAULT_API_VERSION
    };
}

function resolveRollbackDestinationRetrieveSourceApiVersion({
    snapshotSourceMetadataApiVersion = null,
    repositorySourceMetadataApiVersion = null,
    deploymentApiVersion = null,
    destinationMaxApiVersion = null
} = {}) {
    const stored = normalizeApiVersion(snapshotSourceMetadataApiVersion);
    const repository = normalizeApiVersion(repositorySourceMetadataApiVersion);
    const deployment = normalizeApiVersion(deploymentApiVersion);
    const destinationMax = normalizeApiVersion(destinationMaxApiVersion);

    if (stored) {
        return buildResolution({
            snapshotSourceMetadataApiVersion: stored,
            repositorySourceMetadataApiVersion: repository || null,
            deploymentApiVersion: deployment,
            destinationMaxApiVersion: destinationMax,
            effectiveRetrieveApiVersion: effectiveRetrieveApiVersionWithCap(
                stored,
                destinationMax
            ),
            retrieveApiVersionSelection: 'SNAPSHOT_SOURCE_METADATA',
            sourceMetadataApiVersionSource: RETRIEVE_API_VERSION_SOURCE.SNAPSHOT
        });
    }

    if (repository) {
        return buildResolution({
            snapshotSourceMetadataApiVersion: null,
            repositorySourceMetadataApiVersion: repository,
            deploymentApiVersion: deployment,
            destinationMaxApiVersion: destinationMax,
            effectiveRetrieveApiVersion: effectiveRetrieveApiVersionWithCap(
                repository,
                destinationMax
            ),
            retrieveApiVersionSelection:
                RETRIEVE_API_VERSION_SOURCE.REPOSITORY_RETRIEVAL_METADATA,
            sourceMetadataApiVersionSource:
                RETRIEVE_API_VERSION_SOURCE.REPOSITORY_RETRIEVAL_METADATA
        });
    }

    if (deployment) {
        return buildResolution({
            snapshotSourceMetadataApiVersion: null,
            repositorySourceMetadataApiVersion: null,
            deploymentApiVersion: deployment,
            destinationMaxApiVersion: destinationMax,
            effectiveRetrieveApiVersion: deployment,
            retrieveApiVersionSelection: 'DEPLOYMENT_API_VERSION_FALLBACK',
            sourceMetadataApiVersionSource:
                RETRIEVE_API_VERSION_SOURCE.DEPLOYMENT_HISTORY
        });
    }

    return buildResolution({
        snapshotSourceMetadataApiVersion: null,
        repositorySourceMetadataApiVersion: null,
        deploymentApiVersion: null,
        destinationMaxApiVersion: destinationMax,
        effectiveRetrieveApiVersion: null,
        retrieveApiVersionSelection: 'DEFAULT_FALLBACK',
        sourceMetadataApiVersionSource: RETRIEVE_API_VERSION_SOURCE.DEFAULT_FALLBACK
    });
}

async function readRepositorySourceMetadataApiVersion({
    repoUrl = null,
    sourceBranch = null,
    createRepositoryFileReaderFn = createRepositoryFileReader,
    readRepositorySnapshotMetadataFn = readRepositorySnapshotMetadata
} = {}) {
    if (!repoUrl || !sourceBranch) {
        return null;
    }

    if (
        typeof createRepositoryFileReaderFn !== 'function' ||
        typeof readRepositorySnapshotMetadataFn !== 'function'
    ) {
        return null;
    }

    try {
        const readFile = await createRepositoryFileReaderFn(
            repoUrl,
            sourceBranch
        );
        const metadata = await readRepositorySnapshotMetadataFn({
            readFile
        });

        return metadata?.sourceMetadataApiVersion || null;
    } catch (error) {
        void error;
        return null;
    }
}

async function resolveRollbackDestinationRetrieveSourceApiVersionWithDestinationCap({
    snapshot = null,
    deploymentApiVersion = null,
    repoUrl = null,
    sourceBranch = null,
    refreshToken = null,
    instanceUrl = null,
    accessToken = null,
    getLatestApiVersionFn = getLatestApiVersion,
    refreshAccessTokenFn = null,
    createRepositoryFileReaderFn = createRepositoryFileReader,
    readRepositorySnapshotMetadataFn = readRepositorySnapshotMetadata
} = {}) {
    let destinationMaxApiVersion = null;

    if (typeof getLatestApiVersionFn === 'function') {
        let resolvedAccessToken = accessToken;
        let resolvedInstanceUrl = instanceUrl;

        if (!resolvedAccessToken && refreshToken && refreshAccessTokenFn) {
            try {
                const tokenResult = await refreshAccessTokenFn(refreshToken);
                resolvedAccessToken = tokenResult?.accessToken || null;
                resolvedInstanceUrl =
                    tokenResult?.instanceUrl || instanceUrl || null;
            } catch (error) {
                void error;
            }
        }

        if (resolvedAccessToken && resolvedInstanceUrl) {
            try {
                destinationMaxApiVersion = await getLatestApiVersionFn(
                    resolvedInstanceUrl,
                    resolvedAccessToken
                );
            } catch (error) {
                void error;
            }
        }
    }

    const snapshotStored = normalizeApiVersion(
        snapshot?.sourceMetadataApiVersion ?? null
    );
    let repositorySourceMetadataApiVersion = null;

    if (!snapshotStored) {
        repositorySourceMetadataApiVersion =
            await readRepositorySourceMetadataApiVersion({
                repoUrl,
                sourceBranch,
                createRepositoryFileReaderFn,
                readRepositorySnapshotMetadataFn
            });
    }

    return resolveRollbackDestinationRetrieveSourceApiVersion({
        snapshotSourceMetadataApiVersion:
            snapshot?.sourceMetadataApiVersion ?? null,
        repositorySourceMetadataApiVersion,
        deploymentApiVersion,
        destinationMaxApiVersion
    });
}

function logRollbackRetrieveApiVersionDiagnostic(payload) {
    console.log('ROLLBACK_API_VERSION_DIAGNOSTIC', JSON.stringify(payload));
}

module.exports = {
    RETRIEVE_API_VERSION_SOURCE,
    readRepositorySourceMetadataApiVersion,
    resolveRollbackDestinationRetrieveSourceApiVersion,
    resolveRollbackDestinationRetrieveSourceApiVersionWithDestinationCap,
    logRollbackRetrieveApiVersionDiagnostic
};
