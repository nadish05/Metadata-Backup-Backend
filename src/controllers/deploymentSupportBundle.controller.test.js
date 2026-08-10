const assert = require('assert');
const http = require('http');
const express = require('express');
const Module = require('module');

const deploymentHistoryService = require('../services/deploymentHistory.service');
const supportBundleApi = require('../services/supportBundle/supportBundleApi.service');
const deploymentRoutes = require('../routes/deployment.routes');

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

function seedHistory(overrides = {}) {
    const historyId = deploymentHistoryService.createHistory({
        deploymentPackage: {
            deploymentMode: 'VALIDATE',
            ...overrides.deploymentPackage
        },
        deploymentReadiness: {
            overallStatus: overrides.overallStatus || 'NOT_READY',
            canDeploy: false,
            summary: {}
        }
    });
    assert.ok(historyId);
    if (overrides.deploymentId) {
        deploymentHistoryService.updateHistory(historyId, {
            deploymentId: overrides.deploymentId
        });
    }
    return historyId;
}

function formulaContext() {
    return {
        deploymentMode: 'VALIDATE',
        executionMode: 'VALIDATE',
        deploymentReadiness: { overallStatus: 'NOT_READY' },
        packageSummary: {
            metadataCount: 1,
            dependencyCount: 0,
            membersByType: { CustomField: ['Account.Score__c'] }
        },
        failureClassification: {
            failures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c',
                    category: 'MANUAL_ACTION',
                    reason: 'Formula type conversion is incompatible.',
                    errorCode: 'FIELD_INTEGRITY_EXCEPTION',
                    stage: 'CHECK_ONLY',
                    safeToSkip: false
                }
            ]
        },
        resolutionReport: {
            resolutions: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c',
                    resolutionType: 'MANUAL_ACTION',
                    userActionRequired: true
                }
            ]
        },
        autoFixReport: { autoFixApplied: false, fixes: [] },
        autoValidationReport: {
            attempts: 1,
            finalStatus: 'FAILED',
            revalidated: false
        },
        enterpriseDeploymentReport: {
            overallStatus: 'FAILED',
            failures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c',
                    category: 'MANUAL_ACTION'
                }
            ]
        },
        deploymentDiagnostics: {
            deploymentId: '0AfFORMULA',
            overallStatus: 'Failed',
            componentFailures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Score__c',
                    message: 'Formula incompatible',
                    errorCode: 'FIELD_INTEGRITY_EXCEPTION'
                }
            ],
            summary: {}
        }
    };
}

function multiFailureContext() {
    const ctx = formulaContext();
    ctx.failureClassification.failures.push({
        metadataType: 'PermissionSet',
        metadataName: 'WeatherAccess',
        category: 'MISSING_DEPENDENCY',
        reason: 'Missing CustomObject',
        stage: 'DEPENDENCY',
        safeToSkip: null
    });
    ctx.resolutionReport.resolutions.push({
        metadataType: 'PermissionSet',
        metadataName: 'WeatherAccess',
        resolutionType: 'AUTO_FIXABLE'
    });
    ctx.deploymentDiagnostics.componentFailures.push({
        metadataType: 'PermissionSet',
        metadataName: 'WeatherAccess',
        message: 'Missing dependency'
    });
    ctx.enterpriseDeploymentReport.failures.push({
        metadataType: 'PermissionSet',
        metadataName: 'WeatherAccess',
        category: 'MISSING_DEPENDENCY'
    });
    return ctx;
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
                let raw = '';
                res.on('data', (chunk) => {
                    raw += chunk;
                });
                res.on('end', () => {
                    let parsed = null;
                    try {
                        parsed = raw ? JSON.parse(raw) : null;
                    } catch (_err) {
                        parsed = raw;
                    }
                    resolve({ statusCode: res.statusCode, body: parsed });
                });
            }
        );
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

async function withServer(run) {
    const app = express();
    app.use(express.json());
    app.use('/api/deployment', deploymentRoutes);
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        await run(port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

async function main() {
    await runTest('successful entire-deployment bundle', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory({ deploymentId: '0AfALL' });
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: multiFailureContext(),
                issueSelection: { scope: 'ENTIRE_DEPLOYMENT' }
            });
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.success, true);
            assert.ok(response.body.supportBundle.bundleId.startsWith('SUP-'));
            assert.strictEqual(
                response.body.supportBundle.request.issueScope,
                'ENTIRE_DEPLOYMENT'
            );
            assert.strictEqual(
                response.body.supportBundle.failureClassification.failures.length,
                2
            );
            assert.strictEqual(response.body.supportBundle.correlation.historyId, validationId);
        });
    });

    await runTest('successful selected-failure bundle', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: multiFailureContext(),
                issueSelection: {
                    scope: 'SELECTED_FAILURES',
                    failures: [
                        {
                            metadataType: 'PermissionSet',
                            metadataName: 'WeatherAccess'
                        }
                    ]
                }
            });
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(
                response.body.supportBundle.request.issueScope,
                'SELECTED_FAILURES'
            );
            assert.strictEqual(
                response.body.supportBundle.failureClassification.failures.length,
                1
            );
            assert.strictEqual(
                response.body.supportBundle.failureClassification.failures[0]
                    .metadataName,
                'WeatherAccess'
            );
        });
    });

    await runTest('failed deployment bundle', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext()
            });
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(
                response.body.supportBundle.status.enterpriseOverallStatus,
                'FAILED'
            );
        });
    });

    await runTest('Formula failure', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext()
            });
            const failure =
                response.body.supportBundle.failureClassification.failures[0];
            assert.ok(String(failure.reason).includes('Formula'));
        });
    });

    await runTest('PersonAccount failure', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const context = {
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'PersonAccount.PersonAccount',
                            category: 'DESTINATION_FEATURE',
                            stage: 'DESTINATION_VALIDATION',
                            safeToSkip: false
                        }
                    ]
                },
                enterpriseDeploymentReport: { overallStatus: 'FAILED' }
            };
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: context
            });
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(
                response.body.supportBundle.failureClassification.failures[0]
                    .metadataName,
                'PersonAccount.PersonAccount'
            );
        });
    });

    await runTest('missing dependency', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'PermissionSet',
                                metadataName: 'WeatherAccess',
                                category: 'MISSING_DEPENDENCY'
                            }
                        ]
                    }
                }
            });
            assert.strictEqual(
                response.body.supportBundle.failureClassification.failures[0]
                    .category,
                'MISSING_DEPENDENCY'
            );
        });
    });

    await runTest('auto-fixed dependency', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    failureClassification: { failures: [] },
                    autoFixReport: {
                        autoFixApplied: true,
                        fixes: [
                            {
                                metadataType: 'CustomObject',
                                metadataName: 'Weather__c',
                                successful: true,
                                executed: true
                            }
                        ]
                    },
                    enterpriseDeploymentReport: { overallStatus: 'SUCCESS' }
                }
            });
            assert.strictEqual(
                response.body.supportBundle.autoFixReport.autoFixApplied,
                true
            );
        });
    });

    await runTest('AI report present', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext(),
                aiResolutionReport: {
                    generated: true,
                    provider: 'gemini',
                    summary: 'Manual formula fix',
                    explanations: [],
                    disclaimer: 'advisory',
                    prompt: 'SECRET_PROMPT',
                    apiKey: 'SECRET_KEY'
                }
            });
            assert.strictEqual(response.body.supportBundle.aiResolution.present, true);
            assert.strictEqual(
                response.body.supportBundle.aiResolution.provider,
                'gemini'
            );
            assert.strictEqual(
                response.body.supportBundle.aiResolution.prompt,
                undefined
            );
            assert.strictEqual(
                response.body.supportBundle.aiResolution.apiKey,
                undefined
            );
        });
    });

    await runTest('AI report absent', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    ...formulaContext(),
                    aiResolutionReport: { generated: false }
                }
            });
            assert.deepStrictEqual(response.body.supportBundle.aiResolution, {
                present: false
            });
        });
    });

    await runTest('missing validation context', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                issueSelection: { scope: 'ENTIRE_DEPLOYMENT' }
            });
            assert.strictEqual(response.statusCode, 400);
            assert.strictEqual(response.body.success, false);
            assert.ok(String(response.body.error).includes('validationContext'));
        });
    });

    await runTest('invalid validationId', async () => {
        await withServer(async (port) => {
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId: 'history_missing_does_not_exist',
                validationContext: formulaContext()
            });
            assert.strictEqual(response.statusCode, 404);
            assert.strictEqual(response.body.success, false);
        });
    });

    await runTest('missing validationId', async () => {
        await withServer(async (port) => {
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationContext: formulaContext()
            });
            assert.strictEqual(response.statusCode, 400);
            assert.ok(String(response.body.error).includes('validationId'));
        });
    });

    await runTest('invalid issueSelection', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext(),
                issueSelection: { scope: 'EVERYTHING' }
            });
            assert.strictEqual(response.statusCode, 400);
        });
    });

    await runTest('invalid metadataType', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext(),
                issueSelection: {
                    scope: 'SELECTED_FAILURES',
                    failures: [{ metadataType: '  ', metadataName: 'Account.Score__c' }]
                }
            });
            assert.strictEqual(response.statusCode, 400);
            assert.ok(String(response.body.error).includes('metadataType'));
        });
    });

    await runTest('invalid metadataName', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext(),
                issueSelection: {
                    scope: 'SELECTED_FAILURES',
                    failures: [{ metadataType: 'CustomField', metadataName: '' }]
                }
            });
            assert.strictEqual(response.statusCode, 400);
            assert.ok(String(response.body.error).includes('metadataName'));
        });
    });

    await runTest('selected failure does not exist', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext(),
                issueSelection: {
                    scope: 'SELECTED_FAILURES',
                    failures: [
                        {
                            metadataType: 'PermissionSet',
                            metadataName: 'DoesNotExist'
                        }
                    ]
                }
            });
            assert.strictEqual(response.statusCode, 400);
            assert.ok(
                String(response.body.error).includes(
                    'Selected failure was not found'
                )
            );
        });
    });

    await runTest('multiple selected failures', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: multiFailureContext(),
                issueSelection: {
                    scope: 'SELECTED_FAILURES',
                    failures: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Score__c'
                        },
                        {
                            metadataType: 'PermissionSet',
                            metadataName: 'WeatherAccess'
                        }
                    ]
                }
            });
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(
                response.body.supportBundle.failureClassification.failures.length,
                2
            );
        });
    });

    await runTest('empty selected failures', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext(),
                issueSelection: {
                    scope: 'SELECTED_FAILURES',
                    failures: []
                }
            });
            assert.strictEqual(response.statusCode, 400);
        });
    });

    await runTest('successful validation with no failures', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory({ overallStatus: 'READY' });
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    deploymentMode: 'VALIDATE',
                    enterpriseDeploymentReport: { overallStatus: 'SUCCESS' },
                    failureClassification: { failures: [] },
                    deploymentReadiness: { overallStatus: 'READY' }
                }
            });
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(
                response.body.supportBundle.status.overallStatus,
                'SUCCESS'
            );
            assert.strictEqual(
                response.body.supportBundle.failureClassification.failures.length,
                0
            );
        });
    });

    await runTest('missing optional reports', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    failureClassification: { failures: [] }
                }
            });
            assert.strictEqual(response.statusCode, 200);
            assert.deepStrictEqual(
                response.body.supportBundle.enterpriseDeploymentReport,
                {}
            );
            assert.deepStrictEqual(response.body.supportBundle.aiResolution, {
                present: false
            });
        });
    });

    await runTest('secret injection attempt', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    ...formulaContext(),
                    refreshToken: 'SECRET_REFRESH',
                    password: 'SECRET_PASSWORD',
                    cookie: 'sid=SECRET'
                }
            });
            assert.strictEqual(response.statusCode, 200);
            const text = JSON.stringify(response.body);
            assert.ok(!text.includes('SECRET_REFRESH'));
            assert.ok(!text.includes('SECRET_PASSWORD'));
            assert.ok(!text.includes('sid=SECRET'));
        });
    });

    await runTest('accessToken injection attempt', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    ...formulaContext(),
                    accessToken: 'SECRET_ACCESS',
                    deploymentDiagnostics: {
                        ...formulaContext().deploymentDiagnostics,
                        accessToken: 'SECRET_ACCESS_NESTED'
                    }
                }
            });
            const text = JSON.stringify(response.body);
            assert.ok(!text.includes('SECRET_ACCESS'));
        });
    });

    await runTest('API key injection attempt', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    ...formulaContext(),
                    apiKey: 'sk-live-SECRET',
                    openaiApiKey: 'sk-live-SECRET2'
                }
            });
            const text = JSON.stringify(response.body);
            assert.ok(!text.includes('sk-live-SECRET'));
        });
    });

    await runTest('raw CLI output injection', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    ...formulaContext(),
                    cliStdout: 'RAW_CLI_STDOUT',
                    deploymentDiagnostics: {
                        deploymentId: '0Af',
                        overallStatus: 'Failed',
                        cliStderr: 'RAW_CLI_STDERR',
                        rawFailure: { dump: 'RAW' },
                        componentFailures: []
                    }
                }
            });
            const text = JSON.stringify(response.body);
            assert.ok(!text.includes('RAW_CLI_STDOUT'));
            assert.ok(!text.includes('RAW_CLI_STDERR'));
            assert.ok(!text.includes('"dump":"RAW"'));
        });
    });

    await runTest('source code injection', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    ...formulaContext(),
                    sourceCode: 'public class Leak {}',
                    metadataXml: '<ApexClass/>'
                }
            });
            const text = JSON.stringify(response.body);
            assert.ok(!text.includes('public class Leak'));
            assert.ok(!text.includes('<ApexClass/>'));
        });
    });

    await runTest('enterprise report injection attempt', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            // Client can supply a snapshot (architecture limitation), but secrets
            // and non-allowlisted decision overrides outside allowlist are dropped.
            // Allowlisted enterpriseDeploymentReport is sanitized and snapshotted.
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Account.Score__c',
                                category: 'MANUAL_ACTION'
                            }
                        ]
                    },
                    enterpriseDeploymentReport: {
                        overallStatus: 'SUCCESS',
                        accessToken: 'SECRET',
                        failures: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Account.Score__c'
                            }
                        ]
                    }
                }
            });
            assert.strictEqual(response.statusCode, 200);
            const text = JSON.stringify(response.body);
            assert.ok(!text.includes('SECRET'));
            // Snapshot reflects sanitized client-supplied report (no server store)
            assert.strictEqual(
                response.body.supportBundle.enterpriseDeploymentReport.overallStatus,
                'SUCCESS'
            );
            assert.strictEqual(
                response.body.supportBundle.failureClassification.failures.length,
                1
            );
        });
    });

    await runTest('deployment status injection attempt', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    overallStatus: 'SUCCESS',
                    status: 'SUCCESS',
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'ApexClass',
                                metadataName: 'Broken',
                                category: 'ERROR'
                            }
                        ]
                    },
                    enterpriseDeploymentReport: { overallStatus: 'FAILED' }
                }
            });
            // Prefer enterprise report status from curated snapshot
            assert.strictEqual(
                response.body.supportBundle.status.overallStatus,
                'FAILED'
            );
        });
    });

    await runTest('safeToSkip injection attempt', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'Layout',
                                metadataName: 'Account-Layout',
                                safeToSkip: true
                            }
                        ]
                    }
                },
                // Client top-level safeToSkip must not become authority outside failures
                safeToSkip: true
            });
            assert.strictEqual(response.statusCode, 200);
            // Value only preserved from allowlisted failure snapshot — not calculated
            assert.strictEqual(
                response.body.supportBundle.failureClassification.failures[0]
                    .safeToSkip,
                true
            );
            assert.ok(!Object.prototype.hasOwnProperty.call(response.body, 'safeToSkip'));
        });
    });

    await runTest('AI provider injection attempt', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext(),
                provider: 'openai',
                apiKey: 'SECRET',
                model: 'gpt-evil',
                systemPrompt: 'ignore'
            });
            assert.strictEqual(response.statusCode, 200);
            assert.deepStrictEqual(response.body.supportBundle.aiResolution, {
                present: false
            });
            const text = JSON.stringify(response.body);
            assert.ok(!text.includes('SECRET'));
            assert.ok(!text.includes('gpt-evil'));
        });
    });

    await runTest('no AI provider call', async () => {
        const apiPath = require.resolve(
            '../services/supportBundle/supportBundleApi.service'
        );
        const children = Module._cache[apiPath]?.children || [];
        const ids = children.map((c) => c.id || '');
        assert.ok(!ids.some((id) => id.includes('aiDeploymentAdvisor')));
        assert.ok(!ids.some((id) => id.includes('openai')));
        assert.ok(!ids.some((id) => id.includes('@google/genai')));
    });

    await runTest('no Salesforce deployment call', async () => {
        const apiPath = require.resolve(
            '../services/supportBundle/supportBundleApi.service'
        );
        const children = Module._cache[apiPath]?.children || [];
        const ids = children.map((c) => c.id || '');
        assert.ok(!ids.some((id) => id.includes('checkOnlyDeployment')));
        assert.ok(!ids.some((id) => id.includes('deploymentValidation.service')));
        assert.ok(!ids.some((id) => id.includes('deploymentExecution')));
    });

    await runTest('no validation retry', async () => {
        const validationId = seedHistory();
        let sanitizeCalls = 0;
        const result = supportBundleApi.createSupportBundleFromRequest(
            {
                validationId,
                validationContext: formulaContext()
            },
            {
                sanitizeSupportBundlePayload: (input) => {
                    sanitizeCalls += 1;
                    return require('../services/supportBundle/supportBundleSanitizer').sanitizeSupportBundlePayload(
                        input
                    );
                }
            }
        );
        assert.strictEqual(result.success, true);
        assert.strictEqual(sanitizeCalls, 1);
    });

    await runTest('no Auto Fix execution', async () => {
        const apiPath = require.resolve(
            '../services/supportBundle/supportBundleApi.service'
        );
        const children = Module._cache[apiPath]?.children || [];
        const ids = children.map((c) => c.id || '');
        assert.ok(!ids.some((id) => id.includes('deploymentAutoFix')));
    });

    await runTest('HTTP 200 response', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext()
            });
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.success, true);
        });
    });

    await runTest('HTTP 400 response', async () => {
        await withServer(async (port) => {
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationContext: formulaContext()
            });
            assert.strictEqual(response.statusCode, 400);
        });
    });

    await runTest('HTTP 404 response', async () => {
        await withServer(async (port) => {
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId: 'history_not_found_404',
                validationContext: formulaContext()
            });
            assert.strictEqual(response.statusCode, 404);
        });
    });

    await runTest('HTTP 500 safe response', async () => {
        await withServer(async (port) => {
            const original = supportBundleApi.createSupportBundleFromRequest;
            supportBundleApi.createSupportBundleFromRequest = () => {
                throw new Error('unexpected internal failure with SECRET');
            };
            try {
                const validationId = seedHistory();
                const response = await postJson(
                    port,
                    '/api/deployment/support-bundle',
                    {
                        validationId,
                        validationContext: formulaContext()
                    }
                );
                assert.strictEqual(response.statusCode, 500);
                assert.strictEqual(response.body.success, false);
                assert.strictEqual(
                    response.body.error,
                    'Unable to generate support bundle.'
                );
                assert.ok(!JSON.stringify(response.body).includes('SECRET'));
                assert.ok(!response.body.stack);
            } finally {
                supportBundleApi.createSupportBundleFromRequest = original;
            }
        });
    });

    await runTest('bundleId returned', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext()
            });
            assert.match(
                response.body.supportBundle.bundleId,
                /^SUP-\d{8}-[0-9A-F]{6}$/
            );
        });
    });

    await runTest('generatedAt returned', async () => {
        await withServer(async (port) => {
            const validationId = seedHistory();
            const response = await postJson(port, '/api/deployment/support-bundle', {
                validationId,
                validationContext: formulaContext()
            });
            assert.ok(response.body.supportBundle.generatedAt);
            assert.ok(!Number.isNaN(Date.parse(response.body.supportBundle.generatedAt)));
        });
    });

    await runTest('sanitizer always executed before builder', () => {
        const validationId = seedHistory();
        const callOrder = [];
        supportBundleApi.createSupportBundleFromRequest(
            {
                validationId,
                validationContext: formulaContext()
            },
            {
                callOrder,
                sanitizeSupportBundlePayload: (input) =>
                    require('../services/supportBundle/supportBundleSanitizer').sanitizeSupportBundlePayload(
                        input
                    ),
                buildSupportBundle: (args) =>
                    require('../services/supportBundle/supportBundle.service').buildSupportBundle(
                        args
                    )
            }
        );
        assert.deepStrictEqual(callOrder, ['sanitize', 'build']);
    });

    if (process.exitCode && process.exitCode !== 0) {
        process.exit(process.exitCode);
    }
}

main();
