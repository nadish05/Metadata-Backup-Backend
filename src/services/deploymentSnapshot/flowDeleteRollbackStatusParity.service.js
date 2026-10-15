'use strict';

const {
    packMemberFiles,
    unpackMemberFiles
} = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    applyCanonicalFlowSnapshotPackPaths,
    parseVersionQualifiedFlowMember
} = require('../flowMetadata/flowMemberIdentity.service');
const {
    discoverFlowVersions,
    findExactFlowVersion
} = require('../retrieval/flowVersionDiscovery.service');

const FLOW_DELETE_STATUS_ONLY_PARITY_V1 = 'FLOW_DELETE_STATUS_ONLY_PARITY_V1';

const FLOW_VERSION_STATUS_VALUES = Object.freeze([
    'Active',
    'Draft',
    'Obsolete',
    'InvalidDraft',
    'UnderReview'
]);

const FLOW_VERSION_STATUS_SET = new Set(FLOW_VERSION_STATUS_VALUES);

function analyzeFlowRootStatusElement(flowXmlBytes) {
    if (!flowXmlBytes || !flowXmlBytes.length) {
        return { ok: false, reason: 'EMPTY_FLOW_XML' };
    }

    let xml;

    try {
        xml = flowXmlBytes.toString('utf8');
    } catch (error) {
        return { ok: false, reason: 'INVALID_UTF8' };
    }

    const trimmed = xml.trim();

    if (!trimmed.length) {
        return { ok: false, reason: 'EMPTY_FLOW_XML' };
    }

    const flowOpenMatches = trimmed.match(/<Flow\b/gi) || [];

    if (flowOpenMatches.length !== 1) {
        return { ok: false, reason: 'AMBIGUOUS_OR_MISSING_FLOW_ROOT' };
    }

    const statusPattern = /<status>\s*([\s\S]*?)\s*<\/status>/gi;
    const statusMatches = [...trimmed.matchAll(statusPattern)];

    if (statusMatches.length === 0) {
        return { ok: false, reason: 'MISSING_STATUS_ELEMENT' };
    }

    if (statusMatches.length > 1) {
        return { ok: false, reason: 'MULTIPLE_STATUS_ELEMENTS' };
    }

    const statusValue = String(statusMatches[0][1] || '').trim();

    if (!statusValue.length) {
        return { ok: false, reason: 'EMPTY_STATUS_VALUE' };
    }

    if (!FLOW_VERSION_STATUS_SET.has(statusValue)) {
        return { ok: false, reason: 'UNSUPPORTED_STATUS_VALUE' };
    }

    return {
        ok: true,
        xml,
        statusValue,
        statusMatch: statusMatches[0]
    };
}

function replaceSingleFlowStatusElement(xml, newStatus) {
    if (!FLOW_VERSION_STATUS_SET.has(newStatus)) {
        throw new Error('Unsupported Flow status replacement value.');
    }

    const statusPattern = /<status>\s*([\s\S]*?)\s*<\/status>/i;
    const match = xml.match(statusPattern);

    if (!match) {
        throw new Error('Flow status element not found for replacement.');
    }

    return xml.replace(statusPattern, `<status>${newStatus}</status>`);
}

function hashPackedFlowMember(flowXmlBytes, metadataName) {
    const packed = packMemberFiles(
        applyCanonicalFlowSnapshotPackPaths(
            [
                {
                    relativePath: `force-app/main/default/flows/${metadataName}.flow-meta.xml`,
                    bytes: flowXmlBytes
                }
            ],
            metadataName
        )
    );

    return hashBytes(packed);
}

function extractFlowXmlBytesFromPackedArtifact(artifactBytes, metadataName) {
    const files = unpackMemberFiles(artifactBytes);
    const canonical = applyCanonicalFlowSnapshotPackPaths(files, metadataName);

    if (!canonical.length || canonical.length > 1) {
        return {
            ok: false,
            reason: 'UNEXPECTED_PACKED_FLOW_FILE_COUNT'
        };
    }

    return {
        ok: true,
        flowXmlBytes: canonical[0].bytes
    };
}

function tryFlowStatusOnlySealedHashParity({
    destinationFlowXmlBytes,
    metadataName,
    expectedAfterHash,
    currentDestinationHash
} = {}) {
    if (
        typeof expectedAfterHash !== 'string' ||
        !expectedAfterHash.length ||
        typeof currentDestinationHash !== 'string' ||
        !currentDestinationHash.length
    ) {
        return { qualified: false, reason: 'MISSING_HASH_INPUT' };
    }

    if (currentDestinationHash === expectedAfterHash) {
        return { qualified: false, reason: 'RAW_HASH_ALREADY_MATCHES' };
    }

    const analysis = analyzeFlowRootStatusElement(destinationFlowXmlBytes);

    if (!analysis.ok) {
        return { qualified: false, reason: analysis.reason };
    }

    const qualifyingStatuses = [];

    for (const candidateStatus of FLOW_VERSION_STATUS_VALUES) {
        if (candidateStatus === analysis.statusValue) {
            continue;
        }

        let candidateXml;

        try {
            candidateXml = replaceSingleFlowStatusElement(
                analysis.xml,
                candidateStatus
            );
        } catch (error) {
            return { qualified: false, reason: 'STATUS_REPLACEMENT_FAILED' };
        }

        const candidateHash = hashPackedFlowMember(
            Buffer.from(candidateXml, 'utf8'),
            metadataName
        );

        if (candidateHash === expectedAfterHash) {
            qualifyingStatuses.push(candidateStatus);
        }
    }

    if (qualifyingStatuses.length === 0) {
        return {
            qualified: false,
            reason: 'NO_STATUS_CANDIDATE_MATCHES_SEALED_HASH',
            destinationStatus: analysis.statusValue
        };
    }

    if (qualifyingStatuses.length > 1) {
        return {
            qualified: false,
            reason: 'AMBIGUOUS_STATUS_CANDIDATE_MATCH',
            qualifyingStatuses
        };
    }

    return {
        qualified: true,
        destinationStatus: analysis.statusValue,
        qualifyingStatus: qualifyingStatuses[0]
    };
}

function isExactVersionFlowArtifactVerified(retrieved, metadataName) {
    const parsed = parseVersionQualifiedFlowMember(metadataName);

    if (!parsed?.isVersionQualified) {
        return false;
    }

    const recovery = retrieved?.exactVersionRecovery;

    if (recovery?.recoveryOutcome === 'SUCCEEDED') {
        return true;
    }

    if (retrieved?.flowExactVersionArtifactVerified === true) {
        return true;
    }

    return false;
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

async function evaluateFlowDeleteRollbackStatusParity({
    metadataName,
    expectedAfterHash,
    currentDestinationHash,
    destinationArtifactBytes,
    retrieved,
    accessToken,
    instanceUrl,
    discoverFlowVersionsFn = discoverFlowVersions
} = {}) {
    const parsed = parseVersionQualifiedFlowMember(metadataName);

    if (!parsed?.isVersionQualified) {
        return { qualified: false, reason: 'NOT_VERSION_QUALIFIED' };
    }

    if (!isExactVersionFlowArtifactVerified(retrieved, metadataName)) {
        return { qualified: false, reason: 'EXACT_VERSION_ARTIFACT_NOT_VERIFIED' };
    }

    if (!accessToken || !instanceUrl) {
        return { qualified: false, reason: 'MISSING_TOOLING_CREDENTIALS' };
    }

    let discovery;

    try {
        discovery = await discoverFlowVersionsFn({
            instanceUrl,
            accessToken
        });
    } catch (error) {
        return {
            qualified: false,
            reason: 'TOOLING_DISCOVERY_FAILED',
            detail: error.message || 'Flow version discovery failed.'
        };
    }

    const exactRows = countExactFlowVersionRows(
        discovery.versions,
        parsed.definitionDeveloperName,
        parsed.sourceVersionNumber
    );

    if (exactRows.length === 0) {
        return { qualified: false, reason: 'DESTINATION_FLOW_VERSION_NOT_FOUND' };
    }

    if (exactRows.length > 1) {
        return { qualified: false, reason: 'AMBIGUOUS_DESTINATION_FLOW_VERSION' };
    }

    const exactVersion = exactRows[0];
    const toolingStatus = exactVersion.flowVersionStatus || null;

    if (
        exactVersion.flowIsActiveVersion === true ||
        toolingStatus === 'Active'
    ) {
        return { qualified: false, reason: 'DESTINATION_FLOW_VERSION_ACTIVE' };
    }

    const extracted = extractFlowXmlBytesFromPackedArtifact(
        destinationArtifactBytes,
        metadataName
    );

    if (!extracted.ok) {
        return { qualified: false, reason: extracted.reason };
    }

    const parity = tryFlowStatusOnlySealedHashParity({
        destinationFlowXmlBytes: extracted.flowXmlBytes,
        metadataName,
        expectedAfterHash,
        currentDestinationHash
    });

    if (!parity.qualified) {
        return parity;
    }

    return {
        qualified: true,
        comparisonMode: FLOW_DELETE_STATUS_ONLY_PARITY_V1,
        destinationStatus: parity.destinationStatus,
        qualifyingStatus: parity.qualifyingStatus,
        toolingFlowVersionId: exactVersion.sourceFlowVersionId || null,
        toolingFlowVersionStatus: toolingStatus,
        toolingFlowVersionNumber: exactVersion.sourceFlowVersionNumber
    };
}

module.exports = {
    FLOW_DELETE_STATUS_ONLY_PARITY_V1,
    FLOW_VERSION_STATUS_VALUES,
    analyzeFlowRootStatusElement,
    replaceSingleFlowStatusElement,
    hashPackedFlowMember,
    extractFlowXmlBytesFromPackedArtifact,
    tryFlowStatusOnlySealedHashParity,
    evaluateFlowDeleteRollbackStatusParity,
    isExactVersionFlowArtifactVerified
};
