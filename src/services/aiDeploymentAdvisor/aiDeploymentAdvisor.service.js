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
    'deploymentSummary'
]);

const SUPPORTED_PROVIDERS = Object.freeze(['gemini', 'openai']);

const SKIP_GUIDANCE_DEFAULT =
    'Backend has not marked this component as safe to skip. Skipping is not recommended.';

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

function collectKnownItems(context) {
    const items = [];
    const seen = new Set();

    const add = (entry) => {
        if (!entry) {
            return;
        }

        const metadataType = entry.metadataType || entry.type || null;
        const metadataName = entry.metadataName || entry.name || null;
        const key = failureKey(metadataType, metadataName);

        if (!key || seen.has(key.toLowerCase())) {
            return;
        }

        seen.add(key.toLowerCase());
        items.push({
            key,
            metadataType,
            metadataName,
            severity: entry.severity || entry.category || null,
            category: entry.category || null,
            resolutionType: entry.resolutionType || null,
            reason: entry.reason || entry.summary || entry.title || null,
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
        });
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

function deriveBackendCanAutoFix(item) {
    if (!item) {
        return false;
    }

    if (item.autoFixed === true || item.canAutoFix === true) {
        return true;
    }

    if (item.autoFixAvailable === true) {
        return true;
    }

    return false;
}

function deriveUserActionRequired(item) {
    if (!item) {
        return true;
    }

    if (item.autoFixed === true) {
        return false;
    }

    if (typeof item.userActionRequired === 'boolean') {
        return item.userActionRequired;
    }

    return !deriveBackendCanAutoFix(item);
}

function deriveSafeToSkip(item) {
    // Phase 17.7: never invent safe-skip. Only pass through explicit backend flags.
    if (item && item.safeToSkip === true) {
        return true;
    }

    if (item && item.safeToSkip === false) {
        return false;
    }

    return null;
}

function attachBackendDerivedFields(explanation, knownItems) {
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

    const safeToSkip = deriveSafeToSkip(item);

    return {
        ...explanation,
        resolutionCategory: deriveResolutionCategory(item),
        backendCanAutoFix: deriveBackendCanAutoFix(item),
        userActionRequired: deriveUserActionRequired(item),
        safeToSkip,
        skipGuidance:
            safeToSkip === true
                ? 'Backend marked this component as safe to skip.'
                : SKIP_GUIDANCE_DEFAULT
    };
}

function enrichReportExplanations(report, knownItems) {
    if (!report || typeof report !== 'object') {
        return report;
    }

    const explanations = Array.isArray(report.explanations)
        ? report.explanations.map((explanation) =>
              attachBackendDerivedFields(explanation, knownItems)
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
                    recommendedNextStep: failure.recommendedNextStep || null
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
            : null
    };
}

function buildPrompt(structuredContext) {
    return `You are a Salesforce DevOps advisor.

Using ONLY the structured deployment validation context below, produce a JSON object that explains failures for business and technical users.

Rules:
- Explain what failed, why it failed, business impact, recommended resolution, and Salesforce best practice.
- Never invent metadata, package members, or components not present in the context.
- Never recommend unsafe skips, disabling validations, or automatically modifying the deployment package.
- Never say a component is safe to skip unless the backend context explicitly marks safeToSkip=true (it normally will not).
- Never override backend decisions. If autoFixReport shows a successful include, explain that the backend already auto-fixed it.
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

    // Strip any client/model-invented decision fields; backend derives them.
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
                knownItems
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
            knownItems
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
            knownItems
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
    SKIP_GUIDANCE_DEFAULT
};
