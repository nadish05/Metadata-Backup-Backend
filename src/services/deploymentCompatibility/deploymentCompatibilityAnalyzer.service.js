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
