const fs = require('fs');
const path = require('path');

const standardValueSetDiscoverer = require(
    '../dependencyResolution/discoverers/standardValueSet.discoverer'
);

const RECORD_TYPE_META_SUFFIX = '.recordType-meta.xml';
const BUSINESS_PROCESS_META_SUFFIX = '.businessProcess-meta.xml';

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function toProjectRelativePath(projectPath, absolutePath) {
    return normalizePath(path.relative(projectPath, absolutePath));
}

function isRecordTypeOrBusinessProcessFile(relativePath) {
    const normalized = normalizePath(relativePath);
    return normalized.endsWith(RECORD_TYPE_META_SUFFIX)
        || normalized.endsWith(BUSINESS_PROCESS_META_SUFFIX);
}

function walkMetadataFiles(rootDir, projectPath, collected) {
    let entries;

    try {
        entries = fs.readdirSync(rootDir, { withFileTypes: true });
    } catch (error) {
        return;
    }

    for (const entry of entries) {
        if (entry.name === '.git' || entry.name === 'node_modules') {
            continue;
        }

        const absolutePath = path.join(rootDir, entry.name);

        if (entry.isDirectory()) {
            walkMetadataFiles(absolutePath, projectPath, collected);
            continue;
        }

        if (!entry.isFile()) {
            continue;
        }

        const relativePath = toProjectRelativePath(projectPath, absolutePath);
        if (isRecordTypeOrBusinessProcessFile(relativePath)) {
            collected.push(relativePath);
        }
    }
}

function collectRecordTypeAndBusinessProcessFiles(projectPath) {
    if (!projectPath || !fs.existsSync(projectPath)) {
        return [];
    }

    const collected = [];
    const forceAppPath = path.join(projectPath, 'force-app');
    const walkRoot = fs.existsSync(forceAppPath) ? forceAppPath : projectPath;
    walkMetadataFiles(walkRoot, projectPath, collected);
    return collected;
}

function buildSelectedMetadataFromRetrievedFiles(relativePaths) {
    const selectedMetadata = [];

    for (const relativePath of Array.isArray(relativePaths) ? relativePaths : []) {
        const normalized = normalizePath(relativePath);
        const objectsIndex = normalized.indexOf('/objects/');

        if (objectsIndex === -1) {
            continue;
        }

        const afterObjects = normalized.slice(objectsIndex + '/objects/'.length);
        const segments = afterObjects.split('/').filter(Boolean);
        const objectApiName = segments[0];
        const fileName = segments[segments.length - 1];

        if (!objectApiName || !fileName) {
            continue;
        }

        if (fileName.endsWith(RECORD_TYPE_META_SUFFIX)) {
            selectedMetadata.push({
                metadataType: 'RecordType',
                metadataName:
                    `${objectApiName}.${fileName.slice(0, -RECORD_TYPE_META_SUFFIX.length)}`,
                filePath: normalized
            });
            continue;
        }

        if (fileName.endsWith(BUSINESS_PROCESS_META_SUFFIX)) {
            selectedMetadata.push({
                metadataType: 'BusinessProcess',
                metadataName:
                    `${objectApiName}.${fileName.slice(0, -BUSINESS_PROCESS_META_SUFFIX.length)}`,
                filePath: normalized
            });
        }
    }

    return selectedMetadata;
}

function extractUniqueStandardValueSetNames(discovererResult) {
    const names = [];
    const seen = new Set();
    const relationships = Array.isArray(discovererResult?.relationships)
        ? discovererResult.relationships
        : [];

    for (const relationship of relationships) {
        const name = String(relationship?.name || '').trim();

        if (!name || seen.has(name)) {
            continue;
        }

        seen.add(name);
        names.push(name);
    }

    return names;
}

function createProjectFileReader(projectPath) {
    return async function readRepoFile(filePath) {
        const relativeSegments = normalizePath(filePath)
            .split('/')
            .filter(Boolean);
        const absolutePath = path.join(projectPath, ...relativeSegments);
        return fs.readFileSync(absolutePath, 'utf8');
    };
}

/**
 * Invoke the existing StandardValueSetDiscoverer against retrieved DX files.
 * Returns unique StandardValueSet member names. Does not invent members.
 */
async function discoverStandardValueSetNamesFromRetrievedProject(projectPath) {
    const repoFiles = collectRecordTypeAndBusinessProcessFiles(projectPath);
    const selectedMetadata = buildSelectedMetadataFromRetrievedFiles(repoFiles);

    if (selectedMetadata.length === 0) {
        return [];
    }

    const result = await standardValueSetDiscoverer.discover({
        selectedMetadata,
        repoFiles,
        readRepoFile: createProjectFileReader(projectPath)
    });

    return extractUniqueStandardValueSetNames(result);
}

module.exports = {
    collectRecordTypeAndBusinessProcessFiles,
    buildSelectedMetadataFromRetrievedFiles,
    extractUniqueStandardValueSetNames,
    discoverStandardValueSetNamesFromRetrievedProject
};
