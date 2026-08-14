/**
 * Async Deployment Validation orchestration.
 *
 * Starts the EXISTING validateDeployment() in the background and exposes
 * status polling. Does not alter validation internals.
 */

'use strict';

const deploymentValidationStatusStore = require('./deploymentValidationStatus.store');
const deploymentValidationService = require('./deploymentValidation.service');

let runValidation =
    deploymentValidationService.validateDeployment.bind(
        deploymentValidationService
    );

/**
 * Start validation in the background. Returns immediately with validationId.
 * @param {object} args Same arguments as validateDeployment(...)
 * @returns {{ success: true, accepted: true, status: 'RUNNING', validationId: string }}
 */
function startValidation(args) {
    const validationId = deploymentValidationStatusStore.createJob();

    Promise.resolve()
        .then(() => runValidation(args))
        .then((result) => {
            deploymentValidationStatusStore.completeJob(validationId, result);
        })
        .catch((error) => {
            console.error('ASYNC DEPLOYMENT VALIDATION ERROR');
            console.error(error);
            deploymentValidationStatusStore.failJob(validationId, error);
        });

    return {
        success: true,
        accepted: true,
        status: deploymentValidationStatusStore.STATUS.RUNNING,
        validationId
    };
}

/**
 * @param {string} validationId
 * @returns {{ found: false } | { found: true, body: object }}
 */
function getValidationStatus(validationId) {
    return deploymentValidationStatusStore.buildStatusResponse(validationId);
}

/** Test-only: inject a stub for validateDeployment. */
function setRunValidationForTests(fn) {
    if (typeof fn !== 'function') {
        throw new Error('setRunValidationForTests requires a function');
    }
    runValidation = fn;
}

/** Test-only: restore the real validateDeployment binding. */
function resetRunValidationForTests() {
    runValidation = deploymentValidationService.validateDeployment.bind(
        deploymentValidationService
    );
}

module.exports = {
    startValidation,
    getValidationStatus,
    setRunValidationForTests,
    resetRunValidationForTests
};
