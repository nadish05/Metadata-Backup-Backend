const SEVERITY = Object.freeze({
    INFO: 'INFO',
    WARNING: 'WARNING',
    ERROR: 'ERROR',
    BLOCKER: 'BLOCKER'
});

const STATUS = Object.freeze({
    PASS: 'PASS',
    WARNING: 'WARNING',
    FAIL: 'FAIL',
    BLOCK: 'BLOCK'
});

function createFinding({
    id,
    metadataName,
    metadataType,
    ruleId,
    severity,
    status,
    reason,
    requiredBy = null,
    recommendedAction = null,
    blocking = false,
    source = 'DeploymentCompatibilityAnalyzer'
}) {
    return {
        id,
        metadataName,
        metadataType,
        ruleId,
        severity,
        status,
        reason,
        requiredBy,
        recommendedAction,
        blocking: blocking === true,
        source
    };
}

function createPassFinding({
    metadataName,
    metadataType,
    ruleId,
    reason,
    requiredBy = null
}) {
    return createFinding({
        id: `${ruleId}:${metadataType}:${metadataName}:PASS`,
        metadataName,
        metadataType,
        ruleId,
        severity: SEVERITY.INFO,
        status: STATUS.PASS,
        reason,
        requiredBy,
        recommendedAction: 'No action required.',
        blocking: false
    });
}

function createBlockFinding({
    metadataName,
    metadataType,
    ruleId,
    reason,
    requiredBy = null,
    recommendedAction = null
}) {
    return createFinding({
        id: `${ruleId}:${metadataType}:${metadataName}:BLOCK`,
        metadataName,
        metadataType,
        ruleId,
        severity: SEVERITY.BLOCKER,
        status: STATUS.BLOCK,
        reason,
        requiredBy,
        recommendedAction:
            recommendedAction ||
            'Include the missing metadata in the deployment package or remove the reference.',
        blocking: true
    });
}

module.exports = {
    SEVERITY,
    STATUS,
    createFinding,
    createPassFinding,
    createBlockFinding
};
