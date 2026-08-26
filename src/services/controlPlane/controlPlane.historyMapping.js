'use strict';

const { sanitizeHistoryRecord } = require('../deploymentHistory.sanitize');

function toSalesforceHistoryPayload(record) {
    const sanitized = sanitizeHistoryRecord(record) || {};

    return {
        historyId: sanitized.historyId || null,
        snapshotId: sanitized.snapshotId || null,
        rollbackOfHistoryId: sanitized.rollbackOfHistoryId || null,
        deploymentId: sanitized.deploymentId || sanitized.salesforceDeploymentId || null,
        deploymentMode: sanitized.deploymentMode || null,
        executionMode: sanitized.executionMode || null,
        status: sanitized.status || null,
        validationStatus: sanitized.validationStatus || null,
        startedAt: sanitized.startedAt || null,
        completedAt: sanitized.completedAt || null,
        duration: sanitized.duration || null,
        durationMilliseconds: sanitized.durationMilliseconds || null,
        cliVersion: sanitized.cliVersion || null,
        cliCommand: sanitized.cliCommand || null,
        deploymentMessage: sanitized.deploymentMessage || null,
        deploymentPlanId: sanitized.deploymentPlanId || null,
        metadataComparisonId: sanitized.metadataComparisonId || null,
        sourceOrgId: sanitized.sourceOrgId || null,
        destinationOrgId: sanitized.destinationOrgId || null,
        sourceBranch: sanitized.sourceBranch || null,
        destinationBranch: sanitized.destinationBranch || null,
        repoUrl: sanitized.repoUrl || null,
        workspacePath: sanitized.workspacePath || null,
        deploymentSummary: sanitized.deploymentSummary || null,
        validationSummary: sanitized.validationSummary || null,
        summary: sanitized.summary || null,
        timeline: sanitized.timeline || null,
        failureDetails: sanitized.failureDetails || null,
        warnings: sanitized.warnings || null,
        errors: sanitized.errors || null,
        testResults: sanitized.testResults || null,
        cliCompatibility: sanitized.cliCompatibility || null,
        metadataSummary: sanitized.metadataSummary || null,
        manifestSummary: sanitized.manifestSummary || null,
        workspaceSummary: sanitized.workspaceSummary || null
    };
}

module.exports = {
    toSalesforceHistoryPayload
};
