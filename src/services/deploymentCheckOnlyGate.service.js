/**
 * Deployment Check-Only Safety Gate
 *
 * Enforces: actual deployment is allowed only when Salesforce check-only
 * has actually executed and succeeded.
 *
 * Does not change package generation, CLI commands, classification,
 * or pre-validation skip (Phase 11.4) behavior.
 */

const CHECK_ONLY_EXECUTION_STATE = Object.freeze({
    SUCCESS: 'CHECK_ONLY_SUCCESS',
    FAILURE: 'CHECK_ONLY_FAILURE',
    NOT_EXECUTED: 'CHECK_ONLY_NOT_EXECUTED',
    UNKNOWN: 'CHECK_ONLY_UNKNOWN'
});

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

/**
 * Annotate a result returned from runCheckOnlyDeployment as executed.
 * Does not alter success/status/diagnostics.
 */
function annotateCheckOnlyExecuted(result) {
    if (!result || typeof result !== 'object') {
        return result;
    }

    return {
        ...result,
        executed: true
    };
}

/**
 * Explicit NOT_EXECUTED payload when Phase 11.4 (or equivalent) skips CLI.
 * Not a fabricated Salesforce failure.
 */
function buildCheckOnlyNotExecutedResult(reason) {
    const message =
        reason ||
        'Pre-validation blocked check-only execution.';

    return {
        executed: false,
        deploymentId: null,
        status: 'NOT_EXECUTED',
        success: false,
        startTime: null,
        endTime: null,
        duration: null,
        componentSuccesses: 0,
        componentFailures: 0,
        failureDetails: [],
        deploymentDiagnostics: null,
        testResults: {
            testsRun: 0,
            testsFailed: 0,
            failingTests: []
        },
        codeCoverage: {
            overallCoverage: 0
        },
        warnings: [],
        deploymentSummary: {
            componentsValidated: 0,
            componentsFailed: 0,
            testsRun: 0,
            testsFailed: 0,
            overallCoverage: 0,
            deploymentStatus: 'NotExecuted',
            success: false
        },
        message,
        skipReason: message,
        cliCommand: null,
        cliVersion: null,
        executionMode: null
    };
}

function resolveCheckOnlyExecutionState(checkOnlyDeployment) {
    if (checkOnlyDeployment == null) {
        return CHECK_ONLY_EXECUTION_STATE.UNKNOWN;
    }

    if (typeof checkOnlyDeployment !== 'object') {
        return CHECK_ONLY_EXECUTION_STATE.UNKNOWN;
    }

    if (
        checkOnlyDeployment.executed === false ||
        String(checkOnlyDeployment.status || '').toUpperCase() === 'NOT_EXECUTED'
    ) {
        return CHECK_ONLY_EXECUTION_STATE.NOT_EXECUTED;
    }

    if (checkOnlyDeployment.success === true) {
        return CHECK_ONLY_EXECUTION_STATE.SUCCESS;
    }

    const status = String(checkOnlyDeployment.status || '')
        .trim()
        .toUpperCase();

    if (status === 'SUCCESS' || status === 'SUCCEEDED') {
        return CHECK_ONLY_EXECUTION_STATE.SUCCESS;
    }

    if (
        checkOnlyDeployment.executed === true ||
        checkOnlyDeployment.success === false ||
        status === 'FAILED' ||
        status === 'BLOCKED' ||
        status === 'FAILEDPARTIAL' ||
        status === 'SUCCEEDEDPARTIAL' ||
        Object.prototype.hasOwnProperty.call(checkOnlyDeployment, 'status') ||
        Object.prototype.hasOwnProperty.call(checkOnlyDeployment, 'success')
    ) {
        // SucceededPartial maps to non-success via mapDeployStatus; treat as failure.
        if (status === 'SUCCESS' || status === 'SUCCEEDED') {
            return CHECK_ONLY_EXECUTION_STATE.SUCCESS;
        }

        return CHECK_ONLY_EXECUTION_STATE.FAILURE;
    }

    return CHECK_ONLY_EXECUTION_STATE.UNKNOWN;
}

function isCheckOnlySuccess(checkOnlyDeployment) {
    return (
        resolveCheckOnlyExecutionState(checkOnlyDeployment) ===
        CHECK_ONLY_EXECUTION_STATE.SUCCESS
    );
}

/**
 * Actual deployment may run only when mode is DEPLOY, existing canDeploy
 * remains true, and Salesforce check-only executed successfully.
 */
function shouldAllowActualDeployment({
    deploymentMode,
    checkOnlyDeployment,
    canDeploy
} = {}) {
    if (String(deploymentMode || '').toUpperCase() !== 'DEPLOY') {
        return false;
    }

    if (canDeploy === false) {
        return false;
    }

    return isCheckOnlySuccess(checkOnlyDeployment);
}

function buildActualDeploymentBlockedMessage(checkOnlyDeployment) {
    const state = resolveCheckOnlyExecutionState(checkOnlyDeployment);

    if (state === CHECK_ONLY_EXECUTION_STATE.NOT_EXECUTED) {
        return 'Actual deployment blocked: Salesforce check-only was not executed.';
    }

    if (state === CHECK_ONLY_EXECUTION_STATE.UNKNOWN) {
        return 'Actual deployment blocked: Salesforce check-only result is missing or unknown.';
    }

    if (state === CHECK_ONLY_EXECUTION_STATE.FAILURE) {
        return 'Actual deployment blocked: Salesforce check-only did not succeed.';
    }

    return 'Actual deployment blocked: Salesforce check-only gate failed.';
}

function logCheckOnlySkipped(reason) {
    logSection('CHECK-ONLY SKIPPED');
    console.log(
        'Reason:',
        reason || 'Pre-validation blocked check-only execution.'
    );
}

module.exports = {
    CHECK_ONLY_EXECUTION_STATE,
    annotateCheckOnlyExecuted,
    buildCheckOnlyNotExecutedResult,
    resolveCheckOnlyExecutionState,
    isCheckOnlySuccess,
    shouldAllowActualDeployment,
    buildActualDeploymentBlockedMessage,
    logCheckOnlySkipped
};
