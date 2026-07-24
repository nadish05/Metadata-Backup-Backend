/**
 * Build source CustomField shape index from repo XML (Phase 9C).
 * Uses existing artifact filePath + repo read — no destination describe calls.
 */

const util = require('util');
const os = require('os');
const path = require('path');
const { exec } = require('child_process');

const {
    parseCustomFieldName
} = require('../../destinationShape/destinationShape.model');
const {
    parseSourceCustomFieldXml
} = require('./sourceCustomFieldShape.parser');

const execAsync = util.promisify(exec);
const FIELD_META_SUFFIX = '.field-meta.xml';

function shellQuote(value) {
    return `"${String(value).replace(/"/g, '\\"')}"`;
}

function normalizePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function buildSourceKey(metadataName) {
    return `CustomField:${metadataName}`;
}

function resolveCustomFieldFilePath(item, repoFiles) {
    if (
        item?.filePath &&
        normalizePath(item.filePath).endsWith(FIELD_META_SUFFIX)
    ) {
        return normalizePath(item.filePath);
    }

    const metadataName = item?.metadataName || item?.name;

    if (!metadataName || !metadataName.includes('.') || !Array.isArray(repoFiles)) {
        return null;
    }

    const [objectApiName, fieldApiName] = metadataName.split('.');

    if (!objectApiName || !fieldApiName) {
        return null;
    }

    const expectedSuffix = `/objects/${objectApiName}/fields/${fieldApiName}${FIELD_META_SUFFIX}`;

    return (
        repoFiles
            .map(normalizePath)
            .find((repoFile) => repoFile.endsWith(expectedSuffix)) || null
    );
}

async function withSourceRepository(repoUrl, sourceBranch, callback) {
    if (!repoUrl || !sourceBranch) {
        return callback(null, null);
    }

    const githubToken = process.env.GITHUB_TOKEN;
    const repoPath = path.join(
        os.tmpdir(),
        `contract-source-${Date.now()}-${Math.random().toString(16).slice(2)}`
    );
    const branch = sourceBranch;
    const authenticatedUrl =
        githubToken && repoUrl.startsWith('https://')
            ? repoUrl.replace('https://', `https://${githubToken}@`)
            : repoUrl;

    try {
        await execAsync(
            `git clone --branch ${shellQuote(branch)} --single-branch ${shellQuote(authenticatedUrl)} ${shellQuote(repoPath)}`
        );

        const readRepoFile = async (targetPath) => {
            const fileContent = await execAsync(
                `cd ${shellQuote(repoPath)} && git show HEAD:${shellQuote(targetPath)}`
            );

            return fileContent.stdout;
        };

        const listRepoFiles = async () => {
            const result = await execAsync(
                `cd ${shellQuote(repoPath)} && git ls-tree -r --name-only HEAD`
            );

            return result.stdout
                .split('\n')
                .map((line) => line.trim().replace(/\\/g, '/'))
                .filter(Boolean);
        };

        return await callback(readRepoFile, listRepoFiles);
    } finally {
        try {
            await execAsync(
                process.platform === 'win32'
                    ? `rmdir /s /q ${shellQuote(repoPath)}`
                    : `rm -rf ${shellQuote(repoPath)}`
            );
        } catch (error) {
            // Cleanup best-effort.
        }
    }
}

/**
 * Build source shape Map from items + optional preloaded xml by path.
 *
 * @param {object} params
 * @param {Array<object>} [params.items]
 * @param {Function|null} [params.readRepoFile]
 * @param {string[]|null} [params.repoFiles]
 * @returns {Promise<Map<string, object>>}
 */
async function buildSourceCustomFieldShapeIndex({
    items = [],
    readRepoFile = null,
    repoFiles = null
} = {}) {
    const shapes = new Map();
    const customFields = (Array.isArray(items) ? items : []).filter((item) => {
        const type = item?.metadataType || item?.type;
        return type === 'CustomField';
    });

    for (const item of customFields) {
        const metadataName = item?.metadataName || item?.name || null;
        const parsed = parseCustomFieldName(metadataName);

        if (!parsed) {
            continue;
        }

        const key = buildSourceKey(parsed.canonicalName);

        if (shapes.has(key)) {
            continue;
        }

        if (!readRepoFile) {
            shapes.set(key, {
                metadataType: 'CustomField',
                metadataName: parsed.canonicalName,
                parentObject: parsed.parentObject,
                apiName: parsed.fieldApiName,
                attributes: null,
                warning: 'Source repository reader unavailable for CONTRACT.'
            });
            continue;
        }

        const filePath = resolveCustomFieldFilePath(item, repoFiles);

        if (!filePath) {
            shapes.set(key, {
                metadataType: 'CustomField',
                metadataName: parsed.canonicalName,
                parentObject: parsed.parentObject,
                apiName: parsed.fieldApiName,
                attributes: null,
                warning: 'Source CustomField artifact path not resolved.'
            });
            continue;
        }

        try {
            const xml = await readRepoFile(filePath);
            const parsedXml = parseSourceCustomFieldXml(
                xml,
                parsed.canonicalName
            );
            shapes.set(key, parsedXml);
        } catch (error) {
            shapes.set(key, {
                metadataType: 'CustomField',
                metadataName: parsed.canonicalName,
                parentObject: parsed.parentObject,
                apiName: parsed.fieldApiName,
                attributes: null,
                warning:
                    error?.message ||
                    'Unable to read source CustomField XML for CONTRACT.'
            });
        }
    }

    return shapes;
}

/**
 * Convenience: clone source branch once and build CustomField source shapes.
 */
async function buildSourceCustomFieldShapeIndexFromRepo({
    items = [],
    repoUrl = null,
    sourceBranch = null
} = {}) {
    if (!repoUrl || !sourceBranch) {
        return buildSourceCustomFieldShapeIndex({ items });
    }

    try {
        return await withSourceRepository(
            repoUrl,
            sourceBranch,
            async (readRepoFile, listRepoFiles) => {
                if (!readRepoFile) {
                    return buildSourceCustomFieldShapeIndex({ items });
                }

                const repoFiles = await listRepoFiles();
                return buildSourceCustomFieldShapeIndex({
                    items,
                    readRepoFile,
                    repoFiles
                });
            }
        );
    } catch (error) {
        const shapes = await buildSourceCustomFieldShapeIndex({ items });
        // Annotate warning on empty attributes entries.
        for (const [key, entry] of shapes.entries()) {
            if (!entry.attributes && !entry.warning) {
                shapes.set(key, {
                    ...entry,
                    warning:
                        error?.message ||
                        'Source repository unavailable for CONTRACT.'
                });
            }
        }
        return shapes;
    }
}

module.exports = {
    buildSourceCustomFieldShapeIndex,
    buildSourceCustomFieldShapeIndexFromRepo,
    parseSourceCustomFieldXml
};
