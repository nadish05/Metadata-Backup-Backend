/**
 * Focused tests for async Deployment Validation transport
 * (job store + start/status orchestration).
 *
 * Mocks validateDeployment — does not run real Salesforce validation.
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');

const statusStore = require('./deploymentValidationStatus.store');
const asyncService = require('./deploymentValidationAsync.service');
const migrationStatusStore = require('../status.store');
const deploymentRoutes = require('../routes/deployment.routes');
const deploymentController = require('../controllers/deployment.controller');

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

function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForJobStatus(validationId, expectedStatus, timeoutMs = 2000) {
    const started = Date.now();

    while (Date.now() - started < timeoutMs) {
        const job = statusStore.getJob(validationId);
        if (job && job.status === expectedStatus) {
            return job;
        }
        await delay(20);
    }

    throw new Error(
        `Timed out waiting for ${validationId} to become ${expectedStatus}`
    );
}

function postJson(server, urlPath, body) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const payload = JSON.stringify(body || {});
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port: address.port,
                path: urlPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let parsed = null;
                    try {
                        parsed = raw ? JSON.parse(raw) : null;
                    } catch (error) {
                        parsed = raw;
                    }
                    resolve({
                        statusCode: res.statusCode,
                        body: parsed
                    });
                });
            }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function getJson(server, urlPath) {
    return new Promise((resolve, reject) => {
        const address = server.address();
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port: address.port,
                path: urlPath,
                method: 'GET'
            },
            (res) => {
                const chunks = [];
                res.on('data', (chunk) => chunks.push(chunk));
                res.on('end', () => {
                    const raw = Buffer.concat(chunks).toString('utf8');
                    let parsed = null;
                    try {
                        parsed = raw ? JSON.parse(raw) : null;
                    } catch (error) {
                        parsed = raw;
                    }
                    resolve({
                        statusCode: res.statusCode,
                        body: parsed
                    });
                });
            }
        );
        req.on('error', reject);
        req.end();
    });
}

function createTestApp() {
    const app = express();
    app.use(express.json({ limit: '2mb' }));
    app.use('/api/deployment', deploymentRoutes);
    return app;
}

const sampleValidationResult = Object.freeze({
    success: true,
    deploymentValidation: { destinationConnected: true, status: 'PASS' },
    metadataValidation: { overallStatus: 'PASS' },
    dependencyValidation: { overallStatus: 'PASS' },
    deploymentReadiness: { overallStatus: 'READY', canDeploy: true },
    enterpriseDeploymentReport: { overallStatus: 'SUCCESS', version: 1 },
    failureClassification: { failures: [] },
    resolutionReport: { resolutions: [] },
    autoFixReport: { autoFixApplied: false, fixes: [] },
    autoValidationReport: { attempts: 1, revalidated: false },
    aiResolutionReport: { available: false },
    safeSkipReport: { safeSkipApplied: false, decisions: [] },
    checkOnlyDeployment: {
        success: true,
        status: 'Succeeded',
        deploymentSummary: { deploymentStatus: 'Succeeded' }
    },
    blockingComponents: [],
    compatibilityWarnings: [],
    deploymentCompatibilityPlan: { overallCompatibility: 'PASS' },
    generatedDeploymentPackage: { summary: { metadataCount: 2 } },
    deploymentPackageProvenance: { ignoredAutoIncluded: [] },
    deploymentHistory: {
        historyId: 'history_20260101_001',
        status: 'SUCCESS'
    }
});

async function main() {
    statusStore.clearAllJobs();
    statusStore.resetTtlForTests();
    asyncService.resetRunValidationForTests();

    await runTest(
        'TEST 1: Start endpoint returns immediately with validationId',
        async () => {
            statusStore.clearAllJobs();

            let resolveValidation;
            const pendingValidation = new Promise((resolve) => {
                resolveValidation = resolve;
            });
            asyncService.setRunValidationForTests(() => pendingValidation);

            const app = createTestApp();
            const server = await new Promise((resolve) => {
                const s = app.listen(0, '127.0.0.1', () => resolve(s));
            });

            let validationId = null;

            try {
                const startedAt = Date.now();
                const response = await postJson(
                    server,
                    '/api/deployment/validate/start',
                    {
                        refreshToken: 'rt',
                        instanceUrl: 'https://example.my.salesforce.com',
                        orgId: '00Dxx',
                        deploymentPackage: { deploymentMode: 'VALIDATE' }
                    }
                );
                const elapsedMs = Date.now() - startedAt;

                assert.strictEqual(response.statusCode, 200);
                assert.strictEqual(response.body.success, true);
                assert.strictEqual(response.body.accepted, true);
                assert.strictEqual(response.body.status, 'RUNNING');
                assert.ok(
                    typeof response.body.validationId === 'string' &&
                        response.body.validationId.startsWith('validation_')
                );
                validationId = response.body.validationId;
                // Must return without waiting for background validation.
                assert.ok(
                    elapsedMs < 500,
                    `expected immediate response, took ${elapsedMs}ms`
                );
            } finally {
                resolveValidation({ ...sampleValidationResult });
                if (validationId) {
                    await waitForJobStatus(validationId, 'COMPLETED').catch(
                        () => {}
                    );
                }
                server.close();
            }
        }
    );

    await runTest('TEST 2: Start stores RUNNING state', async () => {
        statusStore.clearAllJobs();

        let resolveValidation;
        const pendingValidation = new Promise((resolve) => {
            resolveValidation = resolve;
        });
        asyncService.setRunValidationForTests(() => pendingValidation);

        const accepted = asyncService.startValidation({
            deploymentPackage: { deploymentMode: 'VALIDATE' }
        });

        const job = statusStore.getJob(accepted.validationId);
        assert.ok(job);
        assert.strictEqual(job.status, 'RUNNING');
        assert.strictEqual(job.result, null);
        assert.strictEqual(job.error, null);
        assert.ok(job.createdAt);
        assert.strictEqual(job.completedAt, null);

        resolveValidation({ ok: true });
        await waitForJobStatus(accepted.validationId, 'COMPLETED');
    });

    await runTest(
        'TEST 3: Background validation stores COMPLETED + full result',
        async () => {
            statusStore.clearAllJobs();
            const fullResult = {
                ...sampleValidationResult,
                uniqueMarker: 'exact-full-result-marker'
            };

            asyncService.setRunValidationForTests(async () => fullResult);

            const accepted = asyncService.startValidation({
                deploymentPackage: { deploymentMode: 'VALIDATE' }
            });

            const job = await waitForJobStatus(
                accepted.validationId,
                'COMPLETED'
            );
            assert.strictEqual(job.status, 'COMPLETED');
            assert.deepStrictEqual(job.result, fullResult);
            assert.strictEqual(job.error, null);
            assert.ok(job.completedAt);
        }
    );

    await runTest(
        'TEST 4: Background validation failure stores FAILED',
        async () => {
            statusStore.clearAllJobs();

            asyncService.setRunValidationForTests(async () => {
                throw new Error('Simulated validation crash');
            });

            const accepted = asyncService.startValidation({
                deploymentPackage: { deploymentMode: 'VALIDATE' }
            });

            const job = await waitForJobStatus(accepted.validationId, 'FAILED');
            assert.strictEqual(job.status, 'FAILED');
            assert.ok(
                String(job.error).includes('Simulated validation crash')
            );
            assert.ok(job.completedAt);
        }
    );

    await runTest('TEST 5: Status endpoint returns RUNNING', async () => {
        statusStore.clearAllJobs();

        let resolveValidation;
        const pendingValidation = new Promise((resolve) => {
            resolveValidation = resolve;
        });
        asyncService.setRunValidationForTests(() => pendingValidation);

        const accepted = asyncService.startValidation({
            deploymentPackage: { deploymentMode: 'VALIDATE' }
        });

        const app = createTestApp();
        const server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });

        try {
            const response = await getJson(
                server,
                `/api/deployment/validate/status/${accepted.validationId}`
            );
            assert.strictEqual(response.statusCode, 200);
            assert.deepStrictEqual(response.body, {
                success: true,
                status: 'RUNNING',
                validationId: accepted.validationId
            });
        } finally {
            resolveValidation({ done: true });
            await waitForJobStatus(accepted.validationId, 'COMPLETED');
            server.close();
        }
    });

    await runTest(
        'TEST 6: Status endpoint returns COMPLETED + exact full result',
        async () => {
            statusStore.clearAllJobs();
            const fullResult = {
                ...sampleValidationResult,
                marker: 'preserve-exact-shape'
            };

            asyncService.setRunValidationForTests(async () => fullResult);

            const accepted = asyncService.startValidation({
                deploymentPackage: { deploymentMode: 'VALIDATE' }
            });
            await waitForJobStatus(accepted.validationId, 'COMPLETED');

            const app = createTestApp();
            const server = await new Promise((resolve) => {
                const s = app.listen(0, '127.0.0.1', () => resolve(s));
            });

            try {
                const response = await getJson(
                    server,
                    `/api/deployment/validate/status/${accepted.validationId}`
                );
                assert.strictEqual(response.statusCode, 200);
                assert.strictEqual(response.body.success, true);
                assert.strictEqual(response.body.status, 'COMPLETED');
                assert.strictEqual(
                    response.body.validationId,
                    accepted.validationId
                );
                assert.deepStrictEqual(response.body.result, fullResult);
            } finally {
                server.close();
            }
        }
    );

    await runTest('TEST 7: Status endpoint returns FAILED', async () => {
        statusStore.clearAllJobs();

        asyncService.setRunValidationForTests(async () => {
            throw new Error('Background boom');
        });

        const accepted = asyncService.startValidation({
            deploymentPackage: { deploymentMode: 'VALIDATE' }
        });
        await waitForJobStatus(accepted.validationId, 'FAILED');

        const app = createTestApp();
        const server = await new Promise((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });

        try {
            const response = await getJson(
                server,
                `/api/deployment/validate/status/${accepted.validationId}`
            );
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.success, true);
            assert.strictEqual(response.body.status, 'FAILED');
            assert.strictEqual(
                response.body.validationId,
                accepted.validationId
            );
            assert.ok(String(response.body.error).includes('Background boom'));
        } finally {
            server.close();
        }
    });

    await runTest(
        'TEST 8: Unknown validationId returns proper error',
        async () => {
            statusStore.clearAllJobs();

            const app = createTestApp();
            const server = await new Promise((resolve) => {
                const s = app.listen(0, '127.0.0.1', () => resolve(s));
            });

            try {
                const response = await getJson(
                    server,
                    '/api/deployment/validate/status/validation_does_not_exist'
                );
                assert.strictEqual(response.statusCode, 404);
                assert.strictEqual(response.body.success, false);
                assert.ok(
                    String(response.body.error).toLowerCase().includes('not found')
                );
            } finally {
                server.close();
            }
        }
    );

    await runTest(
        'TEST 9: Two validation jobs do not overwrite each other',
        async () => {
            statusStore.clearAllJobs();

            let resolveA;
            let resolveB;
            const pendingA = new Promise((resolve) => {
                resolveA = resolve;
            });
            const pendingB = new Promise((resolve) => {
                resolveB = resolve;
            });
            const queue = [pendingA, pendingB];

            asyncService.setRunValidationForTests(() => queue.shift());

            const jobA = asyncService.startValidation({
                deploymentPackage: { tag: 'A' }
            });
            const jobB = asyncService.startValidation({
                deploymentPackage: { tag: 'B' }
            });

            assert.notStrictEqual(jobA.validationId, jobB.validationId);
            assert.strictEqual(
                statusStore.getJob(jobA.validationId).status,
                'RUNNING'
            );
            assert.strictEqual(
                statusStore.getJob(jobB.validationId).status,
                'RUNNING'
            );

            const resultB = { ...sampleValidationResult, tag: 'B' };
            const resultA = { ...sampleValidationResult, tag: 'A' };

            // Complete B first with distinct result.
            resolveB(resultB);
            await waitForJobStatus(jobB.validationId, 'COMPLETED');

            assert.strictEqual(
                statusStore.getJob(jobA.validationId).status,
                'RUNNING'
            );
            assert.deepStrictEqual(
                statusStore.getJob(jobB.validationId).result,
                resultB
            );

            resolveA(resultA);
            await waitForJobStatus(jobA.validationId, 'COMPLETED');

            assert.deepStrictEqual(
                statusStore.getJob(jobA.validationId).result,
                resultA
            );
            assert.deepStrictEqual(
                statusStore.getJob(jobB.validationId).result,
                resultB
            );
        }
    );

    await runTest(
        'TEST 10: Validation status does not affect migration status.store.js',
        async () => {
            statusStore.clearAllJobs();
            migrationStatusStore.setStatus('Retrieving Full Metadata');

            asyncService.setRunValidationForTests(async () => ({
                ...sampleValidationResult
            }));

            const accepted = asyncService.startValidation({
                deploymentPackage: { deploymentMode: 'VALIDATE' }
            });
            await waitForJobStatus(accepted.validationId, 'COMPLETED');

            assert.strictEqual(
                migrationStatusStore.getStatus(),
                'Retrieving Full Metadata'
            );

            // Also ensure fail path does not touch migration status.
            asyncService.setRunValidationForTests(async () => {
                throw new Error('fail path');
            });
            const failed = asyncService.startValidation({
                deploymentPackage: { deploymentMode: 'VALIDATE' }
            });
            await waitForJobStatus(failed.validationId, 'FAILED');

            assert.strictEqual(
                migrationStatusStore.getStatus(),
                'Retrieving Full Metadata'
            );

            migrationStatusStore.setStatus('Idle');
        }
    );

    await runTest(
        'TEST 11: Existing synchronous /api/deployment/validate remains unchanged',
        async () => {
            const routesSource = fs.readFileSync(
                path.join(__dirname, '../routes/deployment.routes.js'),
                'utf8'
            );

            assert.ok(
                routesSource.includes("'/validate/start'"),
                'expected /validate/start route'
            );
            assert.ok(
                routesSource.includes("'/validate/status/:validationId'"),
                'expected /validate/status/:validationId route'
            );
            assert.ok(
                routesSource.includes("'/validate'"),
                'expected existing /validate route'
            );
            assert.ok(
                routesSource.includes(
                    'deploymentController.validateDeployment'
                ),
                'expected sync validateDeployment handler still wired'
            );

            assert.strictEqual(
                typeof deploymentController.validateDeployment,
                'function'
            );
            assert.strictEqual(
                typeof deploymentController.startDeploymentValidation,
                'function'
            );
            assert.strictEqual(
                typeof deploymentController.getDeploymentValidationStatus,
                'function'
            );

            // Sync handler source still awaits validateDeployment (not fire-and-forget).
            const controllerSource = fs.readFileSync(
                path.join(__dirname, '../controllers/deployment.controller.js'),
                'utf8'
            );
            assert.ok(
                controllerSource.includes(
                    'await deploymentValidationService.validateDeployment'
                ),
                'sync endpoint must still await validateDeployment'
            );
            assert.ok(
                controllerSource.includes('startDeploymentValidation'),
                'async start handler must exist'
            );
        }
    );

    await runTest(
        'HTTP start endpoint accepts same payload shape and returns RUNNING',
        async () => {
            statusStore.clearAllJobs();

            let resolveValidation;
            const pendingValidation = new Promise((resolve) => {
                resolveValidation = resolve;
            });
            asyncService.setRunValidationForTests(() => pendingValidation);

            const app = createTestApp();
            const server = await new Promise((resolve) => {
                const s = app.listen(0, '127.0.0.1', () => resolve(s));
            });

            try {
                const response = await postJson(
                    server,
                    '/api/deployment/validate/start',
                    {
                        refreshToken: 'rt',
                        instanceUrl: 'https://example.my.salesforce.com',
                        orgId: '00Dxx',
                        deploymentPackage: {
                            deploymentMode: 'VALIDATE',
                            selectedMetadata: []
                        },
                        deploymentSelections: [
                            {
                                metadataType: 'ApexClass',
                                metadataName: 'Foo',
                                action: 'Deploy'
                            }
                        ]
                    }
                );

                assert.strictEqual(response.statusCode, 200);
                assert.strictEqual(response.body.accepted, true);
                assert.strictEqual(response.body.status, 'RUNNING');
                assert.ok(response.body.validationId);

                resolveValidation({ ...sampleValidationResult });
                await waitForJobStatus(
                    response.body.validationId,
                    'COMPLETED'
                );
            } finally {
                server.close();
            }
        }
    );

    // Cleanup injectable mock so later imports are not poisoned if reused.
    asyncService.resetRunValidationForTests();
    statusStore.clearAllJobs();
    statusStore.resetTtlForTests();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
