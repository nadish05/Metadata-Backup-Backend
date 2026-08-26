'use strict';

/**
 * Schema decisions that are intentionally not implemented in P0-R7.4.
 * Do not invent fields or weaken uniqueness to paper over these gaps.
 */
const CONTROL_PLANE_SCHEMA_DECISIONS = Object.freeze({
    failedRetryScope: Object.freeze({
        status: 'STOP',
        claim: 'CONFIRMED',
        field: 'Rollback_Operation__c.Rollback_Scope_Key__c',
        current: 'unique + required + externalId on destinationOrgId|snapshotId',
        nodeRetry: 'FAILED → new operationId with retryOfOperationId, same dest+snapshot scope',
        decisionRequired:
            'Architecture-board field such as unique Active_Scope_Key__c, populated only while status is NOT_STARTED, IN_PROGRESS, SUCCEEDED, or UNKNOWN_RESULT, and cleared when FAILED so a historical FAILED row can remain while a new retry row is inserted. Do not remove Rollback_Scope_Key__c uniqueness. Do not change Node retry semantics.',
        implemented: false
    }),
    artifactIdFieldLength: Object.freeze({
        status: 'STOP',
        claim: 'CONFIRMED',
        field: 'Deployment_Snapshot_Member__c.Artifact_Id__c',
        current: 'Text(80)',
        nodeContract: 'snapshots/{snapshotId}/destination-before/{type}/{name} exceeds 80 with UUID snapshotIds',
        decisionRequired:
            'Lengthen Artifact_Id__c to at least 255 to match ContentVersion.Title. REST lookup uses Title; member field remains too short for canonical artifactIds.',
        implemented: false
    })
});

const LOCK_MULTI_REPLICA_PROOF = Object.freeze({
    status: 'UNPROVEN',
    productionDistributedReady: false,
    claim: 'UNPROVEN',
    apexTransaction:
        'DestinationOrgLockService.acquire uses Database.setSavepoint, SELECT ... FOR UPDATE on Destination_Org_Id__c, then insert or update. Unique Destination_Org_Id__c rejects duplicate inserts. HELD rows return CONFLICT without auto-steal.',
    forUpdate:
        'lockRow() queries Destination_Org_Lock__c WHERE Destination_Org_Id__c = :id LIMIT 1 FOR UPDATE.',
    uniqueConstraint: 'Destination_Org_Id__c is unique (existing object). Duplicate insert rolls back to CONFLICT when the winner is HELD.',
    concurrentRequests:
        'Same destination org DEPLOY+DEPLOY, DEPLOY+ROLLBACK, and ROLLBACK+ROLLBACK serialize at the Apex lock row. Different destination orgs use different unique keys and proceed independently. Mocked HTTP tests demonstrate adapter mapping only.',
    failureBehavior:
        'DmlException on duplicate → CONFLICT if existing is HELD; otherwise DUPLICATE_VALUE. Renew/release require matching ownerId and leaseGeneration. No auto-steal.',
    whyUnproven:
        'Salesforce FOR UPDATE atomicity across multiple Node replicas is not proven by live multi-replica Product Org tests in this phase. Mocked HTTP cannot execute Apex row locks.'
});

module.exports = {
    CONTROL_PLANE_SCHEMA_DECISIONS,
    LOCK_MULTI_REPLICA_PROOF
};
