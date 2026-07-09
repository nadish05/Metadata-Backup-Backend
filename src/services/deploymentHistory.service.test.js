const assert = require('assert');

const deploymentHistoryService = require('./deploymentHistory.service');

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

const basePackage = {
    repoUrl: 'https://github.com/example/repo.git',
    sourceBranch: 'feature/a',
    destinationBranch: 'main',
    selectedMetadata: [{ metadataType: 'ApexClass', metadataName: 'Foo' }],
    requiredDependencies: [{ type: 'ApexClass', name: 'Bar' }]
};

const readyReadiness = {
    overallStatus: 'READY',
    canDeploy: true,
    blockingIssues: [],
    warnings: [],
    summary: {
        destinationConnectivity: 'PASS',
        metadataValidation: 'PASS',
        dependencyValidation: 'PASS'
    }
};

const blockedReadiness = {
    overallStatus: 'BLOCKED',
    canDeploy: false,
    blockingIssues: ['Destination connectivity validation blocked.'],
    warnings: [],
    summary: {
        destinationConnectivity: 'BLOCKED',
        metadataValidation: 'PASS',
        dependencyValidation: 'PASS'
    }
};

runTest('VALIDATE mode records package, manifest, workspace, and check-only timeline', () => {
    const historyId = deploymentHistoryService.createHistory({
        deploymentPackage: { ...basePackage, deploymentMode: 'VALIDATE' },
        deploymentReadiness: readyReadiness
    });

    assert.ok(historyId);

    deploymentHistoryService.updateHistory(historyId, {
        stage: deploymentHistoryService.STAGES.PACKAGE_GENERATED,
        metadataSummary: {
            metadataCount: 1,
            dependencyCount: 1,
            testClassCount: 0,
            totalComponents: 2
        }
    });

    deploymentHistoryService.updateHistory(historyId, {
        stage: deploymentHistoryService.STAGES.MANIFEST_GENERATED,
        manifestSummary: {
            metadataTypes: 1,
            members: 1,
            apiVersion: '61.0'
        }
    });

    deploymentHistoryService.updateHistory(historyId, {
        stage: deploymentHistoryService.STAGES.WORKSPACE_BUILT,
        workspaceSummary: {
            workspaceCreated: true,
            workspacePath: '/tmp/workspace-1',
            status: 'READY'
        },
        workspacePath: '/tmp/workspace-1'
    });

    deploymentHistoryService.updateHistory(historyId, {
        stage: deploymentHistoryService.STAGES.CHECK_ONLY_COMPLETED,
        deploymentSummary: {
            componentsValidated: 2,
            deploymentStatus: 'Succeeded'
        },
        deploymentId: '0Af000001'
    });

    const response = deploymentHistoryService.completeHistory(historyId, {
        deploymentMode: 'VALIDATE',
        deploymentReadiness: readyReadiness,
        generatedWorkspace: { status: 'READY', workspaceCreated: true },
        deploymentResult: {
            success: true,
            status: 'SUCCESS',
            deploymentId: '0Af000001',
            deploymentSummary: {
                componentsValidated: 2,
                deploymentStatus: 'Succeeded'
            }
        }
    });

    assert.strictEqual(response.status, 'SUCCESS');
    assert.strictEqual(response.summary.deploymentMode, 'VALIDATE');
    assert.strictEqual(response.summary.metadataCount, 1);
    assert.strictEqual(response.summary.workspaceCreated, true);
    assert.strictEqual(response.timeline[0].stage, 'Deployment Validation Started');
    assert.strictEqual(
        response.timeline[response.timeline.length - 1].stage,
        'Deployment Completed'
    );
});

runTest('DEPLOY mode records deployment execution timeline', () => {
    const historyId = deploymentHistoryService.createHistory({
        deploymentPackage: { ...basePackage, deploymentMode: 'DEPLOY' },
        deploymentReadiness: readyReadiness
    });

    deploymentHistoryService.updateHistory(historyId, {
        stage: deploymentHistoryService.STAGES.PACKAGE_GENERATED,
        metadataSummary: { metadataCount: 1, dependencyCount: 0 }
    });

    deploymentHistoryService.updateHistory(historyId, {
        stage: deploymentHistoryService.STAGES.MANIFEST_GENERATED,
        manifestSummary: { metadataTypes: 1, members: 1, apiVersion: '61.0' }
    });

    deploymentHistoryService.updateHistory(historyId, {
        stage: deploymentHistoryService.STAGES.WORKSPACE_BUILT,
        workspaceSummary: {
            workspaceCreated: true,
            status: 'READY'
        }
    });

    deploymentHistoryService.updateHistory(historyId, {
        stage: deploymentHistoryService.STAGES.DEPLOYMENT_EXECUTED
    });

    const response = deploymentHistoryService.completeHistory(historyId, {
        deploymentMode: 'DEPLOY',
        deploymentReadiness: readyReadiness,
        generatedWorkspace: { status: 'READY', workspaceCreated: true },
        deploymentResult: {
            success: true,
            status: 'SUCCESS',
            deploymentId: '0Af000002',
            deploymentSummary: {
                componentsDeployed: 1,
                deploymentStatus: 'Succeeded'
            }
        }
    });

    assert.strictEqual(response.summary.deploymentMode, 'DEPLOY');
    assert.strictEqual(response.summary.componentsValidated, 1);
});

runTest('deployment failure is recorded as FAILED', () => {
    const historyId = deploymentHistoryService.createHistory({
        deploymentPackage: basePackage,
        deploymentReadiness: readyReadiness
    });

    const response = deploymentHistoryService.completeHistory(historyId, {
        deploymentReadiness: readyReadiness,
        generatedWorkspace: { status: 'READY', workspaceCreated: true },
        deploymentResult: {
            success: false,
            status: 'FAILED',
            message: 'Check-only deployment validation failed.',
            deploymentSummary: {
                componentsValidated: 0,
                deploymentStatus: 'Failed'
            }
        }
    });

    assert.strictEqual(response.status, 'FAILED');
    assert.ok(response.summary.deploymentStatus);
});

runTest('workspace blocked is recorded as BLOCKED', () => {
    const historyId = deploymentHistoryService.createHistory({
        deploymentPackage: basePackage,
        deploymentReadiness: readyReadiness
    });

    deploymentHistoryService.updateHistory(historyId, {
        stage: deploymentHistoryService.STAGES.WORKSPACE_BUILT,
        workspaceSummary: {
            workspaceCreated: false,
            status: 'BLOCKED',
            missingFiles: ['force-app/main/default/classes/Foo.cls']
        }
    });

    const response = deploymentHistoryService.completeHistory(historyId, {
        deploymentReadiness: readyReadiness,
        generatedWorkspace: {
            status: 'BLOCKED',
            workspaceCreated: false,
            missingFiles: ['force-app/main/default/classes/Foo.cls']
        },
        deploymentResult: {
            success: false,
            status: 'BLOCKED',
            deploymentSummary: {
                deploymentStatus: 'Blocked'
            }
        }
    });

    assert.strictEqual(response.status, 'BLOCKED');
    assert.strictEqual(response.summary.workspaceCreated, false);
});

runTest('history service exceptions never throw to callers', () => {
    assert.doesNotThrow(() => {
        deploymentHistoryService.updateHistory(null, { stage: 'Ignored' });
        deploymentHistoryService.completeHistory('missing-history-id', {});
        deploymentHistoryService.getHistory('missing-history-id');
    });
});

runTest('multiple consecutive requests produce unique history IDs', () => {
    const ids = new Set();

    for (let index = 0; index < 5; index += 1) {
        const historyId = deploymentHistoryService.createHistory({
            deploymentPackage: basePackage,
            deploymentReadiness: readyReadiness
        });

        assert.ok(historyId);
        assert.strictEqual(ids.has(historyId), false);
        ids.add(historyId);
    }

    const allHistory = deploymentHistoryService.getAllHistory();
    assert.ok(allHistory.length >= 5);
});

if (process.exitCode) {
    console.error('Deployment history tests failed.');
} else {
    console.log('Deployment history tests passed.');
}
