/**
 * Centralized Deployment API Version Policy.
 *
 * Single source of truth for package.xml / sfdx-project.json API version
 * selection. Does not rewrite metadata or change deployment CLI flags.
 */

const { DEFAULT_API_VERSION } = require('../config/salesforce');
const {
    extractFlowApiVersion
} = require('./deploymentReview/flowReview.service');
const {
    getMetadataXmlPath
} = require('./apiVersionValidator.service');

const POLICY_NAME = 'HIGHEST_REQUIRED';

const COMPANION_META_TYPES = new Set([
    'ApexClass',
    'ApexTrigger',
    'ApexPage',
    'ApexComponent'
]);

/**
 * Normalize Salesforce API version strings for comparison.
 *
 * @param {string|number|null|undefined} value
 * @returns {string|null}
 */
function normalizeApiVersion(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    const raw = String(value).trim();

    if (!raw) {
        return null;
    }

    const match = raw.match(/^(\d+)(?:\.(\d+))?/);

    if (!match) {
        return null;
    }

    const major = match[1];
    const minor = match[2] !== undefined ? match[2] : '0';

    return `${major}.${minor}`;
}

/**
 * Numeric compare for API versions (e.g. 63.0 > 61.0).
 *
 * @param {string} left
 * @param {string} right
 * @returns {number}
 */
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

/**
 * Reuse existing XML apiVersion readers (Flow extractor = shared regex).
 *
 * @param {string|null|undefined} metadataType
 * @param {string|null|undefined} xmlContent
 * @returns {string|null}
 */
function extractEmbeddedApiVersionFromXml(metadataType, xmlContent) {
    if (!xmlContent) {
        return null;
    }

    // Flow Review extractor — same <apiVersion> pattern used by Apex validator.
    const fromReader = extractFlowApiVersion(xmlContent);

    return normalizeApiVersion(fromReader);
}

/**
 * Resolve which XML path holds <apiVersion> for a metadata type.
 *
 * @param {string|null} metadataType
 * @param {string|null} filePath
 * @returns {string|null}
 */
function resolveApiVersionXmlPath(metadataType, filePath) {
    if (!filePath) {
        return null;
    }

    const normalized = String(filePath).replace(/\\/g, '/');

    if (
        metadataType === 'Flow' ||
        /-meta\.xml$/i.test(normalized)
    ) {
        return normalized;
    }

    if (COMPANION_META_TYPES.has(metadataType)) {
        return getMetadataXmlPath(normalized);
    }

    return normalized;
}

/**
 * Read embedded version from a metadata item without re-parsing Review.
 * Prefers already-attached apiVersion / apiValidation.apiVersion.
 *
 * @param {object} item
 * @returns {string|null}
 */
function readAttachedApiVersion(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    return normalizeApiVersion(
        item.apiVersion ||
            item.apiValidation?.apiVersion ||
            null
    );
}

/**
 * Collect embedded API versions from selected / workspace metadata items.
 *
 * @param {Array<object>} items
 * @returns {Array<{ metadataType: string|null, metadataName: string|null, apiVersion: string }>}
 */
function collectEmbeddedApiVersions(items = []) {
    const collected = [];

    for (const item of items || []) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const metadataType = item.metadataType || item.type || null;
        const metadataName = item.metadataName || item.name || null;
        let apiVersion = readAttachedApiVersion(item);

        if (!apiVersion && item.content) {
            apiVersion = extractEmbeddedApiVersionFromXml(
                metadataType,
                item.content
            );
        }

        if (!apiVersion && item.metaXmlContent) {
            apiVersion = extractEmbeddedApiVersionFromXml(
                metadataType,
                item.metaXmlContent
            );
        }

        if (!apiVersion) {
            continue;
        }

        collected.push({
            metadataType,
            metadataName,
            apiVersion
        });
    }

    return collected;
}

/**
 * Optionally enrich versions by reading source XML via reused extractors.
 *
 * @param {Array<object>} items
 * @param {(filePath: string) => Promise<string>|string} readFile
 * @returns {Promise<Array<{ metadataType: string|null, metadataName: string|null, apiVersion: string }>>}
 */
async function enrichEmbeddedApiVersionsFromFiles(items = [], readFile) {
    const collected = collectEmbeddedApiVersions(items);

    if (typeof readFile !== 'function') {
        return collected;
    }

    const seen = new Set(
        collected.map(
            (entry) =>
                `${entry.metadataType || ''}:${entry.metadataName || ''}`
        )
    );

    for (const item of items || []) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const metadataType = item.metadataType || item.type || null;
        const metadataName = item.metadataName || item.name || null;
        const key = `${metadataType || ''}:${metadataName || ''}`;

        if (seen.has(key) && readAttachedApiVersion(item)) {
            continue;
        }

        if (readAttachedApiVersion(item)) {
            continue;
        }

        const xmlPath = resolveApiVersionXmlPath(
            metadataType,
            item.filePath || null
        );

        if (!xmlPath) {
            continue;
        }

        try {
            const xmlContent = await readFile(xmlPath);
            const apiVersion = extractEmbeddedApiVersionFromXml(
                metadataType,
                xmlContent
            );

            if (!apiVersion) {
                continue;
            }

            seen.add(key);
            collected.push({
                metadataType,
                metadataName,
                apiVersion
            });
        } catch (error) {
            // Missing companion / unreadable file → treat as no embedded version.
        }
    }

    return collected;
}

/**
 * Highest required version among embedded entries.
 * Types without an embedded version contribute nothing (DEFAULT applied later).
 *
 * @param {Array<{ apiVersion: string }>} embeddedApiVersions
 * @returns {string|null}
 */
function resolveHighestRequiredVersion(embeddedApiVersions = []) {
    let highest = null;

    for (const entry of embeddedApiVersions || []) {
        const version = normalizeApiVersion(entry?.apiVersion);

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
 * Select deployment API version (HIGHEST_REQUIRED, floor DEFAULT, cap check).
 *
 * @param {object} params
 * @param {Array<object>} [params.selectedMetadata]
 * @param {Array<object>} [params.workspaceMetadata]
 * @param {Array<{ apiVersion: string }>} [params.embeddedApiVersions]
 * @param {string} [params.defaultApiVersion]
 * @param {string|null} [params.destinationMaxApiVersion]
 * @returns {{
 *   deploymentApiVersion: string,
 *   policy: string,
 *   compatible: boolean,
 *   reason: string|null,
 *   warnings: string[],
 *   highestRequiredVersion: string,
 *   destinationMaxApiVersion: string|null,
 *   defaultApiVersion: string
 * }}
 */
function resolveDeploymentApiVersionPolicy({
    selectedMetadata = [],
    workspaceMetadata = [],
    embeddedApiVersions = null,
    defaultApiVersion = DEFAULT_API_VERSION,
    destinationMaxApiVersion = null
} = {}) {
    const defaultVersion =
        normalizeApiVersion(defaultApiVersion) ||
        normalizeApiVersion(DEFAULT_API_VERSION) ||
        '61.0';

    const embedded = Array.isArray(embeddedApiVersions)
        ? embeddedApiVersions
              .map((entry) => ({
                  metadataType: entry?.metadataType || entry?.type || null,
                  metadataName: entry?.metadataName || entry?.name || null,
                  apiVersion: normalizeApiVersion(entry?.apiVersion)
              }))
              .filter((entry) => entry.apiVersion)
        : [
              ...collectEmbeddedApiVersions(selectedMetadata),
              ...collectEmbeddedApiVersions(workspaceMetadata)
          ];

    const highestFromPayload = resolveHighestRequiredVersion(embedded);
    // Case 5 — no embedded version → DEFAULT.
    // Floor — never deploy below configured DEFAULT.
    const requiredVersion = highestFromPayload
        ? compareApiVersions(highestFromPayload, defaultVersion) < 0
            ? defaultVersion
            : highestFromPayload
        : defaultVersion;

    const destinationMax = normalizeApiVersion(destinationMaxApiVersion);
    const warnings = [];

    if (!destinationMax) {
        warnings.push(
            'Destination maximum API version unavailable; compatibility cap not applied.'
        );

        return {
            deploymentApiVersion: requiredVersion,
            policy: POLICY_NAME,
            compatible: true,
            reason: null,
            warnings,
            highestRequiredVersion: requiredVersion,
            destinationMaxApiVersion: null,
            defaultApiVersion: defaultVersion,
            embeddedApiVersions: embedded
        };
    }

    if (compareApiVersions(requiredVersion, destinationMax) > 0) {
        return {
            deploymentApiVersion: requiredVersion,
            policy: POLICY_NAME,
            compatible: false,
            reason: `Selected metadata requires API ${requiredVersion} but destination org supports only ${destinationMax}.`,
            warnings,
            highestRequiredVersion: requiredVersion,
            destinationMaxApiVersion: destinationMax,
            defaultApiVersion: defaultVersion,
            embeddedApiVersions: embedded
        };
    }

    return {
        deploymentApiVersion: requiredVersion,
        policy: POLICY_NAME,
        compatible: true,
        reason: null,
        warnings,
        highestRequiredVersion: requiredVersion,
        destinationMaxApiVersion: destinationMax,
        defaultApiVersion: defaultVersion,
        embeddedApiVersions: embedded
    };
}

/**
 * Async entry: enrich from files when a reader is provided, then apply policy.
 *
 * @param {object} params
 * @returns {Promise<object>}
 */
async function resolveDeploymentApiVersionPolicyAsync(params = {}) {
    const {
        selectedMetadata = [],
        workspaceMetadata = [],
        readFile = null,
        embeddedApiVersions = null,
        defaultApiVersion = DEFAULT_API_VERSION,
        destinationMaxApiVersion = null
    } = params;

    let embedded = embeddedApiVersions;

    if (!Array.isArray(embedded)) {
        const combined = [...(selectedMetadata || []), ...(workspaceMetadata || [])];
        embedded = await enrichEmbeddedApiVersionsFromFiles(
            combined,
            readFile
        );
    }

    return resolveDeploymentApiVersionPolicy({
        selectedMetadata,
        workspaceMetadata,
        embeddedApiVersions: embedded,
        defaultApiVersion,
        destinationMaxApiVersion
    });
}

module.exports = {
    POLICY_NAME,
    normalizeApiVersion,
    compareApiVersions,
    extractEmbeddedApiVersionFromXml,
    resolveApiVersionXmlPath,
    collectEmbeddedApiVersions,
    enrichEmbeddedApiVersionsFromFiles,
    resolveHighestRequiredVersion,
    resolveDeploymentApiVersionPolicy,
    resolveDeploymentApiVersionPolicyAsync
};
