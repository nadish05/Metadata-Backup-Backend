const util = require('util');
const path = require('path');
const { exec } = require('child_process');

const {
    METADATA_TYPE_RULES,
    METADATA_KINDS,
    isBundleMetadataType,
    getMetadataTypeRule
} = require('../config/metadataTypes');

const execAsync = util.promisify(exec);

const CUSTOM_OBJECT_CHILD_METADATA_TYPES = new Set([
    'CustomField',
    'ValidationRule',
    'RecordType',
    'CompactLayout',
    'FieldSet',
    'ListView',
    'SharingReason',
    'WebLink',
    'Index'
]);

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function isSupportedMetadataType(metadataType) {
    return Boolean(METADATA_TYPE_RULES[metadataType]);
}

function isCustomObjectChildMetadataType(metadataType) {
    return CUSTOM_OBJECT_CHILD_METADATA_TYPES.has(metadataType);
}

function extractBundleNameFromPath(filePath, folder) {
    const normalized = normalizePath(filePath);
    const marker = `/${folder}/`;
    const markerIndex = normalized.indexOf(marker);

    if (markerIndex === -1) {
        return null;
    }

    const afterFolder = normalized.slice(markerIndex + marker.length);
    const bundleName = afterFolder.split('/')[0];

    return bundleName || null;
}

function resolveBundleDescriptorPath(metadataType, metadataName, filePath) {
    const rule = getMetadataTypeRule(metadataType);

    if (!rule || rule.kind !== METADATA_KINDS.BUNDLE) {
        return null;
    }

    const name =
        metadataName ||
        extractBundleNameFromPath(filePath, rule.folder);

    if (!name) {
        return null;
    }

    const descriptorFileName = `${name}${rule.descriptorExtension}`;
    const normalizedFilePath = normalizePath(filePath);

    if (normalizedFilePath) {
        if (normalizedFilePath.endsWith(descriptorFileName)) {
            return normalizedFilePath;
        }

        const marker = `/${rule.folder}/${name}/`;
        const markerIndex = normalizedFilePath.indexOf(marker);

        if (markerIndex !== -1) {
            return (
                normalizedFilePath.slice(0, markerIndex + marker.length) +
                descriptorFileName
            );
        }
    }

    return `force-app/main/default/${rule.folder}/${name}/${descriptorFileName}`;
}

function extensionMatchesMetadataType(filePath, metadataType) {
    const rule = METADATA_TYPE_RULES[metadataType];

    if (!rule || !filePath) {
        return false;
    }

    if (rule.kind === METADATA_KINDS.BUNDLE) {
        const normalized = normalizePath(filePath);
        const name = extractBundleNameFromPath(normalized, rule.folder);

        return Boolean(name) && normalized.includes(`/${rule.folder}/${name}/`);
    }

    return filePath.endsWith(rule.extension);
}

function resolveMetadataName(metadataType, filePath, metadataName) {
    if (metadataName) {
        return metadataName;
    }

    if (!filePath) {
        return null;
    }

    const rule = METADATA_TYPE_RULES[metadataType];

    if (rule?.kind === METADATA_KINDS.BUNDLE) {
        return extractBundleNameFromPath(filePath, rule.folder);
    }

    if (rule?.extension) {
        return path.basename(filePath, rule.extension);
    }

    return path.basename(filePath, path.extname(filePath));
}

function metadataNameMatchesFile(metadataType, filePath, metadataName) {
    const resolvedName = resolveMetadataName(
        metadataType,
        filePath,
        metadataName
    );

    if (!resolvedName || !filePath) {
        return false;
    }

    const expectedName = resolveMetadataName(metadataType, filePath, null);

    if (!expectedName) {
        return false;
    }

    if (resolvedName === expectedName) {
        return true;
    }

    if (
        isCustomObjectChildMetadataType(metadataType) &&
        resolvedName.endsWith(`.${expectedName}`)
    ) {
        return true;
    }

    return false;
}

function normalizeSelectedMetadata(selectedMetadata) {
    if (!Array.isArray(selectedMetadata)) {
        return [];
    }

    return selectedMetadata
        .filter((item) => item?.filePath || item?.metadataName)
        .map((item) => ({
            metadataType: item.metadataType || null,
            metadataName: item.metadataName || null,
            filePath: item.filePath || null
        }));
}

function normalizeDeploymentPackage(deploymentPackage) {
    if (!deploymentPackage || typeof deploymentPackage !== 'object') {
        return {
            repoUrl: null,
            sourceBranch: null,
            selectedMetadata: []
        };
    }

    return {
        repoUrl: deploymentPackage.repoUrl || null,
        sourceBranch:
            deploymentPackage.sourceBranch ||
            deploymentPackage.branch ||
            null,
        selectedMetadata: normalizeSelectedMetadata(
            deploymentPackage.selectedMetadata
        )
    };
}

async function withClonedRepository({ repoUrl, branch }, callback) {
    const githubToken = process.env.GITHUB_TOKEN;
    const repoPath = `/tmp/metadata-validation-${Date.now()}`;

    const authenticatedUrl = repoUrl.replace(
        'https://',
        `https://${githubToken}@`
    );

    try {
        await execAsync(`git clone ${authenticatedUrl} ${repoPath}`);
        await execAsync(`cd ${repoPath} && git fetch --all`);

        const readRepoFile = async (targetPath) => {
            const fileContent = await execAsync(
                `cd ${repoPath} && git show origin/${branch}:"${targetPath}"`
            );

            return fileContent.stdout;
        };

        return await callback(readRepoFile);
    } finally {
        await execAsync(`rm -rf ${repoPath}`);
    }
}

async function fileExistsInRepository(readRepoFile, filePath) {
    if (!filePath) {
        return false;
    }

    try {
        await readRepoFile(filePath);
        return true;
    } catch (error) {
        return false;
    }
}

async function validateBundleMetadataItem(item, readRepoFile) {
    const { metadataType, metadataName, filePath } = item;
    const rule = getMetadataTypeRule(metadataType);
    const validMetadataType = isSupportedMetadataType(metadataType);
    const resolvedName =
        resolveMetadataName(metadataType, filePath, metadataName) ||
        metadataName ||
        null;

    const descriptorPath = resolveBundleDescriptorPath(
        metadataType,
        resolvedName,
        filePath
    );

    const pathLooksLikeBundle = Boolean(
        (filePath &&
            rule &&
            normalizePath(filePath).includes(`/${rule.folder}/`)) ||
            resolvedName
    );

    const existsInSource = descriptorPath
        ? await fileExistsInRepository(readRepoFile, descriptorPath)
        : false;

    const readyForManifest = existsInSource === true;
    const status =
        validMetadataType && pathLooksLikeBundle && readyForManifest
            ? 'PASS'
            : 'BLOCKED';

    return {
        metadataName: resolvedName,
        metadataType,
        existsInSource,
        validMetadataType,
        validFilePath: pathLooksLikeBundle,
        readyForManifest,
        status
    };
}

async function validateMetadataItem(item, readRepoFile) {
    const { metadataType, metadataName, filePath } = item;

    if (isBundleMetadataType(metadataType)) {
        return validateBundleMetadataItem(item, readRepoFile);
    }

    const validMetadataType = isSupportedMetadataType(metadataType);
    const validFilePath =
        Boolean(filePath) && extensionMatchesMetadataType(filePath, metadataType);

    let existsInSource = false;

    if (validFilePath) {
        existsInSource = await fileExistsInRepository(readRepoFile, filePath);
    }

    let readyForManifest = false;

    if (
        validMetadataType &&
        validFilePath &&
        existsInSource &&
        metadataNameMatchesFile(metadataType, filePath, metadataName)
    ) {
        const rule = METADATA_TYPE_RULES[metadataType];

        if (rule.requiresMetaXml) {
            const metaXmlPath = `${filePath}-meta.xml`;
            readyForManifest = await fileExistsInRepository(
                readRepoFile,
                metaXmlPath
            );
        } else {
            readyForManifest = true;
        }
    }

    const status =
        validMetadataType &&
        validFilePath &&
        existsInSource &&
        readyForManifest
            ? 'PASS'
            : 'BLOCKED';

    return {
        metadataName:
            resolveMetadataName(metadataType, filePath, metadataName) ||
            metadataName ||
            null,
        metadataType,
        existsInSource,
        validMetadataType,
        validFilePath,
        readyForManifest,
        status
    };
}

function resolveOverallStatus(results) {
    if (!results.length) {
        return 'PASS';
    }

    return results.every((result) => result.status === 'PASS')
        ? 'PASS'
        : 'BLOCKED';
}

async function validateMetadataPackage(deploymentPackage) {
    logSection('Metadata Validation Started');

    const normalizedPackage = normalizeDeploymentPackage(deploymentPackage);
    const { repoUrl, sourceBranch, selectedMetadata } = normalizedPackage;

    if (!selectedMetadata.length) {
        logSection('Metadata Validation Complete.');

        return {
            overallStatus: 'PASS',
            results: []
        };
    }

    if (!repoUrl || !sourceBranch) {
        console.log('Metadata validation blocked: missing repository details.');

        const results = selectedMetadata.map((item) => ({
            metadataName:
                resolveMetadataName(
                    item.metadataType,
                    item.filePath,
                    item.metadataName
                ) ||
                item.metadataName ||
                null,
            metadataType: item.metadataType,
            existsInSource: false,
            validMetadataType: isSupportedMetadataType(item.metadataType),
            validFilePath: isBundleMetadataType(item.metadataType)
                ? Boolean(item.metadataName || item.filePath)
                : extensionMatchesMetadataType(
                      item.filePath,
                      item.metadataType
                  ),
            readyForManifest: false,
            status: 'BLOCKED'
        }));

        logSection('Metadata Validation Complete.');

        return {
            overallStatus: 'BLOCKED',
            results
        };
    }

    console.log('Cloning repository for metadata validation...');

    const results = await withClonedRepository(
        { repoUrl, branch: sourceBranch },
        async (readRepoFile) => {
            const validationResults = [];

            for (const item of selectedMetadata) {
                const result = await validateMetadataItem(item, readRepoFile);
                validationResults.push(result);
            }

            return validationResults;
        }
    );

    const overallStatus = resolveOverallStatus(results);

    console.log(`Metadata validation status: ${overallStatus}`);
    logSection('Metadata Validation Complete.');

    return {
        overallStatus,
        results
    };
}

module.exports = {
    validateMetadataPackage,
    isSupportedMetadataType,
    extensionMatchesMetadataType,
    isBundleMetadataType,
    resolveBundleDescriptorPath
};
