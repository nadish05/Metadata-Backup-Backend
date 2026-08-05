/**
 * TEMPORARY DEBUG ONLY — Phase 12.2 Object Dependency Investigation.
 * Traces Booking__c and Booking__c.Experience_Name__c only.
 * Remove after root cause is identified. Does not change behavior.
 */

const TRACED_COMPONENTS = Object.freeze([
    'Booking__c',
    'Booking__c.Experience_Name__c'
]);

/**
 * @typedef {{
 *   planner: boolean|null,
 *   package: boolean|null,
 *   workspace: boolean|null,
 *   manifest: boolean|null,
 *   inPackageMetadata: boolean|null,
 *   inPackageDependencies: boolean|null,
 *   inResolvedDependencies: boolean|null,
 *   inResolvedMetadata: boolean|null,
 *   sourcePath: string|null,
 *   sourceExists: boolean|null,
 *   destinationPath: string|null,
 *   copied: boolean|null
 * }} TraceState
 */

/** @type {Map<string, TraceState>} */
const componentState = new Map();

function createEmptyState() {
    return {
        planner: null,
        package: null,
        workspace: null,
        manifest: null,
        inPackageMetadata: null,
        inPackageDependencies: null,
        inResolvedDependencies: null,
        inResolvedMetadata: null,
        sourcePath: null,
        sourceExists: null,
        destinationPath: null,
        copied: null
    };
}

function resetObjectDependencyTrace() {
    componentState.clear();

    for (const name of TRACED_COMPONENTS) {
        componentState.set(name, createEmptyState());
    }
}

function getItemName(item) {
    if (!item || typeof item !== 'object') {
        return null;
    }

    return item.metadataName || item.name || null;
}

function isTracedComponentName(value) {
    return TRACED_COMPONENTS.includes(String(value || '').trim());
}

function isTracedItem(item) {
    return isTracedComponentName(getItemName(item));
}

function ensureState(name) {
    if (!componentState.has(name)) {
        componentState.set(name, createEmptyState());
    }

    return componentState.get(name);
}

function collectionHasName(collection, name) {
    if (!Array.isArray(collection)) {
        return false;
    }

    return collection.some((item) => getItemName(item) === name);
}

function yesNo(value) {
    if (value === true) {
        return 'YES';
    }

    if (value === false) {
        return 'NO';
    }

    return 'UNKNOWN';
}

/**
 * Part 1 — Restore generated package.xml logging.
 */
function logGeneratedPackageXml(packageXml) {
    console.log('====================================================');
    console.log('GENERATED PACKAGE.XML');
    console.log('====================================================');
    console.log(packageXml || '(empty package.xml)');
    console.log('====================================================');
}

/**
 * Part 3 — Planner / package presence for traced components only.
 */
function logPlannerPackageTrace({
    generatedDeploymentPackage = null,
    resolvedDependencies = [],
    resolvedMetadata = []
} = {}) {
    resetObjectDependencyTrace();

    const metadata = generatedDeploymentPackage?.metadata || [];
    const dependencies = generatedDeploymentPackage?.dependencies || [];

    console.log('====================================================');
    console.log('OBJECT DEPENDENCY TRACE — PLANNER / PACKAGE');
    console.log('====================================================');

    for (const name of TRACED_COMPONENTS) {
        const inPackageMetadata = collectionHasName(metadata, name);
        const inPackageDependencies = collectionHasName(dependencies, name);
        const inResolvedDependencies = collectionHasName(
            resolvedDependencies,
            name
        );
        const inResolvedMetadata = collectionHasName(resolvedMetadata, name);
        const inPackage = inPackageMetadata || inPackageDependencies;
        const inPlanner = inResolvedMetadata || inResolvedDependencies;

        const state = ensureState(name);
        state.inPackageMetadata = inPackageMetadata;
        state.inPackageDependencies = inPackageDependencies;
        state.inResolvedDependencies = inResolvedDependencies;
        state.inResolvedMetadata = inResolvedMetadata;
        state.planner = inPlanner;
        state.package = inPackage;

        console.log('------------------------------------');
        console.log(name);
        console.log('generatedDeploymentPackage.metadata:', yesNo(inPackageMetadata));
        console.log(
            'generatedDeploymentPackage.dependencies:',
            yesNo(inPackageDependencies)
        );
        console.log('resolvedDependencies:', yesNo(inResolvedDependencies));
        console.log('resolvedMetadata:', yesNo(inResolvedMetadata));
        console.log('Planner (selected or resolved):', yesNo(inPlanner));
        console.log('Package (metadata or dependencies):', yesNo(inPackage));
    }

    console.log('====================================================');
}

/**
 * Part 4 — Workspace copy trace (before/after for traced items only).
 */
function logWorkspaceCopyAttempt({
    item,
    sourcePath = null,
    sourceExists = null,
    destinationPath = null,
    copied = null,
    phase = 'BEFORE'
} = {}) {
    const name = getItemName(item);

    if (!isTracedComponentName(name)) {
        return;
    }

    const state = ensureState(name);

    if (sourcePath != null) {
        state.sourcePath = sourcePath;
    }

    if (sourceExists != null) {
        state.sourceExists = sourceExists;
    }

    if (destinationPath != null) {
        state.destinationPath = destinationPath;
    }

    if (copied != null) {
        state.copied = copied;
        state.workspace = copied === true;
    }

    console.log('====================================================');
    console.log(`OBJECT DEPENDENCY TRACE — WORKSPACE ${phase}`);
    console.log('====================================================');
    console.log('Component:', name);
    console.log('Source path:', state.sourcePath || '(none)');
    console.log('Exists?:', yesNo(state.sourceExists));
    console.log('Destination path:', state.destinationPath || '(none)');
    console.log('Copied?:', yesNo(state.copied));
    console.log('====================================================');
}

/**
 * Mark workspace as skipped / not attempted for all traced components.
 */
function markWorkspaceSkipped(reason = 'Workspace not executed') {
    for (const name of TRACED_COMPONENTS) {
        const state = ensureState(name);
        if (state.workspace == null) {
            state.workspace = false;
        }
        state.copied = state.copied === true ? true : false;
    }

    console.log('====================================================');
    console.log('OBJECT DEPENDENCY TRACE — WORKSPACE SKIPPED');
    console.log('====================================================');
    console.log('Reason:', reason);
    console.log('====================================================');
}

/**
 * Part 5 — Manifest membership for traced CustomField / CustomObject members.
 */
function logManifestTrace(packageXml) {
    const xml = String(packageXml || '');

    console.log('====================================================');
    console.log('OBJECT DEPENDENCY TRACE — MANIFEST');
    console.log('====================================================');

    for (const name of TRACED_COMPONENTS) {
        const inManifest =
            xml.includes(`<members>${name}</members>`) ||
            xml.includes(`<members>${escapeXml(name)}</members>`);

        const state = ensureState(name);
        state.manifest = inManifest;

        console.log('------------------------------------');
        console.log(name);
        console.log('In package.xml:', yesNo(inManifest));
    }

    console.log('====================================================');
}

function escapeXml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function resolveFirstMissingStage(state) {
    if (state.planner !== true) {
        return 'Planner';
    }

    if (state.package !== true) {
        return 'Package';
    }

    if (state.workspace !== true) {
        return 'Workspace Copy';
    }

    if (state.manifest !== true) {
        return 'Manifest';
    }

    return 'None';
}

/**
 * Part 6 — Final summary for traced components only.
 */
function logObjectDependencyTraceSummary() {
    console.log('====================================================');
    console.log('OBJECT DEPENDENCY TRACE SUMMARY');
    console.log('====================================================');

    for (const name of TRACED_COMPONENTS) {
        const state = ensureState(name);

        // Default unknown stages to NO for summary readability.
        const planner = state.planner === true;
        const pkg = state.package === true;
        const workspace = state.workspace === true;
        const manifest = state.manifest === true;

        console.log('');
        console.log(name);
        console.log('');
        console.log('Planner');
        console.log(yesNo(planner));
        console.log('');
        console.log('Package');
        console.log(yesNo(pkg));
        console.log('');
        console.log('Workspace');
        console.log(yesNo(workspace));
        console.log('');
        console.log('Manifest');
        console.log(yesNo(manifest));
        console.log('');
        console.log('First Missing Stage');
        console.log(
            resolveFirstMissingStage({
                planner,
                package: pkg,
                workspace,
                manifest
            })
        );
        console.log('');
        console.log('------------------------------------');
    }

    console.log('====================================================');
}

module.exports = {
    TRACED_COMPONENTS,
    resetObjectDependencyTrace,
    getItemName,
    isTracedItem,
    isTracedComponentName,
    logGeneratedPackageXml,
    logPlannerPackageTrace,
    logWorkspaceCopyAttempt,
    markWorkspaceSkipped,
    logManifestTrace,
    logObjectDependencyTraceSummary
};
