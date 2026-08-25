'use strict';

const {
    SALESFORCE_DEPLOY_STATUS,
    AUTHORITATIVE_EVIDENCE_SOURCE
} = require('./rollbackAuthorization.types');

function createUnavailableSalesforceDeployStatusService() {
    return {
        async getDeploymentStatus() {
            return Object.freeze({
                status: SALESFORCE_DEPLOY_STATUS.UNAVAILABLE,
                authoritative: false,
                source: AUTHORITATIVE_EVIDENCE_SOURCE.SALESFORCE_DEPLOY_STATUS,
                salesforceDeploymentId: null,
                message:
                    'Salesforce deployment status query is not implemented. Caller-supplied status is not authoritative.'
            });
        }
    };
}

function isAuthoritativeSalesforceEvidence(evidence) {
    return (
        evidence &&
        evidence.authoritative === true &&
        evidence.source === AUTHORITATIVE_EVIDENCE_SOURCE.SALESFORCE_DEPLOY_STATUS &&
        (evidence.status === SALESFORCE_DEPLOY_STATUS.SUCCEEDED ||
            evidence.status === SALESFORCE_DEPLOY_STATUS.FAILED) &&
        Boolean(evidence.salesforceDeploymentId)
    );
}

function createTestSalesforceDeployStatusService({
    status = SALESFORCE_DEPLOY_STATUS.UNAVAILABLE,
    salesforceDeploymentId = null,
    authoritative = false
} = {}) {
    return {
        async getDeploymentStatus() {
            return Object.freeze({
                status,
                authoritative:
                    authoritative &&
                    (status === SALESFORCE_DEPLOY_STATUS.SUCCEEDED ||
                        status === SALESFORCE_DEPLOY_STATUS.FAILED),
                source: AUTHORITATIVE_EVIDENCE_SOURCE.SALESFORCE_DEPLOY_STATUS,
                salesforceDeploymentId,
                message: 'Test Salesforce deploy status service.'
            });
        }
    };
}

module.exports = {
    createUnavailableSalesforceDeployStatusService,
    createTestSalesforceDeployStatusService,
    isAuthoritativeSalesforceEvidence
};
