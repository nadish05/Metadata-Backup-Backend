const assert = require('assert');

const {
    runDeploymentExecution
} = require('./deploymentExecution.service');

const {
    annotateCheckOnlyExecuted,
    buildCheckOnlyNotExecutedResult
} = require('./deploymentCheckOnlyGate.service');

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
    await runTest(
        'Execution gate: missing check-only blocks without Salesforce call',
        async () => {
            const result = await runDeploymentExecution({
                generatedWorkspace: {
                    workspaceCreated: true,
                    packageXmlWritten: true,
                    status: 'READY',
                    workspacePath: 'C:\\tmp\\unused-workspace'
                },
                generatedManifest: {},
                deploymentReadiness: { canDeploy: true },
                priorCheckOnlyDeployment: null,
                refreshToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 'BLOCKED');
            assert.match(result.message, /missing or unknown/i);
        }
    );

    await runTest(
        'Execution gate: NOT_EXECUTED blocks without Salesforce call',
        async () => {
            const result = await runDeploymentExecution({
                generatedWorkspace: {
                    workspaceCreated: true,
                    packageXmlWritten: true,
                    status: 'READY',
                    workspacePath: 'C:\\tmp\\unused-workspace'
                },
                generatedManifest: {},
                deploymentReadiness: { canDeploy: true },
                priorCheckOnlyDeployment: buildCheckOnlyNotExecutedResult(
                    'Pre-validation blocked check-only execution.'
                ),
                refreshToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 'BLOCKED');
            assert.match(result.message, /was not executed/i);
        }
    );

    await runTest(
        'Execution gate: FAILED check-only blocks without Salesforce call',
        async () => {
            const result = await runDeploymentExecution({
                generatedWorkspace: {
                    workspaceCreated: true,
                    packageXmlWritten: true,
                    status: 'READY',
                    workspacePath: 'C:\\tmp\\unused-workspace'
                },
                generatedManifest: {},
                deploymentReadiness: { canDeploy: true },
                priorCheckOnlyDeployment: annotateCheckOnlyExecuted({
                    success: false,
                    status: 'FAILED',
                    message: 'Check-only deployment validation failed.'
                }),
                refreshToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 'BLOCKED');
            assert.match(result.message, /did not succeed/i);
        }
    );

    await runTest(
        'Execution gate: SUCCESS check-only still hits existing canDeploy gate',
        async () => {
            const result = await runDeploymentExecution({
                generatedWorkspace: {
                    workspaceCreated: true,
                    packageXmlWritten: true,
                    status: 'READY',
                    workspacePath: 'C:\\tmp\\unused-workspace'
                },
                generatedManifest: {},
                deploymentReadiness: { canDeploy: false },
                priorCheckOnlyDeployment: annotateCheckOnlyExecuted({
                    success: true,
                    status: 'SUCCESS'
                }),
                refreshToken: 'token',
                instanceUrl: 'https://example.my.salesforce.com'
            });

            assert.strictEqual(result.success, false);
            assert.strictEqual(result.status, 'BLOCKED');
            assert.match(result.message, /Deployment readiness failed/i);
        }
    );

    if (process.exitCode) {
        console.error('deploymentExecution.checkOnlyGate.test.js FAILED');
    } else {
        console.log('deploymentExecution.checkOnlyGate.test.js PASSED');
    }
}

main();
