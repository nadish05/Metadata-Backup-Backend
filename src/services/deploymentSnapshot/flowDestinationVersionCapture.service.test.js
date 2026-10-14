'use strict';

const assert = require('assert');

const {
    FLOW_DESTINATION_CAPTURE_OUTCOME,
    resolveFlowDestinationVersionForCapture
} = require('./flowDestinationVersionCapture.service');

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
    await runTest('unversioned Flow member defers to standard capture path', async () => {
        const result = await resolveFlowDestinationVersionForCapture({
            metadataName: 'My_Flow',
            instanceUrl: 'https://example.com',
            accessToken: 'token',
            discoverFlowVersionsFn: async () => {
                throw new Error('should not be called');
            }
        });

        assert.strictEqual(result.outcome, FLOW_DESTINATION_CAPTURE_OUTCOME.UNVERSIONED);
    });

    await runTest('exact version present on destination', async () => {
        const result = await resolveFlowDestinationVersionForCapture({
            metadataName: 'Check_Amount-4',
            instanceUrl: 'https://example.com',
            accessToken: 'token',
            discoverFlowVersionsFn: async () => ({
                definitions: [{ developerName: 'Check_Amount' }],
                versions: [
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 4,
                        sourceFlowVersionId: '301xx'
                    }
                ]
            })
        });

        assert.strictEqual(
            result.outcome,
            FLOW_DESTINATION_CAPTURE_OUTCOME.VERSION_PRESENT
        );
        assert.strictEqual(result.requestedVersion, 4);
    });

    await runTest('definition present but requested version absent', async () => {
        const result = await resolveFlowDestinationVersionForCapture({
            metadataName: 'Check_Amount-4',
            instanceUrl: 'https://example.com',
            accessToken: 'token',
            discoverFlowVersionsFn: async () => ({
                definitions: [{ developerName: 'Check_Amount' }],
                versions: [
                    {
                        flowDefinitionDeveloperName: 'Check_Amount',
                        sourceFlowVersionNumber: 1,
                        sourceFlowVersionId: '301xx'
                    }
                ]
            })
        });

        assert.strictEqual(
            result.outcome,
            FLOW_DESTINATION_CAPTURE_OUTCOME.VERSION_ABSENT_DEFINITION_PRESENT
        );
    });

    await runTest('definition absent on destination', async () => {
        const result = await resolveFlowDestinationVersionForCapture({
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
            FLOW_DESTINATION_CAPTURE_OUTCOME.DEFINITION_ABSENT
        );
    });

    await runTest('Tooling discovery failure is fail-closed', async () => {
        const result = await resolveFlowDestinationVersionForCapture({
            metadataName: 'Check_Amount-4',
            instanceUrl: 'https://example.com',
            accessToken: 'token',
            discoverFlowVersionsFn: async () => {
                throw new Error('tooling unavailable');
            }
        });

        assert.strictEqual(
            result.outcome,
            FLOW_DESTINATION_CAPTURE_OUTCOME.TOOLING_FAILED
        );
    });
})();
