'use strict';

const axios = require('axios');

const { getLatestApiVersion } = require('../destinationInventory/destinationInventoryBuilder.service');
const {
    parseVersionQualifiedFlowMember
} = require('../flowMetadata/flowMemberIdentity.service');

const FLOW_CAPTURE_VERSION_OUTCOME = {
    NOT_VERSION_QUALIFIED: 'NOT_VERSION_QUALIFIED',
    VERSION_PRESENT: 'VERSION_PRESENT',
    VERSION_ABSENT: 'VERSION_ABSENT',
    DEFINITION_ABSENT: 'DEFINITION_ABSENT',
    TOOLING_FAILED: 'TOOLING_FAILED'
};

async function runToolingQuery(instanceUrl, accessToken, apiVersion, soql) {
    const encodedQuery = encodeURIComponent(soql);
    const endpoint =
        `${instanceUrl}/services/data/v${apiVersion}/tooling/query/?q=${encodedQuery}`;

    const response = await axios.get(endpoint, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        },
        timeout: 60000
    });

    return response.data;
}

async function discoverFlowVersions({
    instanceUrl,
    accessToken,
    getLatestApiVersionFn = getLatestApiVersion
} = {}) {
    if (!instanceUrl || !accessToken) {
        throw new Error(
            'Flow version discovery requires instanceUrl and accessToken.'
        );
    }

    const apiVersion = await getLatestApiVersionFn(instanceUrl, accessToken);

    const flowSoql =
        'SELECT Id, VersionNumber, Status, Definition.DeveloperName ' +
        'FROM Flow ' +
        'WHERE Definition.DeveloperName != null ' +
        'ORDER BY Definition.DeveloperName, VersionNumber';

    const definitionSoql =
        'SELECT DeveloperName, ActiveVersionId, ActiveVersion.VersionNumber, ' +
        'LatestVersionId, LatestVersion.VersionNumber ' +
        'FROM FlowDefinition ' +
        'WHERE DeveloperName != null';

    const [flowResult, definitionResult] = await Promise.all([
        runToolingQuery(instanceUrl, accessToken, apiVersion, flowSoql),
        runToolingQuery(instanceUrl, accessToken, apiVersion, definitionSoql)
    ]);

    const definitionByName = new Map();

    for (const row of definitionResult.records || []) {
        const developerName = row.DeveloperName;

        if (!developerName) {
            continue;
        }

        definitionByName.set(developerName, {
            developerName,
            activeVersionId: row.ActiveVersionId || null,
            activeVersionNumber:
                row.ActiveVersion?.VersionNumber ?? null,
            latestVersionId: row.LatestVersionId || null,
            latestVersionNumber:
                row.LatestVersion?.VersionNumber ?? null
        });
    }

    const versions = [];

    for (const row of flowResult.records || []) {
        const developerName = row.Definition?.DeveloperName;

        if (!developerName) {
            continue;
        }

        const versionNumber = row.VersionNumber;
        const definition = definitionByName.get(developerName) || {};
        const flowVersionId = row.Id || null;
        const requestedMetadataMemberName = `${developerName}-${versionNumber}`;

        versions.push({
            flowDefinitionDeveloperName: developerName,
            sourceFlowVersionNumber: versionNumber,
            sourceFlowVersionId: flowVersionId,
            definitionLatestVersionId: definition.latestVersionId || null,
            flowVersionStatus: row.Status || null,
            flowIsActiveVersion:
                definition.activeVersionId != null &&
                definition.activeVersionId === flowVersionId,
            flowIsLatestVersion:
                definition.latestVersionId != null &&
                definition.latestVersionId === flowVersionId,
            requestedMetadataMemberName,
            requestedMetadataMember: `Flow:${requestedMetadataMemberName}`
        });
    }

    return {
        apiVersion,
        versions,
        definitions: [...definitionByName.values()]
    };
}

function findFlowDefinition(definitions, developerName) {
    return (definitions || []).find(
        (row) => row.developerName === developerName
    );
}

function findExactFlowVersion(versions, developerName, requestedVersion) {
    return (versions || []).find((row) => {
        if (row.flowDefinitionDeveloperName !== developerName) {
            return false;
        }

        const candidate = Number(row.sourceFlowVersionNumber);

        return Number.isFinite(candidate) && candidate === requestedVersion;
    });
}

function countExactFlowVersionRows(versions, developerName, requestedVersion) {
    return (versions || []).filter((row) => {
        if (row.flowDefinitionDeveloperName !== developerName) {
            return false;
        }

        const candidate = Number(row.sourceFlowVersionNumber);

        return Number.isFinite(candidate) && candidate === requestedVersion;
    });
}

/**
 * Tooling-backed version presence for pre-deploy snapshot capture only.
 * Does not retrieve metadata.
 */
async function resolveVersionQualifiedFlowCaptureState({
    metadataName,
    instanceUrl,
    accessToken,
    discoverFlowVersionsFn = discoverFlowVersions
} = {}) {
    const parsed = parseVersionQualifiedFlowMember(metadataName);

    if (!parsed?.isVersionQualified) {
        return { outcome: FLOW_CAPTURE_VERSION_OUTCOME.NOT_VERSION_QUALIFIED };
    }

    const definitionDeveloperName = parsed.definitionDeveloperName;
    const requestedVersion = parsed.sourceVersionNumber;

    let discovery;

    try {
        discovery = await discoverFlowVersionsFn({
            instanceUrl,
            accessToken
        });
    } catch (error) {
        return {
            outcome: FLOW_CAPTURE_VERSION_OUTCOME.TOOLING_FAILED,
            detail: error.message || 'Flow version discovery failed.'
        };
    }

    const definition = findFlowDefinition(
        discovery.definitions,
        definitionDeveloperName
    );
    const exactVersion = findExactFlowVersion(
        discovery.versions,
        definitionDeveloperName,
        requestedVersion
    );

    if (exactVersion) {
        return {
            outcome: FLOW_CAPTURE_VERSION_OUTCOME.VERSION_PRESENT,
            definitionDeveloperName,
            requestedVersion
        };
    }

    if (definition) {
        return {
            outcome: FLOW_CAPTURE_VERSION_OUTCOME.VERSION_ABSENT,
            definitionDeveloperName,
            requestedVersion
        };
    }

    return {
        outcome: FLOW_CAPTURE_VERSION_OUTCOME.DEFINITION_ABSENT,
        definitionDeveloperName,
        requestedVersion
    };
}

const FLOW_POST_DELETE_VERIFICATION_OUTCOME = {
    PASS: 'PASS',
    STILL_PRESENT: 'STILL_PRESENT',
    FAIL_CLOSED: 'FAIL_CLOSED',
    USE_DEFINITION_INVENTORY: 'USE_DEFINITION_INVENTORY'
};

/**
 * After destructive rollback, confirm a version-qualified Flow member is absent
 * on the destination without requiring FlowDefinition to be missing.
 */
async function verifyVersionQualifiedFlowPostDeleteAbsence({
    metadataName,
    instanceUrl,
    accessToken,
    discoverFlowVersionsFn = discoverFlowVersions
} = {}) {
    const parsed = parseVersionQualifiedFlowMember(metadataName);

    if (!parsed?.isVersionQualified) {
        return {
            outcome: FLOW_POST_DELETE_VERIFICATION_OUTCOME.USE_DEFINITION_INVENTORY
        };
    }

    const state = await resolveVersionQualifiedFlowCaptureState({
        metadataName,
        instanceUrl,
        accessToken,
        discoverFlowVersionsFn
    });

    if (state.outcome === FLOW_CAPTURE_VERSION_OUTCOME.TOOLING_FAILED) {
        return {
            outcome: FLOW_POST_DELETE_VERIFICATION_OUTCOME.FAIL_CLOSED,
            detail:
                state.detail ||
                'Flow post-delete version verification failed (Tooling unavailable).'
        };
    }

    if (state.outcome === FLOW_CAPTURE_VERSION_OUTCOME.VERSION_PRESENT) {
        return { outcome: FLOW_POST_DELETE_VERIFICATION_OUTCOME.STILL_PRESENT };
    }

    if (
        state.outcome === FLOW_CAPTURE_VERSION_OUTCOME.VERSION_ABSENT ||
        state.outcome === FLOW_CAPTURE_VERSION_OUTCOME.DEFINITION_ABSENT
    ) {
        return { outcome: FLOW_POST_DELETE_VERIFICATION_OUTCOME.PASS };
    }

    return {
        outcome: FLOW_POST_DELETE_VERIFICATION_OUTCOME.USE_DEFINITION_INVENTORY
    };
}

module.exports = {
    FLOW_CAPTURE_VERSION_OUTCOME,
    FLOW_POST_DELETE_VERIFICATION_OUTCOME,
    discoverFlowVersions,
    runToolingQuery,
    resolveVersionQualifiedFlowCaptureState,
    verifyVersionQualifiedFlowPostDeleteAbsence,
    findFlowDefinition,
    findExactFlowVersion,
    countExactFlowVersionRows
};
