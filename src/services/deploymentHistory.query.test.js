const assert = require('assert');
const http = require('http');
const express = require('express');

const deploymentHistoryService = require('./deploymentHistory.service');
const deploymentHistoryRoutes = require('../routes/deploymentHistory.routes');

const basePackage = {
    repoUrl: 'https://github.com/example/repo.git',
    sourceBranch: 'feature/a',
    destinationBranch: 'main'
};

const readyReadiness = {
    canDeploy: true,
    blockingIssues: [],
    warnings: [],
    summary: {
        destinationConnectivity: 'PASS',
        metadataValidation: 'PASS',
        dependencyValidation: 'PASS'
    }
};

function seedHistory({
    deploymentMode = 'VALIDATE',
    outcome = 'SUCCESS'
} = {}) {
    const historyId = deploymentHistoryService.createHistory({
        deploymentPackage: {
            ...basePackage,
            deploymentMode
        },
        deploymentReadiness: readyReadiness
    });

    const completionByOutcome = {
        SUCCESS: {
            deploymentReadiness: readyReadiness,
            generatedWorkspace: { status: 'READY', workspaceCreated: true },
            deploymentResult: {
                success: true,
                status: 'SUCCESS',
                deploymentSummary: { deploymentStatus: 'Succeeded' }
            }
        },
        FAILED: {
            deploymentReadiness: readyReadiness,
            generatedWorkspace: { status: 'READY', workspaceCreated: true },
            deploymentResult: {
                success: false,
                status: 'FAILED',
                message: 'Deployment failed.',
                deploymentSummary: { deploymentStatus: 'Failed' }
            }
        },
        BLOCKED: {
            deploymentReadiness: {
                ...readyReadiness,
                canDeploy: false,
                blockingIssues: ['Workspace blocked.']
            },
            generatedWorkspace: {
                status: 'BLOCKED',
                workspaceCreated: false,
                missingFiles: ['force-app/main/default/classes/Foo.cls']
            },
            deploymentResult: {
                success: false,
                status: 'BLOCKED',
                deploymentSummary: { deploymentStatus: 'Blocked' }
            }
        },
        IN_PROGRESS: null
    };

    if (outcome !== 'IN_PROGRESS') {
        deploymentHistoryService.completeHistory(historyId, {
            deploymentMode,
            ...completionByOutcome[outcome]
        });
    }

    return historyId;
}

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

function createTestServer() {
    const app = express();
    app.use('/api/deployments', deploymentHistoryRoutes);
    return app.listen(0);
}

function requestJson(server, path) {
    const { port } = server.address();

    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}${path}`, (response) => {
            let body = '';

            response.on('data', (chunk) => {
                body += chunk;
            });

            response.on('end', () => {
                resolve({
                    statusCode: response.statusCode,
                    body: JSON.parse(body)
                });
            });
        }).on('error', reject);
    });
}

runTest('empty history returns empty list and zero statistics', () => {
    const history = deploymentHistoryService.listHistory();
    const statistics = deploymentHistoryService.getStatistics();

    assert.deepStrictEqual(history, []);
    assert.strictEqual(statistics.totalDeployments, 0);
    assert.strictEqual(deploymentHistoryService.getLatest(), null);
});

runTest('one deployment is returned by getLatest and getHistory', () => {
    const historyId = seedHistory({ deploymentMode: 'VALIDATE', outcome: 'SUCCESS' });
    const history = deploymentHistoryService.getHistory(historyId);
    const latest = deploymentHistoryService.getLatest();

    assert.ok(history);
    assert.strictEqual(latest.historyId, historyId);
});

runTest('multiple deployments support filters, limits, and sorting', () => {
    const baselineTotal = deploymentHistoryService.getAllHistory().length;

    seedHistory({ deploymentMode: 'VALIDATE', outcome: 'SUCCESS' });
    seedHistory({ deploymentMode: 'DEPLOY', outcome: 'FAILED' });
    seedHistory({ deploymentMode: 'VALIDATE', outcome: 'BLOCKED' });
    seedHistory({ deploymentMode: 'DEPLOY', outcome: 'SUCCESS' });
    seedHistory({ deploymentMode: 'VALIDATE', outcome: 'SUCCESS' });
    seedHistory({ deploymentMode: 'DEPLOY', outcome: 'IN_PROGRESS' });

    const totalDeployments = deploymentHistoryService.getAllHistory().length;

    assert.strictEqual(totalDeployments, baselineTotal + 6);
    assert.strictEqual(
        deploymentHistoryService.listHistory({ status: 'SUCCESS' }).length,
        baselineTotal + 3
    );
    assert.strictEqual(
        deploymentHistoryService.listHistory({ status: 'FAILED' }).length,
        1
    );
    assert.strictEqual(
        deploymentHistoryService.listHistory({ status: 'BLOCKED' }).length,
        1
    );
    assert.strictEqual(
        deploymentHistoryService.listHistory({ deploymentMode: 'DEPLOY' }).length,
        3
    );
    assert.strictEqual(
        deploymentHistoryService.listHistory({ deploymentMode: 'VALIDATE' }).length,
        baselineTotal + 3
    );
    assert.strictEqual(
        deploymentHistoryService.listHistory({ limit: 5 }).length,
        5
    );
    assert.strictEqual(
        deploymentHistoryService.listHistory({ limit: 20 }).length,
        totalDeployments
    );

    const ascending = deploymentHistoryService.listHistory({
        sort: 'asc',
        limit: 20
    });
    const descending = deploymentHistoryService.listHistory({
        sort: 'desc',
        limit: 20
    });

    assert.ok(
        new Date(ascending[0].startedAt).getTime() <=
            new Date(ascending[ascending.length - 1].startedAt).getTime()
    );
    assert.ok(
        new Date(descending[0].startedAt).getTime() >=
            new Date(descending[descending.length - 1].startedAt).getTime()
    );
});

runTest('statistics summarize deployment outcomes', () => {
    const statistics = deploymentHistoryService.getStatistics();
    const totalDeployments = deploymentHistoryService.getAllHistory().length;

    assert.strictEqual(statistics.totalDeployments, totalDeployments);
    assert.ok(statistics.successfulDeployments >= 4);
    assert.strictEqual(statistics.failedDeployments, 1);
    assert.strictEqual(statistics.blockedDeployments, 1);
    assert.strictEqual(statistics.deploymentRuns, 3);
    assert.ok(statistics.validationRuns >= 3);
    assert.ok(statistics.averageDuration);
    assert.ok(statistics.lastDeploymentTime);
});

async function runApiTests() {
    const server = createTestServer();

    try {
        const listResponse = await requestJson(
            server,
            '/api/deployments/history?limit=5&status=SUCCESS&sort=desc'
        );
        assert.strictEqual(listResponse.statusCode, 200);
        assert.strictEqual(listResponse.body.success, true);
        assert.ok(listResponse.body.count <= 5);

        const latestResponse = await requestJson(
            server,
            '/api/deployments/history/latest'
        );
        assert.strictEqual(latestResponse.statusCode, 200);
        assert.strictEqual(latestResponse.body.success, true);
        assert.ok(latestResponse.body.history.historyId);

        const statsResponse = await requestJson(
            server,
            '/api/deployments/history/statistics'
        );
        assert.strictEqual(statsResponse.statusCode, 200);
        assert.strictEqual(statsResponse.body.success, true);
        assert.ok(statsResponse.body.statistics);

        const unknownResponse = await requestJson(
            server,
            '/api/deployments/history/history_missing'
        );
        assert.strictEqual(unknownResponse.statusCode, 404);
        assert.strictEqual(unknownResponse.body.success, false);

        const invalidResponse = await requestJson(
            server,
            '/api/deployments/history?limit=500&status=INVALID'
        );
        assert.strictEqual(invalidResponse.statusCode, 400);
        assert.strictEqual(invalidResponse.body.success, false);

        console.log('PASS: REST API query endpoints');
    } catch (error) {
        console.error('FAIL: REST API query endpoints');
        console.error(error);
        process.exitCode = 1;
    } finally {
        server.close();
    }
}

runApiTests().then(() => {
    if (process.exitCode) {
        console.error('Deployment history query tests failed.');
    } else {
        console.log('Deployment history query tests passed.');
    }
});
