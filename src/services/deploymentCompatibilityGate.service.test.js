const assert = require('assert');

const {
    shouldSkipDeploymentForCompatibility,
    buildCompatibilitySkippedWorkspace,
    buildCompatibilitySkipFields
} = require('./deploymentCompatibilityGate.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function main() {
    await runTest('Ready package proceeds normally', async () => {
        assert.strictEqual(
            shouldSkipDeploymentForCompatibility({
                readyForDeployment: true,
                canDeploy: true
            }),
            false
        );
        assert.strictEqual(
            shouldSkipDeploymentForCompatibility({
                readyForDeployment: true
            }),
            false
        );
    });

    await runTest('Blocking package skips deployment', async () => {
        assert.strictEqual(
            shouldSkipDeploymentForCompatibility({
                readyForDeployment: false,
                canDeploy: true
            }),
            true
        );

        const skipFields = buildCompatibilitySkipFields({
            deploymentReadiness: {
                readyForDeployment: false,
                summary: { blocking: 2 }
            },
            compatibilitySummary: {
                totalExcluded: 1,
                totalRemaining: 10,
                excludedByCategory: { FORMULA_TYPE_CHANGE: 1 }
            },
            excludedComponents: [
                {
                    metadataName: 'Booking__c.Status__c',
                    metadataType: 'CustomField'
                }
            ],
            blockingComponents: [
                {
                    metadataName: 'Get_Sessions',
                    metadataType: 'Flow',
                    action: 'BLOCKING'
                }
            ]
        });

        assert.strictEqual(skipFields.success, false);
        assert.strictEqual(skipFields.deploymentSkipped, true);
        assert.strictEqual(skipFields.reason, 'BLOCKING_DEPENDENCIES');
        assert.strictEqual(skipFields.blockingComponents.length, 1);
        assert.strictEqual(skipFields.excludedComponents.length, 1);
        assert.ok(skipFields.deploymentReadiness);
        assert.ok(skipFields.compatibilitySummary);
    });

    await runTest('Workspace not invoked when skipped', async () => {
        const calls = { workspace: 0, cli: 0 };

        const readiness = { readyForDeployment: false };
        const skip = shouldSkipDeploymentForCompatibility(readiness);

        assert.strictEqual(skip, true);

        let generatedWorkspace = null;

        if (!skip) {
            calls.workspace += 1;
            generatedWorkspace = { status: 'READY' };
        } else {
            generatedWorkspace = buildCompatibilitySkippedWorkspace();
        }

        assert.strictEqual(calls.workspace, 0);
        assert.strictEqual(generatedWorkspace.status, 'SKIPPED');
        assert.strictEqual(generatedWorkspace.workspaceCreated, false);
        assert.strictEqual(generatedWorkspace.workspacePath, null);
    });

    await runTest('CLI not invoked when skipped', async () => {
        const calls = { workspace: 0, cli: 0 };
        const readiness = { readyForDeployment: false };

        if (!shouldSkipDeploymentForCompatibility(readiness)) {
            calls.workspace += 1;
            calls.cli += 1;
        }

        assert.strictEqual(calls.workspace, 0);
        assert.strictEqual(calls.cli, 0);
    });

    await runTest('Existing successful deployment unchanged', async () => {
        const calls = { workspace: 0, cli: 0 };
        const readiness = {
            readyForDeployment: true,
            canDeploy: true,
            overallStatus: 'READY'
        };

        if (!shouldSkipDeploymentForCompatibility(readiness)) {
            calls.workspace += 1;
            calls.cli += 1;
        }

        assert.strictEqual(calls.workspace, 1);
        assert.strictEqual(calls.cli, 1);
        assert.strictEqual(
            shouldSkipDeploymentForCompatibility(undefined),
            false
        );
        assert.strictEqual(shouldSkipDeploymentForCompatibility({}), false);
    });
}

main();
