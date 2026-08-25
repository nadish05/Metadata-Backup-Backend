'use strict';

const fs = require('fs');
const path = require('path');

const {
    assertSafeStorageKey,
    pathExistsSync,
    atomicWriteSync
} = require('../../utils/durableFileStore');
const {
    HistoryDuplicateError,
    HistoryStateError
} = require('../deploymentHistory.errors');

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

function createFileDeploymentHistoryStore({ rootDir } = {}) {
    if (!rootDir) {
        throw new HistoryStateError(
            'SNAPSHOT_DURABLE_ROOT is required for filesystem deployment history storage.'
        );
    }

    const historyRoot = path.join(rootDir, 'history');

    function historyFile(historyId) {
        assertSafeStorageKey(historyId, 'historyId');

        return path.join(historyRoot, `${historyId}.json`);
    }

    function lockFile(historyId) {
        return `${historyFile(historyId)}.lock`;
    }

    function readRecord(historyId) {
        const filePath = historyFile(historyId);

        if (!pathExistsSync(filePath)) {
            return null;
        }

        try {
            return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (error) {
            console.error('HISTORY_PERSISTENCE_FAILURE');
            console.error(
                JSON.stringify({
                    historyId,
                    reason: 'corrupt_or_unreadable_json'
                })
            );

            return null;
        }
    }

    function withLock(historyId, operation) {
        const lockPath = lockFile(historyId);
        const startedAt = Date.now();

        while (true) {
            try {
                fs.mkdirSync(path.dirname(lockPath), { recursive: true });
                fs.writeFileSync(lockPath, String(process.pid), { flag: 'wx' });
                break;
            } catch (error) {
                if (error.code !== 'EEXIST') {
                    throw error;
                }

                try {
                    const ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;

                    if (Number.isFinite(ageMs) && ageMs > 30000) {
                        fs.unlinkSync(lockPath);
                        continue;
                    }
                } catch (staleError) {
                    void staleError;
                }

                if (Date.now() - startedAt > 5000) {
                    throw new HistoryStateError(
                        `Timed out waiting for history lock: ${historyId}`
                    );
                }

                const waitUntil = Date.now() + 10;

                while (Date.now() < waitUntil) {
                    // brief spin wait for process-local / replica lock
                }
            }
        }

        try {
            return operation();
        } finally {
            try {
                fs.unlinkSync(lockPath);
            } catch (cleanupError) {
                void cleanupError;
            }
        }
    }

    function create(record) {
        const historyId = record?.historyId;
        const filePath = historyFile(historyId);

        return withLock(historyId, () => {
            if (pathExistsSync(filePath)) {
                throw new HistoryDuplicateError(historyId);
            }

            const stored = clone(record);

            try {
                atomicWriteSync(filePath, JSON.stringify(stored, null, 2), {
                    exclusive: true
                });
            } catch (error) {
                if (error && error.code === 'EEXIST') {
                    throw new HistoryDuplicateError(historyId);
                }

                throw error;
            }

            return clone(stored);
        });
    }

    function get(historyId) {
        try {
            const record = readRecord(historyId);

            return record ? clone(record) : null;
        } catch (error) {
            if (error instanceof TypeError) {
                return null;
            }

            throw error;
        }
    }

    function exists(historyId) {
        try {
            return pathExistsSync(historyFile(historyId));
        } catch (error) {
            if (error instanceof TypeError) {
                return false;
            }

            throw error;
        }
    }

    function update(historyId, record) {
        const filePath = historyFile(historyId);

        return withLock(historyId, () => {
            if (!pathExistsSync(filePath)) {
                return null;
            }

            const stored = clone(record);

            atomicWriteSync(filePath, JSON.stringify(stored, null, 2));

            return clone(stored);
        });
    }

    function list() {
        if (!pathExistsSync(historyRoot)) {
            return [];
        }

        const names = fs.readdirSync(historyRoot).filter((name) => {
            return name.endsWith('.json') && !name.endsWith('.tmp');
        });
        const records = [];

        for (const name of names) {
            const historyId = name.slice(0, -'.json'.length);

            try {
                assertSafeStorageKey(historyId, 'historyId');
            } catch (error) {
                continue;
            }

            const record = readRecord(historyId);

            if (record) {
                records.push(clone(record));
            }
        }

        return records;
    }

    function findBySnapshotId(snapshotId) {
        if (!snapshotId) {
            return null;
        }

        for (const record of list()) {
            if (record.snapshotId === snapshotId) {
                return record;
            }
        }

        return null;
    }

    function findBySalesforceDeploymentId(salesforceDeploymentId) {
        if (!salesforceDeploymentId) {
            return null;
        }

        for (const record of list()) {
            if (
                record.salesforceDeploymentId === salesforceDeploymentId ||
                record.deploymentId === salesforceDeploymentId
            ) {
                return record;
            }
        }

        return null;
    }

    return {
        create,
        get,
        exists,
        update,
        list,
        findBySnapshotId,
        findBySalesforceDeploymentId
    };
}

module.exports = {
    createFileDeploymentHistoryStore
};
