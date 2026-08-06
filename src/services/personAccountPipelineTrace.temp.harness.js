/**
 * TEMPORARY DEBUG ONLY — Phase 15.3.1 Person Account Resolution Trace harness.
 *
 * Replays the real pipeline modules offline for the single traced node
 * RecordType:PersonAccount.PersonAccount so the trace report can be produced
 * without a live org. Git access is simulated so the real relationship
 * discovery + merge code executes unchanged.
 *
 * Run:  node src/services/personAccountPipelineTrace.temp.harness.js
 *
 * Reads only. Never deploys, never writes to a repository or org.
 */

const childProcess = require('child_process');

const PERMISSION_SET_NAME = 'Subscription_Access';
const PERMISSION_SET_PATH = `force-app/main/default/permissionsets/${PERMISSION_SET_NAME}.permissionset-meta.xml`;

const PERMISSION_SET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <hasActivationRequired>false</hasActivationRequired>
    <label>Subscription Access</label>
    <objectPermissions>
        <allowCreate>true</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>true</allowEdit>
        <allowRead>true</allowRead>
        <object>Gym_Trainer__c</object>
    </objectPermissions>
    <recordTypeVisibilities>
        <default>false</default>
        <recordType>PersonAccount.PersonAccount</recordType>
        <visible>true</visible>
    </recordTypeVisibilities>
</PermissionSet>`;

const REPO_FILES = [PERMISSION_SET_PATH];

/**
 * Simulate the git commands relationshipDiscovery.service issues so the real
 * discovery + merge path runs. Must be installed before the service is loaded
 * because it promisifies exec at module load time.
 */
function installSimulatedGit() {
    const originalExec = childProcess.exec;

    childProcess.exec = function simulatedExec(command, options, callback) {
        const done = typeof options === 'function' ? options : callback;
        let stdout = '';

        if (command.includes('git ls-tree')) {
            stdout = `${REPO_FILES.join('\n')}\n`;
        } else if (command.includes('git show')) {
            stdout = PERMISSION_SET_XML;
        }

        process.nextTick(() => done(null, { stdout, stderr: '' }));

        return { stdout: null, stderr: null };
    };

    return () => {
        childProcess.exec = originalExec;
    };
}

const restoreGit = installSimulatedGit();

const personAccountTrace = require('./personAccountTrace.temp');
const relationshipDiscoveryService = require('./dependencyResolution/relationshipDiscovery.service');
const dependencyResolutionService = require('./dependencyResolution/dependencyResolution.service');
const deploymentPackageService = require('./deploymentPackage.service');
const deploymentCompatibilityImpactService = require('./deploymentCompatibilityImpact.service');
const deploymentReadinessService = require('./deploymentReadiness.service');
const deploymentCompatibilityGateService = require('./deploymentCompatibilityGate.service');
const {
    buildExistenceQuery
} = require('./destinationInventory/destinationExistenceQueries');

const TRACED_KEY = 'RecordType:PersonAccount.PersonAccount';

const SELECTED_METADATA = [
    {
        metadataType: 'PermissionSet',
        metadataName: PERMISSION_SET_NAME,
        name: PERMISSION_SET_NAME,
        filePath: PERMISSION_SET_PATH,
        sourceExists: true,
        artifactResolved: true
    }
];

/** Destination rows the traced SOQL would return for each scenario. */
const DESTINATION_FIXTURES = {
    MISSING: [],
    EXISTS: [
        {
            DeveloperName: 'PersonAccount',
            SobjectType: 'Account',
            IsPersonType: true
        }
    ]
};

function buildDestinationStates(scenario) {
    const states = new Map();

    states.set('PermissionSet:Subscription_Access', 'MISSING');
    states.set('CustomObject:Gym_Trainer__c', 'EXISTS');
    states.set(TRACED_KEY, scenario);

    return states;
}

/**
 * Step 4 replay: builds the real SOQL from the shared query catalog and feeds
 * the fixture rows through the same trace hook the inventory builder uses.
 */
function replayDestinationStep(scenario) {
    const soql = buildExistenceQuery('RecordType', 'PersonAccount.PersonAccount');
    const records = DESTINATION_FIXTURES[scenario] || [];

    personAccountTrace.logDestinationStep({
        metadataType: 'RecordType',
        metadataName: 'PersonAccount.PersonAccount',
        soql,
        records,
        totalSize: records.length,
        decision: records.length ? 'EXISTS' : 'MISSING'
    });
}

async function runScenario(scenario) {
    console.log('');
    console.log('####################################################');
    console.log(`PERSON ACCOUNT TRACE SCENARIO — DESTINATION ${scenario}`);
    console.log('####################################################');
    console.log('');

    personAccountTrace.beginPersonAccountTrace();

    // Steps 1 + 2 — real discoverer and real dependency graph merge.
    const discoveryResult =
        await relationshipDiscoveryService.discoverRelationships({
            selectedMetadata: SELECTED_METADATA,
            requiredDependencies: [],
            repoUrl: 'https://example.invalid/simulated-repo.git',
            sourceBranch: 'main'
        });

    // Step 4 — destination existence (queried before resolution at runtime).
    replayDestinationStep(scenario);

    // Step 3 — real dependency resolution with the destination inventory map.
    const resolutionResult = await dependencyResolutionService.resolveDependencies(
        {
            requiredDependencies: discoveryResult.enrichedDependencies,
            discoveredReferences: [],
            selectedMetadata: SELECTED_METADATA,
            destinationStates: buildDestinationStates(scenario)
        }
    );

    // Step 5 — real package generation.
    const generatedDeploymentPackage =
        deploymentPackageService.generateDeploymentPackage({
            selectedMetadata: SELECTED_METADATA,
            requiredDependencies: resolutionResult.resolvedDependencies
        });

    personAccountTrace.logPackageStep({
        generatedDeploymentPackage,
        resolvedDependencies: resolutionResult.resolvedDependencies
    });

    // Steps 6 + 7 — real compatibility impact, readiness planner, deploy gate.
    const impact = deploymentCompatibilityImpactService.analyze({
        filteredDeploymentPackage: generatedDeploymentPackage,
        excludedComponents: [],
        resolvedDependencies: resolutionResult.resolvedDependencies,
        discoveredRelationships: discoveryResult.discoveredRelationships,
        discoveredReferences: []
    });

    const compatibilityReadiness =
        deploymentReadinessService.planCompatibilityDeploymentReadiness({
            filteredDeploymentPackage: generatedDeploymentPackage,
            excludedComponents: [],
            blockingComponents: impact.blockingComponents,
            blockingSummary: impact.blockingSummary
        });

    const deploymentSkipped =
        deploymentCompatibilityGateService.shouldSkipDeploymentForCompatibility(
            compatibilityReadiness
        );

    personAccountTrace.logWorkspaceStep({
        resolvedDependencies: resolutionResult.resolvedDependencies,
        generatedDeploymentPackage,
        workspaceSkipped: deploymentSkipped,
        skipReason: deploymentSkipped
            ? 'Compatibility readiness reported blocking dependencies.'
            : null
    });

    personAccountTrace.logDeploymentStep({
        resolvedDependencies: resolutionResult.resolvedDependencies,
        generatedDeploymentPackage,
        dependencyResolutionSummary: resolutionResult.summary,
        dependencyValidationStatus:
            resolutionResult.summary.block > 0 ? 'BLOCKED' : 'PASS',
        deploymentSkipped,
        deploymentMode: 'VALIDATE'
    });

    personAccountTrace.logPersonAccountReport();

    return {
        scenario,
        resolutionSummary: resolutionResult.summary,
        deploymentSkipped,
        firstFailingStage: personAccountTrace.resolveFirstFailingStage(),
        traceState: personAccountTrace.getPersonAccountTraceState()
    };
}

async function main() {
    const results = [];

    for (const scenario of ['MISSING', 'EXISTS']) {
        results.push(await runScenario(scenario));
    }

    console.log('');
    console.log('####################################################');
    console.log('PERSON ACCOUNT TRACE — SCENARIO COMPARISON');
    console.log('####################################################');

    for (const result of results) {
        console.log('');
        console.log('Destination state:', result.scenario);
        console.log('Resolver:', result.traceState.resolver?.resolverId);
        console.log('Decision:', result.traceState.resolver?.action);
        console.log('Resolution blocks:', result.resolutionSummary.block);
        console.log('Deployment skipped:', result.deploymentSkipped);
        console.log('First failing stage:', result.firstFailingStage.stage);
        console.log('Reason:', result.firstFailingStage.reason);
    }

    console.log('');
    restoreGit();
}

main().catch((error) => {
    restoreGit();
    console.error('PERSON ACCOUNT TRACE HARNESS ERROR');
    console.error(error);
    process.exitCode = 1;
});
