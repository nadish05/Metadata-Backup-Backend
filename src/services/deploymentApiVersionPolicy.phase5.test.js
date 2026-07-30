const assert = require('assert');

const { DEFAULT_API_VERSION } = require('../config/salesforce');
const {
    resolveDeploymentApiVersionPolicy,
    collectEmbeddedApiVersions,
    extractEmbeddedApiVersionFromXml
} = require('./deploymentApiVersionPolicy.service');
const { generateManifest } = require('./packageXml.service');
const {
    evaluateDeploymentReadiness
} = require('./deploymentReadiness.service');

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

runTest('Case 1: Only Apex 61 → deploy DEFAULT/61', () => {
    const policy = resolveDeploymentApiVersionPolicy({
        embeddedApiVersions: [
            {
                metadataType: 'ApexClass',
                metadataName: 'InvoiceService',
                apiVersion: '61.0'
            }
        ],
        defaultApiVersion: '61.0',
        destinationMaxApiVersion: '64.0'
    });

    assert.strictEqual(policy.deploymentApiVersion, '61.0');
    assert.strictEqual(policy.compatible, true);
    assert.strictEqual(policy.policy, 'HIGHEST_REQUIRED');
});

runTest('Case 2: Flow 63 → deploy 63', () => {
    const policy = resolveDeploymentApiVersionPolicy({
        embeddedApiVersions: [
            {
                metadataType: 'Flow',
                metadataName: 'Invoice_Orchestrator',
                apiVersion: '63.0'
            }
        ],
        defaultApiVersion: '61.0',
        destinationMaxApiVersion: '64.0'
    });

    assert.strictEqual(policy.deploymentApiVersion, '63.0');
    assert.strictEqual(policy.compatible, true);
});

runTest('Case 3: Flow 63 / destination 62 → incompatible', () => {
    const policy = resolveDeploymentApiVersionPolicy({
        embeddedApiVersions: [
            {
                metadataType: 'Flow',
                metadataName: 'Invoice_Orchestrator',
                apiVersion: '63.0'
            }
        ],
        defaultApiVersion: '61.0',
        destinationMaxApiVersion: '62.0'
    });

    assert.strictEqual(policy.compatible, false);
    assert.strictEqual(policy.deploymentApiVersion, '63.0');
    assert.match(
        policy.reason,
        /requires API 63\.0 but destination org supports only 62\.0/
    );
});

runTest('Case 4: Mixed Apex 61 + Flow 63 + FlexiPage 62 → deploy 63', () => {
    const policy = resolveDeploymentApiVersionPolicy({
        embeddedApiVersions: [
            {
                metadataType: 'ApexClass',
                metadataName: 'InvoiceService',
                apiVersion: '61.0'
            },
            {
                metadataType: 'Flow',
                metadataName: 'Invoice_Orchestrator',
                apiVersion: '63.0'
            },
            {
                metadataType: 'FlexiPage',
                metadataName: 'Invoice_Record_Page',
                apiVersion: '62.0'
            }
        ],
        defaultApiVersion: '61.0',
        destinationMaxApiVersion: '64.0'
    });

    assert.strictEqual(policy.deploymentApiVersion, '63.0');
    assert.strictEqual(policy.compatible, true);
});

runTest('Case 5: No embedded version → DEFAULT_API_VERSION', () => {
    const policy = resolveDeploymentApiVersionPolicy({
        embeddedApiVersions: [],
        defaultApiVersion: DEFAULT_API_VERSION,
        destinationMaxApiVersion: '64.0'
    });

    assert.strictEqual(policy.deploymentApiVersion, DEFAULT_API_VERSION);
    assert.strictEqual(policy.compatible, true);
});

runTest('Never downgrade below DEFAULT when payload is older', () => {
    const policy = resolveDeploymentApiVersionPolicy({
        embeddedApiVersions: [
            {
                metadataType: 'ApexClass',
                metadataName: 'LegacyClass',
                apiVersion: '58.0'
            }
        ],
        defaultApiVersion: '61.0',
        destinationMaxApiVersion: '64.0'
    });

    assert.strictEqual(policy.deploymentApiVersion, '61.0');
});

runTest('Reuses Flow XML apiVersion extraction', () => {
    const version = extractEmbeddedApiVersionFromXml(
        'Flow',
        `<?xml version="1.0"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <apiVersion>63.0</apiVersion>
    <areMetricsLoggedToDataCloud>false</areMetricsLoggedToDataCloud>
</Flow>`
    );

    assert.strictEqual(version, '63.0');
});

runTest('collectEmbeddedApiVersions reads apiValidation from Review DTO', () => {
    const collected = collectEmbeddedApiVersions([
        {
            metadataType: 'Flow',
            metadataName: 'Invoice_Orchestrator',
            apiValidation: { apiVersion: '63.0', supported: true }
        }
    ]);

    assert.strictEqual(collected.length, 1);
    assert.strictEqual(collected[0].apiVersion, '63.0');
});

runTest('generateManifest writes policy version into package.xml', () => {
    const policy = resolveDeploymentApiVersionPolicy({
        embeddedApiVersions: [
            {
                metadataType: 'Flow',
                metadataName: 'Invoice_Orchestrator',
                apiVersion: '63.0'
            }
        ],
        defaultApiVersion: '61.0',
        destinationMaxApiVersion: '64.0'
    });

    const manifest = generateManifest(
        {
            metadata: [
                {
                    metadataType: 'Flow',
                    metadataName: 'Invoice_Orchestrator'
                }
            ]
        },
        {
            deploymentApiVersion: policy.deploymentApiVersion,
            deploymentApiVersionPolicy: policy
        }
    );

    assert.match(manifest.packageXml, /<version>63\.0<\/version>/);
    assert.strictEqual(manifest.summary.apiVersion, '63.0');
    assert.strictEqual(
        manifest.deploymentApiVersionPolicy.deploymentApiVersion,
        '63.0'
    );
});

runTest('Readiness blocks when API version policy is incompatible', () => {
    const policy = resolveDeploymentApiVersionPolicy({
        embeddedApiVersions: [
            {
                metadataType: 'Flow',
                metadataName: 'Invoice_Orchestrator',
                apiVersion: '63.0'
            }
        ],
        defaultApiVersion: '61.0',
        destinationMaxApiVersion: '62.0'
    });

    const readiness = evaluateDeploymentReadiness({
        deploymentValidation: { status: 'PASS' },
        metadataValidation: { overallStatus: 'PASS', results: [] },
        dependencyValidation: { overallStatus: 'PASS', results: [] },
        deploymentApiVersionPolicy: policy
    });

    assert.strictEqual(readiness.canDeploy, false);
    assert.strictEqual(readiness.overallStatus, 'BLOCKED');
    assert.ok(
        readiness.blockingIssues.some((issue) =>
            String(issue).includes('requires API 63.0')
        )
    );
});
