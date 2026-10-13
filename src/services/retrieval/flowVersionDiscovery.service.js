'use strict';

const axios = require('axios');

const { getLatestApiVersion } = require('../destinationInventory/destinationInventoryBuilder.service');

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

module.exports = {
    discoverFlowVersions,
    runToolingQuery
};
