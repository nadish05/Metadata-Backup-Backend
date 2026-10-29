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

const BOUND_DEPLOY_CLAIM_STATE = Object.freeze({
    IN_PROGRESS: 'IN_PROGRESS',
    CONSUMED: 'CONSUMED',
    DEPLOY_FAILED: 'DEPLOY_FAILED',
    UNCERTAIN: 'UNCERTAIN'
});

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
        completedAt: null,
        boundDeployClaim: null
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
    if (job.boundDeployClaim === undefined) {
        job.boundDeployClaim = null;
    }

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
 * Synchronous compare-and-set claim for bound deploy (single Node process).
 * @returns {{ acquired: boolean, code?: string, message?: string, claim?: object }}
 */
function tryAcquireBoundDeployClaim(validationId, { historyId = null } = {}) {
    if (!validationId || typeof validationId !== 'string') {
        return {
            acquired: false,
            code: 'BOUND_VALIDATION_ID_REQUIRED',
            message: 'boundValidationId is required.'
        };
    }

    purgeExpiredJobs();

    const job = jobStore.get(validationId.trim());

    if (!job || job.status !== STATUS.COMPLETED) {
        return {
            acquired: false,
            code: 'BOUND_VALIDATION_NOT_FOUND',
            message:
                'Validation reference is unknown or has expired. Re-run check-only validation.'
        };
    }

    const existing = job.boundDeployClaim;

    if (existing?.state === BOUND_DEPLOY_CLAIM_STATE.IN_PROGRESS) {
        return {
            acquired: false,
            code: 'BOUND_DEPLOY_IN_PROGRESS',
            message:
                'A validation-bound deployment is already in progress for this validation.'
        };
    }

    if (existing?.state === BOUND_DEPLOY_CLAIM_STATE.CONSUMED) {
        return {
            acquired: false,
            code: 'BOUND_DEPLOY_CONSUMED',
            message:
                'This validated artifact has already been deployed and cannot be reused.'
        };
    }

    if (existing?.state === BOUND_DEPLOY_CLAIM_STATE.UNCERTAIN) {
        return {
            acquired: false,
            code: 'BOUND_DEPLOY_UNCERTAIN',
            message:
                'Previous bound deployment outcome is uncertain. Explicit reconciliation is required before retry.'
        };
    }

    if (
        existing?.state &&
        existing.state !== BOUND_DEPLOY_CLAIM_STATE.DEPLOY_FAILED
    ) {
        return {
            acquired: false,
            code: 'BOUND_DEPLOY_NOT_AVAILABLE',
            message: 'Validated artifact is not available for bound deployment.'
        };
    }

    const claim = {
        state: BOUND_DEPLOY_CLAIM_STATE.IN_PROGRESS,
        startedAt: nowIso(),
        historyId: historyId || null,
        leaseId: `bound_${crypto.randomUUID()}`
    };

    job.boundDeployClaim = claim;

    return { acquired: true, claim };
}

function finalizeBoundDeployClaim(validationId, outcome, details = {}) {
    const job = jobStore.get(validationId?.trim?.() || '');

    if (!job) {
        return null;
    }

    const previous = job.boundDeployClaim || {};
    const nextState =
        outcome === BOUND_DEPLOY_CLAIM_STATE.CONSUMED
            ? BOUND_DEPLOY_CLAIM_STATE.CONSUMED
            : outcome === BOUND_DEPLOY_CLAIM_STATE.UNCERTAIN
              ? BOUND_DEPLOY_CLAIM_STATE.UNCERTAIN
              : outcome === BOUND_DEPLOY_CLAIM_STATE.DEPLOY_FAILED
                ? BOUND_DEPLOY_CLAIM_STATE.DEPLOY_FAILED
                : null;

    if (!nextState) {
        return null;
    }

    job.boundDeployClaim = {
        ...previous,
        state: nextState,
        finishedAt: nowIso(),
        ...details
    };

    return job.boundDeployClaim;
}

function releaseBoundDeployClaimInProgress(validationId) {
    const job = jobStore.get(validationId?.trim?.() || '');

    if (!job?.boundDeployClaim) {
        return null;
    }

    if (job.boundDeployClaim.state !== BOUND_DEPLOY_CLAIM_STATE.IN_PROGRESS) {
        return job.boundDeployClaim;
    }

    job.boundDeployClaim = {
        state: BOUND_DEPLOY_CLAIM_STATE.DEPLOY_FAILED,
        finishedAt: nowIso(),
        releasedWithoutDeploy: true
    };

    return job.boundDeployClaim;
}

/**
 * Explicit reconciliation after UNCERTAIN (ops / support). Does not auto-run on retry.
 */
function reconcileBoundDeployClaim(validationId, resolution) {
    const job = jobStore.get(validationId?.trim?.() || '');

    if (!job?.boundDeployClaim) {
        return {
            ok: false,
            message: 'No bound deployment claim exists for this validation.'
        };
    }

    if (job.boundDeployClaim.state !== BOUND_DEPLOY_CLAIM_STATE.UNCERTAIN) {
        return {
            ok: false,
            message: 'Reconciliation is only allowed after an uncertain bound deployment outcome.'
        };
    }

    if (resolution === 'MARK_CONSUMED') {
        job.boundDeployClaim = {
            ...job.boundDeployClaim,
            state: BOUND_DEPLOY_CLAIM_STATE.CONSUMED,
            reconciledAt: nowIso(),
            reconciliation: 'MARK_CONSUMED'
        };
        return { ok: true, claim: job.boundDeployClaim };
    }

    if (resolution === 'MARK_DEPLOY_FAILED') {
        job.boundDeployClaim = {
            ...job.boundDeployClaim,
            state: BOUND_DEPLOY_CLAIM_STATE.DEPLOY_FAILED,
            reconciledAt: nowIso(),
            reconciliation: 'MARK_DEPLOY_FAILED'
        };
        return { ok: true, claim: job.boundDeployClaim };
    }

    return {
        ok: false,
        message:
            'Unsupported reconciliation resolution. Use MARK_CONSUMED or MARK_DEPLOY_FAILED.'
    };
}

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
                result: job.result,
                boundDeployClaim: job.boundDeployClaim || null
            }
        };
    }

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
    BOUND_DEPLOY_CLAIM_STATE,
    DEFAULT_TTL_MS,
    DEFAULT_MAX_AGE_MS,
    createJob,
    getJob,
    completeJob,
    failJob,
    tryAcquireBoundDeployClaim,
    finalizeBoundDeployClaim,
    releaseBoundDeployClaimInProgress,
    reconcileBoundDeployClaim,
    buildStatusResponse,
    getJobCount,
    clearAllJobs,
    purgeExpiredJobs,
    setTtlForTests,
    resetTtlForTests
};
