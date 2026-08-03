/**
 * TEMPORARY DEBUG ONLY — Phase 10.19 Workspace Materialization Trace.
 * Remove after investigation. Does not change behavior.
 */

const fs = require('fs');
const path = require('path');
const util = require('util');

const stat = util.promisify(fs.stat);

const TRACED_COMPONENTS = Object.freeze([
    'Booking__c',
    'Booking__c.Experience_Name__c',
    'Booking__c.Number_of_Guests__c',
    'Guest_Review__c',
    'Guest_Review__c.Experience__c'
]);

/**
 * @typedef {{
 *   selected: boolean|null,
 *   sourceExists: boolean|null,
 *   copied: boolean|null,
 *   workspaceFileExists: boolean|null,
 *   deploymentWorkspaceContains: boolean|null,
 *   sourcePath: string|null,
 *   destinationPath: string|null,
 *   metadataType: string|null,
 *   action: string|null,
 *   copyAttempted: boolean
 * }} TraceState
 */

/** @type {Map<string, TraceState>} */
const componentState = new Map();

function resetWorkspaceMaterializationTrace() {
    componentState.clear();

    for (const name of TRACED_COMPONENTS) {
        componentState.set(name, {
            selected: false,
            sourceExists: null,
            copied: null,
            workspaceFileExists: null,
            deploymentWorkspaceContains: null,
            sourcePath: null,
            destinationPath: null,
            metadataType: null,
            action: null,
            copyAttempted: false
        });
    }
}

function getItemName(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    return item.name || item.metadataName || null;
}

function isTracedComponentName(value) {
    return TRACED_COMPONENTS.includes(String(value || '').trim());
}

function isTracedItem(item) {
    return isTracedComponentName(getItemName(item));
}

function ensureState(name) {
    if (!componentState.has(name)) {
        componentState.set(name, {
            selected: false,
            sourceExists: null,
            copied: null,
            workspaceFileExists: null,
            deploymentWorkspaceContains: null,
            sourcePath: null,
            destinationPath: null,
            metadataType: null,
            action: null,
            copyAttempted: false
        });
    }

    return componentState.get(name);
}

function expectedRelativeHints(componentName) {
    if (!componentName.includes('.')) {
        return [
            `objects/${componentName}/${componentName}.object-meta.xml`,
            `objects/${componentName}.object-meta.xml`,
            `${componentName}.object-meta.xml`
        ];
    }

    const [objectName, fieldName] = componentName.split('.');

    return [
        `objects/${objectName}/fields/${fieldName}.field-meta.xml`,
        `${objectName}/fields/${fieldName}.field-meta.xml`
    ];
}

function expectedDisplayPaths(componentName) {
    if (!componentName.includes('.')) {
        return [`${componentName}.object-meta.xml`];
    }

    const [objectName, fieldName] = componentName.split('.');

    return [`${objectName}/fields/${fieldName}.field-meta.xml`];
}

async function pathExists(targetPath) {
    try {
        await stat(targetPath);
        return true;
    } catch (error) {
        return false;
    }
}

async function resolveExistingPath(workspacePath, relativeHints) {
    if (!workspacePath) {
        return null;
    }

    for (const hint of relativeHints) {
        const normalized = String(hint).replace(/\\/g, '/');
        const candidates = [
            path.join(workspacePath, ...normalized.split('/')),
            path.join(
                workspacePath,
                'force-app',
                'main',
                'default',
                ...normalized.split('/')
            )
        ];

        for (const candidate of candidates) {
            if (await pathExists(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function findTracedInCollections(metadata, dependencies) {
    const found = new Map();

    for (const collection of [metadata, dependencies]) {
        if (!Array.isArray(collection)) {
            continue;
        }

        for (const item of collection) {
            const name = getItemName(item);

            if (!isTracedComponentName(name)) {
                continue;
            }

            if (!found.has(name)) {
                found.set(name, item);
            }
        }
    }

    return found;
}

/**
 * Stage 1 — before workspace generation.
 */
function logStage1PackageInputs(generatedDeploymentPackage) {
    resetWorkspaceMaterializationTrace();

    const metadata = generatedDeploymentPackage?.metadata || [];
    const dependencies = generatedDeploymentPackage?.dependencies || [];
    const found = findTracedInCollections(metadata, dependencies);

    console.log('====================================================');
    console.log('WORKSPACE MATERIALIZATION TRACE — STAGE 1');
    console.log('====================================================');
    console.log('generatedDeploymentPackage.metadata length:');
    console.log(metadata.length);
    console.log('generatedDeploymentPackage.dependencies length:');
    console.log(dependencies.length);

    for (const name of TRACED_COMPONENTS) {
        const item = found.get(name) || null;
        const state = ensureState(name);

        if (item) {
            state.selected = true;
            state.metadataType = item.metadataType || item.type || null;
            state.action = item.action != null ? item.action : null;
            state.sourcePath =
                item.filePath || item.sourcePath || state.sourcePath;
        } else {
            state.selected = false;
        }

        console.log('--------------------------------');
        console.log(name);
        console.log('metadataType:');
        console.log(state.metadataType);
        console.log('metadataName:');
        console.log(name);
        console.log('sourcePath:');
        console.log(state.sourcePath);
        console.log('selected:');
        console.log(item ? item.selected : null);
        console.log('action:');
        console.log(state.action);
        console.log('Present in package metadata/dependencies?:');
        console.log(item ? 'YES' : 'NO');
    }

    console.log('====================================================');
}

/**
 * Stage 2 — immediately before file copy for a traced component.
 */
async function logStage2BeforeCopy({
    componentName,
    resolvedSourceRelativePath,
    absoluteSourcePath
} = {}) {
    if (!isTracedComponentName(componentName)) {
        return;
    }

    const state = ensureState(componentName);
    const sourceRelative =
        resolvedSourceRelativePath || state.sourcePath || null;
    const sourceAbsolute = absoluteSourcePath || null;
    const exists = sourceAbsolute
        ? await pathExists(sourceAbsolute)
        : false;

    state.sourcePath = sourceRelative;
    state.sourceExists = exists;
    state.copyAttempted = true;

    console.log('====================================================');
    console.log('WORKSPACE MATERIALIZATION TRACE — STAGE 2');
    console.log('====================================================');
    console.log(componentName);
    console.log('Source:');
    console.log(sourceRelative);
    console.log('Absolute source:');
    console.log(sourceAbsolute);
    console.log('Exists:');
    console.log(exists ? 'YES' : 'NO');
    console.log('====================================================');
}

/**
 * Stage 3 — immediately after copy for a traced component.
 */
async function logStage3AfterCopy({
    componentName,
    destinationPath,
    copied
} = {}) {
    if (!isTracedComponentName(componentName)) {
        return;
    }

    const state = ensureState(componentName);
    const destExists = destinationPath
        ? await pathExists(destinationPath)
        : false;

    state.copied = copied === true;
    state.destinationPath = destinationPath || null;

    if (destExists) {
        state.workspaceFileExists = true;
    }

    console.log('====================================================');
    console.log('WORKSPACE MATERIALIZATION TRACE — STAGE 3');
    console.log('====================================================');
    console.log(componentName);
    console.log('Destination path:');
    console.log(destinationPath);
    console.log('Copied?:');
    console.log(copied ? 'YES' : 'NO');
    console.log('Destination exists on disk?:');
    console.log(destExists ? 'YES' : 'NO');
    console.log('====================================================');
}

/**
 * Stage 4 — after workspace build completes; verify physical existence.
 */
async function logStage4VerifyWorkspace(workspacePath) {
    console.log('====================================================');
    console.log('WORKSPACE MATERIALIZATION TRACE — STAGE 4');
    console.log('====================================================');
    console.log('Workspace path:');
    console.log(workspacePath);
    console.log('Workspace contains');

    for (const name of TRACED_COMPONENTS) {
        const state = ensureState(name);
        const hints = expectedRelativeHints(name);
        const foundPath = await resolveExistingPath(workspacePath, hints);
        const exists = Boolean(foundPath);

        state.workspaceFileExists = exists;
        state.deploymentWorkspaceContains = exists;

        for (const display of expectedDisplayPaths(name)) {
            console.log(display);
            console.log(exists ? 'YES' : 'NO');
        }

        if (foundPath) {
            console.log('Resolved workspace path:');
            console.log(foundPath);
        }
    }

    console.log('====================================================');
}

/**
 * Stage 5 — immediately before Salesforce CLI (workspace ready handoff).
 */
async function logStage5BeforeCli({
    workspacePath,
    metadataCount = 0,
    dependencyCount = 0,
    workspaceFileCount = 0,
    copiedFilePaths = null
} = {}) {
    console.log('====================================================');
    console.log('WORKSPACE MATERIALIZATION TRACE — STAGE 5');
    console.log('(workspace ready for Salesforce CLI)');
    console.log('====================================================');
    console.log('Workspace root:');
    console.log(workspacePath);
    console.log('Workspace metadata count:');
    console.log(metadataCount);
    console.log('Workspace dependency count:');
    console.log(dependencyCount);
    console.log('Workspace file count:');
    console.log(workspaceFileCount);

    for (const name of TRACED_COMPONENTS) {
        const state = ensureState(name);
        const hints = expectedRelativeHints(name);
        const foundPath = await resolveExistingPath(workspacePath, hints);
        const inCopiedSet =
            copiedFilePaths instanceof Set
                ? [...copiedFilePaths].some((relative) =>
                      hints.some(
                          (hint) =>
                              String(relative).replace(/\\/g, '/').endsWith(
                                  hint
                              ) ||
                              String(relative)
                                  .replace(/\\/g, '/')
                                  .includes(hint)
                      )
                  )
                : false;

        const contains = Boolean(foundPath) || inCopiedSet;
        state.deploymentWorkspaceContains = contains;

        console.log('--------------------------------');
        console.log(name);
        console.log('Traced file path:');
        console.log(foundPath || state.destinationPath || state.sourcePath);
        console.log('Present?:');
        console.log(contains ? 'YES' : 'NO');
    }

    console.log('====================================================');
}

/**
 * Log selected package members that never entered the copy loops.
 */
function logSelectedButNotCopied() {
    for (const name of TRACED_COMPONENTS) {
        const state = ensureState(name);

        if (!state.selected || state.copyAttempted) {
            continue;
        }

        console.log('====================================================');
        console.log('WORKSPACE MATERIALIZATION TRACE — STAGE 2/3 MISS');
        console.log('====================================================');
        console.log(name);
        console.log('Selected in package but never entered copy path.');
        console.log('Source:');
        console.log(state.sourcePath);
        console.log('Exists:');
        console.log('NO (copy never attempted)');
        console.log('Copied?:');
        console.log('NO');
        console.log('====================================================');

        state.sourceExists = false;
        state.copied = false;
    }
}

/**
 * Stage 6 — final report.
 */
function logFinalWorkspaceMaterializationReport() {
    console.log('====================================================');
    console.log('WORKSPACE MATERIALIZATION REPORT');
    console.log('====================================================');

    for (const name of TRACED_COMPONENTS) {
        const state = ensureState(name);

        console.log(name);
        console.log('');
        console.log('Selected');
        console.log(state.selected ? 'YES' : 'NO');
        console.log('Source file exists');
        console.log(
            state.sourceExists === null
                ? 'N/A'
                : state.sourceExists
                  ? 'YES'
                  : 'NO'
        );
        console.log('Copied');
        console.log(
            state.copied === null ? 'N/A' : state.copied ? 'YES' : 'NO'
        );
        console.log('Workspace file exists');
        console.log(
            state.workspaceFileExists === null
                ? 'N/A'
                : state.workspaceFileExists
                  ? 'YES'
                  : 'NO'
        );
        console.log('Deployment workspace contains');
        console.log(
            state.deploymentWorkspaceContains === null
                ? 'N/A'
                : state.deploymentWorkspaceContains
                  ? 'YES'
                  : 'NO'
        );
        console.log('--------------------------------');
    }

    console.log('====================================================');
}

module.exports = {
    TRACED_COMPONENTS,
    isTracedItem,
    isTracedComponentName,
    getItemName,
    resetWorkspaceMaterializationTrace,
    logStage1PackageInputs,
    logStage2BeforeCopy,
    logStage3AfterCopy,
    logStage4VerifyWorkspace,
    logStage5BeforeCli,
    logSelectedButNotCopied,
    logFinalWorkspaceMaterializationReport,
    expectedRelativeHints
};
