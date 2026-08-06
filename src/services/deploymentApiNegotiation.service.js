/**
 * Enterprise Metadata API Negotiation (Phase 13.3).
 *
 * READ-ONLY. Computes the highest Metadata API version mutually supported by
 * source and destination. Does not change CLI, package.xml, workspace, gate,
 * or deployment behavior.
 */

const NEGOTIATION_STATUS = Object.freeze({
    SUCCESS: 'SUCCESS',
    READY_FOR_UPGRADE: 'READY_FOR_UPGRADE',
    UNKNOWN: 'UNKNOWN'
});

function emptyNegotiation(currentDeploymentApiVersion = null) {
    const current = normalizeApiVersion(currentDeploymentApiVersion);

    return {
        sourceApiVersion: null,
        destinationApiVersion: null,
        currentDeploymentApiVersion: current,
        negotiatedApiVersion: null,
        negotiationStatus: NEGOTIATION_STATUS.UNKNOWN,
        effectiveCompatibilityApiVersion: current,
        upgradeAvailable: false
    };
}

function normalizeApiVersion(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const match = String(value).trim().match(/^(\d+)(?:\.(\d+))?/);

    if (!match) {
        return null;
    }

    return `${match[1]}.${match[2] || '0'}`;
}

function compareApiVersions(left, right) {
    const a = normalizeApiVersion(left);
    const b = normalizeApiVersion(right);

    if (!a && !b) {
        return 0;
    }

    if (!a) {
        return -1;
    }

    if (!b) {
        return 1;
    }

    const [aMajor, aMinor] = a.split('.').map(Number);
    const [bMajor, bMinor] = b.split('.').map(Number);

    if (aMajor !== bMajor) {
        return aMajor - bMajor;
    }

    return aMinor - bMinor;
}

function minApiVersion(left, right) {
    if (!left || !right) {
        return null;
    }

    return compareApiVersions(left, right) <= 0 ? left : right;
}

function maxApiVersion(versions = []) {
    let highest = null;

    for (const value of versions) {
        const version = normalizeApiVersion(value);

        if (!version) {
            continue;
        }

        if (!highest || compareApiVersions(version, highest) > 0) {
            highest = version;
        }
    }

    return highest;
}

/**
 * Resolve a source API version from explicit org values or embedded metadata.
 * Explicit source-org values take precedence. Embedded metadata is a fallback
 * proxy when the source org cannot be queried live.
 */
function resolveSourceApiVersion({
    sourceApiVersion = null,
    deploymentPackage = null,
    embeddedApiVersions = []
} = {}) {
    const explicit =
        normalizeApiVersion(sourceApiVersion) ||
        normalizeApiVersion(deploymentPackage?.sourceApiVersion) ||
        normalizeApiVersion(deploymentPackage?.sourceMaxApiVersion) ||
        normalizeApiVersion(deploymentPackage?.sourceOrgApiVersion);

    if (explicit) {
        return explicit;
    }

    const embedded = Array.isArray(embeddedApiVersions)
        ? embeddedApiVersions.map((entry) =>
              typeof entry === 'string' || typeof entry === 'number'
                  ? entry
                  : entry?.apiVersion
          )
        : [];

    return maxApiVersion(embedded);
}

/**
 * Negotiate the highest mutually supported Metadata API version.
 *
 * Negotiated = MIN(source, destination) when both are known.
 * Never throws. Never changes deployment execution inputs.
 */
function negotiateDeploymentApiVersions({
    sourceApiVersion = null,
    destinationApiVersion = null,
    currentDeploymentApiVersion = null,
    deploymentPackage = null,
    embeddedApiVersions = []
} = {}) {
    try {
        const source = resolveSourceApiVersion({
            sourceApiVersion,
            deploymentPackage,
            embeddedApiVersions
        });
        const destination = normalizeApiVersion(destinationApiVersion);
        const current = normalizeApiVersion(currentDeploymentApiVersion);
        const negotiated = minApiVersion(source, destination);

        if (!source || !destination || !negotiated) {
            return {
                sourceApiVersion: source,
                destinationApiVersion: destination,
                currentDeploymentApiVersion: current,
                negotiatedApiVersion: null,
                negotiationStatus: NEGOTIATION_STATUS.UNKNOWN,
                effectiveCompatibilityApiVersion: current,
                upgradeAvailable: false
            };
        }

        const upgradeAvailable =
            current != null && compareApiVersions(negotiated, current) > 0;

        return {
            sourceApiVersion: source,
            destinationApiVersion: destination,
            currentDeploymentApiVersion: current,
            negotiatedApiVersion: negotiated,
            negotiationStatus: upgradeAvailable
                ? NEGOTIATION_STATUS.READY_FOR_UPGRADE
                : NEGOTIATION_STATUS.SUCCESS,
            effectiveCompatibilityApiVersion: negotiated,
            upgradeAvailable
        };
    } catch (error) {
        return emptyNegotiation(currentDeploymentApiVersion);
    }
}

function negotiateDeploymentApiVersionsSafe(input) {
    try {
        return negotiateDeploymentApiVersions(input);
    } catch (error) {
        return emptyNegotiation(input?.currentDeploymentApiVersion);
    }
}

/**
 * Select the Metadata API version used at deployment runtime.
 *
 * Only READY_FOR_UPGRADE adopts the negotiated version. Every other status,
 * including unknown future failure statuses, falls back to the current
 * deployment version.
 */
function resolveDeploymentApiVersion({
    deploymentApiNegotiation = null,
    currentDeploymentApiVersion = null
} = {}) {
    const current =
        normalizeApiVersion(currentDeploymentApiVersion) ||
        normalizeApiVersion(
            deploymentApiNegotiation?.currentDeploymentApiVersion
        );

    if (
        deploymentApiNegotiation?.negotiationStatus ===
        NEGOTIATION_STATUS.READY_FOR_UPGRADE
    ) {
        return (
            normalizeApiVersion(
                deploymentApiNegotiation?.negotiatedApiVersion
            ) || current
        );
    }

    return current;
}

module.exports = {
    NEGOTIATION_STATUS,
    emptyNegotiation,
    normalizeApiVersion,
    compareApiVersions,
    minApiVersion,
    maxApiVersion,
    resolveSourceApiVersion,
    negotiateDeploymentApiVersions,
    negotiateDeploymentApiVersionsSafe,
    resolveDeploymentApiVersion
};
