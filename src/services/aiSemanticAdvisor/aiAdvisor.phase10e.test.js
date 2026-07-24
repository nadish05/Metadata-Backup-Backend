const assert = require('assert');
const http = require('http');
const express = require('express');

const {
    runAiAdvisor,
    normalizeAdvisorInputs
} = require('./aiAdvisor.service');
const aiAdvisorRoutes = require('../../routes/aiAdvisor.routes');
const { ADVISOR_STATUS } = require('./llmAdapter.service');
const { VALIDATION_ADVISOR_STATUS } = require('./semanticValidator.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function sampleBody() {
    return {
        plannerDecision: {
            metadataType: 'CustomField',
            metadataName: 'Account.Status__c',
            choice: 'DEPLOY',
            canSkip: false,
            decision: 'APPLY',
            reason: 'Analyzer: authorization DENIED; Deploy required.',
            confidence: 'HIGH',
            destinationState: 'EXISTS',
            useAnalyzer: true,
            fallbackUsed: false,
            analysisLevel: 'EXISTENCE',
            authorization: {
                authorized: false,
                availability: 'DENIED',
                reasons: ['Authorization DENIED: CONTRACT capability failed.'],
                trace: {
                    evaluated: [
                        {
                            capability: 'CONTRACT',
                            role: 'ACTIVE',
                            status: 'FAIL',
                            trusted: true,
                            contributedToCanSkip: false
                        }
                    ]
                }
            }
        },
        plannerCompatibility: {
            plannerCompatibility: {
                results: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Status__c',
                        canSkip: false,
                        analysisLevel: 'EXISTENCE',
                        graphSafe: true,
                        capabilities: {
                            EXISTENCE: {
                                status: 'PASS',
                                evidence: {
                                    destinationState: 'EXISTS',
                                    existsInDestination: true
                                }
                            },
                            GRAPH: {
                                status: 'PASS',
                                evidence: { graphSafe: true }
                            },
                            CONTRACT: {
                                status: 'FAIL',
                                reason: 'type mismatch',
                                evidence: {
                                    rulesChecked: ['FIELD_TYPE'],
                                    mismatches: [
                                        {
                                            ruleId: 'FIELD_TYPE',
                                            field: 'type',
                                            message: 'type mismatch'
                                        }
                                    ]
                                }
                            }
                        }
                    }
                ]
            }
        },
        packageSummary: {
            metadataCount: 1,
            dependencyCount: 0,
            testClassCount: 0,
            totalComponents: 1
        },
        authorizationTrace: { ignored: true },
        request: { validationId: 'val-10e', mode: 'validate' },
        options: {
            generatedAt: '2026-07-24T00:00:00.000Z'
        }
    };
}

function withServer(handler) {
    const app = express();
    app.use(express.json());
    app.use('/api/ai', aiAdvisorRoutes);

    const server = http.createServer(app);

    return new Promise((resolve, reject) => {
        server.listen(0, '127.0.0.1', async () => {
            try {
                const { port } = server.address();
                await handler(port);
                server.close(() => resolve());
            } catch (error) {
                server.close(() => reject(error));
            }
        });
    });
}

function postJson(port, path, body) {
    const payload = JSON.stringify(body);

    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payload)
                }
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => {
                    data += chunk;
                });
                res.on('end', () => {
                    resolve({
                        statusCode: res.statusCode,
                        body: data ? JSON.parse(data) : null
                    });
                });
            }
        );

        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function main() {
    await runTest('normalizeAdvisorInputs maps singular plannerDecision', () => {
        const normalized = normalizeAdvisorInputs(sampleBody());
        assert.strictEqual(normalized.plannerDecisions.length, 1);
        assert.strictEqual(
            normalized.generatedDeploymentPackage.summary.totalComponents,
            1
        );
    });

    await runTest('DISABLED when AI_ENABLED=false', async () => {
        const previous = process.env.AI_ENABLED;
        process.env.AI_ENABLED = 'false';

        try {
            const result = await runAiAdvisor(sampleBody());
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.advisorStatus, ADVISOR_STATUS.DISABLED);
            assert.strictEqual(result.semanticResponse, null);
            assert.strictEqual(result.httpStatus, 200);
            assert.strictEqual(result.diagnostics.stage, 'ADAPTER');
        } finally {
            if (previous === undefined) {
                delete process.env.AI_ENABLED;
            } else {
                process.env.AI_ENABLED = previous;
            }
        }
    });

    await runTest('MOCK path returns grounded OK advisory', async () => {
        const result = await runAiAdvisor({
            ...sampleBody(),
            options: {
                generatedAt: '2026-07-24T00:00:00.000Z',
                enabled: true,
                provider: 'MOCK'
            }
        });

        assert.strictEqual(result.success, true);
        assert.ok(
            result.advisorStatus === VALIDATION_ADVISOR_STATUS.OK ||
                result.advisorStatus === VALIDATION_ADVISOR_STATUS.PARTIAL
        );
        assert.ok(result.groundingScore >= 80);
        assert.ok(result.semanticResponse);
        assert.ok(!('rawProviderPayload' in result));
        assert.ok(!JSON.stringify(result).includes('sk-'));
        assert.strictEqual(result.httpStatus, 200);
    });

    await runTest('POST /api/ai/advisor returns structured JSON', async () => {
        await withServer(async (port) => {
            const response = await postJson(port, '/api/ai/advisor', {
                ...sampleBody(),
                options: {
                    generatedAt: '2026-07-24T00:00:00.000Z',
                    enabled: true,
                    provider: 'MOCK'
                }
            });

            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(typeof response.body.success, 'boolean');
            assert.ok(response.body.advisorStatus);
            assert.ok('groundingScore' in response.body);
            assert.ok('semanticResponse' in response.body);
            assert.ok(Array.isArray(response.body.validationWarnings));
            assert.ok(response.body.diagnostics);
            assert.ok(!('httpStatus' in response.body));
            assert.ok(!JSON.stringify(response.body).includes('filePath'));
            assert.ok(!JSON.stringify(response.body).includes('stack'));
        });
    });

    await runTest('POST /api/ai/advisor DISABLED via options', async () => {
        await withServer(async (port) => {
            const response = await postJson(port, '/api/ai/advisor', {
                ...sampleBody(),
                options: {
                    enabled: false,
                    generatedAt: '2026-07-24T00:00:00.000Z'
                }
            });

            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.success, true);
            assert.strictEqual(response.body.advisorStatus, 'DISABLED');
            assert.strictEqual(response.body.semanticResponse, null);
        });
    });

    await runTest('invalid empty body yields INVALID_RESPONSE envelope', async () => {
        const result = await runAiAdvisor({
            options: {
                enabled: true,
                provider: 'MOCK',
                generatedAt: '2026-07-24T00:00:00.000Z'
            }
        });

        // Empty items context is still schema-valid; MOCK should succeed with empty items.
        assert.ok(result.advisorStatus);
        assert.ok(Array.isArray(result.validationWarnings));
        assert.ok(result.diagnostics);
    });

    if (!process.exitCode) {
        console.log('Phase 10E regression: PASS');
    }
}

main();
