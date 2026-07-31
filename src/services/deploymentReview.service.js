const util = require('util');
const path = require('path');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

const dependencyAnalyzer = require('./deploymentReview/dependencyAnalyzer.service');
const namedCredentialDependencyAnalyzer = require('./deploymentReview/namedCredentialDependencyAnalyzer.service');
const customObjectDependencyAnalyzer = require('./deploymentReview/customObjectDependencyAnalyzer.service');
const customObjectValidationRuleAnalyzer = require('./deploymentReview/customObjectValidationRuleAnalyzer.service');
const customObjectRecordTypeAnalyzer = require('./deploymentReview/customObjectRecordTypeAnalyzer.service');
const customObjectChildMetadataAnalyzer = require('./deploymentReview/customObjectChildMetadataAnalyzer.service');
const customObjectFlexiPageAnalyzer = require('./deploymentReview/customObjectFlexiPageAnalyzer.service');
const dependencySelection = require('./dependencySelection.service');
const apiVersionValidator = require('./apiVersionValidator.service');
const testClassValidator = require('./testClassValidator.service');
const {
    normalizeDeployableMetadata
} = require('./deployableMetadataNormalizer.service');
const {
    canonicalizeCustomFieldDependencies
} = require('./deploymentReview/customFieldCanonicalizer.service');
const flowReview = require('./deploymentReview/flowReview.service');
const flowDestinationValidation = require('./deploymentReview/flowDestinationValidation.service');

const {
    METADATA_ORIGINS,
    shouldEnumerateCustomObjectChildren,
    resolveMetadataOrigin
} = require('./dependencyResolution/metadataGraphOrigin.model');

const APEX_REVIEW_METADATA_TYPE = 'ApexClass';
const SUPPORTED_REVIEW_METADATA_TYPES = new Set([
    'ApexClass',
    'NamedCredential',
    'ExternalCredential',
    'CustomObject',
    'Flow'
]);

const { METADATA_TYPE_RULES } = require('../config/metadataTypes');

function isSupportedReviewMetadataType(metadataType) {
    return SUPPORTED_REVIEW_METADATA_TYPES.has(metadataType);
}

function getMetadataName(filePath) {
    return path.basename(filePath, path.extname(filePath));
}

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

/**
 * Resolve a repository file path for a deployable metadata item.
 * Supports items discovered without an explicit filePath.
 */
function resolveMetadataFilePath(metadataType, metadataName, repoFiles) {
    if (!metadataType || !metadataName || !Array.isArray(repoFiles)) {
        return null;
    }

    const name = String(metadataName).trim();
    const normalizedFiles = repoFiles.map(normalizePath);

    if (metadataType === 'CustomObject') {
        const expectedSuffix = `/objects/${name}/${name}.object-meta.xml`;
        return (
            normalizedFiles.find((file) => file.endsWith(expectedSuffix)) ||
            null
        );
    }

    const rule = METADATA_TYPE_RULES[metadataType];

    if (!rule?.extension) {
        return null;
    }

    const expectedEnding = `/${name}${rule.extension}`;

    return (
        normalizedFiles.find((file) => file.endsWith(expectedEnding)) || null
    );
}

function buildEmptyDependencyAnalysisResult() {
    return {
        dependencyAnalysis: {
            requiredDependencies: [],
            recommendedTestClasses: [],
            optionalDependencies: []
        }
    };
}

/**
 * Prefer a bundle member path whose basename matches the logical component name.
 * Keeps existing Review naming (path.basename) without changing processMetadataItem.
 */
function resolveReviewIngressFilePath(item) {
    const sources = Array.isArray(item?.sourceFiles) ? item.sourceFiles : [];
    const jsMember = sources.find(
        (filePath) =>
            typeof filePath === 'string' &&
            filePath.endsWith('.js') &&
            !filePath.endsWith('.js-meta.xml')
    );

    if (jsMember) {
        return jsMember;
    }

    const nonMetaMember = sources.find(
        (filePath) =>
            typeof filePath === 'string' && !filePath.endsWith('-meta.xml')
    );

    if (nonMetaMember) {
        return nonMetaMember;
    }

    return item?.filePath || null;
}

function normalizeSelectedMetadata(selectedMetadata) {
    if (!Array.isArray(selectedMetadata)) {
        return [];
    }

    return selectedMetadata
        .map((item) => ({
            metadataType: item?.metadataType || null,
            filePath: resolveReviewIngressFilePath(item)
        }))
        .filter((item) => item.filePath);
}

function normalizeDeploymentPackage(payload) {
    if (Array.isArray(payload.selectedMetadata)) {
        return {
            comparisonId: payload.comparisonId || null,
            repoUrl: payload.repoUrl,
            sourceBranch: payload.sourceBranch || null,
            destinationBranch: payload.destinationBranch,
            // Collapse physical LWC files → logical components before Review.
            selectedMetadata: normalizeSelectedMetadata(
                normalizeDeployableMetadata(payload.selectedMetadata)
            )
        };
    }

    if (payload.filePath) {
        return {
            comparisonId: null,
            repoUrl: payload.repoUrl,
            sourceBranch: payload.sourceBranch || payload.branch,
            destinationBranch: payload.destinationBranch || payload.branch,
            selectedMetadata: normalizeSelectedMetadata(
                normalizeDeployableMetadata([
                    {
                        metadataType:
                            payload.metadataType || APEX_REVIEW_METADATA_TYPE,
                        filePath: payload.filePath
                    }
                ])
            )
        };
    }

    return {
        comparisonId: payload.comparisonId || null,
        repoUrl: payload.repoUrl,
        sourceBranch: payload.sourceBranch || payload.branch || null,
        destinationBranch: payload.destinationBranch || payload.branch,
        selectedMetadata: []
    };
}

async function withClonedRepository({ repoUrl, branch }, callback) {
    const githubToken = process.env.GITHUB_TOKEN;
    const repoPath = `/tmp/deployment-review-${Date.now()}`;

    const authenticatedUrl = repoUrl.replace(
        'https://',
        `https://${githubToken}@`
    );

    try {
        await execAsync(
            `git clone ${authenticatedUrl} ${repoPath}`
        );

        await execAsync(
            `cd ${repoPath} && git fetch --all`
        );

        const readRepoFile = async (targetPath) => {
            const fileContent = await execAsync(
                `cd ${repoPath} && git show origin/${branch}:"${targetPath}"`
            );

            return fileContent.stdout;
        };

        const listRepoFiles = async () => {
            const result = await execAsync(
                `cd ${repoPath} && git ls-tree -r --name-only origin/${branch}`
            );

            return result.stdout
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean);
        };

        return await callback(readRepoFile, listRepoFiles);
    } finally {
        await execAsync(
            `rm -rf ${repoPath}`
        );
    }
}

async function reviewSingleMetadataItem({
    metadataType,
    filePath,
    readRepoFile,
    listRepoFiles
}) {
    const content = await readRepoFile(filePath);

    const currentClassName = dependencyAnalyzer.getCurrentClassName(
        content,
        filePath
    );

    const rawDependencyAnalysis = dependencyAnalyzer.analyzeApexContent(
        content,
        currentClassName
    );

    const apiValidation = await apiVersionValidator.validateApiVersion(
        metadataType,
        filePath,
        readRepoFile
    );

    const testValidation = await testClassValidator.findTestClasses(
        metadataType,
        filePath,
        readRepoFile,
        listRepoFiles
    );

    const builtDependencyAnalysis = dependencySelection.buildDependencySelection(
        rawDependencyAnalysis,
        testValidation
    );

    // Canonicalize CustomField API names against repo field files (case only).
    // Analyzer extraction stays unchanged; graph receives canonical identities.
    const repoFiles = await listRepoFiles();
    const dependencyAnalysis = {
        ...builtDependencyAnalysis,
        requiredDependencies: canonicalizeCustomFieldDependencies(
            builtDependencyAnalysis.requiredDependencies,
            repoFiles
        )
    };

    return {
        dependencyAnalysis,
        apiValidation,
        testValidation
    };
}

function buildNotSupportedResult({ metadataType, filePath }) {
    return {
        metadataType,
        metadataName: getMetadataName(filePath),
        filePath,
        status: 'NOT_SUPPORTED_YET'
    };
}

async function processMetadataItem(
    item,
    readRepoFile,
    listRepoFiles,
    destinationCredentials = null
) {
    const { metadataType, filePath } = item;
    const metadataName = getMetadataName(filePath);
    const origin = resolveMetadataOrigin(item);

    if (!isSupportedReviewMetadataType(metadataType)) {
        return buildNotSupportedResult({ metadataType, filePath });
    }

    if (metadataType === 'ExternalCredential') {
        return {
            metadataType,
            metadataName,
            filePath,
            status: 'SUCCESS',
            ...buildEmptyDependencyAnalysisResult()
        };
    }

    if (metadataType === 'NamedCredential') {
        try {
            const content = await readRepoFile(filePath);

            return {
                metadataType,
                metadataName,
                filePath,
                status: 'SUCCESS',
                ...namedCredentialDependencyAnalyzer.analyzeNamedCredentialContent(
                    content
                )
            };
        } catch (error) {
            return {
                metadataType,
                metadataName,
                filePath,
                status: 'FAILED',
                error:
                    error.stderr ||
                    error.stdout ||
                    error.message
            };
        }
    }

    if (metadataType === 'Flow') {
        const flowName =
            flowReview.getFlowApiName(filePath) || metadataName;

        try {
            const content = await readRepoFile(filePath);
            const reviewResult = flowReview.analyzeFlowReview({
                content,
                filePath
            });

            // Phase 3 — destination existence for Phase 2 inventory only.
            // Does not rediscover or re-parse Flow XML.
            const enrichment =
                await flowDestinationValidation.enrichFlowDependenciesWithDestinationState(
                    reviewResult.dependencyAnalysis?.requiredDependencies ||
                        [],
                    destinationCredentials || {}
                );

            return {
                ...reviewResult,
                dependencyAnalysis: {
                    ...reviewResult.dependencyAnalysis,
                    requiredDependencies: enrichment.requiredDependencies,
                    destinationValidationSummary:
                        enrichment.destinationValidationSummary
                }
            };
        } catch (error) {
            return {
                metadataType,
                metadataName: flowName,
                filePath,
                status: 'FAILED',
                error:
                    error.stderr ||
                    error.stdout ||
                    error.message
            };
        }
    }

    if (metadataType === 'CustomObject') {
        const customObjectName =
            customObjectDependencyAnalyzer.getCustomObjectApiName(filePath) ||
            metadataName;

        try {
            // Context-aware CustomObject review:
            // PRIMARY_SELECTION → full child enumeration (fields, rules, etc.)
            // RELATIONSHIP_TARGET / other non-primary → preserve already-discovered
            // field deps only; do not invent artificial field dependencies.
            const reviewStrategy = shouldEnumerateCustomObjectChildren(origin)
                ? 'FULL_OBJECT'
                : 'RELATIONSHIP_ONLY';

            // TEMPORARY DEBUG — CustomObject review entry (remove after trace).
            {
                console.log('==========================================================');
                console.log('CUSTOM OBJECT REVIEW');
                console.log('==========================================================');
                console.log('Metadata Name:');
                console.log(customObjectName);
                console.log('Metadata Type:');
                console.log(metadataType);
                console.log('Origin:');
                console.log(origin);
                console.log('Selected:');
                console.log(
                    item.selected !== undefined ? item.selected : 'n/a'
                );
                console.log('Caller (if available):');
                console.log(
                    item.caller ||
                        item.discoveredBy ||
                        item.debugCaller ||
                        'n/a'
                );
                console.log('Review Strategy:');
                console.log(reviewStrategy);
                console.log('(FULL_OBJECT or RELATIONSHIP_ONLY)');
                console.log('==========================================================');
            }

            if (!shouldEnumerateCustomObjectChildren(origin)) {
                return {
                    metadataType,
                    metadataName: customObjectName,
                    filePath,
                    status: 'SUCCESS',
                    origin,
                    reviewStrategy: 'RELATIONSHIP_ONLY',
                    dependencyAnalysis: {
                        requiredDependencies: [],
                        recommendedTestClasses: [],
                        optionalDependencies: []
                    }
                };
            }

            const repoFiles = await listRepoFiles();

            const fieldAnalysis =
                customObjectDependencyAnalyzer.analyzeCustomObjectFields(
                    customObjectName,
                    repoFiles,
                    {
                        origin,
                        reviewStrategy: 'FULL_OBJECT',
                        caller:
                            item.caller ||
                            item.discoveredBy ||
                            item.debugCaller ||
                            null
                    }
                );

            const validationRuleAnalysis =
                customObjectValidationRuleAnalyzer.analyzeCustomObjectValidationRules(
                    customObjectName,
                    repoFiles
                );

            const recordTypeAnalysis =
                customObjectRecordTypeAnalyzer.analyzeCustomObjectRecordTypes(
                    customObjectName,
                    repoFiles
                );

            const childMetadataAnalysis =
                customObjectChildMetadataAnalyzer.analyzeCustomObjectChildMetadata(
                    customObjectName,
                    repoFiles
                );

            const objectMetaXmlContent = await readRepoFile(filePath);
            const flexiPageAnalysis =
                customObjectFlexiPageAnalyzer.analyzeCustomObjectFlexiPages(
                    objectMetaXmlContent
                );

            const requiredDependencies = [
                ...(fieldAnalysis.dependencyAnalysis?.requiredDependencies ||
                    []),
                ...(validationRuleAnalysis.dependencyAnalysis
                    ?.requiredDependencies || []),
                ...(recordTypeAnalysis.dependencyAnalysis?.requiredDependencies ||
                    []),
                ...(childMetadataAnalysis.dependencyAnalysis
                    ?.requiredDependencies || []),
                ...(flexiPageAnalysis.dependencyAnalysis
                    ?.requiredDependencies || [])
            ];

            const dependencyKeys = new Set();
            const dedupedRequiredDependencies = [];

            for (const dependency of requiredDependencies) {
                const key = `${dependency.type}:${dependency.name}`;

                if (dependencyKeys.has(key)) {
                    continue;
                }

                dependencyKeys.add(key);
                dedupedRequiredDependencies.push(dependency);
            }

            dedupedRequiredDependencies.sort((a, b) =>
                a.name.localeCompare(b.name)
            );

            return {
                metadataType,
                metadataName: customObjectName,
                filePath,
                status: 'SUCCESS',
                origin,
                reviewStrategy: 'FULL_OBJECT',
                dependencyAnalysis: {
                    requiredDependencies: dedupedRequiredDependencies,
                    recommendedTestClasses:
                        fieldAnalysis.dependencyAnalysis
                            ?.recommendedTestClasses || [],
                    optionalDependencies:
                        fieldAnalysis.dependencyAnalysis
                            ?.optionalDependencies || []
                }
            };
        } catch (error) {
            return {
                metadataType,
                metadataName: customObjectName,
                filePath,
                status: 'FAILED',
                origin,
                error:
                    error.stderr ||
                    error.stdout ||
                    error.message
            };
        }
    }

    try {
        const reviewResult = await reviewSingleMetadataItem({
            metadataType,
            filePath,
            readRepoFile,
            listRepoFiles
        });

        return {
            metadataType,
            metadataName,
            filePath,
            status: 'SUCCESS',
            ...reviewResult
        };
    } catch (error) {
        return {
            metadataType,
            metadataName,
            filePath,
            status: 'FAILED',
            error:
                error.stderr ||
                error.stdout ||
                error.message
        };
    }
}

async function runDeploymentReview(payload) {
    const deploymentPackage = normalizeDeploymentPackage(payload);
    const { repoUrl, sourceBranch, selectedMetadata } = deploymentPackage;
    const destinationCredentials = {
        refreshToken: payload?.refreshToken || null,
        accessToken: payload?.accessToken || null,
        instanceUrl: payload?.instanceUrl || null
    };

    if (!repoUrl || !sourceBranch) {
        throw new Error('repoUrl and sourceBranch are required');
    }

    if (!selectedMetadata.length) {
        return {
            success: true,
            deploymentReview: []
        };
    }

    const hasSupportedMetadata = selectedMetadata.some(
        (item) => isSupportedReviewMetadataType(item.metadataType)
    );

    if (!hasSupportedMetadata) {
        return {
            success: true,
            deploymentReview: selectedMetadata.map((item) =>
                buildNotSupportedResult(item)
            )
        };
    }

    return withClonedRepository(
        { repoUrl, branch: sourceBranch },
        async (readRepoFile, listRepoFiles) => {
            const reviewResult = await reviewDeployableMetadataItems({
                items: selectedMetadata.map((item) => ({
                    ...item,
                    origin:
                        item.origin || METADATA_ORIGINS.PRIMARY_SELECTION
                })),
                readRepoFile,
                listRepoFiles,
                defaultOrigin: METADATA_ORIGINS.PRIMARY_SELECTION,
                destinationCredentials
            });

            return {
                success: true,
                deploymentReview: reviewResult.deploymentReview
            };
        }
    );
}

/**
 * Reusable Deployment Review for arbitrary deployable metadata items.
 * Used by both the original user-selection review and Relationship Discovery.
 *
 * @param {{
 *   items: Array<{ metadataType?: string, type?: string, metadataName?: string, name?: string, filePath?: string, origin?: string }>,
 *   readRepoFile: Function,
 *   listRepoFiles: Function,
 *   defaultOrigin?: string,
 *   destinationCredentials?: {
 *     refreshToken?: string|null,
 *     accessToken?: string|null,
 *     instanceUrl?: string|null
 *   }|null
 * }} options
 */
async function reviewDeployableMetadataItems({
    items,
    readRepoFile,
    listRepoFiles,
    defaultOrigin = METADATA_ORIGINS.PRIMARY_SELECTION,
    destinationCredentials = null
}) {
    const deploymentReview = [];
    const aggregatedDependencies = [];
    const dependencyKeys = new Set();
    const warnings = [];
    let reviewsExecuted = 0;
    let reviewsSkipped = 0;

    if (!Array.isArray(items) || !items.length) {
        return {
            deploymentReview,
            requiredDependencies: aggregatedDependencies,
            reviewsExecuted,
            reviewsSkipped,
            warnings
        };
    }

    const repoFiles = await listRepoFiles();

    for (const item of items) {
        const metadataType = item?.metadataType || item?.type || null;
        const metadataName = item?.metadataName || item?.name || null;
        const origin = resolveMetadataOrigin(item, defaultOrigin);
        let filePath = item?.filePath ? normalizePath(item.filePath) : null;

        if (!filePath && metadataType && metadataName) {
            filePath = resolveMetadataFilePath(
                metadataType,
                metadataName,
                repoFiles
            );
        }

        if (!metadataType || !filePath) {
            reviewsSkipped += 1;
            warnings.push(
                `Unable to resolve review file path for ${metadataType || 'Unknown'}:${metadataName || 'Unknown'}`
            );
            continue;
        }

        if (!isSupportedReviewMetadataType(metadataType)) {
            reviewsSkipped += 1;
            deploymentReview.push(
                buildNotSupportedResult({ metadataType, filePath })
            );
            continue;
        }

        const result = await processMetadataItem(
            { metadataType, filePath, origin },
            readRepoFile,
            listRepoFiles,
            destinationCredentials
        );

        reviewsExecuted += 1;
        deploymentReview.push(result);

        const requiredDependencies =
            result?.dependencyAnalysis?.requiredDependencies || [];

        for (const dependency of requiredDependencies) {
            if (!dependency?.name || !dependency?.type) {
                continue;
            }

            const key = `${dependency.type}:${dependency.name}`;

            if (dependencyKeys.has(key)) {
                continue;
            }

            dependencyKeys.add(key);
            aggregatedDependencies.push({
                ...dependency,
                origin:
                    dependency.origin ||
                    METADATA_ORIGINS.DIRECT_DEPENDENCY,
                sourceMetadata:
                    result.metadataName || metadataName || dependency.sourceMetadata,
                discoveredBy: 'DeploymentReview',
                discoveryMethod: 'deploymentReview',
                reason:
                    dependency.reason ||
                    `Discovered by Deployment Review of ${result.metadataName || metadataName}.`
            });
        }
    }

    return {
        deploymentReview,
        requiredDependencies: aggregatedDependencies,
        reviewsExecuted,
        reviewsSkipped,
        warnings
    };
}

module.exports = {
    runDeploymentReview,
    reviewSingleMetadataItem,
    reviewDeployableMetadataItems,
    resolveMetadataFilePath,
    isSupportedReviewMetadataType,
    normalizeDeploymentPackage,
    SUPPORTED_REVIEW_METADATA_TYPES,
    METADATA_ORIGINS
};
