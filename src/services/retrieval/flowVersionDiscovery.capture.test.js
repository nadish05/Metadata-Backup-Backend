'use strict';

const assert = require('assert');

const {
    FLOW_CAPTURE_VERSION_OUTCOME,
    resolveVersionQualifiedFlowCaptureState
} = require('./flowVersionDiscovery.service');

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

(async () => {
    await runTest('unversioned Flow defers to inventory-only capture', async () => {
        const result = await resolveVersionQualifiedFlowCaptureState({
            metadataName: 'My_Flow',
            instanceUrl: 'https://example.com',
            accessToken: 'token',
            discoverFlowVersionsFn: async () => {
                throw new Error('should not be called');
            }
        });

        assert.strictEqual(
            result.outcome,
            FLOW_CAPTURE_VERSION_OUTCOME.NOT_VERSION_QUALIFIED
        );
    });

    await runTest('exact version present on destination', async () => {
        const result = await resolveVersionQualifiedFlowCaptureState({
            metadataName: 'Check_Amount-4',
            instanceUrl: 'https://example.com',
            accessToken: 'token',
            discoverFlowVersionsFn: async () => ({
                definitions: [{ developerName: 'Check_Amount' }],
                versions: [
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 4
                    }
                ]
            })
        });

        assert.strictEqual(
            result.outcome,
            FLOW_CAPTURE_VERSION_OUTCOME.VERSION_PRESENT
        );
    });

    await runTest('definition present but requested version absent', async () => {
        const result = await resolveVersionQualifiedFlowCaptureState({
            metadataName: 'Check_Amount-4',
            instanceUrl: 'https://example.com',
            accessToken: 'token',
            discoverFlowVersionsFn: async () => ({
                definitions: [{ developerName: 'Check_Amount' }],
                versions: [
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 1
                    }
                ]
            })
        });

        assert.strictEqual(
            result.outcome,
            FLOW_CAPTURE_VERSION_OUTCOME.VERSION_ABSENT
        );
    });

    await runTest('definition absent on destination', async () => {
        const result = await resolveVersionQualifiedFlowCaptureState({
            metadataName: 'Check_Amount-4',
            instanceUrl: 'https://example.com',
            accessToken: 'token',
            discoverFlowVersionsFn: async () => ({
                definitions: [],
                versions: []
            })
        });

        assert.strictEqual(
            result.outcome,
            FLOW_CAPTURE_VERSION_OUTCOME.DEFINITION_ABSENT
        );
    });

    await runTest('Tooling discovery failure is fail-closed', async () => {
        const result = await resolveVersionQualifiedFlowCaptureState({
            metadataName: 'Check_Amount-4',
            instanceUrl: 'https://example.com',
            accessToken: 'token',
            discoverFlowVersionsFn: async () => {
                throw new Error('tooling unavailable');
            }
        });

        assert.strictEqual(
            result.outcome,
            FLOW_CAPTURE_VERSION_OUTCOME.TOOLING_FAILED
        );
    });
})();
