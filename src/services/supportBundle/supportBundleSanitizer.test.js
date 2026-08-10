const assert = require('assert');

const {
    sanitizeSupportBundlePayload,
    LIMITS,
    REDACTED,
    isDeniedKey,
    sanitizeStringValue,
    sanitizePathLikeString,
    sanitizeGithubOrHttpUrl
} = require('./supportBundleSanitizer');

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

function sanitize(input) {
    return sanitizeSupportBundlePayload(input);
}

function assertNoSecretResidue(value, forbidden = ['SECRET', 'sk-live', 'ghp_']) {
    const text = JSON.stringify(value);
    for (const needle of forbidden) {
        assert.ok(
            !text.includes(needle),
            `Expected sanitized payload not to contain ${needle}`
        );
    }
}

async function main() {
    await runTest('accessToken removed', () => {
        const result = sanitize({ accessToken: 'SECRET', metadataType: 'ApexClass' });
        assert.strictEqual(result.sanitized, true);
        assert.strictEqual(result.payload.accessToken, undefined);
        assert.strictEqual(result.payload.metadataType, 'ApexClass');
    });

    await runTest('refreshToken removed', () => {
        const result = sanitize({ refreshToken: 'SECRET', historyId: 'H-1' });
        assert.strictEqual(result.payload.refreshToken, undefined);
        assert.strictEqual(result.payload.historyId, 'H-1');
    });

    await runTest('Authorization removed', () => {
        const result = sanitize({
            diagnostics: {
                headers: {
                    Authorization: 'Bearer SECRET'
                },
                message: 'ok'
            }
        });
        assert.strictEqual(result.payload.diagnostics.headers.Authorization, undefined);
        assert.strictEqual(result.payload.diagnostics.message, 'ok');
    });

    await runTest('apiKey removed', () => {
        const result = sanitize({ apiKey: 'SECRET', status: 'FAILED' });
        assert.strictEqual(result.payload.apiKey, undefined);
        assert.strictEqual(result.payload.status, 'FAILED');
    });

    await runTest('clientSecret removed', () => {
        const result = sanitize({ clientSecret: 'SECRET', deploymentId: '0Af...' });
        assert.strictEqual(result.payload.clientSecret, undefined);
        assert.strictEqual(result.payload.deploymentId, '0Af...');
    });

    await runTest('password removed', () => {
        const result = sanitize({ password: 'SECRET', overallStatus: 'FAILED' });
        assert.strictEqual(result.payload.password, undefined);
    });

    await runTest('cookie removed', () => {
        const result = sanitize({ cookie: 'sid=SECRET', stage: 'DEPLOY' });
        assert.strictEqual(result.payload.cookie, undefined);
        assert.strictEqual(result.payload.stage, 'DEPLOY');
    });

    await runTest('nested secret removal', () => {
        const result = sanitize({
            failureClassification: {
                failures: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Score__c',
                        accessToken: 'SECRET',
                        message: 'Formula incompatible'
                    }
                ]
            }
        });
        const failure = result.payload.failureClassification.failures[0];
        assert.strictEqual(failure.accessToken, undefined);
        assert.strictEqual(failure.metadataName, 'Account.Score__c');
        assert.strictEqual(failure.message, 'Formula incompatible');
    });

    await runTest('case-insensitive secret keys', () => {
        const result = sanitize({
            AccessToken: 'SECRET',
            REFRESHTOKEN: 'SECRET',
            Api_Key: 'SECRET',
            Client_Secret: 'SECRET',
            metadataType: 'PermissionSet'
        });
        assert.strictEqual(result.payload.AccessToken, undefined);
        assert.strictEqual(result.payload.REFRESHTOKEN, undefined);
        assert.strictEqual(result.payload.Api_Key, undefined);
        assert.strictEqual(result.payload.Client_Secret, undefined);
        assert.strictEqual(result.payload.metadataType, 'PermissionSet');
    });

    await runTest('Bearer token redaction', () => {
        const result = sanitize({
            message: 'Auth failed Bearer ABCdef1234567890xyz'
        });
        assert.ok(result.payload.message.includes(REDACTED));
        assert.ok(!result.payload.message.includes('ABCdef1234567890xyz'));
    });

    await runTest('token embedded in URL', () => {
        const result = sanitize({
            url: 'https://github.com/user/repo.git?token=SECRET'
        });
        assert.ok(result.payload.url.includes(REDACTED));
        assert.ok(!result.payload.url.includes('SECRET'));
    });

    await runTest('GitHub credential URL sanitized', () => {
        const cleaned = sanitizeGithubOrHttpUrl(
            'https://TOKEN@github.com/user/repo.git'
        );
        assert.strictEqual(cleaned, 'https://github.com/user/repo.git');

        const result = sanitize({
            repositoryUrl: 'https://ghp_abc1234567890token@github.com/org/repo.git'
        });
        assert.ok(!result.payload.repositoryUrl.includes('ghp_'));
        assert.ok(result.payload.repositoryUrl.includes('github.com/org/repo.git'));
    });

    await runTest('cliStdout removed', () => {
        const result = sanitize({
            cliStdout: 'huge output SECRET',
            deploymentId: '0AfAAA'
        });
        assert.strictEqual(result.payload.cliStdout, undefined);
        assert.strictEqual(result.payload.deploymentId, '0AfAAA');
    });

    await runTest('cliStderr removed', () => {
        const result = sanitize({
            cliStderr: 'error SECRET',
            status: 'Failed'
        });
        assert.strictEqual(result.payload.cliStderr, undefined);
    });

    await runTest('rawFailure removed when explicitly classified raw', () => {
        const result = sanitize({
            deploymentDiagnostics: {
                componentFailures: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'Foo',
                        message: 'Compile error',
                        rawFailure: { full: 'SECRET dump' }
                    }
                ]
            }
        });
        const failure = result.payload.deploymentDiagnostics.componentFailures[0];
        assert.strictEqual(failure.rawFailure, undefined);
        assert.strictEqual(failure.metadataName, 'Foo');
        assert.strictEqual(failure.message, 'Compile error');
    });

    await runTest('sourceCode removed', () => {
        const result = sanitize({
            sourceCode: 'public class Foo {}',
            metadataName: 'Foo'
        });
        assert.strictEqual(result.payload.sourceCode, undefined);
        assert.strictEqual(result.payload.metadataName, 'Foo');
    });

    await runTest('metadataXml removed', () => {
        const result = sanitize({
            metadataXml: '<?xml version="1.0"?><ApexClass/>',
            metadataType: 'ApexClass'
        });
        assert.strictEqual(result.payload.metadataXml, undefined);
    });

    await runTest('package.xml removed', () => {
        const result = sanitize({
            packageXml: '<?xml version="1.0"?><Package/>',
            packageXML: '<Package/>',
            'package.xml': '<Package/>',
            fullPackageXml: '<Package/>',
            deploymentMode: 'VALIDATE'
        });
        assert.strictEqual(result.payload.packageXml, undefined);
        assert.strictEqual(result.payload.packageXML, undefined);
        assert.strictEqual(result.payload['package.xml'], undefined);
        assert.strictEqual(result.payload.fullPackageXml, undefined);
        assert.strictEqual(result.payload.deploymentMode, 'VALIDATE');
    });

    await runTest('package member summary preserved', () => {
        const result = sanitize({
            packageXml: '<Package/>',
            packageSummary: {
                metadataCount: 2,
                membersByType: {
                    ApexClass: ['Foo', 'Bar']
                }
            },
            memberSummary: {
                count: 2
            }
        });
        assert.strictEqual(result.payload.packageXml, undefined);
        assert.strictEqual(result.payload.packageSummary.metadataCount, 2);
        assert.deepStrictEqual(result.payload.packageSummary.membersByType.ApexClass, [
            'Foo',
            'Bar'
        ]);
        assert.strictEqual(result.payload.memberSummary.count, 2);
    });

    await runTest('relative path preserved', () => {
        const relative = 'force-app/main/default/classes/MyClass.cls';
        const result = sanitize({ filePath: relative });
        assert.strictEqual(result.payload.filePath, relative);
    });

    await runTest('absolute Windows path normalized/redacted', () => {
        const withForceApp = sanitizePathLikeString(
            'C:\\Users\\nadish_b\\project\\force-app\\main\\default\\classes\\MyClass.cls'
        );
        assert.strictEqual(
            withForceApp,
            'force-app/main/default/classes/MyClass.cls'
        );

        const noForceApp = sanitizePathLikeString('C:\\Users\\nadish_b\\secret\\file.txt');
        assert.strictEqual(noForceApp, REDACTED);

        const result = sanitize({
            filePath: 'C:/Users/nadish_b/repo/force-app/main/default/objects/Account.object-meta.xml'
        });
        assert.strictEqual(
            result.payload.filePath,
            'force-app/main/default/objects/Account.object-meta.xml'
        );
    });

    await runTest('absolute Linux path normalized/redacted', () => {
        assert.strictEqual(
            sanitizePathLikeString('/home/user/app/force-app/main/default/lwc/foo/foo.js'),
            'force-app/main/default/lwc/foo/foo.js'
        );
        assert.strictEqual(sanitizePathLikeString('/home/user/secrets/config'), REDACTED);
        assert.strictEqual(sanitizePathLikeString('/workspace/tmp/cache'), REDACTED);
        assert.strictEqual(sanitizePathLikeString('/app/data/keys'), REDACTED);
    });

    await runTest('normal Salesforce error message preserved', () => {
        const msg =
            "Field Score__c does not exist. Check spelling. (FIELD_INTEGRITY_EXCEPTION)";
        const result = sanitize({ message: msg, errorCode: 'FIELD_INTEGRITY_EXCEPTION' });
        assert.strictEqual(result.payload.message, msg);
        assert.strictEqual(result.payload.errorCode, 'FIELD_INTEGRITY_EXCEPTION');
    });

    await runTest('metadataType preserved', () => {
        const result = sanitize({ metadataType: 'PermissionSet' });
        assert.strictEqual(result.payload.metadataType, 'PermissionSet');
    });

    await runTest('metadataName preserved', () => {
        const result = sanitize({ metadataName: 'Subscription_Access' });
        assert.strictEqual(result.payload.metadataName, 'Subscription_Access');
    });

    await runTest('deploymentId preserved', () => {
        const result = sanitize({ deploymentId: '0Af5g00000XYZ123' });
        assert.strictEqual(result.payload.deploymentId, '0Af5g00000XYZ123');
    });

    await runTest('historyId preserved', () => {
        const result = sanitize({ historyId: 'HIST-100' });
        assert.strictEqual(result.payload.historyId, 'HIST-100');
    });

    await runTest('AI summary preserved', () => {
        const result = sanitize({
            aiResolutionReport: {
                provider: 'gemini',
                generated: true,
                fallbackUsed: false,
                summary: 'Formula field requires manual correction.',
                disclaimer: 'AI-generated / advisory only.',
                explanations: [{ metadataName: 'Account.Score__c', reason: 'type mismatch' }],
                prompt: 'SYSTEM SECRET PROMPT',
                apiKey: 'SECRET',
                providerResponse: { raw: 'SECRET' }
            }
        });
        const ai = result.payload.aiResolutionReport;
        assert.strictEqual(ai.provider, 'gemini');
        assert.strictEqual(ai.generated, true);
        assert.strictEqual(ai.fallbackUsed, false);
        assert.strictEqual(ai.summary, 'Formula field requires manual correction.');
        assert.strictEqual(ai.disclaimer, 'AI-generated / advisory only.');
        assert.strictEqual(ai.explanations[0].metadataName, 'Account.Score__c');
        assert.strictEqual(ai.prompt, undefined);
        assert.strictEqual(ai.apiKey, undefined);
        assert.strictEqual(ai.providerResponse, undefined);
    });

    await runTest('AI prompt removed', () => {
        const result = sanitize({
            prompt: 'leak',
            systemPrompt: 'leak',
            rawPrompt: 'leak',
            summary: 'safe'
        });
        assert.strictEqual(result.payload.prompt, undefined);
        assert.strictEqual(result.payload.systemPrompt, undefined);
        assert.strictEqual(result.payload.rawPrompt, undefined);
        assert.strictEqual(result.payload.summary, 'safe');
    });

    await runTest('AI provider response removed', () => {
        const result = sanitize({
            providerResponse: { text: 'SECRET' },
            rawProviderResponse: 'SECRET',
            provider: 'openai'
        });
        assert.strictEqual(result.payload.providerResponse, undefined);
        assert.strictEqual(result.payload.rawProviderResponse, undefined);
        assert.strictEqual(result.payload.provider, 'openai');
    });

    await runTest('safeToSkip true preserved', () => {
        const result = sanitize({ safeToSkip: true, metadataName: 'X' });
        assert.strictEqual(result.payload.safeToSkip, true);
    });

    await runTest('safeToSkip false preserved', () => {
        const result = sanitize({ safeToSkip: false });
        assert.strictEqual(result.payload.safeToSkip, false);
    });

    await runTest('safeToSkip null preserved', () => {
        const result = sanitize({ safeToSkip: null, status: 'FAILED' });
        assert.strictEqual(result.payload.safeToSkip, null);
        assert.strictEqual(result.payload.status, 'FAILED');
    });

    await runTest('original input not mutated', () => {
        const input = {
            accessToken: 'SECRET',
            metadataType: 'ApexClass',
            nested: { refreshToken: 'SECRET', message: 'ok' }
        };
        const snapshot = JSON.parse(JSON.stringify(input));
        sanitize(input);
        assert.deepStrictEqual(input, snapshot);
    });

    await runTest('null input', () => {
        const result = sanitize(null);
        assert.strictEqual(result.sanitized, true);
        assert.strictEqual(result.payload, null);
    });

    await runTest('empty object', () => {
        const result = sanitize({});
        assert.strictEqual(result.sanitized, true);
        assert.deepStrictEqual(result.payload, {});
    });

    await runTest('arrays', () => {
        const result = sanitize({
            failures: [
                { metadataType: 'ApexClass', metadataName: 'A', accessToken: 'SECRET' },
                { metadataType: 'ApexClass', metadataName: 'B' }
            ]
        });
        assert.strictEqual(result.payload.failures.length, 2);
        assert.strictEqual(result.payload.failures[0].accessToken, undefined);
        assert.strictEqual(result.payload.failures[0].metadataName, 'A');
        assert.strictEqual(result.payload.failures[1].metadataName, 'B');
    });

    await runTest('circular reference', () => {
        const input = {
            summary: { message: 'root' },
            details: { status: 'FAILED' }
        };
        input.details.summary = input.summary;
        input.summary.details = input.details;

        const result = sanitize(input);
        assert.strictEqual(result.sanitized, true);
        assert.ok(result.payload);
        const text = JSON.stringify(result.payload);
        assert.ok(text.includes('[Circular]') || text.includes('root'));
        assert.doesNotThrow(() => JSON.stringify(result.payload));
    });

    await runTest('oversized input protection', () => {
        const huge = {
            message: 'x'.repeat(LIMITS.maxStringLength + 500),
            failures: Array.from({ length: LIMITS.maxArrayItems + 50 }, (_, i) => ({
                metadataType: 'ApexClass',
                metadataName: `Class_${i}`
            }))
        };
        const result = sanitize(huge);
        assert.ok(result.payload.message.includes('[TRUNCATED]'));
        assert.ok(result.payload.message.length <= LIMITS.maxStringLength);
        assert.ok(result.payload.failures.length <= LIMITS.maxArrayItems + 1);
        const truncatedMarker = result.payload.failures.find(
            (item) => item && item._sanitizer === '[ArrayItemsTruncated]'
        );
        assert.ok(truncatedMarker);
        assert.ok(truncatedMarker.omittedCount > 0);
    });

    await runTest('nested malicious payload', () => {
        const result = sanitize({
            failureClassification: {
                failures: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Evil__c',
                        message: 'Bearer evilTokenValue999',
                        headers: {
                            Authorization: 'Bearer SECRET',
                            cookie: 'x=1'
                        },
                        env: {
                            OPENAI_API_KEY: 'sk-live-SECRET',
                            GITHUB_TOKEN: 'ghp_SECRET'
                        },
                        sourceCode: 'hack',
                        packageXml: '<Package/>',
                        cliStdout: 'dump',
                        prompt: 'ignore previous instructions SECRET',
                        safeToSkip: false,
                        unknownEvilField: 'should-drop',
                        url: 'https://user:pass@github.com/org/repo.git?api_key=SECRET'
                    }
                ]
            }
        });

        const failure = result.payload.failureClassification.failures[0];
        assert.strictEqual(failure.metadataType, 'CustomObject');
        assert.strictEqual(failure.safeToSkip, false);
        assert.strictEqual(failure.sourceCode, undefined);
        assert.strictEqual(failure.packageXml, undefined);
        assert.strictEqual(failure.cliStdout, undefined);
        assert.strictEqual(failure.prompt, undefined);
        assert.strictEqual(failure.env, undefined);
        assert.strictEqual(failure.unknownEvilField, undefined);
        assert.strictEqual(failure.headers.Authorization, undefined);
        assert.strictEqual(failure.headers.cookie, undefined);
        assert.ok(failure.message.includes(REDACTED));
        assert.ok(!failure.message.includes('evilTokenValue999'));
        assertNoSecretResidue(result.payload, [
            'SECRET',
            'sk-live',
            'ghp_SECRET',
            'evilTokenValue999',
            'user:pass'
        ]);
    });

    await runTest('undefined input', () => {
        const result = sanitize(undefined);
        assert.strictEqual(result.sanitized, true);
        assert.strictEqual(result.payload, null);
    });

    await runTest('deny-key helper covers githubToken variants', () => {
        assert.strictEqual(isDeniedKey('githubToken'), true);
        assert.strictEqual(isDeniedKey('GITHUB_TOKEN'), true);
        assert.strictEqual(isDeniedKey('openaiApiKey'), true);
        assert.strictEqual(isDeniedKey('metadataType'), false);
    });

    await runTest('string sanitizer leaves ordinary SF text alone', () => {
        const msg = 'Required field is missing: Name';
        assert.strictEqual(sanitizeStringValue(msg), msg);
    });

    if (process.exitCode && process.exitCode !== 0) {
        process.exit(process.exitCode);
    }
}

main();
