const { getRegisteredCompatibilityRules } = require('./registry');
const { buildAvailabilityIndex } = require('./availabilityIndex');
const { STATUS } = require('./compatibilityModel');

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function collectMetadataChecked({
    selectedMetadata = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    resolvedDependencies = []
}) {
    const keys = new Set();

    function add(type, name) {
        if (type && name) {
            keys.add(`${type}:${name}`);
        }
    }

    for (const item of selectedMetadata) {
        add(item.metadataType || item.type, item.metadataName || item.name);
    }

    for (const item of discoveredRelationships) {
        add(item.metadataType || item.type, item.name);
    }

    for (const item of discoveredReferences) {
        add(item.metadataType || item.type, item.name);
    }

    for (const item of resolvedDependencies) {
        add(item.metadataType || item.type, item.name);
    }

    return keys.size;
}

function buildSummary({ rulesExecuted, findings, metadataChecked }) {
    return {
        rulesExecuted,
        findings: findings.length,
        warnings: findings.filter((finding) => finding.status === STATUS.WARNING)
            .length,
        blockers: findings.filter(
            (finding) =>
                finding.status === STATUS.BLOCK || finding.blocking === true
        ).length,
        metadataChecked
    };
}

function resolveOverallCompatibility(findings) {
    if (
        findings.some(
            (finding) =>
                finding.status === STATUS.BLOCK || finding.blocking === true
        )
    ) {
        return 'BLOCKED';
    }

    if (findings.some((finding) => finding.status === STATUS.FAIL)) {
        return 'FAILED';
    }

    if (findings.some((finding) => finding.status === STATUS.WARNING)) {
        return 'WARNING';
    }

    return 'PASS';
}

function findNodeContext(finding, context) {
    const metadataType = finding?.metadataType || null;
    const metadataName = finding?.metadataName || null;

    if (!metadataType || !metadataName) {
        return {
            deployDecision: null,
            artifactResolved: null,
            sourceExists: null
        };
    }

    const collections = [
        ...(context.resolvedDependencies || []),
        ...(context.selectedMetadata || []),
        ...(context.discoveredReferences || []),
        ...(context.discoveredRelationships || [])
    ];

    const match = collections.find((item) => {
        const type = item?.metadataType || item?.type;
        const name = item?.metadataName || item?.name;
        return type === metadataType && name === metadataName;
    });

    return {
        deployDecision: match?.action || null,
        artifactResolved:
            match?.artifactResolved != null ? match.artifactResolved : null,
        sourceExists: match?.sourceExists != null ? match.sourceExists : null
    };
}

function isBlockingFinding(finding) {
    return (
        finding?.status === STATUS.BLOCK ||
        finding?.status === STATUS.FAIL ||
        finding?.blocking === true
    );
}

/**
 * DEBUG ONLY — temporary diagnostics for Compatibility BLOCKED root cause.
 * Does not change findings or overall compatibility.
 */
function logCompatibilityDiagnostics(findings, context, overallCompatibility) {
    for (const finding of findings) {
        const nodeContext = findNodeContext(finding, context);

        console.log('----------------------------------------');
        console.log('Compatibility Evaluation');
        console.log('----------------------------------------');
        console.log('Metadata Type:');
        console.log(finding.metadataType);
        console.log('Metadata Name:');
        console.log(finding.metadataName);
        console.log('Deploy Decision:');
        console.log(nodeContext.deployDecision);
        console.log('artifactResolved:');
        console.log(nodeContext.artifactResolved);
        console.log('sourceExists:');
        console.log(nodeContext.sourceExists);
        console.log('Blocking:');
        console.log(isBlockingFinding(finding));
        console.log('Reason:');
        console.log(finding.reason);
    }

    const blockingFindings = findings.filter(isBlockingFinding);

    console.log('========================================');
    console.log('COMPATIBILITY SUMMARY');
    console.log('========================================');
    console.log('Blocking Nodes:');

    if (!blockingFindings.length) {
        console.log('(none)');
    } else {
        for (const finding of blockingFindings) {
            const nodeContext = findNodeContext(finding, context);

            console.log('metadataType');
            console.log(finding.metadataType);
            console.log('metadataName');
            console.log(finding.metadataName);
            console.log('deployDecision');
            console.log(nodeContext.deployDecision);
            console.log('artifactResolved');
            console.log(nodeContext.artifactResolved);
            console.log('sourceExists');
            console.log(nodeContext.sourceExists);
            console.log('ruleName');
            console.log(finding.ruleId);
            console.log('reason');
            console.log(finding.reason);
            console.log('----------------------------------------');
        }
    }

    console.log('Deployment blocked because of:');

    if (
        overallCompatibility === 'BLOCKED' ||
        overallCompatibility === 'FAILED'
    ) {
        if (!blockingFindings.length) {
            console.log('(no blocking findings found)');
        } else {
            for (const finding of blockingFindings) {
                console.log(
                    `${finding.metadataType}:${finding.metadataName}`
                );
            }
        }
    } else {
        console.log('(not blocked)');
    }
}

function logFindings(findings, summary, overallCompatibility) {
    console.log('Metadata checked:', summary.metadataChecked);
    console.log('Rules executed:', summary.rulesExecuted);
    console.log('Warnings:', summary.warnings);
    console.log('Errors:', findings.filter((f) => f.status === STATUS.FAIL).length);
    console.log('Blockers:', summary.blockers);
    console.log('Compatibility status:', overallCompatibility);

    for (const finding of findings) {
        console.log('------------------------------------');
        console.log('Rule:', finding.ruleId);
        console.log(
            'Metadata:',
            `${finding.metadataType}:${finding.metadataName}`
        );
        console.log('Status:', finding.status);
        console.log('Reason:', finding.reason);
        console.log('Recommended Action:', finding.recommendedAction);
    }

    logSection('Deployment Compatibility Analyzer Summary');
}

/**
 * Analyze deployment compatibility.
 * Read-only — never modifies metadata, packages, or decisions.
 *
 * @param {{
 *   selectedMetadata?: Array,
 *   discoveredRelationships?: Array,
 *   discoveredReferences?: Array,
 *   resolvedDependencies?: Array
 * }} options
 */
function analyzeDeploymentCompatibility({
    selectedMetadata = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    resolvedDependencies = []
} = {}) {
    logSection('Deployment Compatibility Analyzer');

    const rules = getRegisteredCompatibilityRules();
    const availability = buildAvailabilityIndex({
        selectedMetadata,
        resolvedDependencies,
        discoveredRelationships
    });

    const context = {
        selectedMetadata,
        discoveredRelationships,
        discoveredReferences,
        resolvedDependencies,
        availability
    };

    const findings = [];
    const executedRuleIds = [];

    for (const rule of rules) {
        if (!rule.applies(context)) {
            continue;
        }

        executedRuleIds.push(rule.id);

        try {
            const ruleFindings = rule.analyze(context) || [];
            findings.push(...ruleFindings);
        } catch (error) {
            findings.push({
                id: `${rule.id}:ERROR`,
                metadataName: null,
                metadataType: null,
                ruleId: rule.id,
                severity: 'ERROR',
                status: STATUS.FAIL,
                reason:
                    error?.message ||
                    `Compatibility rule ${rule.id} failed unexpectedly.`,
                requiredBy: null,
                recommendedAction: 'Review analyzer logs and retry analysis.',
                blocking: false,
                source: 'DeploymentCompatibilityAnalyzer'
            });
        }
    }

    const metadataChecked = collectMetadataChecked({
        selectedMetadata,
        discoveredRelationships,
        discoveredReferences,
        resolvedDependencies
    });

    const summary = buildSummary({
        rulesExecuted: executedRuleIds.length,
        findings,
        metadataChecked
    });

    const overallCompatibility = resolveOverallCompatibility(findings);

    console.log('Rules registered:', rules.map((rule) => rule.id).join(', '));
    logCompatibilityDiagnostics(findings, context, overallCompatibility);
    logFindings(findings, summary, overallCompatibility);

    return {
        overallCompatibility,
        findings,
        summary,
        rulesExecuted: executedRuleIds
    };
}

module.exports = {
    analyzeDeploymentCompatibility
};
