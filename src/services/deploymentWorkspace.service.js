const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');

const { METADATA_TYPE_RULES } = require('../config/metadataTypes');
const {
    CHILD_METADATA_CONFIG
} = require('./deploymentReview/customObjectChildMetadataAnalyzer.service');

const execAsync = util.promisify(exec);
const mkdir = util.promisify(fs.mkdir);
const copyFile = util.promisify(fs.copyFile);
const writeFile = util.promisify(fs.writeFile);
const stat = util.promisify(fs.stat);
const rm = util.promisify(fs.rm);

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const REPOSITORY_CACHE_ROOT = path.join(
    PROJECT_ROOT,
    'cache',
    'repositories'
);
const DEPLOYMENT_WORKSPACE_ROOT = path.join(
    PROJECT_ROOT,
    'deployment',
    'workspaces'
);

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function getRepositoryHash(repoUrl) {
    return crypto.createHash('sha256').update(repoUrl).digest('hex');
}

function getAuthenticatedRepoUrl(repoUrl) {
    const githubToken = process.env.GITHUB_TOKEN;

    if (!githubToken || !repoUrl?.startsWith('https://')) {
        return repoUrl;
    }

    return repoUrl.replace('https://', `https://${githubToken}@`);
}

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch (error) {
        return false;
    }
}

async function isGitRepository(repoPath) {
    return pathExists(path.join(repoPath, '.git'));
}

async function prepareRepository(repoUrl) {
    logSection('Preparing Repository');

    const repositoryHash = getRepositoryHash(repoUrl);
    const repoPath = path.join(REPOSITORY_CACHE_ROOT, repositoryHash);
    const authenticatedUrl = getAuthenticatedRepoUrl(repoUrl);

    await mkdir(REPOSITORY_CACHE_ROOT, { recursive: true });

    if (!(await isGitRepository(repoPath))) {
        await mkdir(path.dirname(repoPath), { recursive: true });
        await execAsync(
            `git clone ${shellQuote(authenticatedUrl)} ${shellQuote(repoPath)}`
        );
    } else {
        await execAsync(
            `cd ${shellQuote(repoPath)} && git fetch --all`
        );
    }

    return repoPath;
}

async function checkoutSourceBranch(repoPath, sourceBranch) {
    logSection('Checking Out Source Branch');

    await execAsync(
        `cd ${shellQuote(repoPath)} && git fetch --all`
    );

    try {
        await execAsync(
            `cd ${shellQuote(repoPath)} && git checkout ${shellQuote(sourceBranch)}`
        );
    } catch (error) {
        await execAsync(
            `cd ${shellQuote(repoPath)} && git checkout -B ${shellQuote(sourceBranch)} origin/${sourceBranch}`
        );
    }
}

async function listRepositoryFiles(repoPath) {
    const result = await execAsync(
        `cd ${shellQuote(repoPath)} && git ls-tree -r --name-only HEAD`
    );

    return result.stdout
        .split('\n')
        .map((line) => line.trim().replace(/\\/g, '/'))
        .filter(Boolean);
}

function getCompanionMetaXmlPath(filePath) {
    return `${filePath}-meta.xml`;
}

function getMissingFileLabel(type, name, filePath) {
    if (name) {
        return name;
    }

    if (filePath) {
        return path.basename(filePath);
    }

    return type || 'unknown';
}

function resolveCustomFieldPath(name, repoFiles) {
    const rule = METADATA_TYPE_RULES.CustomField;

    if (!name.includes('.')) {
        return null;
    }

    const [objectName, fieldName] = name.split('.');
    const suffix = rule.extension;

    return (
        repoFiles.find(
            (repoFile) =>
                repoFile.endsWith(suffix) &&
                repoFile.includes(`/objects/${objectName}/`) &&
                path.basename(repoFile, suffix) === fieldName
        ) || null
    );
}

function resolveCustomObjectPath(name, repoFiles) {
    const suffix = METADATA_TYPE_RULES.CustomObject.extension;

    return (
        repoFiles.find((repoFile) => {
            if (!repoFile.endsWith(suffix)) {
                return false;
            }

            const baseName = path.basename(repoFile, suffix);

            return (
                baseName === name ||
                repoFile.includes(`/objects/${name}/`)
            );
        }) || null
    );
}

function resolveCustomMetadataPath(name, repoFiles) {
    const suffix = METADATA_TYPE_RULES.CustomMetadata.extension;
    const recordName = name.includes('.')
        ? name.split('.').pop()
        : name;

    return (
        repoFiles.find(
            (repoFile) =>
                repoFile.endsWith(suffix) &&
                path.basename(repoFile, suffix) === recordName
        ) || null
    );
}

function resolveCustomLabelPath(repoFiles) {
    return (
        repoFiles.find((repoFile) =>
            repoFile.endsWith('CustomLabels.labels-meta.xml')
        ) || null
    );
}

function getChildMetadataFolder(dependencyType) {
    const config = CHILD_METADATA_CONFIG.find(
        (entry) => entry.dependencyType === dependencyType
    );

    return config?.folder || null;
}

function resolveObjectChildMetadataPath(
    objectApiName,
    childApiName,
    repoFiles,
    folder,
    extension
) {
    if (!objectApiName || !childApiName || !folder || !extension) {
        return null;
    }

    if (!Array.isArray(repoFiles)) {
        return null;
    }

    const expectedFolder = `/objects/${objectApiName}/${folder}/`;

    return (
        repoFiles.find(
            (repoFile) =>
                repoFile.endsWith(extension) &&
                repoFile.includes(expectedFolder) &&
                path.basename(repoFile, extension) === childApiName
        ) || null
    );
}

function resolveValidationRulePath(objectApiName, childApiName, repoFiles) {
    return resolveObjectChildMetadataPath(
        objectApiName,
        childApiName,
        repoFiles,
        'validationRules',
        METADATA_TYPE_RULES.ValidationRule.extension
    );
}

function resolveRecordTypePath(objectApiName, childApiName, repoFiles) {
    return resolveObjectChildMetadataPath(
        objectApiName,
        childApiName,
        repoFiles,
        'recordTypes',
        METADATA_TYPE_RULES.RecordType.extension
    );
}

function resolveCompactLayoutPath(objectApiName, childApiName, repoFiles) {
    return resolveObjectChildMetadataPath(
        objectApiName,
        childApiName,
        repoFiles,
        getChildMetadataFolder('CompactLayout'),
        METADATA_TYPE_RULES.CompactLayout.extension
    );
}

function resolveFieldSetPath(objectApiName, childApiName, repoFiles) {
    return resolveObjectChildMetadataPath(
        objectApiName,
        childApiName,
        repoFiles,
        getChildMetadataFolder('FieldSet'),
        METADATA_TYPE_RULES.FieldSet.extension
    );
}

function resolveListViewPath(objectApiName, childApiName, repoFiles) {
    return resolveObjectChildMetadataPath(
        objectApiName,
        childApiName,
        repoFiles,
        getChildMetadataFolder('ListView'),
        METADATA_TYPE_RULES.ListView.extension
    );
}

function resolveSharingReasonPath(objectApiName, childApiName, repoFiles) {
    return resolveObjectChildMetadataPath(
        objectApiName,
        childApiName,
        repoFiles,
        getChildMetadataFolder('SharingReason'),
        METADATA_TYPE_RULES.SharingReason.extension
    );
}

function resolveWebLinkPath(objectApiName, childApiName, repoFiles) {
    return resolveObjectChildMetadataPath(
        objectApiName,
        childApiName,
        repoFiles,
        getChildMetadataFolder('WebLink'),
        METADATA_TYPE_RULES.WebLink.extension
    );
}

function resolveIndexPath(objectApiName, childApiName, repoFiles) {
    return resolveObjectChildMetadataPath(
        objectApiName,
        childApiName,
        repoFiles,
        getChildMetadataFolder('Index'),
        METADATA_TYPE_RULES.Index.extension
    );
}

function parseObjectChildName(name) {
    if (!name || !name.includes('.')) {
        return null;
    }

    const [objectApiName, childApiName] = name.split('.');

    if (!objectApiName || !childApiName) {
        return null;
    }

    return { objectApiName, childApiName };
}

function resolvePathByTypeAndName(type, name, repoFiles) {
    if (type === 'CustomField') {
        return resolveCustomFieldPath(name, repoFiles);
    }

    if (type === 'CustomObject') {
        return resolveCustomObjectPath(name, repoFiles);
    }

    if (type === 'CustomMetadata') {
        return resolveCustomMetadataPath(name, repoFiles);
    }

    if (type === 'CustomLabel') {
        return resolveCustomLabelPath(repoFiles);
    }

    if (type === 'ValidationRule') {
        const parsed = parseObjectChildName(name);
        return parsed
            ? resolveValidationRulePath(
                  parsed.objectApiName,
                  parsed.childApiName,
                  repoFiles
              )
            : null;
    }

    if (type === 'RecordType') {
        const parsed = parseObjectChildName(name);
        return parsed
            ? resolveRecordTypePath(
                  parsed.objectApiName,
                  parsed.childApiName,
                  repoFiles
              )
            : null;
    }

    if (type === 'CompactLayout') {
        const parsed = parseObjectChildName(name);
        return parsed
            ? resolveCompactLayoutPath(
                  parsed.objectApiName,
                  parsed.childApiName,
                  repoFiles
              )
            : null;
    }

    if (type === 'FieldSet') {
        const parsed = parseObjectChildName(name);
        return parsed
            ? resolveFieldSetPath(
                  parsed.objectApiName,
                  parsed.childApiName,
                  repoFiles
              )
            : null;
    }

    if (type === 'ListView') {
        const parsed = parseObjectChildName(name);
        return parsed
            ? resolveListViewPath(
                  parsed.objectApiName,
                  parsed.childApiName,
                  repoFiles
              )
            : null;
    }

    if (type === 'SharingReason') {
        const parsed = parseObjectChildName(name);
        return parsed
            ? resolveSharingReasonPath(
                  parsed.objectApiName,
                  parsed.childApiName,
                  repoFiles
              )
            : null;
    }

    if (type === 'WebLink') {
        const parsed = parseObjectChildName(name);
        return parsed
            ? resolveWebLinkPath(
                  parsed.objectApiName,
                  parsed.childApiName,
                  repoFiles
              )
            : null;
    }

    if (type === 'Index') {
        const parsed = parseObjectChildName(name);
        return parsed
            ? resolveIndexPath(
                  parsed.objectApiName,
                  parsed.childApiName,
                  repoFiles
              )
            : null;
    }

    const rule = METADATA_TYPE_RULES[type];

    if (!rule) {
        return null;
    }

    const extension = rule.extension;

    return (
        repoFiles.find(
            (repoFile) =>
                repoFile.endsWith(extension) &&
                path.basename(repoFile, extension) === name
        ) || null
    );
}

function resolveMetadataItemPath(item, repoFiles) {
    if (item?.filePath) {
        return item.filePath.replace(/\\/g, '/');
    }

    if (item?.metadataType && item?.metadataName) {
        return resolvePathByTypeAndName(
            item.metadataType,
            item.metadataName,
            repoFiles
        );
    }

    return null;
}

function getFilesToCopy(filePath, metadataType) {
    const files = [filePath];
    const rule = METADATA_TYPE_RULES[metadataType];

    if (rule?.requiresMetaXml) {
        files.push(getCompanionMetaXmlPath(filePath));
    }

    return files;
}

async function ensureParentDirectory(targetPath) {
    await mkdir(path.dirname(targetPath), { recursive: true });
}

async function copyRepositoryFile({
    repoPath,
    workspacePath,
    relativeFilePath,
    workspaceStats
}) {
    const normalizedPath = relativeFilePath.replace(/\\/g, '/');

    if (workspaceStats.copiedFilePaths.has(normalizedPath)) {
        return true;
    }

    const sourcePath = path.join(repoPath, ...normalizedPath.split('/'));
    const destinationPath = path.join(
        workspacePath,
        ...normalizedPath.split('/')
    );

    if (!(await pathExists(sourcePath))) {
        return false;
    }

    const fileStat = await stat(sourcePath);

    await ensureParentDirectory(destinationPath);
    await copyFile(sourcePath, destinationPath);
    workspaceStats.copiedFilePaths.add(normalizedPath);
    workspaceStats.copiedFiles += 1;
    workspaceStats.totalBytes += fileStat.size;

    return true;
}

async function copyMetadataItems({
    metadata,
    repoPath,
    workspacePath,
    repoFiles,
    workspaceStats,
    missingFiles
}) {
    logSection('Copying Metadata');

    let metadataCopied = 0;

    for (const item of metadata) {
        const resolvedPath = resolveMetadataItemPath(item, repoFiles);
        const missingLabel = getMissingFileLabel(
            item.metadataType,
            item.metadataName,
            resolvedPath
        );

        if (!resolvedPath) {
            missingFiles.push(missingLabel);
            continue;
        }

        const filesToCopy = getFilesToCopy(
            resolvedPath,
            item.metadataType
        );
        let itemCopied = false;
        let itemMissing = false;

        for (const filePath of filesToCopy) {
            const copied = await copyRepositoryFile({
                repoPath,
                workspacePath,
                relativeFilePath: filePath,
                workspaceStats
            });

            if (copied) {
                itemCopied = true;
            } else {
                itemMissing = true;
                missingFiles.push(
                    getMissingFileLabel(
                        item.metadataType,
                        item.metadataName,
                        filePath
                    )
                );
            }
        }

        if (itemCopied && !itemMissing) {
            metadataCopied += 1;
        }
    }

    return metadataCopied;
}

async function copyDependencyItems({
    dependencies,
    repoPath,
    workspacePath,
    repoFiles,
    workspaceStats,
    missingFiles
}) {
    logSection('Copying Dependencies');

    let dependenciesCopied = 0;

    for (const dependency of dependencies) {
        const resolvedPath = resolvePathByTypeAndName(
            dependency.type,
            dependency.name,
            repoFiles
        );
        const missingLabel = getMissingFileLabel(
            dependency.type,
            dependency.name,
            resolvedPath
        );

        if (!resolvedPath) {
            missingFiles.push(missingLabel);
            continue;
        }

        const filesToCopy = getFilesToCopy(
            resolvedPath,
            dependency.type
        );
        let itemCopied = false;
        let itemMissing = false;

        for (const filePath of filesToCopy) {
            const copied = await copyRepositoryFile({
                repoPath,
                workspacePath,
                relativeFilePath: filePath,
                workspaceStats
            });

            if (copied) {
                itemCopied = true;
            } else {
                itemMissing = true;
                missingFiles.push(
                    getMissingFileLabel(
                        dependency.type,
                        dependency.name,
                        filePath
                    )
                );
            }
        }

        if (itemCopied && !itemMissing) {
            dependenciesCopied += 1;
        }
    }

    return dependenciesCopied;
}

async function createWorkspace(workspacePath) {
    logSection('Creating Workspace');

    await mkdir(DEPLOYMENT_WORKSPACE_ROOT, { recursive: true });
    await rm(workspacePath, { recursive: true, force: true });
    await mkdir(workspacePath, { recursive: true });
}

async function writePackageXml(workspacePath, packageXml, workspaceStats) {
    logSection('Writing package.xml');

    const packageXmlPath = path.join(workspacePath, 'package.xml');
    await writeFile(packageXmlPath, packageXml, 'utf8');

    if (!(await pathExists(packageXmlPath))) {
        return false;
    }

    workspaceStats.copiedFiles += 1;
    workspaceStats.totalBytes += Buffer.byteLength(packageXml, 'utf8');

    return true;
}

function dedupeMissingFiles(missingFiles) {
    return [...new Set(missingFiles)];
}

function formatWorkspaceSize(totalBytes) {
    if (totalBytes < 1024) {
        return `${totalBytes} B`;
    }

    if (totalBytes < 1024 * 1024) {
        return `${Math.round(totalBytes / 1024)} KB`;
    }

    return `${(totalBytes / (1024 * 1024)).toFixed(1)} MB`;
}

function createWorkspaceStats() {
    return {
        copiedFilePaths: new Set(),
        copiedFiles: 0,
        totalBytes: 0
    };
}

function buildWorkspaceResult({
    workspacePath = null,
    workspaceCreated = false,
    packageXmlWritten = false,
    metadataCopied = 0,
    dependenciesCopied = 0,
    copiedFiles = 0,
    workspaceSize = '0 B',
    missingFiles = [],
    status = 'BLOCKED'
}) {
    return {
        workspacePath,
        workspaceCreated,
        packageXmlWritten,
        metadataCopied,
        dependenciesCopied,
        copiedFiles,
        workspaceSize,
        missingFiles: dedupeMissingFiles(missingFiles),
        status
    };
}

function logWorkspaceSummary(result) {
    logSection('Workspace Summary');
    console.log('Metadata Copied:', result.metadataCopied);
    console.log('Dependencies Copied:', result.dependenciesCopied);
    console.log('Copied Files:', result.copiedFiles);
    console.log('Workspace Size:', result.workspaceSize);
    console.log('Missing Files:', result.missingFiles);
    console.log('Workspace Status:', result.status);

    if (result.status === 'READY') {
        logSection('Workspace Ready');
    } else {
        logSection('Workspace Blocked');
    }
}

async function buildDeploymentWorkspace({
    generatedDeploymentPackage,
    generatedManifest,
    repoUrl,
    sourceBranch
}) {
    logSection('Workspace Builder Started');

    const missingFiles = [];

    if (!repoUrl || !sourceBranch) {
        const result = buildWorkspaceResult({
            missingFiles: ['Repository URL or source branch not provided'],
            status: 'BLOCKED'
        });
        logWorkspaceSummary(result);
        return result;
    }

    if (!generatedDeploymentPackage || !generatedManifest?.packageXml) {
        const result = buildWorkspaceResult({
            missingFiles: [
                'Generated deployment package or manifest not available'
            ],
            status: 'BLOCKED'
        });
        logWorkspaceSummary(result);
        return result;
    }

    const runId = String(Date.now());
    const workspacePath = path.join(DEPLOYMENT_WORKSPACE_ROOT, runId);
    let workspaceCreated = false;
    let packageXmlWritten = false;
    let metadataCopied = 0;
    let dependenciesCopied = 0;
    const workspaceStats = createWorkspaceStats();

    try {
        const repoPath = await prepareRepository(repoUrl);
        await checkoutSourceBranch(repoPath, sourceBranch);
        const repoFiles = await listRepositoryFiles(repoPath);

        await createWorkspace(workspacePath);
        workspaceCreated = true;

        const metadata = generatedDeploymentPackage.metadata || [];
        const dependencies = generatedDeploymentPackage.dependencies || [];

        metadataCopied = await copyMetadataItems({
            metadata,
            repoPath,
            workspacePath,
            repoFiles,
            workspaceStats,
            missingFiles
        });

        dependenciesCopied = await copyDependencyItems({
            dependencies,
            repoPath,
            workspacePath,
            repoFiles,
            workspaceStats,
            missingFiles
        });

        packageXmlWritten = await writePackageXml(
            workspacePath,
            generatedManifest.packageXml,
            workspaceStats
        );

        if (!packageXmlWritten) {
            missingFiles.push('package.xml');
        }
    } catch (error) {
        console.error('Workspace Builder Error');
        console.error(error.message || error);
        missingFiles.push(error.message || 'Workspace creation failed');
    }

    const result = buildWorkspaceResult({
        workspacePath: workspaceCreated ? workspacePath : null,
        workspaceCreated,
        packageXmlWritten,
        metadataCopied,
        dependenciesCopied,
        copiedFiles: workspaceStats.copiedFiles,
        workspaceSize: formatWorkspaceSize(workspaceStats.totalBytes),
        missingFiles,
        status:
            workspaceCreated &&
            packageXmlWritten &&
            missingFiles.length === 0
                ? 'READY'
                : 'BLOCKED'
    });

    logWorkspaceSummary(result);

    return result;
}

module.exports = {
    buildDeploymentWorkspace
};
