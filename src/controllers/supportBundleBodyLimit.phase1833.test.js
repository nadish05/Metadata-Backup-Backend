/**
 * Phase 18.3.3 — Support Bundle route-scoped JSON body limit tests.
 * Does not change Support Bundle business logic; verifies HTTP parsing only.
 */

'use strict';

const assert = require('assert');
const http = require('http');
const express = require('express');

const deploymentHistoryService = require('../services/deploymentHistory.service');
const deploymentRoutes = require('../routes/deployment.routes');
const {
    applyJsonBodyParsing,
    applySupportBundlePayloadTooLargeHandler,
    SUPPORT_BUNDLE_PAYLOAD_TOO_LARGE
} = require('../middleware/supportBundleBodyLimit');

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

function seedHistory() {
    return deploymentHistoryService.createHistory({
        deploymentPackage: { deploymentMode: 'VALIDATE' },
        deploymentReadiness: {
            overallStatus: 'NOT_READY',
            canDeploy: false,
            summary: {}
        }
    });
}

function formulaContext(extra = {}) {
    return {
        deploymentMode: 'VALIDATE',
        executionMode: 'VALIDATE',
        deploymentReadiness: { overallStatus: 'NOT_READY' },
        packageSummary: {
            metadataCount: 1,
            dependencyCount: 0
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
                    message: 'Formula incompatible'
                }
            ],
            summary: {}
        },
        ...extra
    };
}

function postRawJson(port, path, payloadString) {
    return new Promise((resolve, reject) => {
        const req = http.request(
            {
                hostname: '127.0.0.1',
                port,
                path,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(payloadString)
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
                    resolve({
                        statusCode: res.statusCode,
                        headers: res.headers,
                        body: parsed,
                        raw
                    });
                });
            }
        );
        req.on('error', reject);
        req.write(payloadString);
        req.end();
    });
}

function buildSizedSupportBundlePayload(validationId, targetBytes) {
    const base = {
        validationId,
        validationContext: formulaContext({
            // Allowlisted report field used only as size ballast for parser tests.
            resolutionReport: {
                resolutions: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        resolutionType: 'MANUAL_ACTION',
                        userActionRequired: true,
                        note: ''
                    }
                ]
            }
        }),
        issueSelection: { scope: 'ENTIRE_DEPLOYMENT', failures: [] }
    };

    let payload = JSON.stringify(base);
    const current = Buffer.byteLength(payload);
    if (current >= targetBytes) {
        return payload;
    }

    const padLen = targetBytes - current + 32;
    base.validationContext.resolutionReport.resolutions[0].note = 'P'.repeat(
        Math.max(1, padLen)
    );
    payload = JSON.stringify(base);

    // Trim if slightly over.
    while (Buffer.byteLength(payload) > targetBytes + 2048) {
        const note = base.validationContext.resolutionReport.resolutions[0].note;
        base.validationContext.resolutionReport.resolutions[0].note = note.slice(
            0,
            Math.floor(note.length * 0.9)
        );
        payload = JSON.stringify(base);
    }

    return payload;
}

async function withProductionLikeServer(run) {
    const app = express();
    applyJsonBodyParsing(app);
    app.use('/api/deployment', deploymentRoutes);
    applySupportBundlePayloadTooLargeHandler(app);

    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();
    try {
        await run(port);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
}

function assertNoLeak(rawText, secrets = []) {
    assert.ok(typeof rawText === 'string');
    assert.ok(!/at\s+\S+\s+\(/.test(rawText), 'must not include stack frames');
    assert.ok(!rawText.includes('PayloadTooLargeError'));
    for (const secret of secrets) {
        assert.ok(!rawText.includes(secret), `must not leak ${secret}`);
    }
}

async function main() {
    await runTest('Support Bundle under 100 KB succeeds', async () => {
        await withProductionLikeServer(async (port) => {
            const validationId = seedHistory();
            const payload = buildSizedSupportBundlePayload(validationId, 8 * 1024);
            assert.ok(Buffer.byteLength(payload) < 100 * 1024);
            const response = await postRawJson(
                port,
                '/api/deployment/support-bundle',
                payload
            );
            assert.strictEqual(response.statusCode, 200);
            assert.strictEqual(response.body.success, true);
            assert.ok(response.body.supportBundle);
            assert.strictEqual(response.body.delivery.mode, 'DOWNLOAD');
            assert.ok(
                String(response.body.delivery.filename || '').startsWith('SUP-')
            );
        });
    });

    await runTest(
        'Support Bundle between 100 KB and 1 MB reaches route (not global 413)',
        async () => {
            await withProductionLikeServer(async (port) => {
                const validationId = seedHistory();
                const payload = buildSizedSupportBundlePayload(
                    validationId,
                    200 * 1024
                );
                const bytes = Buffer.byteLength(payload);
                assert.ok(bytes > 100 * 1024, `expected >100KB got ${bytes}`);
                assert.ok(bytes < 1024 * 1024, `expected <1MB got ${bytes}`);

                const response = await postRawJson(
                    port,
                    '/api/deployment/support-bundle',
                    payload
                );
                assert.notStrictEqual(response.statusCode, 413);
                assert.strictEqual(response.statusCode, 200);
                assert.strictEqual(response.body.success, true);
                assert.ok(response.body.supportBundle.bundleId.startsWith('SUP-'));
                assert.notStrictEqual(
                    response.body.error,
                    'SUPPORT_BUNDLE_PAYLOAD_TOO_LARGE'
                );
            });
        }
    );

    await runTest('Support Bundle above 1 MB returns HTTP 413 JSON', async () => {
        await withProductionLikeServer(async (port) => {
            const validationId = seedHistory();
            const payload = buildSizedSupportBundlePayload(
                validationId,
                1.2 * 1024 * 1024
            );
            assert.ok(Buffer.byteLength(payload) > 1024 * 1024);

            const secretMarker = 'SECRET_TOKEN_SHOULD_NOT_LEAK';
            const poisoned = payload.replace(
                '"VALIDATE"',
                `"VALIDATE","leak":"${secretMarker}"`
            );

            const response = await postRawJson(
                port,
                '/api/deployment/support-bundle',
                poisoned
            );

            assert.strictEqual(response.statusCode, 413);
            assert.strictEqual(typeof response.body, 'object');
            assert.strictEqual(response.body.success, false);
            assert.strictEqual(
                response.body.error,
                SUPPORT_BUNDLE_PAYLOAD_TOO_LARGE.error
            );
            assert.strictEqual(
                response.body.message,
                SUPPORT_BUNDLE_PAYLOAD_TOO_LARGE.message
            );
            assert.strictEqual(response.body.stack, undefined);
            assertNoLeak(response.raw, [secretMarker, 'P'.repeat(100)]);
        });
    });

    await runTest(
        'valid Support Bundle response contract unchanged',
        async () => {
            await withProductionLikeServer(async (port) => {
                const validationId = seedHistory();
                const payload = JSON.stringify({
                    validationId,
                    validationContext: formulaContext(),
                    issueSelection: { scope: 'ENTIRE_DEPLOYMENT', failures: [] }
                });
                const response = await postRawJson(
                    port,
                    '/api/deployment/support-bundle',
                    payload
                );
                assert.strictEqual(response.statusCode, 200);
                assert.strictEqual(response.body.success, true);
                assert.ok(response.body.supportBundle);
                assert.deepStrictEqual(
                    {
                        mode: response.body.delivery.mode,
                        filenamePrefix: String(
                            response.body.delivery.filename
                        ).slice(0, 4)
                    },
                    { mode: 'DOWNLOAD', filenamePrefix: 'SUP-' }
                );
            });
        }
    );

    await runTest(
        'global ~100 KB limit still applies to non-Support-Bundle JSON',
        async () => {
            await withProductionLikeServer(async (port) => {
                const oversized = JSON.stringify({
                    padding: 'X'.repeat(150 * 1024)
                });
                assert.ok(Buffer.byteLength(oversized) > 100 * 1024);
                assert.ok(Buffer.byteLength(oversized) < 1024 * 1024);

                const response = await postRawJson(
                    port,
                    '/api/deployment/validate',
                    oversized
                );

                assert.strictEqual(response.statusCode, 413);
                // Must not be the Support Bundle-specific error contract.
                if (response.body && typeof response.body === 'object') {
                    assert.notStrictEqual(
                        response.body.error,
                        'SUPPORT_BUNDLE_PAYLOAD_TOO_LARGE'
                    );
                }
            });
        }
    );

    await runTest(
        'accepted mid-size Support Bundle still sanitizes and builds',
        async () => {
            await withProductionLikeServer(async (port) => {
                const validationId = seedHistory();
                const context = formulaContext({
                    // Forbidden / large fields must not appear in the bundle.
                    apiKey: 'sk-live-SECRET',
                    packageXml: '<Package>SHOULD_NOT_APPEAR</Package>',
                    sourceCode: 'public class Secret {}',
                    cliStdout: 'CLI_STDOUT_SECRET'
                });
                const payload = buildSizedSupportBundlePayload(
                    validationId,
                    120 * 1024
                );
                // Inject secrets into the already-sized payload object.
                const parsed = JSON.parse(payload);
                parsed.validationContext.apiKey = 'sk-live-SECRET';
                parsed.validationContext.packageXml =
                    '<Package>SHOULD_NOT_APPEAR</Package>';
                parsed.validationContext.sourceCode = 'public class Secret {}';
                parsed.validationContext.cliStdout = 'CLI_STDOUT_SECRET';
                Object.assign(parsed.validationContext, context);

                const response = await postRawJson(
                    port,
                    '/api/deployment/support-bundle',
                    JSON.stringify(parsed)
                );

                assert.strictEqual(response.statusCode, 200);
                assert.strictEqual(response.body.success, true);
                assert.ok(response.body.supportBundle.bundleId.startsWith('SUP-'));
                assert.strictEqual(response.body.delivery.mode, 'DOWNLOAD');

                const serialized = JSON.stringify(response.body);
                assert.ok(!serialized.includes('sk-live-SECRET'));
                assert.ok(!serialized.includes('SHOULD_NOT_APPEAR'));
                assert.ok(!serialized.includes('CLI_STDOUT_SECRET'));
                assert.ok(!serialized.includes('public class Secret'));
                // Builder output present
                assert.ok(response.body.supportBundle.failureClassification);
                assert.ok(response.body.supportBundle.correlation);
            });
        }
    );

    await runTest('app.js does not raise global JSON limit', async () => {
        const fs = require('fs');
        const path = require('path');
        const appSource = fs.readFileSync(
            path.join(__dirname, '../app.js'),
            'utf8'
        );
        assert.ok(!/express\.json\(\s*\{\s*limit\s*:/.test(appSource));
        assert.ok(appSource.includes('applyJsonBodyParsing(app)'));
        assert.ok(
            appSource.includes('applySupportBundlePayloadTooLargeHandler(app)')
        );

        const middlewareSource = fs.readFileSync(
            path.join(__dirname, '../middleware/supportBundleBodyLimit.js'),
            'utf8'
        );
        assert.ok(middlewareSource.includes("SUPPORT_BUNDLE_JSON_LIMIT = '1mb'"));
        assert.ok(middlewareSource.includes('limit: SUPPORT_BUNDLE_JSON_LIMIT'));
        assert.ok(!middlewareSource.includes('Infinity'));
        assert.ok(!middlewareSource.includes("'10mb'"));
        assert.ok(!middlewareSource.includes("'50mb'"));
        assert.ok(!middlewareSource.includes("'100mb'"));
    });

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
