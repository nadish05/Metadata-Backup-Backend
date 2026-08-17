/**
 * AI Deployment Resolution Layer (Phase 17.5 / 17.7).
 *
 * Phase 17.7: On-demand AI resolution via explicit API.
 * Validation no longer automatically invokes the LLM.
 *
 * Advisory only. Never influences deployment decisions, package contents,
 * metadata, planner selections, auto-fix, or auto-validation.
 */

const { generateAiText } = require('../aiTextGeneration.service');
const {
    sanitizeFactPackForAi,
    getComponentFactPack,
    getFlowEvidence
} = require('./aiResolutionFactPack.service');

const DEFAULT_DISCLAIMER =
    'AI explanations are advisory only. They do not change deployment decisions, packages, metadata, or validation results.';

const ON_DEMAND_STUB_SUMMARY =
    'AI deployment resolution is available on demand.';

const ON_DEMAND_STUB_DISCLAIMER =
    'AI guidance is advisory only and is generated only when requested.';

const ALLOWED_CONTEXT_KEYS = Object.freeze([
    'failureClassification',
    'resolutionReport',
    'autoFixReport',
    'autoValidationReport',
    'enterpriseDeploymentReport',
    'deploymentDiagnostics',
    'deploymentSummary',
    'aiResolutionFactPack',
    'safeSkipReport',
    'compatibilityPackageFilter',
    'excludedComponents',
    'compatibilitySummary'
]);

const SUPPORTED_PROVIDERS = Object.freeze(['gemini', 'openai']);

const SKIP_GUIDANCE_DEFAULT =
    'Backend has not marked this component as safe to skip. Skipping is not recommended.';

const FIX_OWNERS = Object.freeze({
    RUNTIME_AUTOFIX: 'RUNTIME_AUTOFIX',
    MANUAL_METADATA: 'MANUAL_METADATA',
    DESTINATION_FEATURE: 'DESTINATION_FEATURE',
    UNKNOWN: 'UNKNOWN'
});

class UnsupportedAiProviderError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UnsupportedAiProviderError';
        this.code = 'UNSUPPORTED_AI_PROVIDER';
        this.statusCode = 400;
    }
}

function parseEnvBool(value, defaultValue) {
    if (value === undefined || value === null || value === '') {
        return defaultValue;
    }

    const normalized = String(value).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) {
        return true;
    }
    if (['0', 'false', 'no', 'off'].includes(normalized)) {
        return false;
    }

    return defaultValue;
}

function isAiEnabled(options = {}) {
    if (options.enabled !== undefined) {
        return options.enabled === true;
    }

    return parseEnvBool(process.env.AI_ENABLED, false);
}

/**
 * Validate and normalize an on-demand provider.
 * Accepts: gemini | openai | gpt (→ openai).
 * Rejects all other values (no silent Gemini default).
 *
 * @param {unknown} provider
 * @returns {string} 'gemini' | 'openai'
 */
function normalizeOnDemandProvider(provider) {
    if (provider === undefined || provider === null || provider === '') {
        throw new UnsupportedAiProviderError(
            'Unsupported AI provider. Supported providers: gemini, openai.'
        );
    }

    const normalized = String(provider).trim().toLowerCase();

    if (normalized === 'gpt') {
        return 'openai';
    }

    if (SUPPORTED_PROVIDERS.includes(normalized)) {
        return normalized;
    }

    throw new UnsupportedAiProviderError(
        'Unsupported AI provider. Supported providers: gemini, openai.'
    );
}

/**
 * Allowlist context fields for on-demand AI. Drops credentials, prompts, keys.
 *
 * @param {object} rawContext
 * @returns {object}
 */
function sanitizeAiResolutionContext(rawContext) {
    const source =
        rawContext && typeof rawContext === 'object' ? rawContext : {};
    const sanitized = {};

    for (const key of ALLOWED_CONTEXT_KEYS) {
        if (Object.prototype.hasOwnProperty.call(source, key)) {
            sanitized[key] = source[key];
        }
    }

    if (Object.prototype.hasOwnProperty.call(sanitized, 'aiResolutionFactPack')) {
        sanitized.aiResolutionFactPack = sanitizeFactPackForAi(
            sanitized.aiResolutionFactPack
        );
    }

    if (Object.prototype.hasOwnProperty.call(sanitized, 'safeSkipReport')) {
        sanitized.safeSkipReport = sanitizeSafeSkipReport(
            sanitized.safeSkipReport
        );
    }

    if (
        Object.prototype.hasOwnProperty.call(
            sanitized,
            'compatibilityPackageFilter'
        )
    ) {
        sanitized.compatibilityPackageFilter = sanitizeExcludedListContainer(
            sanitized.compatibilityPackageFilter
        );
    }

    if (Object.prototype.hasOwnProperty.call(sanitized, 'excludedComponents')) {
        sanitized.excludedComponents = sanitizeExcludedComponents(
            sanitized.excludedComponents
        );
    }

    if (
        Object.prototype.hasOwnProperty.call(sanitized, 'compatibilitySummary')
    ) {
        sanitized.compatibilitySummary = sanitizeCompatibilitySummary(
            sanitized.compatibilitySummary
        );
    }

    return sanitized;
}

function emptyReport(overrides = {}) {
    return {
        available: false,
        provider: null,
        generated: false,
        explanations: [],
        summary: null,
        disclaimer: DEFAULT_DISCLAIMER,
        fallbackUsed: false,
        ...overrides
    };
}

function buildOnDemandAiResolutionStub() {
    return emptyReport({
        available: false,
        provider: null,
        generated: false,
        summary: ON_DEMAND_STUB_SUMMARY,
        disclaimer: ON_DEMAND_STUB_DISCLAIMER,
        fallbackUsed: false
    });
}

function failureKey(type, name) {
    if (!type && !name) {
        return null;
    }

    return `${type || 'Unknown'}:${name || 'Unknown'}`;
}

function identityKey(metadataType, metadataName) {
    const key = failureKey(metadataType, metadataName);
    return key ? key.toLowerCase() : null;
}

function autoFixIncludeTarget(metadataType, metadataName) {
    if (metadataType === 'ExternalCredentialPrincipal' && metadataName) {
        const parentName = String(metadataName).split('-')[0];

        if (parentName) {
            return {
                metadataType: 'ExternalCredential',
                metadataName: parentName
            };
        }
    }

    return {
        metadataType: metadataType || null,
        metadataName: metadataName || null
    };
}

function componentProblemText(item) {
    return `${item?.reason || ''} ${item?.cliProblem || ''}`.toLowerCase();
}

function isUnknownUserPermission(item) {
    return /unknown user permission\s*:/.test(componentProblemText(item));
}

function isInvalidCompactLayout(item) {
    return /invalid compact layout assigned/.test(componentProblemText(item));
}

function isApexTestOrCoverage(item) {
    const text = componentProblemText(item);
    return (
        text.includes('code coverage') ||
        (text.includes('apex') && text.includes('test'))
    );
}

function sanitizeExcludedComponents(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }

    return raw
        .filter((item) => item && (item.metadataType || item.metadataName))
        .map((item) => ({
            metadataType: item.metadataType || item.type || null,
            metadataName: item.metadataName || item.name || null,
            category: item.category || null,
            action: item.action || null,
            reason: item.reason || null
        }));
}

function sanitizeExcludedListContainer(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    return {
        excludedComponents: sanitizeExcludedComponents(raw.excludedComponents)
    };
}

function sanitizeSafeSkipReport(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    return {
        safeSkipAvailable: raw.safeSkipAvailable === true,
        safeSkipApplied: raw.safeSkipApplied === true,
        decisions: Array.isArray(raw.decisions)
            ? raw.decisions.map((decision) => ({
                  metadataType: decision?.metadataType || null,
                  metadataName: decision?.metadataName || null,
                  safeToSkip:
                      decision?.safeToSkip === true
                          ? true
                          : decision?.safeToSkip === false
                            ? false
                            : null,
                  decision: decision?.decision || null,
                  applied: decision?.applied === true,
                  reason: decision?.reason || null
              }))
            : []
    };
}

function sanitizeCompatibilitySummary(raw) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    return {
        status: raw.status || null,
        filesModified: Array.isArray(raw.filesModified)
            ? raw.filesModified.map((entry) => ({
                  file: entry?.file || null,
                  ruleId: entry?.ruleId || null,
                  summary: entry?.summary || null
              }))
            : []
    };
}

function flexiPageNameFromPath(filePath) {
    const base = String(filePath || '')
        .replace(/\\/g, '/')
        .split('/')
        .pop();

    if (!base) {
        return null;
    }

    return base.replace(/\.flexipage-meta\.xml$/i, '') || null;
}

function collectSafeSkipDecisions(context) {
    return [
        ...(Array.isArray(context?.safeSkipReport?.decisions)
            ? context.safeSkipReport.decisions
            : []),
        ...(Array.isArray(context?.enterpriseDeploymentReport?.safeSkips?.decisions)
            ? context.enterpriseDeploymentReport.safeSkips.decisions
            : [])
    ];
}

function collectExcludedComponents(context) {
    return [
        ...(Array.isArray(context?.excludedComponents)
            ? context.excludedComponents
            : []),
        ...(Array.isArray(context?.compatibilityPackageFilter?.excludedComponents)
            ? context.compatibilityPackageFilter.excludedComponents
            : [])
    ];
}

function findSuccessfulIncludeFix(context, metadataType, metadataName) {
    const candidateKeys = new Set(
        [
            identityKey(metadataType, metadataName),
            identityKey(
                autoFixIncludeTarget(metadataType, metadataName).metadataType,
                autoFixIncludeTarget(metadataType, metadataName).metadataName
            )
        ].filter(Boolean)
    );

    for (const fix of context?.autoFixReport?.fixes || []) {
        if (
            fix?.fixType !== 'INCLUDE_DISCOVERED_DEPENDENCY' ||
            fix.successful !== true
        ) {
            continue;
        }

        const fixKey = identityKey(fix.metadataType, fix.metadataName);

        if (fixKey && candidateKeys.has(fixKey)) {
            return fix;
        }
    }

    return null;
}

function findAppliedSafeSkip(context, metadataType, metadataName) {
    const key = identityKey(metadataType, metadataName);

    if (!key) {
        return null;
    }

    return (
        collectSafeSkipDecisions(context).find((decision) => {
            return (
                decision?.applied === true &&
                decision?.safeToSkip === true &&
                identityKey(decision.metadataType, decision.metadataName) === key
            );
        }) || null
    );
}

function findCompatibilityExclusion(context, metadataType, metadataName) {
    const key = identityKey(metadataType, metadataName);

    if (!key) {
        return null;
    }

    return (
        collectExcludedComponents(context).find((item) => {
            return (
                identityKey(
                    item?.metadataType || item?.type,
                    item?.metadataName || item?.name
                ) === key
            );
        }) || null
    );
}

function findFlexiPageWorkspaceModification(context, metadataType, metadataName) {
    if (metadataType !== 'FlexiPage' || !metadataName) {
        return null;
    }

    const files = context?.compatibilitySummary?.filesModified;

    if (!Array.isArray(files)) {
        return null;
    }

    return (
        files.find((entry) => {
            const fileName = flexiPageNameFromPath(entry?.file);
            const isFlexiPageFile = /\.flexipage-meta\.xml$/i.test(
                String(entry?.file || '')
            );
            const isTabsetRule =
                !entry?.ruleId ||
                String(entry.ruleId).includes('flexipage.remove-tabset-label');

            return (
                isFlexiPageFile &&
                isTabsetRule &&
                fileName === metadataName
            );
        }) || null
    );
}

function getComponentExecutionEvidence(
    context,
    metadataType,
    metadataName
) {
    return {
        successfulInclude: findSuccessfulIncludeFix(
            context,
            metadataType,
            metadataName
        ),
        appliedSkip: findAppliedSafeSkip(context, metadataType, metadataName),
        compatibilityExclusion: findCompatibilityExclusion(
            context,
            metadataType,
            metadataName
        ),
        flexiPageWorkspaceModified: findFlexiPageWorkspaceModification(
            context,
            metadataType,
            metadataName
        )
    };
}

function extractCliProblem(entry) {
    if (typeof entry?.cliProblem === 'string' && entry.cliProblem) {
        return entry.cliProblem;
    }

    if (
        typeof entry?.evidence?.problem === 'string' &&
        entry.evidence.problem
    ) {
        return entry.evidence.problem;
    }

    return null;
}

function toKnownItem(entry) {
    const metadataType = entry.metadataType || entry.type || null;
    const metadataName = entry.metadataName || entry.name || null;
    const key = failureKey(metadataType, metadataName);

    return {
        key,
        metadataType,
        metadataName,
        severity: entry.severity || entry.category || null,
        category: entry.category || null,
        resolutionType: entry.resolutionType || null,
        reason: entry.reason || entry.summary || entry.title || null,
        cliProblem: extractCliProblem(entry),
        recommendation:
            entry.recommendation ||
            entry.recommendedNextStep ||
            entry.recommendedAction ||
            null,
        autoFixed: entry.autoFixed === true,
        autoFixAvailable: entry.autoFixAvailable === true,
        userActionRequired: entry.userActionRequired,
        canAutoFix: entry.canAutoFix === true,
        safeToSkip:
            entry.safeToSkip === true
                ? true
                : entry.safeToSkip === false
                  ? false
                  : null
    };
}

function mergeKnownItem(existing, incoming) {
    // Preserve the first (failure) row. Merge deterministic resolutionType
    // from the resolution report without duplicating or inventing types.
    if (!existing.resolutionType && incoming.resolutionType) {
        existing.resolutionType = incoming.resolutionType;
    }

    if (!existing.cliProblem && incoming.cliProblem) {
        existing.cliProblem = incoming.cliProblem;
    }

    if (existing.autoFixAvailable !== true && incoming.autoFixAvailable === true) {
        existing.autoFixAvailable = true;
    }

    if (existing.autoFixed !== true && incoming.autoFixed === true) {
        existing.autoFixed = true;
    }

    if (existing.canAutoFix !== true && incoming.canAutoFix === true) {
        existing.canAutoFix = true;
    }

    if (
        typeof existing.userActionRequired !== 'boolean' &&
        typeof incoming.userActionRequired === 'boolean'
    ) {
        existing.userActionRequired = incoming.userActionRequired;
    }

    if (!existing.recommendation && incoming.recommendation) {
        existing.recommendation = incoming.recommendation;
    }
}

function collectKnownItems(context) {
    const items = [];
    const byKey = new Map();

    const add = (entry) => {
        if (!entry) {
            return;
        }

        const next = toKnownItem(entry);

        if (!next.key) {
            return;
        }

        const mapKey = next.key.toLowerCase();
        const existing = byKey.get(mapKey);

        if (existing) {
            mergeKnownItem(existing, next);
            return;
        }

        byKey.set(mapKey, next);
        items.push(next);
    };

    for (const failure of context.failureClassification?.failures || []) {
        add(failure);
    }

    for (const resolution of context.resolutionReport?.resolutions || []) {
        add(resolution);
    }

    for (const fix of context.autoFixReport?.fixes || []) {
        if (
            fix?.fixType === 'INCLUDE_DISCOVERED_DEPENDENCY' &&
            fix.successful === true
        ) {
            add({
                metadataType: fix.metadataType,
                metadataName: fix.metadataName,
                severity: 'INFO',
                resolutionType: 'AUTO_FIXED_DEPENDENCY',
                reason: fix.action || 'Dependency was automatically included.',
                recommendation:
                    'Dependency was automatically added during validation.',
                autoFixed: true,
                autoFixAvailable: true,
                userActionRequired: false,
                canAutoFix: true,
                safeToSkip: null
            });
        }
    }

    for (const failure of context.enterpriseDeploymentReport?.failures || []) {
        add(failure);
    }

    for (const resolution of context.enterpriseDeploymentReport?.resolutions ||
        []) {
        add(resolution);
    }

    return items;
}

function deriveResolutionCategory(item) {
    if (!item) {
        return 'NONE';
    }

    if (item.autoFixed === true) {
        return 'DEPENDENCY';
    }

    const resolutionType = String(item.resolutionType || '').toUpperCase();
    if (
        [
            'DEPENDENCY',
            'PACKAGE',
            'WORKSPACE',
            'RETRY',
            'ENABLE_FEATURE',
            'MANUAL_METADATA_CHANGE',
            'MANUAL_CONFIGURATION',
            'INFORMATION'
        ].includes(resolutionType)
    ) {
        return resolutionType;
    }

    if (resolutionType === 'AUTO_FIXED_DEPENDENCY') {
        return 'DEPENDENCY';
    }

    const reason = String(item.reason || '').toLowerCase();
    const category = String(item.category || '').toLowerCase();

    if (reason.includes('person account') || reason.includes('personaccount')) {
        return 'ENABLE_FEATURE';
    }

    if (reason.includes('formula') || category.includes('formula')) {
        return 'MANUAL_METADATA_CHANGE';
    }

    if (reason.includes('dependency') || reason.includes('not included')) {
        return 'DEPENDENCY';
    }

    return 'NONE';
}

function deriveBackendCanAutoFix(item, evidence = null) {
    if (evidence?.successfulInclude || evidence?.flexiPageWorkspaceModified) {
        return true;
    }

    return false;
}

function deriveUserActionRequired(item, evidence = null) {
    if (deriveBackendCanAutoFix(item, evidence)) {
        return false;
    }

    if (evidence?.appliedSkip) {
        return false;
    }

    if (!item) {
        return true;
    }

    if (item.autoFixed === true) {
        return false;
    }

    if (typeof item.userActionRequired === 'boolean') {
        return item.userActionRequired;
    }

    return true;
}

function deriveSafeToSkip(item, evidence = null) {
    if (evidence?.appliedSkip) {
        return true;
    }

    return null;
}

function isFieldTypeConversion(componentFacts) {
    return (
        componentFacts?.comparison?.conflictType === 'FIELD_TYPE_CONVERSION'
    );
}

/**
 * Backend-owned resolution owner. Not LLM-decided.
 * Does not invent ownership from raw Salesforce CLI text.
 */
function getMatchedFlowDependency(flowEvidence) {
    const dependencies = flowEvidence?.dependencies;

    if (!Array.isArray(dependencies) || dependencies.length !== 1) {
        return null;
    }

    return dependencies[0];
}

function isFlowPackageGap(dependency) {
    return (
        dependency?.review?.discovered === true &&
        dependency?.sourceArtifact?.exists === true &&
        dependency?.deploymentPackage?.included === false
    );
}

function isFlowSourceMissing(dependency) {
    return dependency?.sourceArtifact?.exists === false;
}

function deriveFixOwner(item, componentFacts, flowEvidence = null, evidence = null) {
    if (evidence?.successfulInclude || evidence?.flexiPageWorkspaceModified) {
        return FIX_OWNERS.RUNTIME_AUTOFIX;
    }

    if (isFieldTypeConversion(componentFacts)) {
        return FIX_OWNERS.MANUAL_METADATA;
    }

    const resolutionType = String(item?.resolutionType || '').toUpperCase();

    if (resolutionType === 'ENABLE_FEATURE') {
        return FIX_OWNERS.DESTINATION_FEATURE;
    }

    const flowDependency = getMatchedFlowDependency(flowEvidence);

    if (
        flowDependency &&
        (isFlowPackageGap(flowDependency) || isFlowSourceMissing(flowDependency))
    ) {
        return FIX_OWNERS.MANUAL_METADATA;
    }

    if (isUnknownUserPermission(item)) {
        return FIX_OWNERS.MANUAL_METADATA;
    }

    if (isInvalidCompactLayout(item)) {
        return FIX_OWNERS.MANUAL_METADATA;
    }

    if (isApexTestOrCoverage(item) || resolutionType === 'MANUAL_METADATA_CHANGE') {
        return FIX_OWNERS.MANUAL_METADATA;
    }

    if (evidence?.compatibilityExclusion) {
        return FIX_OWNERS.MANUAL_METADATA;
    }

    return FIX_OWNERS.UNKNOWN;
}

function deriveBackendResolution(
    fixOwner,
    componentFacts,
    flowEvidence = null,
    evidence = null,
    item = null
) {
    if (evidence?.successfulInclude) {
        const included = autoFixIncludeTarget(
            evidence.successfulInclude.metadataType,
            evidence.successfulInclude.metadataName
        );

        return (
            `The backend automatically included ${included.metadataType} ${included.metadataName}` +
            ' because it was a required deployment dependency with a resolved source artifact. ' +
            'The deployment package was regenerated and revalidated. ' +
            'Salesforce source and destination metadata were not changed.'
        );
    }

    if (evidence?.flexiPageWorkspaceModified) {
        return (
            'The backend removed the unsupported tabset label from the temporary ' +
            'deployment workspace copy before check-only validation. ' +
            'Source Git metadata and Salesforce org metadata were not changed.'
        );
    }

    if (isFieldTypeConversion(componentFacts)) {
        if (fixOwner !== FIX_OWNERS.MANUAL_METADATA) {
            return null;
        }

        const source = componentFacts.source;
        const destination = componentFacts.destination;
        let text =
            `Source field type is ${source?.type ?? 'UNKNOWN'}` +
            ` (calculated=${String(source?.calculated)})` +
            ` while destination field type is ${destination?.type ?? 'UNKNOWN'}` +
            ` (calculated=${String(destination?.calculated)}).` +
            ' Salesforce does not allow this in-place conversion.';

        if (evidence?.compatibilityExclusion) {
            text +=
                ' The backend excluded this incompatible metadata member from the generated deployment package. ' +
                'Exclusion is not a field conversion.';
        }

        return text;
    }

    const flowDependency = getMatchedFlowDependency(flowEvidence);

    if (flowDependency && fixOwner === FIX_OWNERS.MANUAL_METADATA) {
        if (isFlowPackageGap(flowDependency)) {
            return (
                `The Flow references CustomField ${flowDependency.metadataName}. ` +
                'The dependency exists in the source branch but was not included in the deployment package.'
            );
        }

        if (isFlowSourceMissing(flowDependency)) {
            return (
                `The Flow references CustomField ${flowDependency.metadataName}. ` +
                'No source artifact was resolved for that field. ' +
                'Confirm the field metadata exists in the source branch, then re-run Deployment Review.'
            );
        }
    }

    if (isUnknownUserPermission(item)) {
        return (
            'The destination/profile metadata contains a permission that is not ' +
            'recognized or available in the target Salesforce environment.'
        );
    }

    if (isInvalidCompactLayout(item)) {
        return (
            'The RecordType CompactLayout assignment is invalid. ' +
            'The backend can discover CompactLayout dependencies but cannot rewrite CompactLayout or RecordType assignment metadata.'
        );
    }

    if (isApexTestOrCoverage(item)) {
        return (
            'Deployment requires passing Apex tests and coverage thresholds. ' +
            'The backend cannot repair Apex test classes automatically.'
        );
    }

    if (evidence?.compatibilityExclusion) {
        return (
            'The backend excluded this incompatible metadata member from the generated deployment package. ' +
            'Exclusion is not a metadata conversion or Salesforce org change.'
        );
    }

    if (evidence?.appliedSkip) {
        return (
            'The backend excluded this component from the deployment package after determining it was safe to skip. ' +
            'Source metadata was not changed.'
        );
    }

    return null;
}

function buildManualResolutionSteps(item, evidence, flowDependency) {
    if (evidence?.successfulInclude || evidence?.flexiPageWorkspaceModified) {
        return [
            'Review the auto-fix report to confirm the backend operation completed.',
            'Confirm check-only validation results for the regenerated package.',
            'Proceed with deployment only if check-only succeeded.'
        ];
    }

    const flowSteps = buildFlowResolutionSteps(flowDependency);

    if (flowSteps) {
        return flowSteps;
    }

    if (isUnknownUserPermission(item)) {
        return [
            'Open the affected Profile.',
            'Verify whether the permission exists in the destination Salesforce release/org.',
            'Remove or reconcile the unsupported permission in source metadata.',
            'Re-run validation.'
        ];
    }

    if (isInvalidCompactLayout(item)) {
        return [
            'Open the affected RecordType.',
            'Assign a CompactLayout that exists in the source package and destination org.',
            'Re-run deployment review and validation.',
            'Confirm check-only succeeds before deploying.'
        ];
    }

    return null;
}

function buildFlowResolutionSteps(dependency) {
    if (isFlowPackageGap(dependency)) {
        return [
            'Re-run Deployment Review for the Flow.',
            `Confirm ${dependency.metadataName} appears as a required CustomField dependency.`,
            'Re-run deployment validation.',
            'Confirm check-only succeeds.',
            'Proceed with deployment.'
        ];
    }

    if (isFlowSourceMissing(dependency)) {
        return [
            `Confirm CustomField ${dependency.metadataName} exists in the source branch.`,
            'Re-run Deployment Review for the Flow.',
            'Re-run deployment validation.'
        ];
    }

    return null;
}

function attachBackendDerivedFields(
    explanation,
    knownItems,
    factPack = null,
    context = null
) {
    const key = failureKey(
        explanation?.metadataType,
        explanation?.metadataName
    );
    const item =
        (key &&
            knownItems.find(
                (known) =>
                    failureKey(known.metadataType, known.metadataName) === key
            )) ||
        null;

    const evidence = getComponentExecutionEvidence(
        context,
        explanation?.metadataType,
        explanation?.metadataName
    );
    const componentFacts = getComponentFactPack(
        factPack,
        explanation?.metadataType,
        explanation?.metadataName
    );
    const flowEvidence = getFlowEvidence(
        factPack,
        explanation?.metadataType,
        explanation?.metadataName
    );
    const flowDependency = getMatchedFlowDependency(flowEvidence);
    const fixOwner = deriveFixOwner(
        item,
        componentFacts,
        flowEvidence,
        evidence
    );
    const safeToSkip = deriveSafeToSkip(item, evidence);
    const backendResolution = deriveBackendResolution(
        fixOwner,
        componentFacts,
        flowEvidence,
        evidence,
        item
    );

    const enriched = {
        ...explanation,
        resolutionCategory: deriveResolutionCategory(item),
        backendCanAutoFix: deriveBackendCanAutoFix(item, evidence),
        userActionRequired: deriveUserActionRequired(item, evidence),
        safeToSkip,
        skipGuidance:
            safeToSkip === true
                ? 'Backend excluded this component from the deployment package. Source metadata was not changed.'
                : SKIP_GUIDANCE_DEFAULT,
        fixOwner,
        backendResolution,
        flowEvidence: flowEvidence || null
    };

    if (isFlowPackageGap(flowDependency) && enriched.resolutionCategory === 'NONE') {
        enriched.resolutionCategory = 'DEPENDENCY';
    }

    const manualSteps = buildManualResolutionSteps(
        item,
        evidence,
        flowDependency
    );

    if (manualSteps) {
        enriched.resolution = {
            action: deriveBackendCanAutoFix(item, evidence) ? 'BACKEND' : 'MANUAL',
            steps: manualSteps,
            reason: backendResolution
        };
    }

    if (!componentFacts) {
        return enriched;
    }

    // Backend-authoritative additive facts — never invent destination types.
    enriched.source = {
        type: componentFacts.source?.type ?? null,
        calculated: componentFacts.source?.calculated ?? null,
        confidence: componentFacts.source?.confidence || 'UNKNOWN',
        exists: componentFacts.source?.exists ?? null,
        label: componentFacts.source?.label ?? null
    };
    enriched.destination = {
        type: componentFacts.destination?.type ?? null,
        calculated: componentFacts.destination?.calculated ?? null,
        confidence: componentFacts.destination?.confidence || 'UNKNOWN',
        exists: componentFacts.destination?.exists ?? null,
        label: componentFacts.destination?.label ?? null
    };
    enriched.conflict = {
        type: componentFacts.comparison?.conflictType ?? null,
        description: buildConflictDescription(componentFacts),
        cliProblem: componentFacts.cliProblem || null,
        classifiedReason: componentFacts.classifiedReason || null
    };

    if (!manualSteps || isFieldTypeConversion(componentFacts)) {
        enriched.resolution = {
            action: deriveResolutionAction(componentFacts),
            steps: buildResolutionSteps(componentFacts),
            reason: backendResolution || buildResolutionReason(componentFacts)
        };
    }

    return enriched;
}

function buildConflictDescription(componentFacts) {
    const comparison = componentFacts?.comparison;
    const source = componentFacts?.source;
    const destination = componentFacts?.destination;

    if (!comparison || comparison.confidence === 'UNKNOWN') {
        return (
            'Destination field type could not be verified. Salesforce reported a field definition conflict, but the exact destination type is UNKNOWN.'
        );
    }

    if (comparison.conflictType !== 'FIELD_TYPE_CONVERSION') {
        return null;
    }

    return (
        `Source field type is ${source?.type ?? 'UNKNOWN'}` +
        ` (calculated=${String(source?.calculated)})` +
        ` while destination field type is ${destination?.type ?? 'UNKNOWN'}` +
        ` (calculated=${String(destination?.calculated)}).`
    );
}

function deriveResolutionAction(componentFacts) {
    const comparison = componentFacts?.comparison;

    if (!comparison || comparison.confidence === 'UNKNOWN') {
        return 'MANUAL';
    }

    if (comparison.conflictType === 'FIELD_TYPE_CONVERSION') {
        return 'BOTH';
    }

    return 'MANUAL';
}

function buildResolutionSteps(componentFacts) {
    const comparison = componentFacts?.comparison;

    if (!comparison || comparison.confidence === 'UNKNOWN') {
        return [
            'Review the Salesforce CLI problem text for this CustomField.',
            'Verify the destination field definition in Setup.',
            'Reconcile source and destination field definitions manually before redeploying.'
        ];
    }

    if (comparison.conflictType === 'FIELD_TYPE_CONVERSION') {
        return [
            'Compare the source CustomField definition with the destination field definition.',
            'Salesforce does not allow in-place conversion between incompatible field types (including Formula ↔ non-Formula).',
            'Decide whether to change the source metadata, change the destination field, or deploy a new field — then re-validate.',
            'Do not delete or replace production fields without reviewing business impact.'
        ];
    }

    return [
        'Review the Salesforce error and reconcile source/destination metadata manually.'
    ];
}

function buildResolutionReason(componentFacts) {
    if (componentFacts?.cliProblem) {
        return componentFacts.cliProblem;
    }

    return (
        componentFacts?.classifiedReason ||
        'Manual reconciliation is required for this CustomField failure.'
    );
}

function enrichReportExplanations(
    report,
    knownItems,
    factPack = null,
    context = null
) {
    if (!report || typeof report !== 'object') {
        return report;
    }

    const explanations = Array.isArray(report.explanations)
        ? report.explanations.map((explanation) =>
              attachBackendDerivedFields(
                  explanation,
                  knownItems,
                  factPack,
                  context
              )
          )
        : [];

    return {
        ...report,
        explanations
    };
}

function buildDeterministicExplanation(item) {
    const resolutionType = String(item.resolutionType || '').toUpperCase();
    const reason = String(item.reason || '').toLowerCase();
    const category = String(item.category || '').toLowerCase();

    let base;

    if (
        item.autoFixed === true ||
        resolutionType === 'AUTO_FIXED_DEPENDENCY'
    ) {
        base = {
            metadataType: item.metadataType,
            metadataName: item.metadataName,
            severity: item.severity || 'INFO',
            title: 'Auto-fixed dependency',
            why: 'A required metadata dependency was missing from the deployment package and was resolved by the backend Auto Fix Orchestrator.',
            impact: 'The deployment package was incomplete until the dependency was included.',
            recommendedAction:
                'Dependency was automatically added during validation.',
            bestPractice: 'Use dependency discovery before deployment.',
            confidence: 'HIGH'
        };
    } else if (
        resolutionType === 'ENABLE_FEATURE' ||
        reason.includes('person account') ||
        reason.includes('personaccount')
    ) {
        base = {
            metadataType: item.metadataType,
            metadataName: item.metadataName,
            severity: item.severity || 'HIGH',
            title: 'Person Account feature dependency',
            why: 'The destination org does not contain the required Person Account RecordType.',
            impact: 'PermissionSet references cannot be validated.',
            recommendedAction:
                'Enable Person Accounts or deploy into an org where the feature is available.',
            bestPractice:
                'Validate platform feature dependencies before deployment.',
            confidence: 'HIGH'
        };
    } else if (
        resolutionType === 'MANUAL_METADATA_CHANGE' ||
        reason.includes('formula') ||
        category.includes('formula')
    ) {
        base = {
            metadataType: item.metadataType,
            metadataName: item.metadataName,
            severity: item.severity || 'HIGH',
            title: 'Formula field incompatibility',
            why: 'Salesforce does not allow conversion from Formula fields to stored field types.',
            impact:
                'Deployment cannot continue until the field types are compatible.',
            recommendedAction:
                'Create a new field or migrate data before replacing the Formula field.',
            bestPractice:
                'Perform field type migrations in multiple deployment stages.',
            confidence: 'HIGH'
        };
    } else if (
        resolutionType === 'DEPENDENCY' ||
        resolutionType === 'PACKAGE' ||
        reason.includes('dependency') ||
        reason.includes('not included')
    ) {
        base = {
            metadataType: item.metadataType,
            metadataName: item.metadataName,
            severity: item.severity || 'HIGH',
            title: 'Missing dependency',
            why: 'A required metadata dependency was not included in the deployment package.',
            impact: 'The deployment package was incomplete.',
            recommendedAction:
                item.recommendation ||
                'Include the missing dependency through discovery or explicit selection, then re-validate.',
            bestPractice: 'Use dependency discovery before deployment.',
            confidence: 'HIGH'
        };
    } else {
        base = {
            metadataType: item.metadataType,
            metadataName: item.metadataName,
            severity: item.severity || 'MEDIUM',
            title: item.reason || 'Deployment validation finding',
            why:
                item.reason ||
                'A deployment validation finding was reported for this metadata.',
            impact:
                'Deployment validation reported an issue that may block progress.',
            recommendedAction:
                item.recommendation ||
                'Review the resolution report and address the finding manually.',
            bestPractice:
                'Resolve deterministic validation findings before deploying to production.',
            confidence: 'MEDIUM'
        };
    }

    return attachBackendDerivedFields(base, [item]);
}

function buildStructuredContext(context) {
    const factPack = sanitizeFactPackForAi(context.aiResolutionFactPack);
    const knownItems = collectKnownItems(context);

    return {
        failureClassification: {
            overallStatus: context.failureClassification?.overallStatus || null,
            summary: context.failureClassification?.summary || null,
            failures: (context.failureClassification?.failures || []).map(
                (failure) => ({
                    metadataType: failure.metadataType || null,
                    metadataName: failure.metadataName || null,
                    category: failure.category || null,
                    severity: failure.severity || null,
                    reason: failure.reason || null,
                    recommendedNextStep: failure.recommendedNextStep || null,
                    cliProblem:
                        failure.evidence?.problem ||
                        failure.cliProblem ||
                        null
                })
            )
        },
        resolutionReport: {
            overallStatus: context.resolutionReport?.overallStatus || null,
            summary: context.resolutionReport?.summary || null,
            resolutions: (context.resolutionReport?.resolutions || []).map(
                (resolution) => ({
                    metadataType: resolution.metadataType || null,
                    metadataName: resolution.metadataName || null,
                    resolutionType: resolution.resolutionType || null,
                    severity: resolution.severity || null,
                    title: resolution.title || null,
                    summary: resolution.summary || null,
                    recommendation: resolution.recommendation || null,
                    autoFixAvailable: resolution.autoFixAvailable === true
                })
            )
        },
        autoFixReport: {
            autoFixAvailable: context.autoFixReport?.autoFixAvailable === true,
            autoFixApplied: context.autoFixReport?.autoFixApplied === true,
            fixes: (context.autoFixReport?.fixes || []).map((fix) => ({
                metadataType: fix.metadataType || null,
                metadataName: fix.metadataName || null,
                fixType: fix.fixType || null,
                action: fix.action || null,
                executed: fix.executed === true,
                successful: fix.successful === true
            }))
        },
        safeSkipReport: sanitizeSafeSkipReport(context.safeSkipReport),
        excludedComponents: sanitizeExcludedComponents(
            collectExcludedComponents(context)
        ),
        compatibilitySummary: sanitizeCompatibilitySummary(
            context.compatibilitySummary
        ),
        autoValidationReport: context.autoValidationReport
            ? {
                  attempts: context.autoValidationReport.attempts ?? null,
                  autoValidationExecuted:
                      context.autoValidationReport.autoValidationExecuted ===
                      true,
                  initialStatus:
                      context.autoValidationReport.initialStatus || null,
                  finalStatus: context.autoValidationReport.finalStatus || null,
                  autoFixesApplied:
                      context.autoValidationReport.autoFixesApplied ?? null,
                  revalidated:
                      context.autoValidationReport.revalidated === true
              }
            : null,
        enterpriseDeploymentReport: context.enterpriseDeploymentReport
            ? {
                  overallStatus:
                      context.enterpriseDeploymentReport.overallStatus || null,
                  summary: context.enterpriseDeploymentReport.summary || null,
                  statistics:
                      context.enterpriseDeploymentReport.statistics || null,
                  nextActions: Array.isArray(
                      context.enterpriseDeploymentReport.nextActions
                  )
                      ? context.enterpriseDeploymentReport.nextActions.map(
                            (action) => ({
                                priority: action.priority ?? null,
                                type: action.type || null,
                                metadataType: action.metadataType || null,
                                metadataName: action.metadataName || null,
                                message: action.message || null,
                                completed: action.completed === true
                            })
                        )
                      : []
              }
            : null,
        deploymentDiagnostics: context.deploymentDiagnostics
            ? {
                  componentFailureCount: Array.isArray(
                      context.deploymentDiagnostics.componentFailures
                  )
                      ? context.deploymentDiagnostics.componentFailures.length
                      : typeof context.deploymentDiagnostics
                              .componentFailureCount === 'number'
                        ? context.deploymentDiagnostics.componentFailureCount
                        : 0,
                  warningCount: Array.isArray(
                      context.deploymentDiagnostics.componentWarnings ||
                          context.deploymentDiagnostics.warnings
                  )
                      ? (
                            context.deploymentDiagnostics.componentWarnings ||
                            context.deploymentDiagnostics.warnings
                        ).length
                      : typeof context.deploymentDiagnostics.warningCount ===
                          'number'
                        ? context.deploymentDiagnostics.warningCount
                        : 0
              }
            : null,
        deploymentSummary: context.deploymentSummary
            ? {
                  status: context.deploymentSummary.status || null,
                  success: context.deploymentSummary.success,
                  message: context.deploymentSummary.message || null
              }
            : null,
        aiResolutionFactPack: factPack,
        backendOwnedResolution: knownItems.map((item) => {
            const componentFacts = getComponentFactPack(
                factPack,
                item.metadataType,
                item.metadataName
            );
            const flowEvidence = getFlowEvidence(
                factPack,
                item.metadataType,
                item.metadataName
            );
            const evidence = getComponentExecutionEvidence(
                context,
                item.metadataType,
                item.metadataName
            );
            const fixOwner = deriveFixOwner(
                item,
                componentFacts,
                flowEvidence,
                evidence
            );

            return {
                metadataType: item.metadataType,
                metadataName: item.metadataName,
                fixOwner,
                backendResolution: deriveBackendResolution(
                    fixOwner,
                    componentFacts,
                    flowEvidence,
                    evidence,
                    item
                ),
                backendCanAutoFix: deriveBackendCanAutoFix(item, evidence),
                safeToSkip: deriveSafeToSkip(item, evidence),
                flowEvidence: flowEvidence || null,
                executionEvidence: {
                    autoFixApplied: Boolean(evidence.successfulInclude),
                    safeSkipApplied: Boolean(evidence.appliedSkip),
                    compatibilityExcluded: Boolean(
                        evidence.compatibilityExclusion
                    ),
                    workspaceModified: Boolean(
                        evidence.flexiPageWorkspaceModified
                    )
                }
            };
        })
    };
}

function buildPrompt(structuredContext) {
    return `You are a Salesforce DevOps advisor.

Using ONLY the structured deployment validation context below, produce a JSON object that explains failures for business and technical users.

Rules:
- Explain what failed, why it failed, business impact, recommended resolution, and Salesforce best practice.
- Never invent metadata, package members, or components not present in the context.
- Never invent destination field types, calculated flags, or org capabilities.
- Treat aiResolutionFactPack.source as authoritative for source field facts.
- Treat aiResolutionFactPack.destination as authoritative for destination field facts.
- Treat aiResolutionFactPack.flowEvidence as authoritative for Flow dependency, source artifact, and package membership facts.
- Treat conflict / comparison.conflictType as authoritative. Do not invent a conflict type.
- Prefer cliProblem (original Salesforce error) over rewritten classification reasons when both are present.
- If destination.confidence is UNKNOWN or destination.type is null, explicitly say the destination type could not be verified. Do not claim it is Formula or any other type.
- If flowEvidence.destination.exists is null or confidence is UNKNOWN, do not claim the field exists or is missing in the destination org.
- Do not invent Flow dependency names, source artifact paths, or package membership.
- Explain conflicts using provided source/destination facts and comparison.conflictType when present.
- Give actionable user guidance (SOURCE, DESTINATION, BOTH, or MANUAL) without automatically modifying metadata.
- Never recommend unsafe skips, disabling validations, or automatically modifying the deployment package.
- Never say a component is safe to skip unless the backend context explicitly marks safeToSkip=true (it normally will not).
- Never convert FAILURE into SAFE_SKIP or claim check-only succeeded when it failed.
- Never claim deployment is ready, that metadata was changed, or that a backend fix was performed unless backendOwnedResolution.executionEvidence.autoFixApplied is true or autoFixReport shows a successful INCLUDE_DISCOVERED_DEPENDENCY for that component.
- Never override backend decisions. If autoFixReport shows a successful include, explain that the backend already included the dependency in the package. Do not say Salesforce metadata was edited.
- If executionEvidence.safeSkipApplied is true, explain that the backend excluded the component from the deployment package. Do not claim the metadata was fixed or converted.
- If executionEvidence.compatibilityExcluded is true, explain that the backend excluded the incompatible member from the package. Exclusion is not a field conversion.
- If executionEvidence.workspaceModified is true, explain that only the temporary deployment workspace copy was changed before check-only. Source Git and Salesforce org metadata were not changed.
- Backend-derived fields are authoritative: fixOwner, backendResolution, backendCanAutoFix, safeToSkip, userActionRequired, resolutionCategory, resolution.action, source, destination, conflict, flowEvidence, and executionEvidence.
- Use backendOwnedResolution.fixOwner and backendOwnedResolution.backendResolution when explaining who must act. They are backend-authored.
- Use backendOwnedResolution.backendCanAutoFix only when it is true. Discovery of a Flow dependency is not an automatic fix. A type on an include list is not an automatic fix.
- Do not invent a backend fix. Do not claim a problem is backend-fixable when fixOwner is UNKNOWN or absent.
- Do not generate fixOwner, backendResolution, backendCanAutoFix, safeToSkip, userActionRequired, resolutionCategory, resolution, source, destination, conflict, or flowEvidence. The backend attaches those after your response.
- Do not recommend deleting or replacing production fields unless facts support that option and clearly require user review of business impact.
- Return JSON only. No markdown.

Required JSON shape:
{
  "summary": "short overall summary",
  "explanations": [
    {
      "metadataType": "string|null",
      "metadataName": "string|null",
      "severity": "HIGH|MEDIUM|LOW|INFO",
      "title": "string",
      "why": "string",
      "impact": "string",
      "recommendedAction": "string",
      "bestPractice": "string",
      "confidence": "HIGH|MEDIUM|LOW"
    }
  ]
}

Structured context:
${JSON.stringify(structuredContext, null, 2)}
`;
}

function extractJsonObject(text) {
    if (!text || typeof text !== 'string') {
        return null;
    }

    const trimmed = text.trim();

    try {
        return JSON.parse(trimmed);
    } catch (_error) {
        const start = trimmed.indexOf('{');
        const end = trimmed.lastIndexOf('}');

        if (start >= 0 && end > start) {
            try {
                return JSON.parse(trimmed.slice(start, end + 1));
            } catch (_inner) {
                return null;
            }
        }
    }

    return null;
}

function normalizeExplanation(raw, knownKeys) {
    if (!raw || typeof raw !== 'object') {
        return null;
    }

    const metadataType = raw.metadataType || null;
    const metadataName = raw.metadataName || null;
    const key = failureKey(metadataType, metadataName);

    if (key && knownKeys.size > 0 && !knownKeys.has(key.toLowerCase())) {
        // Reject invented metadata.
        return null;
    }

    // Allowlisted prose only. Strip LLM-invented decision and fact fields;
    // backend re-attaches fixOwner, backendResolution, backendCanAutoFix,
    // safeToSkip, userActionRequired, resolutionCategory, resolution,
    // source, destination, conflict, and flowEvidence.
    return {
        metadataType,
        metadataName,
        severity: raw.severity || 'MEDIUM',
        title: raw.title || 'Deployment finding',
        why: raw.why || raw.reason || 'A deployment finding was reported.',
        impact: raw.impact || 'Deployment validation may be blocked.',
        recommendedAction:
            raw.recommendedAction ||
            raw.recommendation ||
            'Review the resolution report.',
        bestPractice:
            raw.bestPractice ||
            'Follow Salesforce metadata deployment best practices.',
        confidence: raw.confidence || 'MEDIUM'
    };
}

function buildDeterministicReport(knownItems, provider, summaryOverride) {
    const explanations = knownItems.map(buildDeterministicExplanation);

    return {
        available: true,
        provider: provider || null,
        generated: false,
        fallbackUsed: true,
        explanations,
        summary:
            summaryOverride ||
            (explanations.length
                ? `Deterministic fallback: generated ${explanations.length} deployment resolution explanation(s).`
                : 'No deployment failures require AI resolution.'),
        disclaimer: DEFAULT_DISCLAIMER
    };
}

/**
 * Generate an AI resolution report from structured validation outputs.
 * Used by on-demand API (and retained for unit tests).
 *
 * @param {object} context
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function generateAiResolutionReport(context = {}, options = {}) {
    const enabled = isAiEnabled(options);
    const providerOption = options.provider;
    const provider =
        providerOption !== undefined && providerOption !== null
            ? normalizeOnDemandProvider(providerOption)
            : normalizeOnDemandProvider(
                  process.env.AI_DEPLOYMENT_PROVIDER ||
                      process.env.AI_PROVIDER ||
                      'gemini'
              );

    const knownItems = collectKnownItems(context);
    const knownKeys = new Set(
        knownItems
            .map((item) => failureKey(item.metadataType, item.metadataName))
            .filter(Boolean)
            .map((key) => key.toLowerCase())
    );

    if (!enabled) {
        return emptyReport({
            available: false,
            provider,
            generated: false,
            summary: 'AI deployment resolution is disabled.',
            fallbackUsed: false
        });
    }

    if (!knownItems.length) {
        return {
            available: true,
            provider,
            generated: false,
            fallbackUsed: false,
            explanations: [],
            summary: 'No deployment failures require AI resolution.',
            disclaimer: DEFAULT_DISCLAIMER
        };
    }

    const generateText = options.generateText || generateAiText;
    const structuredContext = buildStructuredContext(context);
    const factPack = structuredContext.aiResolutionFactPack;
    const prompt = buildPrompt(structuredContext);
    const startedAt = Date.now();

    try {
        const { text, provider: usedProvider } = await generateText(prompt, {
            provider
            // Never forward client apiKey/model/systemPrompt.
        });

        const parsed = extractJsonObject(text);
        const aiExplanations = Array.isArray(parsed?.explanations)
            ? parsed.explanations
                  .map((entry) => normalizeExplanation(entry, knownKeys))
                  .filter(Boolean)
            : [];

        if (!aiExplanations.length) {
            console.log(
                '[AI Resolution] fallbackUsed=true reason=empty_or_ungrounded durationMs=' +
                    (Date.now() - startedAt)
            );
            return enrichReportExplanations(
                buildDeterministicReport(
                    knownItems,
                    usedProvider || provider,
                    parsed?.summary ||
                        'AI response was incomplete; returned deterministic resolution explanations.'
                ),
                knownItems,
                factPack,
                context
            );
        }

        console.log(
            '[AI Resolution] provider=' +
                (usedProvider || provider) +
                ' success=true fallbackUsed=false durationMs=' +
                (Date.now() - startedAt)
        );

        return enrichReportExplanations(
            {
                available: true,
                provider: usedProvider || provider,
                generated: true,
                fallbackUsed: false,
                explanations: aiExplanations,
                summary:
                    typeof parsed?.summary === 'string' && parsed.summary.trim()
                        ? parsed.summary.trim()
                        : `Generated ${aiExplanations.length} deployment resolution explanation(s).`,
                disclaimer: DEFAULT_DISCLAIMER
            },
            knownItems,
            factPack,
            context
        );
    } catch (error) {
        console.error('AI RESOLUTION LAYER ERROR');
        console.error(error?.message || error);
        console.log(
            '[AI Resolution] provider=' +
                provider +
                ' success=false fallbackUsed=true durationMs=' +
                (Date.now() - startedAt)
        );

        return enrichReportExplanations(
            buildDeterministicReport(
                knownItems,
                provider,
                'AI provider unavailable; returned deterministic resolution explanations.'
            ),
            knownItems,
            factPack,
            context
        );
    }
}

/**
 * Phase 17.7 on-demand entry point.
 *
 * @param {object} rawContext
 * @param {string} provider
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function generateOnDemandAiResolution(
    rawContext,
    provider,
    options = {}
) {
    const normalizedProvider = normalizeOnDemandProvider(provider);
    const context = sanitizeAiResolutionContext(rawContext);

    console.log(
        '[AI Resolution] on-demand request provider=' + normalizedProvider
    );

    return generateAiResolutionReport(context, {
        ...options,
        provider: normalizedProvider,
        enabled:
            options.enabled !== undefined
                ? options.enabled === true
                : isAiEnabled()
    });
}

module.exports = {
    generateAiResolutionReport,
    generateOnDemandAiResolution,
    buildOnDemandAiResolutionStub,
    sanitizeAiResolutionContext,
    normalizeOnDemandProvider,
    buildDeterministicExplanation,
    buildPrompt,
    collectKnownItems,
    buildStructuredContext,
    UnsupportedAiProviderError,
    SUPPORTED_PROVIDERS,
    ALLOWED_CONTEXT_KEYS,
    DEFAULT_DISCLAIMER,
    ON_DEMAND_STUB_SUMMARY,
    SKIP_GUIDANCE_DEFAULT,
    FIX_OWNERS
};
