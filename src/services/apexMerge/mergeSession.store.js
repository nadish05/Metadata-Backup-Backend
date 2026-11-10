'use strict';

const crypto = require('crypto');

const SESSION_STATUS = Object.freeze({
    OPEN: 'OPEN',
    PREVIEWED: 'PREVIEWED',
    RESOLVED: 'RESOLVED',
    SEALED: 'SEALED'
});

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

const sessionStore = new Map();

let ttlMs = DEFAULT_TTL_MS;
let maxAgeMs = DEFAULT_MAX_AGE_MS;

function generateMergeSessionId() {
    return `merge_${crypto.randomUUID()}`;
}

function nowIso() {
    return new Date().toISOString();
}

function purgeExpiredSessions(referenceTime = Date.now()) {
    for (const [mergeSessionId, session] of sessionStore.entries()) {
        const createdMs = new Date(session.createdAt).getTime();
        const sealedMs = session.sealedAt
            ? new Date(session.sealedAt).getTime()
            : null;

        const ageMs = referenceTime - createdMs;
        if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
            sessionStore.delete(mergeSessionId);
            continue;
        }

        if (
            session.status === SESSION_STATUS.SEALED &&
            sealedMs !== null &&
            referenceTime - sealedMs > ttlMs
        ) {
            sessionStore.delete(mergeSessionId);
        }
    }
}

function createSessionRecord(session) {
    purgeExpiredSessions();
    const mergeSessionId = generateMergeSessionId();

    const record = {
        mergeSessionId,
        status: SESSION_STATUS.OPEN,
        createdAt: nowIso(),
        updatedAt: nowIso(),
        sealedAt: null,
        manifest: null,
        ...session
    };

    sessionStore.set(mergeSessionId, record);
    return record;
}

function getSession(mergeSessionId) {
    if (!mergeSessionId) {
        return null;
    }

    purgeExpiredSessions();
    return sessionStore.get(String(mergeSessionId).trim()) || null;
}

function updateSession(mergeSessionId, patch) {
    const session = getSession(mergeSessionId);

    if (!session) {
        return null;
    }

    const next = {
        ...session,
        ...patch,
        updatedAt: nowIso()
    };

    sessionStore.set(mergeSessionId, next);
    return next;
}

function sealSession(mergeSessionId, manifest) {
    return updateSession(mergeSessionId, {
        status: SESSION_STATUS.SEALED,
        sealedAt: nowIso(),
        manifest
    });
}

function clearAllSessions() {
    sessionStore.clear();
}

function setTtlForTests(nextTtlMs, nextMaxAgeMs) {
    if (Number.isFinite(nextTtlMs)) {
        ttlMs = nextTtlMs;
    }
    if (Number.isFinite(nextMaxAgeMs)) {
        maxAgeMs = nextMaxAgeMs;
    }
}

function resetTtlForTests() {
    ttlMs = DEFAULT_TTL_MS;
    maxAgeMs = DEFAULT_MAX_AGE_MS;
}

module.exports = {
    SESSION_STATUS,
    DEFAULT_TTL_MS,
    DEFAULT_MAX_AGE_MS,
    createSessionRecord,
    getSession,
    updateSession,
    sealSession,
    clearAllSessions,
    purgeExpiredSessions,
    setTtlForTests,
    resetTtlForTests
};
