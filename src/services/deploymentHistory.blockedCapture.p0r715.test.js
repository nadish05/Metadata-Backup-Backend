'use strict';

const assert = require('assert');

const { buildBlockedResult } = require('./checkOnlyDeployment.service');
const {
    createDeploymentHistoryService
} = require('./deploymentHistory.service');
const {
    createMemoryDeploymentHistoryStore
} = require('./deploymentHistoryStores/memoryDeploymentHistoryStore');
const {
    completeWithAutoValidationLoop
} = require('./deploymentFailureClassification/deploymentAutoValidation.service');
const {
    HISTORY_CONTROL_ORG_ENV,
    resolveDefaultHistoryStore,
    resetDefaultHistoryStoreForTests,
    STORAGE_MODE_ENV
} = require('./deploymentHistory.persistence');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function buildBlockedSnapshotDeployHistory(store) {
    const service = createDeploymentHistoryService({ store });
    const historyId = service.createHistory({
        deploymentPackage: {
            deploymentMode: 'DEPLOY',
            sourceBranch: 'main',
            repoUrl: 'https://example.com/repo.git'
        },
        deploymentReadiness: {
            canDeploy: true,
            overallStatus: 'READY',
            summary: {
                destinationConnectivity: 'PASS',
                metadataValidation: 'PASS',
                dependencyValidation: 'PASS'
            }
        },
        metadataValidation: { overallStatus: 'PASS' },
        dependencyValidation: { overallStatus: 'PASS' }
    });

    const checkOnly = {
        deploymentId: '0AfCHECKONLY001',
        success: true,
        status: 'SUCCESS',
        deploymentSummary: {
            componentsValidated: 2,
            deploymentStatus: 'Succeeded'
        }
    };
    const blocked = buildBlockedResult(
        'Destination snapshot capture failed: durable snapshot storage is not configured.',
        { mode: 'execution', executionMode: 'deploy' }
    );

    service.updateHistory(historyId, {
        stage: service.STAGES.DEPLOYMENT_EXECUTED,
        deploymentId: blocked.deploymentId || checkOnly.deploymentId || null,
        deploymentSummary: blocked.deploymentSummary
    });

    return service.completeHistory(historyId, {
        deploymentMode: 'DEPLOY',
        deploymentReadiness: {
            canDeploy: true,
            overallStatus: 'READY'
        },
        generatedWorkspace: { status: 'READY' },
        deploymentResult: blocked,
        destinationOrgId: '00DTESTORG',
        snapshotId: null
    });
}

(async () => {
    await runTest(
        'CASE 1: successful deployment history payload remains Apex-compatible',
        () => {
            const store = createMemoryDeploymentHistoryStore();
            const service = createDeploymentHistoryService({ store });
            const historyId = service.createHistory({
                deploymentPackage: { deploymentMode: 'DEPLOY' },
                deploymentReadiness: {
                    canDeploy: true,
                    overallStatus: 'READY',
                    summary: {}
                }
            });

            const response = service.completeHistory(historyId, {
                deploymentMode: 'DEPLOY',
                deploymentReadiness: {
                    canDeploy: true,
                    overallStatus: 'READY'
                },
                generatedWorkspace: { status: 'READY' },
                deploymentResult: {
                    success: true,
                    status: 'SUCCESS',
                    deploymentId: '0AfSUCCESS001',
                    deploymentSummary: {
                        componentsDeployed: 1,
                        deploymentStatus: 'Succeeded'
                    }
                },
                snapshotId: 'snap-success-001'
            });

            assert.strictEqual(response.status, 'SUCCESS');
            assert.strictEqual(response.deploymentId, '0AfSUCCESS001');
            assert.strictEqual(response.salesforceDeploymentId, '0AfSUCCESS001');
            assert.strictEqual(response.snapshotId, 'snap-success-001');
        }
    );

    await runTest(
        'CASE 2: snapshot capture BLOCKED history still returns deploymentHistory',
        () => {
            const response = buildBlockedSnapshotDeployHistory(
                createMemoryDeploymentHistoryStore()
            );

            assert.ok(response);
            assert.strictEqual(response.status, 'BLOCKED');
            assert.strictEqual(response.deploymentMode, 'DEPLOY');
            assert.strictEqual(response.deploymentId, '0AfCHECKONLY001');
            assert.strictEqual(
                response.salesforceDeploymentId,
                '0AfCHECKONLY001'
            );
            assert.match(
                response.deploymentMessage,
                /durable snapshot storage is not configured/
            );
        }
    );

    await runTest(
        'CASE 3: BLOCKED snapshot-blocked deployment has snapshotId = null',
        () => {
            const response = buildBlockedSnapshotDeployHistory(
                createMemoryDeploymentHistoryStore()
            );

            assert.strictEqual(response.snapshotId, null);
            assert.strictEqual(response.status, 'BLOCKED');
        }
    );

    await runTest(
        'CASE 4: auto-validation merge preserves blocked deploymentHistory',
        async () => {
            const blockedHistory = buildBlockedSnapshotDeployHistory(
                createMemoryDeploymentHistoryStore()
            );

            const initialResponse = {
                deploymentHistory: blockedHistory,
                deploymentExecution: {
                    success: false,
                    status: 'BLOCKED'
                },
                snapshotExport: {
                    snapshotId: 'snap-should-not-be-lost',
                    status: 'SEALED'
                },
                autoFixReport: {
                    autoFixApplied: true,
                    fixes: [{ successful: true }]
                },
                safeSkipReport: { safeSkipApplied: false }
            };

            const finalResponse = await completeWithAutoValidationLoop({
                initialResponse,
                autoFixResult: {
                    autoFixApplied: true,
                    generatedDeploymentPackage: { metadata: [] }
                },
                deploymentPackage: { deploymentMode: 'DEPLOY' },
                validationArgs: {},
                runValidation: async () => ({
                    checkOnlyDeployment: { success: true },
                    deploymentReadiness: { canDeploy: true }
                })
            });

            assert.deepStrictEqual(
                finalResponse.deploymentHistory,
                blockedHistory
            );
            assert.strictEqual(
                finalResponse.deploymentHistory.status,
                'BLOCKED'
            );
            assert.strictEqual(
                finalResponse.deploymentHistory.snapshotId,
                null
            );
        }
    );

    await runTest(
        'CONTROL_ORG snapshot mode does not route deployment history through Control Plane by default',
        () => {
            const previous = {
                [STORAGE_MODE_ENV]: process.env[STORAGE_MODE_ENV],
                [HISTORY_CONTROL_ORG_ENV]: process.env[HISTORY_CONTROL_ORG_ENV]
            };

            process.env[STORAGE_MODE_ENV] = 'CONTROL_ORG';
            delete process.env[HISTORY_CONTROL_ORG_ENV];
            resetDefaultHistoryStoreForTests();

            try {
                const store = resolveDefaultHistoryStore();
                const created = store.create({
                    historyId: 'hist-memory-default',
                    status: 'IN_PROGRESS'
                });

                assert.strictEqual(created.historyId, 'hist-memory-default');
            } finally {
                Object.entries(previous).forEach(([key, value]) => {
                    if (value === undefined) {
                        delete process.env[key];
                    } else {
                        process.env[key] = value;
                    }
                });
                resetDefaultHistoryStoreForTests();
            }
        }
    );
})();
