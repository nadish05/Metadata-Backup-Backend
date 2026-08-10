/**
 * Support Bundle Sanitizer (Phase 17.8.1)
 *
 * Pure security boundary for Enterprise Support Bundle payloads.
 * ALLOWLIST FIRST + DENYLIST recursive safety net.
 *
 * Does not mutate input. Does not import deployment/AI/Salesforce clients.
 * Does not create deployment decisions or invoke AI.
 */

'use strict';

const REDACTED = '[REDACTED]';
const CIRCULAR = '[Circular]';
const UNSUPPORTED = '[Unsupported]';
const TRUNCATED_SUFFIX = '…[TRUNCATED]';
const DEPTH_EXCEEDED = '[MaxDepthExceeded]';
const ARRAY_TRUNCATED_MARKER = '[ArrayItemsTruncated]';

/** Deterministic size / structure guards */
const LIMITS = Object.freeze({
    maxStringLength: 4000,
    maxArrayItems: 500,
    maxDepth: 32,
    maxObjectKeys: 500,
    maxEstimatedBytes: 1_500_000
});

function normalizeKey(key) {
    return String(key || '')
        .trim()
        .toLowerCase()
        .replace(/[\s-]+/g, '_');
}

function compactKey(key) {
    return normalizeKey(key).replace(/_/g, '');
}

/**
 * Keys that are always stripped (case-insensitive exact match after normalize).
 * Covers secrets, raw CLI, source bodies, AI prompts, env dumps.
 */
const DENY_KEY_LIST = [
    // Secrets / auth
    'token',
    'accessToken',
    'refreshToken',
    'authorization',
    'apiKey',
    'secret',
    'clientSecret',
    'password',
    'cookie',
    'cookies',
    'privateKey',
    'authorizationCode',
    'oauthCode',
    'client_secret',
    'clientsecret',
    'accesstoken',
    'refreshtoken',
    'githubToken',
    'github_token',
    'openaiApiKey',
    'openai_api_key',
    'geminiApiKey',
    'gemini_api_key',
    'salesforceAccessToken',
    'salesforce_access_token',
    'salesforceRefreshToken',
    'salesforce_refresh_token',
    'sf_client_secret',
    'sfClientSecret',
    'bearerToken',
    'sessionToken',
    'sessionId',
    'id_token',
    'idToken',
    'credentials',
    'credential',
    // Raw CLI / debug
    'cliStdout',
    'cliStderr',
    'rawStdout',
    'rawStderr',
    'debugLog',
    'rawCliOutput',
    'rawFailure',
    'rawSuccess',
    'rawOutput',
    // Source / package bodies
    'sourceCode',
    'source',
    'apexSource',
    'lwcSource',
    'fileContents',
    'content',
    'rawMetadata',
    'metadataXml',
    'xmlContent',
    'repositoryContents',
    'packageXml',
    'packageXML',
    'package.xml',
    'fullPackageXml',
    'fullManifest',
    // AI unsafe
    'prompt',
    'systemPrompt',
    'rawPrompt',
    'providerResponse',
    'rawProviderResponse',
    // Env dumps
    'processEnv',
    'env',
    'environmentVariables',
    'envVars'
];

const DENY_KEYS = Object.freeze(
    new Set(DENY_KEY_LIST.flatMap((k) => [normalizeKey(k), compactKey(k)]))
);

/** Extra deny patterns: key contains these substrings (normalized). */
const DENY_KEY_SUBSTRINGS = Object.freeze([
    'accesstoken',
    'refreshtoken',
    'clientsecret',
    'apikey',
    'privatekey',
    'authorization',
    'githubtoken',
    'openai',
    'geminiapikey',
    'bearertoken'
]);

/**
 * Allowlisted diagnostic keys (case-sensitive match as commonly used in this project,
 * checked via normalize against this set).
 */
const ALLOW_KEYS = Object.freeze(
    new Set(
        [
            // Identity / correlation
            'bundleId',
            'bundleVersion',
            'generatedAt',
            'historyId',
            'deploymentId',
            'validationCorrelationId',
            'correlationId',
            'requestId',
            'id',
            'key',
            // Status / mode
            'success',
            'status',
            'overallStatus',
            'finalStatus',
            'initialStatus',
            'deploymentStatus',
            'deploymentMode',
            'executionMode',
            'stage',
            'phase',
            'duration',
            'durationMs',
            'timestamp',
            'createdAt',
            'updatedAt',
            // Metadata identity
            'metadataType',
            'metadataName',
            'type',
            'name',
            'fullName',
            'member',
            'members',
            'fileName',
            'filePath',
            'path',
            'lineNumber',
            'columnNumber',
            'componentType',
            'componentName',
            // Errors / classification
            'errorCode',
            'problemType',
            'problem',
            'message',
            'reason',
            'category',
            'classification',
            'classificationConfidence',
            'confidence',
            'severity',
            'blocking',
            'deployable',
            // Resolution / auto-fix / validation
            'resolutionType',
            'resolution',
            'resolutions',
            'autoFixAvailable',
            'autoFixApplied',
            'autoFixReport',
            'fixType',
            'fixes',
            'userActionRequired',
            'canSafeSkip',
            'safeToSkip',
            'safeSkipAvailable',
            'safeSkipApplied',
            'safeSkipReport',
            'safeSkips',
            'skippedComponents',
            'backendCanApply',
            'applied',
            'prerequisites',
            'impact',
            'decision',
            'attempts',
            'revalidated',
            'autoValidationExecuted',
            'autoValidationReport',
            'remainingFailures',
            'included',
            'excluded',
            'action',
            'actions',
            // Reports / sections
            'failureClassification',
            'failures',
            'resolutionReport',
            'enterpriseDeploymentReport',
            'deploymentDiagnostics',
            'deploymentReadiness',
            'deploymentReadinessAnalysis',
            'deploymentSummary',
            'summary',
            'details',
            'items',
            'results',
            'errors',
            'warnings',
            'componentFailures',
            'componentSuccesses',
            'diagnostics',
            'selectionSummary',
            'membersByType',
            'metadataCount',
            'dependencyCount',
            'packageSummary',
            'memberSummary',
            'types',
            'count',
            'total',
            'failedComponents',
            'successfulComponents',
            'componentsValidated',
            // AI safe fields
            'aiResolution',
            'aiResolutionReport',
            'provider',
            'generated',
            'fallbackUsed',
            'explanations',
            'disclaimer',
            'resolutionCategory',
            'backendCanAutoFix',
            'advisoryOnly',
            'aiGenerated',
            // Environment safe flags (booleans / labels only — values sanitized)
            'environment',
            'nodeEnv',
            'deploymentDebugEnabled',
            'aiEnabled',
            'AI_ENABLED',
            // Destination / org (kept; string values scrubbed)
            'username',
            'instanceUrl',
            'orgId',
            'organizationId',
            'apiVersion',
            'cliVersion',
            'featureAvailability',
            // Nested report scaffolding
            'product',
            'request',
            'sanitization',
            'applied',
            'excludedCategories',
            'reproHints',
            'stages',
            'blockingComponents',
            'errorCodes',
            'safeToSkipHints',
            'note',
            'payload',
            'sanitized',
            'data',
            'report',
            'nextActions',
            'nextAction',
            'priority',
            'title',
            'description',
            'impact',
            'severity',
            'code',
            'value',
            'label',
            'enabled',
            'available',
            'required',
            'optional',
            'present',
            'skipped',
            'skipReason',
            'decision',
            'decisions',
            'state',
            'flags',
            'version',
            'url',
            'repositoryUrl',
            'repoUrl',
            'branch',
            'ref',
            'headers',
            'body',
            'query',
            'params',
            'options',
            'context',
            'meta',
            'metadata',
            'info',
            'outcome',
            'salesforceOutcome',
            'cliCommand',
            'cliCommandRedacted',
            'issueScope',
            'selectedFailures',
            'scope'
        ].flatMap((k) => [normalizeKey(k), compactKey(k)])
    )
);

function isPlainObject(value) {
    if (value === null || typeof value !== 'object') {
        return false;
    }
    if (Array.isArray(value)) {
        return false;
    }
    const proto = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
}

function isDeniedKey(key) {
    const normalized = normalizeKey(key);
    const compact = compactKey(key);
    if (!normalized) {
        return true;
    }
    if (DENY_KEYS.has(normalized) || DENY_KEYS.has(compact)) {
        return true;
    }
    for (const part of DENY_KEY_SUBSTRINGS) {
        if (compact.includes(part) && !isAllowExceptionForSubstring(compact)) {
            return true;
        }
    }
    if (compact.includes('packagexml')) {
        return true;
    }
    return false;
}

function isAllowExceptionForSubstring(compact) {
    if (compact === 'apiversion' || compact === 'metadataapiversion') {
        return true;
    }
    return false;
}

function isAllowedKey(key) {
    const normalized = normalizeKey(key);
    if (ALLOW_KEYS.has(normalized)) {
        return true;
    }
    return ALLOW_KEYS.has(compactKey(key));
}

/**
 * Redact sensitive substrings inside string values.
 * Conservative: only patterns with clear secret evidence.
 */
function sanitizeStringValue(input) {
    if (typeof input !== 'string') {
        return input;
    }

    let value = input;

    try {
        // Bearer tokens
        value = value.replace(/\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi, `Bearer ${REDACTED}`);

        // Authorization header style
        value = value.replace(
            /\bAuthorization\s*[:=]\s*Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
            `Authorization: Bearer ${REDACTED}`
        );

        // URLs with embedded userinfo credentials: https://user:pass@host or https://TOKEN@host
        value = value.replace(
            /\b([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi,
            (_, scheme) => `${scheme}${REDACTED}@`
        );
        // Prefer stripping credentials entirely for github-style when possible
        value = value.replace(
            /\b(https?:\/\/)[^/@\s]+@((?:github\.com|raw\.githubusercontent\.com)\/[^\s'"]+)/gi,
            `$1$2`
        );

        // Query params with token/secret/key/password/auth
        value = value.replace(
            /([?&](?:access_token|refresh_token|token|api[_-]?key|secret|password|authorization|auth)=)([^&#\s'"]+)/gi,
            `$1${REDACTED}`
        );

        // Salesforce session / access token-like (00D…!… or long opaque)
        value = value.replace(
            /\b00[A-Za-z0-9]{12,15}![A-Za-z0-9._]{20,}\b/g,
            REDACTED
        );

        // GitHub PATs (ghp_, gho_, ghu_, ghs_, ghr_)
        value = value.replace(/\b(gh[pours]_[A-Za-z0-9_]{20,})\b/g, REDACTED);

        // OpenAI / Gemini style keys when clearly prefixed
        value = value.replace(/\b(sk-[A-Za-z0-9]{20,})\b/g, REDACTED);
        value = value.replace(/\b(AIza[A-Za-z0-9_-]{20,})\b/g, REDACTED);

        // refresh_token=... in free text
        value = value.replace(
            /\b(refresh[_-]?token)\s*[:=]\s*([^\s'",}]+)/gi,
            `$1=${REDACTED}`
        );
        value = value.replace(
            /\b(access[_-]?token)\s*[:=]\s*([^\s'",}]+)/gi,
            `$1=${REDACTED}`
        );

        value = truncateString(value);
    } catch (_err) {
        return REDACTED;
    }

    return value;
}

function truncateString(value) {
    if (typeof value !== 'string') {
        return value;
    }
    if (value.length <= LIMITS.maxStringLength) {
        return value;
    }
    const keep = Math.max(0, LIMITS.maxStringLength - TRUNCATED_SUFFIX.length);
    return value.slice(0, keep) + TRUNCATED_SUFFIX;
}

/**
 * Normalize absolute machine paths; keep relative force-app paths.
 */
function sanitizePathLikeString(value) {
    if (typeof value !== 'string') {
        return value;
    }

    let path = value.trim();

    // Windows absolute
    if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) {
        const forceAppIdx = path.toLowerCase().search(/force-app[\\/]/);
        if (forceAppIdx >= 0) {
            return path.slice(forceAppIdx).replace(/\\/g, '/');
        }
        return REDACTED;
    }

    // Unix absolute
    if (path.startsWith('/')) {
        const forceAppIdx = path.search(/force-app\//);
        if (forceAppIdx >= 0) {
            return path.slice(forceAppIdx);
        }
        // Known container / workspace roots without force-app → redact
        if (
            /^\/(home|Users|users|workspace|app|var|tmp|opt|root)\b/i.test(path) ||
            path.startsWith('/mnt/')
        ) {
            return REDACTED;
        }
        // Other absolute paths without force-app → redact
        return REDACTED;
    }

    return sanitizeStringValue(path);
}

function looksLikePathKey(key) {
    const n = normalizeKey(key);
    return (
        n === 'path' ||
        n === 'filepath' ||
        n === 'filename' ||
        n === 'file' ||
        n.endsWith('path') ||
        n.endsWith('filepath')
    );
}

function looksLikeUrlKey(key) {
    const n = normalizeKey(key);
    return n.includes('url') || n === 'href' || n === 'uri' || n === 'repository' || n === 'repo';
}

function isFreeKeyMapParent(keyHint) {
    const compact = compactKey(keyHint || '');
    return (
        compact === 'membersbytype' ||
        compact === 'types' ||
        compact === 'members' ||
        compact === 'errorcodes' ||
        compact === 'flags' ||
        compact === 'featureavailability'
    );
}

function sanitizeGithubOrHttpUrl(value) {
    if (typeof value !== 'string') {
        return value;
    }
    let url = value.trim();

    // Strip userinfo: https://TOKEN@github.com/org/repo.git → https://github.com/org/repo.git
    url = url.replace(
        /^(https?:\/\/)[^/@]+@([^/\s]+\/\S+)/i,
        '$1$2'
    );

    // Also handle git@ replaced already; scrub query tokens
    url = sanitizeStringValue(url);
    return url;
}

function estimateSize(value, seen, depth) {
    if (value === null || value === undefined) {
        return 4;
    }
    const t = typeof value;
    if (t === 'boolean') {
        return 5;
    }
    if (t === 'number') {
        return 16;
    }
    if (t === 'string') {
        return value.length + 2;
    }
    if (t === 'bigint' || t === 'symbol' || t === 'function') {
        return 16;
    }
    if (seen.has(value)) {
        return 12;
    }
    if (depth > LIMITS.maxDepth) {
        return 20;
    }
    if (Array.isArray(value)) {
        seen.add(value);
        let size = 2;
        const lim = Math.min(value.length, LIMITS.maxArrayItems);
        for (let i = 0; i < lim; i += 1) {
            size += estimateSize(value[i], seen, depth + 1) + 1;
            if (size > LIMITS.maxEstimatedBytes) {
                return size;
            }
        }
        return size;
    }
    if (isPlainObject(value)) {
        seen.add(value);
        let size = 2;
        const keys = Object.keys(value);
        const lim = Math.min(keys.length, LIMITS.maxObjectKeys);
        for (let i = 0; i < lim; i += 1) {
            const k = keys[i];
            size += k.length + 3 + estimateSize(value[k], seen, depth + 1);
            if (size > LIMITS.maxEstimatedBytes) {
                return size;
            }
        }
        return size;
    }
    return 16;
}

function sanitizeValue(value, keyHint, state) {
    if (value === null || value === undefined) {
        return value === undefined ? undefined : null;
    }

    if (state.depth > LIMITS.maxDepth) {
        return DEPTH_EXCEEDED;
    }

    if (state.estimatedBytes > LIMITS.maxEstimatedBytes) {
        return REDACTED;
    }

    const t = typeof value;

    if (t === 'string') {
        let out;
        if (looksLikePathKey(keyHint)) {
            out = sanitizePathLikeString(value);
        } else if (looksLikeUrlKey(keyHint)) {
            out = sanitizeGithubOrHttpUrl(value);
        } else {
            out = sanitizeStringValue(value);
        }
        state.estimatedBytes += (out ? out.length : 0) + 2;
        return out;
    }

    if (t === 'number' || t === 'boolean') {
        state.estimatedBytes += 8;
        return value;
    }

    if (t === 'bigint') {
        return String(value);
    }

    if (t === 'symbol' || t === 'function') {
        return UNSUPPORTED;
    }

    if (Array.isArray(value)) {
        if (state.seen.has(value)) {
            return CIRCULAR;
        }
        state.seen.add(value);
        state.depth += 1;
        const out = [];
        const limit = Math.min(value.length, LIMITS.maxArrayItems);
        for (let i = 0; i < limit; i += 1) {
            if (state.estimatedBytes > LIMITS.maxEstimatedBytes) {
                out.push(REDACTED);
                break;
            }
            const item = sanitizeValue(value[i], keyHint, state);
            if (item !== undefined) {
                out.push(item);
            }
        }
        if (value.length > LIMITS.maxArrayItems) {
            out.push({
                _sanitizer: ARRAY_TRUNCATED_MARKER,
                omittedCount: value.length - LIMITS.maxArrayItems
            });
        }
        state.depth -= 1;
        return out;
    }

    if (!isPlainObject(value)) {
        // Date, Buffer, Error, Map, etc.
        try {
            if (value instanceof Date) {
                return value.toISOString();
            }
        } catch (_e) {
            return UNSUPPORTED;
        }
        return UNSUPPORTED;
    }

    if (state.seen.has(value)) {
        return CIRCULAR;
    }
    state.seen.add(value);

    state.depth += 1;
    const out = {};
    const keys = Object.keys(value);
    const keyLimit = Math.min(keys.length, LIMITS.maxObjectKeys);
    let includedKeys = 0;

    for (let i = 0; i < keyLimit; i += 1) {
        if (state.estimatedBytes > LIMITS.maxEstimatedBytes) {
            out._sizeLimitReached = true;
            break;
        }

        const key = keys[i];

        try {
            if (isDeniedKey(key)) {
                continue;
            }
            // ALLOWLIST FIRST: drop unknown keys, except typed maps (membersByType, etc.)
            if (!isAllowedKey(key) && !isFreeKeyMapParent(keyHint)) {
                continue;
            }

            const child = value[key];
            const sanitizedChild = sanitizeValue(child, key, state);
            if (sanitizedChild !== undefined) {
                out[key] = sanitizedChild;
                includedKeys += 1;
            }
        } catch (_err) {
            // Never surface original payload in errors
            continue;
        }
    }

    if (keys.length > LIMITS.maxObjectKeys) {
        out._keysTruncated = true;
        out._omittedKeyCount = keys.length - LIMITS.maxObjectKeys;
    }

    state.depth -= 1;

    // Empty object is fine
    void includedKeys;
    return out;
}

/**
 * Sanitize an arbitrary diagnostic object for Support Bundle use.
 * Does not mutate the input.
 *
 * @param {*} input
 * @returns {{ sanitized: true, payload: object|null|Array|string|number|boolean }}
 */
function sanitizeSupportBundlePayload(input) {
    try {
        if (input === undefined) {
            return { sanitized: true, payload: null };
        }

        if (input === null) {
            return { sanitized: true, payload: null };
        }

        const t = typeof input;
        if (t === 'string' || t === 'number' || t === 'boolean') {
            const state = {
                seen: new WeakSet(),
                depth: 0,
                estimatedBytes: 0
            };
            return {
                sanitized: true,
                payload: sanitizeValue(input, '', state)
            };
        }

        // Pre-check estimated size of input structure (does not copy secrets out)
        const preSize = estimateSize(input, new WeakSet(), 0);
        const state = {
            seen: new WeakSet(),
            depth: 0,
            estimatedBytes: 0
        };

        let payload = sanitizeValue(input, '', state);

        if (preSize > LIMITS.maxEstimatedBytes && payload && typeof payload === 'object') {
            if (Array.isArray(payload)) {
                payload = {
                    _sizeLimitReached: true,
                    truncated: true,
                    preview: payload.slice(0, 20)
                };
            } else if (isPlainObject(payload)) {
                payload = {
                    ...payload,
                    _sizeLimitReached: true,
                    truncated: true
                };
            }
        }

        if (payload === undefined) {
            payload = null;
        }

        return {
            sanitized: true,
            payload
        };
    } catch (_err) {
        return {
            sanitized: true,
            payload: {
                _sanitizerError: true,
                message: 'Sanitization failed safely'
            }
        };
    }
}

module.exports = {
    sanitizeSupportBundlePayload,
    LIMITS,
    REDACTED,
    // Exported for focused unit assertions
    normalizeKey,
    isDeniedKey,
    isAllowedKey,
    sanitizeStringValue,
    sanitizePathLikeString,
    sanitizeGithubOrHttpUrl
};
