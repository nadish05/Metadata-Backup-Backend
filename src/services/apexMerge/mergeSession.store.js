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
        if (isSessionExpired(session, referenceTime)) {
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

function computeSessionExpiryMs(session, referenceTime = Date.now()) {
    if (!session) {
        return referenceTime;
    }

    const createdMs = new Date(session.createdAt).getTime();
    const sealedMs = session.sealedAt
        ? new Date(session.sealedAt).getTime()
        : null;

    const maxAgeExpiry = Number.isFinite(createdMs)
        ? createdMs + maxAgeMs
        : referenceTime + maxAgeMs;
    const sealedExpiry =
        session.status === SESSION_STATUS.SEALED && sealedMs !== null
            ? sealedMs + ttlMs
            : maxAgeExpiry;

    return Math.min(maxAgeExpiry, sealedExpiry);
}

function isSessionExpired(session, referenceTime = Date.now()) {
    if (!session) {
        return true;
    }

    const createdMs = new Date(session.createdAt).getTime();
    const sealedMs = session.sealedAt
        ? new Date(session.sealedAt).getTime()
        : null;

    const ageMs = referenceTime - createdMs;
    if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
        return true;
    }

    if (
        session.status === SESSION_STATUS.SEALED &&
        sealedMs !== null &&
        referenceTime - sealedMs > ttlMs
    ) {
        return true;
    }

    return false;
}

function readSessionRaw(mergeSessionId) {
    if (!mergeSessionId) {
        return null;
    }

    return sessionStore.get(String(mergeSessionId).trim()) || null;
}

function purgeSession(mergeSessionId) {
    if (!mergeSessionId) {
        return;
    }

    sessionStore.delete(String(mergeSessionId).trim());
}

function getSession(mergeSessionId) {
    if (!mergeSessionId) {
        return null;
    }

    purgeExpiredSessions();
    const session = readSessionRaw(mergeSessionId);

    if (session && isSessionExpired(session)) {
        purgeSession(mergeSessionId);
        return null;
    }

    return session;
}

function patchSessionRaw(mergeSessionId, patch) {
    const session = readSessionRaw(mergeSessionId);

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
    readSessionRaw,
    patchSessionRaw,
    isSessionExpired,
    purgeSession,
    computeSessionExpiryMs,
    getSessionTtlMs: () => ttlMs,
    getSessionMaxAgeMs: () => maxAgeMs,
    setTtlForTests,
    resetTtlForTests
};
