/**
 * In-memory Deployment Validation job/result store.
 *
 * Isolated from migration/retrieval status.store.js (global string).
 * Stores full validateDeployment() results for async start/status polling.
 */

'use strict';

const crypto = require('crypto');

const STATUS = {
    RUNNING: 'RUNNING',
    COMPLETED: 'COMPLETED',
    FAILED: 'FAILED'
};

/** Completed/failed jobs older than this are eligible for cleanup. */
const DEFAULT_TTL_MS = 60 * 60 * 1000; // 1 hour

/** Absolute max age for any job (including RUNNING). */
const DEFAULT_MAX_AGE_MS = 6 * 60 * 60 * 1000; // 6 hours

const jobStore = new Map();

let ttlMs = DEFAULT_TTL_MS;
let maxAgeMs = DEFAULT_MAX_AGE_MS;

function generateValidationId() {
    return `validation_${crypto.randomUUID()}`;
}

function nowIso() {
    return new Date().toISOString();
}

function purgeExpiredJobs(referenceTime = Date.now()) {
    for (const [validationId, job] of jobStore.entries()) {
        const createdMs = new Date(job.createdAt).getTime();
        const completedMs = job.completedAt
            ? new Date(job.completedAt).getTime()
            : null;

        const ageMs = referenceTime - createdMs;
        if (Number.isFinite(ageMs) && ageMs > maxAgeMs) {
            jobStore.delete(validationId);
            continue;
        }

        if (
            job.status !== STATUS.RUNNING &&
            completedMs !== null &&
            Number.isFinite(completedMs) &&
            referenceTime - completedMs > ttlMs
        ) {
            jobStore.delete(validationId);
        }
    }
}

function createJob() {
    purgeExpiredJobs();

    const validationId = generateValidationId();
    const job = {
        validationId,
        status: STATUS.RUNNING,
        result: null,
        error: null,
        createdAt: nowIso(),
        completedAt: null
    };

    jobStore.set(validationId, job);
    return validationId;
}

function getJob(validationId) {
    if (!validationId || typeof validationId !== 'string') {
        return null;
    }

    purgeExpiredJobs();

    const job = jobStore.get(validationId.trim());
    return job || null;
}

function completeJob(validationId, result) {
    const job = jobStore.get(validationId);

    if (!job) {
        return null;
    }

    job.status = STATUS.COMPLETED;
    job.result = result;
    job.error = null;
    job.completedAt = nowIso();

    return job;
}

function failJob(validationId, error) {
    const job = jobStore.get(validationId);

    if (!job) {
        return null;
    }

    const message =
        error && typeof error === 'object' && error.message
            ? String(error.message)
            : error
              ? String(error)
              : 'Deployment validation failed.';

    job.status = STATUS.FAILED;
    job.error = message;
    // Preserve a result object only when the rejection already carried one.
    if (
        error &&
        typeof error === 'object' &&
        error.result !== undefined &&
        error.result !== null
    ) {
        job.result = error.result;
    }
    job.completedAt = nowIso();

    return job;
}

/**
 * Build the HTTP status payload for a validation job.
 * @returns {{ found: false } | { found: true, body: object }}
 */
function buildStatusResponse(validationId) {
    const job = getJob(validationId);

    if (!job) {
        return { found: false };
    }

    if (job.status === STATUS.RUNNING) {
        return {
            found: true,
            body: {
                success: true,
                status: STATUS.RUNNING,
                validationId: job.validationId
            }
        };
    }

    if (job.status === STATUS.COMPLETED) {
        return {
            found: true,
            body: {
                success: true,
                status: STATUS.COMPLETED,
                validationId: job.validationId,
                result: job.result
            }
        };
    }

    // FAILED
    const body = {
        success: true,
        status: STATUS.FAILED,
        validationId: job.validationId,
        error: job.error || 'Deployment validation failed.'
    };

    if (job.result !== null && job.result !== undefined) {
        body.result = job.result;
    }

    return { found: true, body };
}

function getJobCount() {
    return jobStore.size;
}

/** Test / ops helper — clears all jobs. */
function clearAllJobs() {
    jobStore.clear();
}

function setTtlForTests(nextTtlMs, nextMaxAgeMs) {
    if (Number.isFinite(nextTtlMs) && nextTtlMs > 0) {
        ttlMs = nextTtlMs;
    }
    if (Number.isFinite(nextMaxAgeMs) && nextMaxAgeMs > 0) {
        maxAgeMs = nextMaxAgeMs;
    }
}

function resetTtlForTests() {
    ttlMs = DEFAULT_TTL_MS;
    maxAgeMs = DEFAULT_MAX_AGE_MS;
}

module.exports = {
    STATUS,
    DEFAULT_TTL_MS,
    DEFAULT_MAX_AGE_MS,
    createJob,
    getJob,
    completeJob,
    failJob,
    buildStatusResponse,
    getJobCount,
    clearAllJobs,
    purgeExpiredJobs,
    setTtlForTests,
    resetTtlForTests
};
