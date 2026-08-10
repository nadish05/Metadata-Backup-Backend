/**
 * SAFE_SKIP Engine (Phase 17.9)
 *
 * Deterministic backend decisions for safely excluding isolated components
 * from the deployment package. Never invents skip safety from AI/client.
 * Never mutates source metadata or package.xml strings.
 *
 * Three-state model:
 *   true  — proven safe to skip
 *   false — proven unsafe to skip
 *   null  — cannot prove safety
 */

'use strict';

const deploymentPackageService = require('../deploymentPackage.service');
const packageXmlService = require('../packageXml.service');
const deploymentWorkspaceService = require('../deploymentWorkspace.service');
const deploymentCompatibilityImpactService = require('../deploymentCompatibilityImpact.service');

const DECISIONS = Object.freeze({
    SAFE_SKIP: 'SAFE_SKIP',
    NOT_SAFE_TO_SKIP: 'NOT_SAFE_TO_SKIP',
    UNKNOWN: 'UNKNOWN'
});

const SKIP_TYPES = Object.freeze({
    EXCLUDE_SAFE_SKIP_MEMBER: 'EXCLUDE_SAFE_SKIP_MEMBER',
    REGENERATE_PACKAGE: 'REGENERATE_PACKAGE',
    REBUILD_WORKSPACE: 'REBUILD_WORKSPACE'
});

function emptySafeSkipReport() {
    return {
        safeSkipAvailable: false,
        safeSkipApplied: false,
        decisions: [],
        skippedComponents: [],
        summary: {
            available: 0,
            applied: 0,
            blocked: 0,
            unknown: 0
        }
    };
}

function normalizeKey(metadataType, metadataName) {
    if (!metadataType || !metadataName) {
        return null;
    }
    return `${String(metadataType)}:${String(metadataName)}`.toLowerCase();
}

function getType(item) {
    return item?.metadataType || item?.type || null;
}

function getName(item) {
    return item?.metadataName || item?.name || null;
}

function asArray(value) {
    return Array.isArray(value) ? value : [];
}

function packageContains(deploymentPackage, metadataType, metadataName) {
    if (!deploymentPackage || !metadataType || !metadataName) {
        return false;
    }
    const key = normalizeKey(metadataType, metadataName);
    const items = [
        ...asArray(deploymentPackage.metadata),
        ...asArray(deploymentPackage.dependencies)
    ];
    return items.some(
        (item) => normalizeKey(getType(item), getName(item)) === key
    );
}

function buildSummary(metadata, dependencies, testClasses) {
    const metadataCount = asArray(metadata).length;
    const dependencyCount = asArray(dependencies).length;
    const testClassCount = asArray(testClasses).length;
    return {
        metadataCount,
        dependencyCount,
        testClassCount,
        totalComponents: metadataCount + dependencyCount
    };
}

function isPersonAccountFailure(failure) {
    const text = `${failure?.reason || ''} ${failure?.evidence || ''} ${failure?.metadataName || ''}`
        .toLowerCase();
    return (
        text.includes('personaccount') ||
        text.includes('person account') ||
        String(failure?.recommendedNextStep || '')
            .toUpperCase()
            .includes('ENABLE')
    );
}

function isMissingRequiredDependency(failure, resolution) {
    const category = String(failure?.category || '').toUpperCase();
    const resolutionType = String(resolution?.resolutionType || '').toUpperCase();

    if (resolutionType === 'ENABLE_FEATURE') {
        return true;
    }

    if (resolutionType === 'DEPENDENCY' || resolutionType === 'PACKAGE') {
        // Prefer Auto Fix / include — not SAFE_SKIP for missing required deps.
        return true;
    }

    if (failure?.canAutoFix === true) {
        return true;
    }

    const text = String(failure?.reason || failure?.evidence || '').toLowerCase();
    if (
        text.includes('missing') &&
        (text.includes('depend') ||
            text.includes('externalcredential') ||
            text.includes('customobject') ||
            text.includes('recordtype'))
    ) {
        // Unless classifier already marked canSafeSkip true for an isolated case,
        // treat missing dependency text as not safe to skip.
        if (failure?.canSafeSkip !== true) {
            return true;
        }
    }

    if (category === 'MANUAL_ACTION' && failure?.canSafeSkip !== true) {
        return false;
    }

    return false;
}

function findResolution(resolutionReport, metadataType, metadataName) {
    const key = normalizeKey(metadataType, metadataName);
    return (
        asArray(resolutionReport?.resolutions).find(
            (item) =>
                normalizeKey(item?.metadataType, item?.metadataName) === key
        ) || null
    );
}

/**
 * Evaluate SAFE_SKIP for each classified failure.
 * Ignores client-authored safeToSkip on the failure object as authority —
 * only uses backend canSafeSkip / category / impact evidence.
 */
function evaluateSafeSkipDecisions({
    failureClassification = null,
    resolutionReport = null,
    generatedDeploymentPackage = null,
    resolvedDependencies = [],
    discoveredRelationships = [],
    discoveredReferences = [],
    dependencyExplorer = null
} = {}) {
    const failures = asArray(failureClassification?.failures);
    const decisions = [];

    if (!failures.length) {
        return {
            ...emptySafeSkipReport(),
            decisions
        };
    }

    // First pass: provisional decisions without applied package filter.
    const provisionalSkipCandidates = [];

    for (const failure of failures) {
        const metadataType = failure?.metadataType || null;
        const metadataName = failure?.metadataName || null;
        const resolution = findResolution(
            resolutionReport,
            metadataType,
            metadataName
        );

        // Explicitly ignore any client-injected safeToSkip on the failure blob.
        // Backend authority is canSafeSkip from classification + graph evidence.
        const backendCanSafeSkip = failure?.canSafeSkip === true;
        const backendCannotSafeSkip = failure?.canSafeSkip === false;
        const category = String(failure?.category || '').toUpperCase();

        let safeToSkip = null;
        let decision = DECISIONS.UNKNOWN;
        let reason = 'Backend cannot prove that skipping this component is safe.';
        let impact = 'No skip applied.';
        let prerequisites = [];
        let backendCanApply = false;

        if (isPersonAccountFailure(failure) ||
            String(resolution?.resolutionType || '').toUpperCase() ===
                'ENABLE_FEATURE') {
            safeToSkip = false;
            decision = DECISIONS.NOT_SAFE_TO_SKIP;
            reason =
                'Person Accounts / platform feature must be enabled in the destination. SAFE_SKIP is not allowed.';
            impact =
                'Enable the required Salesforce feature, then re-run validation.';
            prerequisites = ['ENABLE_PLATFORM_FEATURE'];
        } else if (isMissingRequiredDependency(failure, resolution)) {
            safeToSkip = false;
            decision = DECISIONS.NOT_SAFE_TO_SKIP;
            reason =
                'Missing or required dependency must be included or resolved — not skipped.';
            impact =
                'Prefer Auto Fix / INCLUDE_DISCOVERED_DEPENDENCY or manual dependency resolution.';
            prerequisites = ['RESOLVE_DEPENDENCY'];
        } else if (backendCannotSafeSkip && category !== 'SAFE_SKIP') {
            safeToSkip = false;
            decision = DECISIONS.NOT_SAFE_TO_SKIP;
            reason =
                failure?.reason ||
                'Classifier determined this component is not safe to skip.';
            impact = 'Component remains in the deployment selection.';
        } else if (backendCanSafeSkip || category === 'SAFE_SKIP') {
            // Provisional — graph impact may veto below.
            safeToSkip = true;
            decision = DECISIONS.SAFE_SKIP;
            reason =
                failure?.reason ||
                'Classifier marked this component as safely skippable and no required dependency conflict was detected yet.';
            impact =
                'Component may be excluded from the deployment package if no remaining members depend on it.';
            backendCanApply = true;
            provisionalSkipCandidates.push({
                metadataType,
                metadataName,
                reason,
                category: failure?.category || 'SAFE_SKIP'
            });
        } else {
            safeToSkip = null;
            decision = DECISIONS.UNKNOWN;
            reason =
                failure?.reason ||
                'Insufficient deterministic evidence to prove skip safety.';
            impact = 'Manual review required.';
        }

        decisions.push({
            safeToSkip,
            decision,
            metadataType,
            metadataName,
            reason,
            impact,
            prerequisites,
            backendCanApply,
            applied: false,
            // Preserve classification evidence for reports; never trust client.
            category: failure?.category || null,
            canSafeSkip: backendCanSafeSkip
                ? true
                : backendCannotSafeSkip
                  ? false
                  : null
        });
    }

    // Graph impact: if any remaining package member depends on a skip candidate, veto.
    if (provisionalSkipCandidates.length && generatedDeploymentPackage) {
        const impactResult = deploymentCompatibilityImpactService.analyze({
            filteredDeploymentPackage: generatedDeploymentPackage,
            excludedComponents: provisionalSkipCandidates,
            resolvedDependencies,
            discoveredRelationships,
            discoveredReferences,
            dependencyExplorer
        });

        const blockedSkipKeys = new Set();
        for (const blocking of asArray(impactResult.blockingComponents)) {
            for (const blockedBy of asArray(blocking.blockedBy)) {
                const key = normalizeKey(
                    blockedBy.metadataType,
                    blockedBy.metadataName
                );
                if (key) {
                    blockedSkipKeys.add(key);
                }
            }
        }

        for (const item of decisions) {
            const key = normalizeKey(item.metadataType, item.metadataName);
            if (!key || item.decision !== DECISIONS.SAFE_SKIP) {
                continue;
            }
            if (!blockedSkipKeys.has(key)) {
                continue;
            }

            item.safeToSkip = false;
            item.decision = DECISIONS.NOT_SAFE_TO_SKIP;
            item.backendCanApply = false;
            item.reason =
                'Skipping this component is unsafe because other selected package members depend on it.';
            item.impact =
                'SAFE_SKIP blocked to protect package structural consistency.';
            item.prerequisites = ['RESOLVE_DEPENDENT_COMPONENTS'];
        }
    }

    const available = decisions.filter(
        (d) => d.safeToSkip === true && d.backendCanApply === true
    ).length;
    const blocked = decisions.filter(
        (d) => d.decision === DECISIONS.NOT_SAFE_TO_SKIP
    ).length;
    const unknown = decisions.filter(
        (d) => d.decision === DECISIONS.UNKNOWN
    ).length;

    return {
        safeSkipAvailable: available > 0,
        safeSkipApplied: false,
        decisions,
        skippedComponents: [],
        summary: {
            available,
            applied: 0,
            blocked,
            unknown
        }
    };
}

function filterPackageMembers(generatedDeploymentPackage, skipKeys) {
    const original = generatedDeploymentPackage || {
        metadata: [],
        dependencies: [],
        testClasses: []
    };

    const metadata = [];
    const skipped = [];

    for (const item of asArray(original.metadata)) {
        const key = normalizeKey(getType(item), getName(item));
        if (key && skipKeys.has(key)) {
            skipped.push({
                metadataType: getType(item),
                metadataName: getName(item),
                source: 'metadata'
            });
            continue;
        }
        metadata.push(item);
    }

    const dependencies = [];
    for (const item of asArray(original.dependencies)) {
        const key = normalizeKey(getType(item), getName(item));
        if (key && skipKeys.has(key)) {
            skipped.push({
                metadataType: getType(item),
                metadataName: getName(item),
                source: 'dependencies'
            });
            continue;
        }
        dependencies.push(item);
    }

    const testClasses = asArray(original.testClasses);

    return {
        deploymentPackage: {
            ...original,
            metadata,
            dependencies,
            testClasses,
            summary: buildSummary(metadata, dependencies, testClasses)
        },
        skipped
    };
}

/**
 * Apply SAFE_SKIP exclusions via existing package/workspace pipeline.
 */
async function applySafeSkips(context = {}, services = {}) {
    const generateDeploymentPackage =
        services.generateDeploymentPackage ||
        deploymentPackageService.generateDeploymentPackage;
    const generateManifest =
        services.generateManifest || packageXmlService.generateManifest;
    const buildDeploymentWorkspace =
        services.buildDeploymentWorkspace ||
        deploymentWorkspaceService.buildDeploymentWorkspace;
    const evaluate =
        services.evaluateSafeSkipDecisions || evaluateSafeSkipDecisions;

    const {
        failureClassification = null,
        resolutionReport = null,
        generatedDeploymentPackage = null,
        generatedManifest = null,
        generatedWorkspace = null,
        deploymentPackage = null,
        selectedMetadata = null,
        resolvedDependencies = [],
        discoveredRelationships = [],
        discoveredReferences = [],
        dependencyExplorer = null,
        repoUrl = null,
        sourceBranch = null,
        deploymentApiVersion = null,
        deploymentApiVersionPolicy = null
    } = context;

    const evaluation = evaluate({
        failureClassification,
        resolutionReport,
        generatedDeploymentPackage,
        resolvedDependencies,
        discoveredRelationships,
        discoveredReferences,
        dependencyExplorer
    });

    const applyCandidates = evaluation.decisions.filter(
        (d) =>
            d.safeToSkip === true &&
            d.backendCanApply === true &&
            d.metadataType &&
            d.metadataName
    );

    if (!applyCandidates.length) {
        return {
            ...evaluation,
            generatedDeploymentPackage,
            generatedManifest,
            generatedWorkspace
        };
    }

    const skipKeys = new Set(
        applyCandidates.map((c) =>
            normalizeKey(c.metadataType, c.metadataName)
        )
    );

    // Prefer filtering the current generated package (post auto-fix if any).
    // Also strip from selectedMetadata when regenerating via package service.
    const { deploymentPackage: filteredPackage } = filterPackageMembers(
        generatedDeploymentPackage,
        skipKeys
    );

    const effectiveSelectedMetadata = asArray(
        selectedMetadata ||
            deploymentPackage?.selectedMetadata ||
            deploymentPackage?.metadata ||
            filteredPackage.metadata
    ).filter((item) => {
        const key = normalizeKey(getType(item), getName(item));
        return !(key && skipKeys.has(key));
    });

    const effectiveDependencies = asArray(
        resolvedDependencies ||
            generatedDeploymentPackage?.dependencies ||
            []
    ).map((dependency) => {
        const key = normalizeKey(getType(dependency), getName(dependency));
        if (key && skipKeys.has(key)) {
            return {
                ...dependency,
                action: 'SKIP',
                selected: false,
                required: false
            };
        }
        return { ...dependency };
    });

    let regeneratedPackage = filteredPackage;
    let regeneratedManifest = generatedManifest;
    let regeneratedWorkspace = generatedWorkspace;
    let packageRegenerated = false;

    try {
        regeneratedPackage = generateDeploymentPackage({
            ...(deploymentPackage && typeof deploymentPackage === 'object'
                ? deploymentPackage
                : {}),
            selectedMetadata: effectiveSelectedMetadata,
            requiredDependencies: effectiveDependencies
        });

        // Ensure skip keys remain excluded even if package service re-includes.
        const ensured = filterPackageMembers(regeneratedPackage, skipKeys);
        regeneratedPackage = ensured.deploymentPackage;

        regeneratedManifest = generateManifest(regeneratedPackage, {
            deploymentApiVersion,
            deploymentApiVersionPolicy: deploymentApiVersionPolicy
                ? {
                      ...deploymentApiVersionPolicy,
                      deploymentApiVersion:
                          deploymentApiVersion ||
                          deploymentApiVersionPolicy.deploymentApiVersion
                  }
                : undefined
        });
        packageRegenerated = true;
    } catch (_error) {
        return {
            ...evaluation,
            safeSkipApplied: false,
            generatedDeploymentPackage,
            generatedManifest,
            generatedWorkspace
        };
    }

    const skippedComponents = [];
    for (const candidate of applyCandidates) {
        const stillPresent = packageContains(
            regeneratedPackage,
            candidate.metadataType,
            candidate.metadataName
        );
        const applied = packageRegenerated && !stillPresent;

        const decision = evaluation.decisions.find(
            (d) =>
                normalizeKey(d.metadataType, d.metadataName) ===
                normalizeKey(candidate.metadataType, candidate.metadataName)
        );
        if (decision) {
            decision.applied = applied;
            if (!applied) {
                decision.backendCanApply = false;
                decision.reason =
                    'SAFE_SKIP was evaluated but the component remained in the regenerated package.';
            }
        }

        if (applied) {
            skippedComponents.push({
                metadataType: candidate.metadataType,
                metadataName: candidate.metadataName,
                skipType: SKIP_TYPES.EXCLUDE_SAFE_SKIP_MEMBER,
                reason: candidate.reason
            });
        }
    }

    const anyApplied = skippedComponents.length > 0;

    if (
        anyApplied &&
        repoUrl &&
        sourceBranch &&
        regeneratedWorkspace &&
        regeneratedWorkspace.skipped !== true
    ) {
        try {
            regeneratedWorkspace = await buildDeploymentWorkspace({
                repoUrl,
                branch: sourceBranch,
                generatedDeploymentPackage: regeneratedPackage,
                generatedManifest: regeneratedManifest
            });
        } catch (_error) {
            // Package skip still stands; workspace rebuild failure is non-fatal here.
        }
    }

    const available = evaluation.decisions.filter(
        (d) => d.safeToSkip === true
    ).length;
    const appliedCount = evaluation.decisions.filter(
        (d) => d.applied === true
    ).length;
    const blocked = evaluation.decisions.filter(
        (d) => d.decision === DECISIONS.NOT_SAFE_TO_SKIP
    ).length;
    const unknown = evaluation.decisions.filter(
        (d) => d.decision === DECISIONS.UNKNOWN
    ).length;

    return {
        safeSkipAvailable: available > 0,
        safeSkipApplied: anyApplied,
        decisions: evaluation.decisions,
        skippedComponents,
        summary: {
            available,
            applied: appliedCount,
            blocked,
            unknown
        },
        generatedDeploymentPackage: anyApplied
            ? regeneratedPackage
            : generatedDeploymentPackage,
        generatedManifest: anyApplied
            ? regeneratedManifest
            : generatedManifest,
        generatedWorkspace: anyApplied
            ? regeneratedWorkspace
            : generatedWorkspace
    };
}

module.exports = {
    DECISIONS,
    SKIP_TYPES,
    emptySafeSkipReport,
    evaluateSafeSkipDecisions,
    applySafeSkips,
    filterPackageMembers,
    packageContains,
    normalizeKey
};
