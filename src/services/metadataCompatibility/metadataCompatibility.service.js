const fs = require('fs');
const path = require('path');
const util = require('util');

const { getRegisteredRules } = require('./registry');

const readdir = util.promisify(fs.readdir);
const readFile = util.promisify(fs.readFile);
const writeFile = util.promisify(fs.writeFile);
const stat = util.promisify(fs.stat);

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function createEmptySummary(status, warnings = []) {
    return {
        status,
        rulesExecuted: [],
        filesModified: [],
        warnings: [...warnings]
    };
}

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch (error) {
        return false;
    }
}

async function listWorkspaceFiles(directoryPath) {
    const entries = await readdir(directoryPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const absolutePath = path.join(directoryPath, entry.name);

        if (entry.isDirectory()) {
            const nestedFiles = await listWorkspaceFiles(absolutePath);
            files.push(...nestedFiles);
            continue;
        }

        if (entry.isFile()) {
            files.push(absolutePath);
        }
    }

    return files;
}

function toWorkspaceRelativePath(workspacePath, filePath) {
    return path.relative(workspacePath, filePath).replace(/\\/g, '/');
}

function logCompatibilitySummary({
    workspacePath,
    filesScanned,
    rules,
    summary
}) {
    console.log('Workspace:', workspacePath || null);
    console.log('Files scanned:', filesScanned);
    console.log(
        'Rules executed:',
        summary.rulesExecuted.length
            ? summary.rulesExecuted.join(', ')
            : '(none)'
    );
    console.log('Files modified:', summary.filesModified.length);
    console.log(
        'Warnings:',
        summary.warnings.length ? summary.warnings : '(none)'
    );
    console.log('Registered rules:', rules.map((rule) => rule.id).join(', '));
    console.log('Summary status:', summary.status);

    if (summary.filesModified.length > 0) {
        for (const modification of summary.filesModified) {
            console.log(
                `Modified: ${modification.file} [${modification.ruleId}] ${modification.summary}`
            );
        }
    }

    logSection('Metadata Compatibility Summary');
}

async function applyRulesToFile({
    workspacePath,
    filePath,
    rules,
    summary
}) {
    const relativePath = toWorkspaceRelativePath(workspacePath, filePath);
    const applicableRules = rules.filter((rule) => rule.applies(filePath));

    if (applicableRules.length === 0) {
        return false;
    }

    let content = await readFile(filePath, 'utf8');
    let fileChanged = false;

    for (const rule of applicableRules) {
        if (!summary.rulesExecuted.includes(rule.id)) {
            summary.rulesExecuted.push(rule.id);
        }

        const result = rule.transform(content, {
            filePath,
            relativePath,
            workspacePath
        });

        if (!result?.changed) {
            continue;
        }

        content = result.content;
        fileChanged = true;

        summary.filesModified.push({
            file: relativePath,
            ruleId: rule.id,
            summary: result.summary || rule.description
        });

        if (result.warning) {
            summary.warnings.push(result.warning);
        }
    }

    if (fileChanged) {
        await writeFile(filePath, content, 'utf8');
    }

    return fileChanged;
}

/**
 * Process temporary deployment workspace files with registered compatibility rules.
 * Mutates workspace files only. Never touches GitHub, cache, or comparison artifacts.
 *
 * @param {{ workspacePath?: string }} options
 * @returns {Promise<{
 *   status: string,
 *   rulesExecuted: string[],
 *   filesModified: Array<{ file: string, ruleId: string, summary: string }>,
 *   warnings: string[]
 * }>}
 */
async function processWorkspace({ workspacePath } = {}) {
    logSection('Metadata Compatibility Processor');

    const rules = getRegisteredRules();

    if (!workspacePath) {
        const summary = createEmptySummary('SKIPPED', [
            'Workspace path not provided; compatibility processing skipped'
        ]);
        logCompatibilitySummary({
            workspacePath: null,
            filesScanned: 0,
            rules,
            summary
        });
        return summary;
    }

    const resolvedWorkspacePath = path.resolve(workspacePath);

    if (!(await pathExists(resolvedWorkspacePath))) {
        const summary = createEmptySummary('SKIPPED', [
            `Workspace not found: ${resolvedWorkspacePath}`
        ]);
        logCompatibilitySummary({
            workspacePath: resolvedWorkspacePath,
            filesScanned: 0,
            rules,
            summary
        });
        return summary;
    }

    const summary = createEmptySummary('NO_CHANGES');

    try {
        const files = await listWorkspaceFiles(resolvedWorkspacePath);
        let modifiedCount = 0;

        for (const filePath of files) {
            const changed = await applyRulesToFile({
                workspacePath: resolvedWorkspacePath,
                filePath,
                rules,
                summary
            });

            if (changed) {
                modifiedCount += 1;
            }
        }

        summary.status = modifiedCount > 0 ? 'APPLIED' : 'NO_CHANGES';

        logCompatibilitySummary({
            workspacePath: resolvedWorkspacePath,
            filesScanned: files.length,
            rules,
            summary
        });

        return summary;
    } catch (error) {
        summary.status = 'FAILED';
        summary.warnings.push(
            error?.message || 'Metadata compatibility processing failed'
        );

        logCompatibilitySummary({
            workspacePath: resolvedWorkspacePath,
            filesScanned: 0,
            rules,
            summary
        });

        return summary;
    }
}

module.exports = {
    processWorkspace
};
