/**
 * Destination Inventory Builder (Step 2 — not wired into runtime yet).
 *
 * Builds a request-scoped destination existence inventory using the shared
 * destinationExistenceQueries catalog. Does not decide Deploy/Skip.
 *
 * API errors → UNKNOWN (never invent MISSING).
 */

const axios = require('axios');

const {
    buildExistenceQuery,
    usesToolingApi
} = require('./destinationExistenceQueries');

const DESTINATION_STATE = Object.freeze({
    EXISTS: 'EXISTS',
    MISSING: 'MISSING',
    UNKNOWN: 'UNKNOWN'
});

const DEFAULT_CHUNK_SIZE = 25;

function buildInventoryKey(metadataType, metadataName) {
    return `${metadataType}:${metadataName}`;
}

function normalizeItems(items) {
    const byKey = new Map();

    if (!Array.isArray(items)) {
        return [];
    }

    for (const item of items) {
        const metadataType = item?.metadataType || item?.type || null;
        const metadataName = item?.metadataName || item?.name || null;

        if (!metadataType || !metadataName) {
            continue;
        }

        const key = buildInventoryKey(metadataType, metadataName);

        if (!byKey.has(key)) {
            byKey.set(key, { metadataType, metadataName });
        }
    }

    return [...byKey.values()].sort((a, b) => {
        const typeCompare = a.metadataType.localeCompare(b.metadataType);

        if (typeCompare !== 0) {
            return typeCompare;
        }

        return a.metadataName.localeCompare(b.metadataName);
    });
}

function groupItemsByType(items) {
    const groups = new Map();

    for (const item of items) {
        if (!groups.has(item.metadataType)) {
            groups.set(item.metadataType, []);
        }

        groups.get(item.metadataType).push(item);
    }

    return groups;
}

function chunkArray(values, chunkSize) {
    const chunks = [];

    for (let i = 0; i < values.length; i += chunkSize) {
        chunks.push(values.slice(i, i + chunkSize));
    }

    return chunks;
}

function createEntry({
    metadataType,
    metadataName,
    state,
    api = null,
    queried = false,
    warning = null,
    unsupported = false
}) {
    return {
        metadataType,
        metadataName,
        state,
        source: 'INVENTORY_BUILDER',
        api,
        queried,
        warning,
        unsupported
    };
}

function createEmptySummary() {
    return {
        requested: 0,
        exists: 0,
        missing: 0,
        unknown: 0,
        unsupported: 0,
        warnings: []
    };
}

function summarizeInventory(inventory) {
    const summary = createEmptySummary();
    summary.requested = inventory.size;

    for (const entry of inventory.values()) {
        if (entry.state === DESTINATION_STATE.EXISTS) {
            summary.exists += 1;
        } else if (entry.state === DESTINATION_STATE.MISSING) {
            summary.missing += 1;
        } else {
            summary.unknown += 1;
        }

        if (entry.warning) {
            summary.warnings.push(entry.warning);
        }

        if (entry.unsupported) {
            summary.unsupported += 1;
        }
    }

    return summary;
}

async function getLatestApiVersion(instanceUrl, accessToken) {
    const response = await axios.get(`${instanceUrl}/services/data/`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        },
        timeout: 15000
    });

    const versions = response.data;

    if (!Array.isArray(versions) || !versions.length) {
        return '59.0';
    }

    return versions[versions.length - 1].version;
}

async function runSoqlQuery(
    instanceUrl,
    accessToken,
    apiVersion,
    soql,
    useToolingApi = false
) {
    const encodedQuery = encodeURIComponent(soql);
    const queryPath = useToolingApi ? 'tooling/query' : 'query';
    const response = await axios.get(
        `${instanceUrl}/services/data/v${apiVersion}/${queryPath}/?q=${encodedQuery}`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 15000
        }
    );

    return response.data;
}

async function querySingleExistence({
    metadataType,
    metadataName,
    instanceUrl,
    accessToken,
    apiVersion
}) {
    const soql = buildExistenceQuery(metadataType, metadataName);
    const useTooling = usesToolingApi(metadataType);
    const api = useTooling ? 'TOOLING' : 'REST';

    if (!soql) {
        return createEntry({
            metadataType,
            metadataName,
            state: DESTINATION_STATE.UNKNOWN,
            api: null,
            queried: false,
            unsupported: true,
            warning: `${metadataType} existence query is not supported.`
        });
    }

    try {
        const queryResult = await runSoqlQuery(
            instanceUrl,
            accessToken,
            apiVersion,
            soql,
            useTooling
        );

        const exists = (queryResult.totalSize || 0) > 0;

        return createEntry({
            metadataType,
            metadataName,
            state: exists
                ? DESTINATION_STATE.EXISTS
                : DESTINATION_STATE.MISSING,
            api,
            queried: true,
            warning: null
        });
    } catch (error) {
        return createEntry({
            metadataType,
            metadataName,
            state: DESTINATION_STATE.UNKNOWN,
            api,
            queried: true,
            warning:
                error?.message ||
                `Unable to query destination state for ${metadataType}:${metadataName}.`
        });
    }
}

/**
 * Build a request-scoped destination existence inventory.
 *
 * @param {object} options
 * @param {Array<object>} [options.items]
 * @param {string} [options.accessToken]
 * @param {string} [options.instanceUrl]
 * @param {number} [options.chunkSize]
 * @returns {Promise<{
 *   inventory: Map<string, object>,
 *   summary: object
 * }>}
 */
async function buildDestinationInventory({
    items = [],
    accessToken,
    instanceUrl,
    chunkSize = DEFAULT_CHUNK_SIZE
} = {}) {
    const normalizedItems = normalizeItems(items);
    const inventory = new Map();

    if (!normalizedItems.length) {
        return {
            inventory,
            summary: createEmptySummary()
        };
    }

    if (!accessToken || !instanceUrl) {
        for (const item of normalizedItems) {
            const key = buildInventoryKey(
                item.metadataType,
                item.metadataName
            );

            inventory.set(
                key,
                createEntry({
                    metadataType: item.metadataType,
                    metadataName: item.metadataName,
                    state: DESTINATION_STATE.UNKNOWN,
                    warning:
                        'Missing destination credentials; existence not queried.'
                })
            );
        }

        return {
            inventory,
            summary: summarizeInventory(inventory)
        };
    }

    let apiVersion;

    try {
        apiVersion = await getLatestApiVersion(instanceUrl, accessToken);
    } catch (error) {
        const warning =
            error?.message ||
            'Unable to resolve Salesforce API version for destination inventory.';

        for (const item of normalizedItems) {
            const key = buildInventoryKey(
                item.metadataType,
                item.metadataName
            );

            inventory.set(
                key,
                createEntry({
                    metadataType: item.metadataType,
                    metadataName: item.metadataName,
                    state: DESTINATION_STATE.UNKNOWN,
                    warning
                })
            );
        }

        return {
            inventory,
            summary: summarizeInventory(inventory)
        };
    }

    const groups = groupItemsByType(normalizedItems);

    for (const [metadataType, typeItems] of groups.entries()) {
        const chunks = chunkArray(typeItems, chunkSize);

        for (const chunk of chunks) {
            const entries = await Promise.all(
                chunk.map((item) =>
                    querySingleExistence({
                        metadataType,
                        metadataName: item.metadataName,
                        instanceUrl,
                        accessToken,
                        apiVersion
                    })
                )
            );

            for (const entry of entries) {
                const key = buildInventoryKey(
                    entry.metadataType,
                    entry.metadataName
                );
                inventory.set(key, entry);
            }
        }
    }

    return {
        inventory,
        summary: summarizeInventory(inventory)
    };
}

/**
 * Read a single inventory state.
 *
 * @param {Map<string, object>|object|null} inventory
 * @param {string} metadataType
 * @param {string} metadataName
 * @returns {'EXISTS'|'MISSING'|'UNKNOWN'}
 */
function getState(inventory, metadataType, metadataName) {
    if (!metadataType || !metadataName) {
        return DESTINATION_STATE.UNKNOWN;
    }

    const key = buildInventoryKey(metadataType, metadataName);

    if (inventory instanceof Map) {
        return inventory.get(key)?.state || DESTINATION_STATE.UNKNOWN;
    }

    if (inventory && typeof inventory === 'object') {
        return inventory[key]?.state || DESTINATION_STATE.UNKNOWN;
    }

    return DESTINATION_STATE.UNKNOWN;
}

/**
 * Convert inventory to Dependency Resolution destinationStates Map shape.
 *
 * @param {Map<string, object>|null} inventory
 * @returns {Map<string, string>}
 */
function toDestinationStateMap(inventory) {
    const destinationStates = new Map();

    if (!(inventory instanceof Map)) {
        return destinationStates;
    }

    for (const [key, entry] of inventory.entries()) {
        destinationStates.set(
            key,
            entry?.state || DESTINATION_STATE.UNKNOWN
        );
    }

    return destinationStates;
}

module.exports = {
    DESTINATION_STATE,
    buildDestinationInventory,
    getState,
    toDestinationStateMap
};
