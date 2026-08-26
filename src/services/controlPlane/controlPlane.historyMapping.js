'use strict';

const { sanitizeHistoryRecord } = require('../deploymentHistory.sanitize');
const { sfField, toIso, toNumber, toText } = require('./controlPlane.record');

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

function parseJsonField(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    if (typeof value !== 'string') {
        return value;
    }

    try {
        return JSON.parse(value);
    } catch (error) {
        return value;
    }
}

function fromSalesforceHistoryRecord(record) {
    if (!record) {
        return null;
    }

    const historyId = toText(sfField(record, 'Backend_History_Id__c', 'historyId'));
    const deploymentId = toText(
        sfField(record, 'Deployment_ID__c', 'deploymentId', 'salesforceDeploymentId')
    );

    return sanitizeHistoryRecord({
        historyId,
        snapshotId: toText(sfField(record, 'Snapshot_Id__c', 'snapshotId')),
        rollbackOfHistoryId: toText(
            sfField(record, 'Rollback_Of_History_Id__c', 'rollbackOfHistoryId')
        ),
        deploymentId,
        salesforceDeploymentId: deploymentId,
        deploymentMode: toText(sfField(record, 'Deployment_Mode__c', 'deploymentMode')),
        executionMode: toText(sfField(record, 'Execution_Mode__c', 'executionMode')),
        status: toText(sfField(record, 'Deployment_Status__c', 'status')),
        validationStatus: toText(
            sfField(record, 'Validation_Status__c', 'validationStatus')
        ),
        startedAt: toIso(sfField(record, 'Started_At__c', 'startedAt')),
        completedAt: toIso(sfField(record, 'Completed_At__c', 'completedAt')),
        duration: toText(sfField(record, 'Duration_Display__c', 'duration')),
        durationMilliseconds: toNumber(
            sfField(record, 'Duration_Milliseconds__c', 'durationMilliseconds')
        ),
        cliVersion: toText(sfField(record, 'CLI_Version__c', 'cliVersion')),
        cliCommand: toText(sfField(record, 'CLI_Command__c', 'cliCommand')),
        deploymentMessage: toText(
            sfField(record, 'Deployment_Message__c', 'deploymentMessage')
        ),
        deploymentSummary: parseJsonField(
            sfField(record, 'Deployment_Summary__c', 'deploymentSummary')
        ),
        validationSummary: parseJsonField(
            sfField(record, 'Validation_Summary__c', 'validationSummary')
        ),
        timeline: parseJsonField(sfField(record, 'Timeline__c', 'timeline')),
        failureDetails: parseJsonField(
            sfField(record, 'Failure_Details__c', 'failureDetails')
        ),
        testResults: parseJsonField(sfField(record, 'Test_Results__c', 'testResults')),
        cliCompatibility: parseJsonField(
            sfField(record, 'CLI_Compatibility__c', 'cliCompatibility')
        ),
        salesforceRecordId: toText(sfField(record, 'Id', 'recordId', 'salesforceRecordId'))
    });
}

module.exports = {
    fromSalesforceHistoryRecord,
    toSalesforceHistoryPayload
};
