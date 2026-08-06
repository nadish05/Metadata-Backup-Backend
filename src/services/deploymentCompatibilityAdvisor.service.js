/**
 * Enterprise Compatibility Advisor (Phase 11.6).
 *
 * READ-ONLY remediation guidance derived from existing compatibility
 * findings. Does not modify package, readiness, gate, workspace, or CLI.
 */

const CATEGORY_GUIDANCE = Object.freeze({
    FORMULA_TYPE_CHANGE: Object.freeze({
        reason: 'Formula conversion not supported.',
        salesforceBehavior:
            'Salesforce does not allow converting an existing field to a Formula type (or incompatible formula conversion) via Metadata API deploy.',
        recommendedAction:
            'Recreate field manually or convert in target before deployment.',
        deploymentImpact: 'Excluded automatically.',
        documentationHint:
            'See Salesforce Metadata API field type conversion limitations for CustomField Formula updates.',
        defaultSeverity: 'WARNING'
    }),
    FORMULA_COMPILATION: Object.freeze({
        reason: 'Formula references metadata unavailable in destination.',
        salesforceBehavior:
            'Salesforce rejects formula fields that reference fields or relationships missing from the destination org or deployment set.',
        recommendedAction:
            'Deploy missing dependencies first then retry.',
        deploymentImpact: 'Excluded automatically.',
        documentationHint:
            'Ensure all formula-referenced CustomFields and relationships exist in destination or the same package.',
        defaultSeverity: 'WARNING'
    }),
    FIELD_TYPE_CHANGE: Object.freeze({
        reason: 'Salesforce blocks incompatible field type conversion.',
        salesforceBehavior:
            'Incompatible CustomField type changes are rejected by the Metadata API and cannot be applied in-place.',
        recommendedAction: 'Manual migration required.',
        deploymentImpact: 'Excluded automatically.',
        documentationHint:
            'Review Salesforce field type conversion matrix; create a new field or migrate data manually when conversion is unsupported.',
        defaultSeverity: 'WARNING'
    }),
    PICKLIST_TYPE_CHANGE: Object.freeze({
        reason: 'Picklist/Text conversion unsupported.',
        salesforceBehavior:
            'Salesforce does not support converting between Picklist and Text (or related) field types through metadata deployment.',
        recommendedAction:
            'Create replacement field or migrate data manually.',
        deploymentImpact: 'Excluded automatically.',
        documentationHint:
            'Use a new field plus data migration when Picklist/Text conversion is required.',
        defaultSeverity: 'WARNING'
    }),
    FLOW_API_VERSION: Object.freeze({
        reason: 'Flow metadata version newer than destination org.',
        salesforceBehavior:
            'Flow properties or structure tied to a newer API version may be rejected or ignored by older destination org API versions.',
        recommendedAction:
            'Retrieve using supported API version or upgrade destination.',
        deploymentImpact: 'Warning — may fail at deploy time if unresolved.',
        documentationHint:
            'Align Flow retrieve/deploy API version with destination org capabilities.',
        defaultSeverity: 'WARNING'
    }),
    LWC_DEPENDENCY: Object.freeze({
        reason: 'Referenced LWC module missing.',
        salesforceBehavior:
            'Lightning Web Components fail deployment or runtime resolution when imported modules are not present in the destination org.',
        recommendedAction: 'Deploy dependency bundle first.',
        deploymentImpact: 'Warning — dependent LWC may fail until dependency deploys.',
        documentationHint:
            'Include or pre-deploy referenced LightningComponentBundle modules.',
        defaultSeverity: 'WARNING'
    }),
    FLEXIPAGE_DEPENDENCY: Object.freeze({
        reason: 'Referenced Lightning component unavailable.',
        salesforceBehavior:
            'FlexiPage deployment requires referenced Lightning components to exist in the destination org.',
        recommendedAction: 'Deploy dependent components first.',
        deploymentImpact:
            'Warning — FlexiPage may fail until referenced components deploy.',
        documentationHint:
            'Deploy Lightning components referenced by the FlexiPage before or with the page.',
        defaultSeverity: 'WARNING'
    }),
    PERMISSION_SET_API_VERSION: Object.freeze({
        reason:
            'Permission Set contains security properties unsupported by the selected Metadata API version.',
        salesforceBehavior:
            'Salesforce rejects version-gated PermissionSet XML properties. Removing them can reduce or otherwise change granted access, and Salesforce does not recreate omitted security grants.',
        recommendedAction:
            'Deploy using Metadata API 63.0 or later; upgrade the destination to support the required Metadata API when necessary; or replace View All Fields with explicit field permissions only after security review.',
        deploymentImpact:
            'Blocks deployment because the Permission Set security model cannot be preserved automatically.',
        documentationHint:
            'Review the Salesforce Metadata API PermissionSet schema and property availability for the destination API version.',
        defaultSeverity: 'BLOCKER'
    }),
    BLOCKING_DEPENDENCY: Object.freeze({
        reason:
            'Component depends on metadata that was excluded for compatibility reasons.',
        salesforceBehavior:
            'Deploying a consumer without its required dependency produces incomplete or failing metadata in the destination org.',
        recommendedAction:
            'Resolve or manually remediate excluded dependencies, then retry deployment.',
        deploymentImpact: 'Blocks deployment readiness.',
        documentationHint:
            'Remove the consumer from the package or remediate the excluded dependency before deploying.',
        defaultSeverity: 'BLOCKER'
    })
});

function emptyAdvisor() {
    return {
        summary: {
            overallRisk: 'LOW',
            totalExcluded: 0,
            totalBlocking: 0,
            manualActionsRequired: 0
        },
        recommendations: []
    };
}

function getGuidance(category) {
    return (
        CATEGORY_GUIDANCE[category] || {
            reason: 'Compatibility issue detected.',
            salesforceBehavior:
                'Salesforce may reject or ignore this metadata during deployment.',
            recommendedAction: 'Review the finding and remediate before retrying.',
            deploymentImpact: 'May affect deployment success.',
            documentationHint:
                'Review Salesforce Metadata API compatibility guidance for this metadata type.',
            defaultSeverity: 'WARNING'
        }
    );
}

function componentKey(metadataType, component) {
    if (!component) {
        return null;
    }

    return `${String(metadataType || 'Unknown')}:${String(component)}`;
}

function buildRecommendation({
    component,
    metadataType,
    category,
    severity,
    reason,
    salesforceBehavior,
    recommendedAction,
    deploymentImpact,
    documentationHint
}) {
    const guidance = getGuidance(category);

    return {
        component: component || null,
        metadataType: metadataType || null,
        category: category || 'UNKNOWN',
        severity: severity || guidance.defaultSeverity || 'WARNING',
        reason: reason || guidance.reason,
        salesforceBehavior: salesforceBehavior || guidance.salesforceBehavior,
        recommendedAction: recommendedAction || guidance.recommendedAction,
        deploymentImpact: deploymentImpact || guidance.deploymentImpact,
        documentationHint: documentationHint || guidance.documentationHint
    };
}

function resolveOverallRisk(totalExcluded, totalBlocking) {
    if (totalBlocking > 0) {
        return 'HIGH';
    }

    if (totalExcluded > 0) {
        return 'MEDIUM';
    }

    return 'LOW';
}

function collectExcludedRecommendations(excludedComponents, seen) {
    const recommendations = [];

    for (const excluded of excludedComponents || []) {
        const component = excluded?.metadataName || excluded?.name || null;
        const metadataType =
            excluded?.metadataType || excluded?.type || 'CustomField';
        const category = excluded?.category || 'UNKNOWN';
        const key = componentKey(metadataType, component);

        if (key && seen.has(key)) {
            continue;
        }

        if (key) {
            seen.add(key);
        }

        const guidance = getGuidance(category);

        recommendations.push(
            buildRecommendation({
                component,
                metadataType,
                category,
                severity: 'WARNING',
                reason: guidance.reason,
                salesforceBehavior: guidance.salesforceBehavior,
                recommendedAction: guidance.recommendedAction,
                deploymentImpact: guidance.deploymentImpact,
                documentationHint: guidance.documentationHint
            })
        );
    }

    return recommendations;
}

function collectBlockingRecommendations(blockingComponents, seen) {
    const recommendations = [];

    for (const blocking of blockingComponents || []) {
        const component = blocking?.metadataName || blocking?.name || null;
        const metadataType =
            blocking?.metadataType || blocking?.type || null;
        const primaryBlocker =
            Array.isArray(blocking?.blockedBy) && blocking.blockedBy.length
                ? blocking.blockedBy[0]
                : null;
        const category =
            blocking?.category ||
            primaryBlocker?.category ||
            'BLOCKING_DEPENDENCY';
        const key = `BLOCKING:${componentKey(metadataType, component)}`;

        if (key && seen.has(key)) {
            continue;
        }

        if (key) {
            seen.add(key);
        }

        const guidance = getGuidance(
            category === 'PERMISSION_SET_API_VERSION'
                ? category
                : 'BLOCKING_DEPENDENCY'
        );
        const blockerNames = (blocking?.blockedBy || [])
            .map((item) => item?.metadataName)
            .filter(Boolean)
            .join(', ');

        recommendations.push(
            buildRecommendation({
                component,
                metadataType,
                category,
                severity: 'BLOCKER',
                reason: blockerNames
                    ? `Depends on excluded component(s): ${blockerNames}.`
                    : guidance.reason,
                salesforceBehavior: guidance.salesforceBehavior,
                recommendedAction: guidance.recommendedAction,
                deploymentImpact: guidance.deploymentImpact,
                documentationHint: guidance.documentationHint
            })
        );
    }

    return recommendations;
}

function collectWarningRecommendations(compatibilityWarnings, seen) {
    const recommendations = [];
    const advisoryCategories = new Set([
        'FLOW_API_VERSION',
        'LWC_DEPENDENCY',
        'FLEXIPAGE_DEPENDENCY',
        'FORMULA_TYPE_CHANGE',
        'FORMULA_COMPILATION',
        'FIELD_TYPE_CHANGE',
        'PICKLIST_TYPE_CHANGE',
        'PERMISSION_SET_API_VERSION'
    ]);

    for (const warning of compatibilityWarnings || []) {
        const category = warning?.category;

        if (!advisoryCategories.has(category)) {
            continue;
        }

        const component = warning?.metadataName || warning?.name || null;
        const metadataType =
            warning?.metadataType || warning?.type || null;
        const key = componentKey(metadataType, component);

        // Prefer excluded/blocking recommendations already recorded.
        if (
            key &&
            (seen.has(key) ||
                (category === 'PERMISSION_SET_API_VERSION' &&
                    seen.has(`BLOCKING:${key}`)))
        ) {
            continue;
        }

        if (key) {
            seen.add(key);
        }

        const guidance = getGuidance(category);
        const severity =
            warning?.severity === 'BLOCKER' || warning?.severity === 'INFO'
                ? warning.severity
                : guidance.defaultSeverity;

        recommendations.push(
            buildRecommendation({
                component,
                metadataType,
                category,
                severity,
                reason: guidance.reason,
                salesforceBehavior: guidance.salesforceBehavior,
                recommendedAction:
                    warning?.recommendation || guidance.recommendedAction,
                deploymentImpact: guidance.deploymentImpact,
                documentationHint: guidance.documentationHint
            })
        );
    }

    return recommendations;
}

/**
 * Build enterprise remediation guidance from existing compatibility results.
 *
 * @param {{
 *   deploymentCompatibilityPlan?: object,
 *   deploymentCompatibilityImpact?: object,
 *   deploymentReadiness?: object,
 *   excludedComponents?: object[],
 *   blockingComponents?: object[],
 *   compatibilityWarnings?: object[]
 * }} input
 * @returns {{ summary: object, recommendations: object[] }}
 */
function buildDeploymentCompatibilityAdvisor({
    deploymentCompatibilityPlan = null,
    deploymentCompatibilityImpact = null,
    deploymentReadiness = null,
    excludedComponents = null,
    blockingComponents = null,
    compatibilityWarnings = null
} = {}) {
    const excluded = Array.isArray(excludedComponents)
        ? excludedComponents
        : Array.isArray(deploymentReadiness?.excludedComponents)
          ? deploymentReadiness.excludedComponents
          : [];

    const blocking = Array.isArray(blockingComponents)
        ? blockingComponents
        : Array.isArray(deploymentCompatibilityImpact?.blockingComponents)
          ? deploymentCompatibilityImpact.blockingComponents
          : Array.isArray(deploymentReadiness?.blockingComponents)
            ? deploymentReadiness.blockingComponents
            : [];

    const warnings = Array.isArray(compatibilityWarnings)
        ? compatibilityWarnings
        : Array.isArray(deploymentCompatibilityPlan?.compatibilityWarnings)
          ? deploymentCompatibilityPlan.compatibilityWarnings
          : [];

    const seen = new Set();
    const recommendations = [
        ...collectExcludedRecommendations(excluded, seen),
        ...collectBlockingRecommendations(blocking, seen),
        ...collectWarningRecommendations(warnings, seen)
    ];

    const totalExcluded = excluded.length;
    const totalBlocking = blocking.length;
    const manualActionsRequired = recommendations.filter(
        (item) => item.severity === 'BLOCKER' || item.severity === 'WARNING'
    ).length;

    return {
        summary: {
            overallRisk: resolveOverallRisk(totalExcluded, totalBlocking),
            totalExcluded,
            totalBlocking,
            manualActionsRequired
        },
        recommendations
    };
}

/**
 * Fail-safe wrapper — never throws to callers.
 */
function buildDeploymentCompatibilityAdvisorSafe(input) {
    try {
        return buildDeploymentCompatibilityAdvisor(input);
    } catch (error) {
        return emptyAdvisor();
    }
}

module.exports = {
    CATEGORY_GUIDANCE,
    emptyAdvisor,
    buildDeploymentCompatibilityAdvisor,
    buildDeploymentCompatibilityAdvisorSafe,
    resolveOverallRisk
};
