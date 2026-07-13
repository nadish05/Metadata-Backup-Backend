const {
    postToApplicationOrgApex
} = require('./applicationOrgRest.service');

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function valueOrNull(value) {
    return value === undefined ? null : value;
}

function resolveDurationMilliseconds(startedAt, completedAt) {
    if (!startedAt || !completedAt) {
        return null;
    }

    const startMs = new Date(startedAt).getTime();
    const endMs = new Date(completedAt).getTime();

    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) {
        return null;
    }

    return endMs - startMs;
}

function buildFailedResult(message, httpStatus = null) {
    return {
        success: false,
        salesforceRecordId: null,
        status: 'FAILED',
        message:
            message ||
            'Unable to synchronize deployment history to Salesforce.',
        httpStatus
    };
}

function buildSuccessResult(recordId, httpStatus = 200) {
    return {
        success: true,
        salesforceRecordId: recordId || null,
        status: 'SUCCESS',
        message: 'Deployment history synchronized to Salesforce.',
        httpStatus
    };
}

function buildApexPayload({
    deploymentHistory,
    deploymentSummary,
    validationSummary,
    generatedPackage,
    generatedManifest,
    generatedWorkspace,
    deploymentMode,
    destinationOrgId
}) {
    const history = deploymentHistory || {};
    const summary =
        deploymentSummary !== undefined
            ? deploymentSummary
            : history.deploymentSummary;
    const validation =
        validationSummary !== undefined
            ? validationSummary
            : history.validationSummary;
    const packageSummary =
        generatedPackage?.summary !== undefined
            ? generatedPackage.summary
            : history.metadataSummary;
    const manifestSummary =
        generatedManifest?.summary !== undefined
            ? generatedManifest.summary
            : history.manifestSummary;
    const workspaceSummary =
        generatedWorkspace
            ? {
                  workspaceCreated:
                      generatedWorkspace.workspaceCreated === true,
                  workspacePath: generatedWorkspace.workspacePath || null,
                  status: generatedWorkspace.status || null,
                  metadataCopied: generatedWorkspace.metadataCopied ?? null,
                  dependenciesCopied:
                      generatedWorkspace.dependenciesCopied ?? null,
                  copiedFiles: generatedWorkspace.copiedFiles ?? null,
                  workspaceSize: generatedWorkspace.workspaceSize || null,
                  missingFiles: generatedWorkspace.missingFiles || []
              }
            : history.workspaceSummary;

    return {
        historyId: valueOrNull(history.historyId),
        deploymentId: valueOrNull(history.deploymentId),
        deploymentMode: valueOrNull(
            deploymentMode || history.deploymentMode
        ),
        executionMode: valueOrNull(history.executionMode),
        status: valueOrNull(history.status),
        validationStatus: valueOrNull(validation?.overallStatus),
        startedAt: valueOrNull(history.startedAt),
        completedAt: valueOrNull(history.completedAt),
        duration: valueOrNull(history.duration),
        durationMilliseconds: resolveDurationMilliseconds(
            history.startedAt,
            history.completedAt
        ),
        cliVersion: valueOrNull(history.cliVersion),
        cliCommand: valueOrNull(history.cliCommand),
        deploymentMessage: valueOrNull(history.deploymentMessage),
        deploymentSummary: valueOrNull(summary),
        validationSummary: valueOrNull(validation),
        timeline: Array.isArray(history.timeline) ? history.timeline : null,
        warnings: Array.isArray(history.warnings) ? history.warnings : null,
        errors: Array.isArray(history.errors) ? history.errors : null,
        failureDetails: valueOrNull(history.failureDetails),
        testResults: valueOrNull(history.testResults),
        cliCompatibility: valueOrNull(history.cliCompatibility),
        metadataSummary: valueOrNull(packageSummary),
        manifestSummary: valueOrNull(manifestSummary),
        workspaceSummary: valueOrNull(workspaceSummary),
        deploymentPlanId: valueOrNull(history.deploymentPlanId),
        metadataComparisonId: valueOrNull(history.metadataComparisonId),
        sourceOrgId: valueOrNull(history.sourceOrgId),
        destinationOrgId: valueOrNull(
            history.destinationOrgId || destinationOrgId
        )
    };
}

/**
 * Persist completed deployment history to the APPLICATION Salesforce Org.
 *
 * Destination org credentials must NEVER be used here.
 * Destination org receives metadata deploys only.
 */
async function syncDeploymentHistory({
    deploymentHistory,
    deploymentSummary,
    validationSummary,
    generatedPackage,
    generatedManifest,
    generatedWorkspace,
    deploymentMode,
    connectedOrg
} = {}) {
    logSection('History Synchronization Started');

    try {
        if (!deploymentHistory?.historyId) {
            logSection('History Synchronization Failed');
            return buildFailedResult(
                'Unable to synchronize deployment history to Salesforce.'
            );
        }

        const payload = buildApexPayload({
            deploymentHistory,
            deploymentSummary,
            validationSummary,
            generatedPackage,
            generatedManifest,
            generatedWorkspace,
            deploymentMode,
            destinationOrgId: connectedOrg?.orgId ?? null
        });

        logSection('Calling Salesforce Apex');

        const apexResult = await postToApplicationOrgApex(
            '/services/apexrest/deployment-history',
            payload
        );

        if (!apexResult.success) {
            logSection('History Synchronization Failed');
            return buildFailedResult(
                apexResult.message ||
                    'Unable to synchronize deployment history to Salesforce.',
                apexResult.httpStatus
            );
        }

        if (apexResult.url) {
            console.log('Deployment History Sync URL:', apexResult.url);
        }

        const body = apexResult.data || {};

        if (body.success === true) {
            logSection('History Synchronization Complete');
            return buildSuccessResult(
                body.recordId || null,
                apexResult.httpStatus
            );
        }

        logSection('History Synchronization Failed');
        return buildFailedResult(
            body.message ||
                'Unable to synchronize deployment history to Salesforce.',
            apexResult.httpStatus
        );
    } catch (error) {
        console.error('HISTORY SYNCHRONIZATION ERROR');
        console.error(error.response?.data || error.message || error);

        logSection('History Synchronization Failed');

        return buildFailedResult(
            'Unable to synchronize deployment history to Salesforce.',
            error.response?.status || null
        );
    }
}

module.exports = {
    syncDeploymentHistory
};
