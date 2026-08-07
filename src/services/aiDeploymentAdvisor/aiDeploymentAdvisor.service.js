/**
 * AI Deployment Resolution Layer (Phase 17.5).
 *
 * Runs ONLY after deployment validation has fully completed.
 * Generates user-friendly explanations from structured reports.
 *
 * Never influences deployment decisions, package contents, metadata,
 * planner selections, auto-fix, or auto-validation.
 */

const { generateAiText } = require('../aiTextGeneration.service');

const DEFAULT_DISCLAIMER =
    'AI explanations are advisory only. They do not change deployment decisions, packages, metadata, or validation results.';

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

function resolveAdvisorConfig(options = {}) {
    const enabled =
        options.enabled !== undefined
            ? options.enabled === true
            : parseEnvBool(process.env.AI_ENABLED, false);

    const provider = String(
        options.provider ||
            options.model ||
            process.env.AI_DEPLOYMENT_PROVIDER ||
            process.env.AI_PROVIDER ||
            'gemini'
    )
        .trim()
        .toLowerCase();

    return {
        enabled,
        provider: provider === 'gpt' ? 'openai' : provider
    };
}

function emptyReport(overrides = {}) {
    return {
        available: false,
        provider: null,
        generated: false,
        explanations: [],
        summary: null,
        disclaimer: DEFAULT_DISCLAIMER,
        ...overrides
    };
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
            autoFixed: entry.autoFixed === true
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
                autoFixed: true
            });
        }
    }

    return items;
}

function buildDeterministicExplanation(item) {
    const resolutionType = String(item.resolutionType || '').toUpperCase();
    const reason = String(item.reason || '').toLowerCase();
    const category = String(item.category || '').toLowerCase();

    if (
        item.autoFixed === true ||
        resolutionType === 'AUTO_FIXED_DEPENDENCY'
    ) {
        return {
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
    }

    if (
        resolutionType === 'ENABLE_FEATURE' ||
        reason.includes('person account') ||
        reason.includes('personaccount')
    ) {
        return {
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
    }

    if (
        resolutionType === 'MANUAL_METADATA_CHANGE' ||
        reason.includes('formula') ||
        category.includes('formula')
    ) {
        return {
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
    }

    if (
        resolutionType === 'DEPENDENCY' ||
        resolutionType === 'PACKAGE' ||
        reason.includes('dependency') ||
        reason.includes('not included')
    ) {
        return {
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
    }

    return {
        metadataType: item.metadataType,
        metadataName: item.metadataName,
        severity: item.severity || 'MEDIUM',
        title: item.reason || 'Deployment validation finding',
        why:
            item.reason ||
            'A deployment validation finding was reported for this metadata.',
        impact: 'Deployment validation reported an issue that may block progress.',
        recommendedAction:
            item.recommendation ||
            'Review the resolution report and address the finding manually.',
        bestPractice:
            'Resolve deterministic validation findings before deploying to production.',
        confidence: 'MEDIUM'
    };
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
        deploymentDiagnostics: context.deploymentDiagnostics
            ? {
                  componentFailureCount: Array.isArray(
                      context.deploymentDiagnostics.componentFailures
                  )
                      ? context.deploymentDiagnostics.componentFailures.length
                      : 0,
                  warningCount: Array.isArray(
                      context.deploymentDiagnostics.componentWarnings ||
                          context.deploymentDiagnostics.warnings
                  )
                      ? (
                            context.deploymentDiagnostics.componentWarnings ||
                            context.deploymentDiagnostics.warnings
                        ).length
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

function buildDeterministicReport(knownItems, provider) {
    const explanations = knownItems.map(buildDeterministicExplanation);

    return {
        available: true,
        provider: provider || null,
        generated: true,
        explanations,
        summary: explanations.length
            ? `Generated ${explanations.length} deployment resolution explanation(s).`
            : 'No deployment failures required AI explanation.',
        disclaimer: DEFAULT_DISCLAIMER
    };
}

/**
 * Generate an additive AI resolution report from structured validation outputs.
 *
 * @param {object} context
 * @param {object} [options]
 * @returns {Promise<object>}
 */
async function generateAiResolutionReport(context = {}, options = {}) {
    const config = resolveAdvisorConfig(options);
    const knownItems = collectKnownItems(context);
    const knownKeys = new Set(
        knownItems
            .map((item) => failureKey(item.metadataType, item.metadataName))
            .filter(Boolean)
            .map((key) => key.toLowerCase())
    );

    if (!config.enabled) {
        return emptyReport({
            available: false,
            provider: config.provider,
            generated: false,
            summary: 'AI Resolution Layer is disabled.'
        });
    }

    if (!knownItems.length) {
        return {
            available: true,
            provider: config.provider,
            generated: true,
            explanations: [],
            summary: 'No deployment failures required AI explanation.',
            disclaimer: DEFAULT_DISCLAIMER
        };
    }

    const generateText = options.generateText || generateAiText;
    const structuredContext = buildStructuredContext(context);
    const prompt = buildPrompt(structuredContext);

    try {
        const { text, provider } = await generateText(prompt, {
            provider: config.provider,
            ...options.generateOptions
        });

        const parsed = extractJsonObject(text);
        const aiExplanations = Array.isArray(parsed?.explanations)
            ? parsed.explanations
                  .map((entry) => normalizeExplanation(entry, knownKeys))
                  .filter(Boolean)
            : [];

        if (!aiExplanations.length) {
            const fallback = buildDeterministicReport(knownItems, provider);
            fallback.summary =
                parsed?.summary ||
                fallback.summary ||
                'Generated deterministic deployment explanations.';
            return fallback;
        }

        return {
            available: true,
            provider: provider || config.provider,
            generated: true,
            explanations: aiExplanations,
            summary:
                typeof parsed?.summary === 'string' && parsed.summary.trim()
                    ? parsed.summary.trim()
                    : `Generated ${aiExplanations.length} deployment resolution explanation(s).`,
            disclaimer: DEFAULT_DISCLAIMER
        };
    } catch (error) {
        console.error('AI RESOLUTION LAYER ERROR');
        console.error(error?.message || error);

        const fallback = buildDeterministicReport(knownItems, config.provider);
        fallback.summary =
            'AI provider unavailable; returned deterministic resolution explanations.';
        return fallback;
    }
}

module.exports = {
    generateAiResolutionReport,
    buildDeterministicExplanation,
    buildPrompt,
    collectKnownItems,
    buildStructuredContext,
    DEFAULT_DISCLAIMER
};
