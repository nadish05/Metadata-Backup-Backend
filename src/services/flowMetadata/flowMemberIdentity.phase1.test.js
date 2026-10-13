'use strict';

const assert = require('assert');

const {
    parseVersionQualifiedFlowMember,
    buildCanonicalFlowArtifactRelativePath,
    parseFlowArtifactBasename,
    enrichFlowMetadataItem,
    getFlowMetadataUniquenessKey
} = require('./flowMemberIdentity.service');

const {
    getMetadataUniquenessKey,
    normalizeMetadata,
    generateDeploymentPackage
} = require('../deploymentPackage.service');

const {
    validateFlowDeploymentSelections,
    FLOW_MULTIPLE_VERSIONS_CODE
} = require('./deploymentFlowPackage.service');
const { generateManifest } = require('../packageXml.service');

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

runTest('parseVersionQualifiedFlowMember distinguishes versioned names', () => {
    const v2 = parseVersionQualifiedFlowMember('Get_Customer_Details-2');

    assert.strictEqual(v2.definitionDeveloperName, 'Get_Customer_Details');
    assert.strictEqual(v2.sourceVersionNumber, 2);
    assert.strictEqual(v2.isVersionQualified, true);

    const legacy = parseVersionQualifiedFlowMember('Get_Customer_Details');

    assert.strictEqual(legacy.isVersionQualified, false);
    assert.strictEqual(legacy.sourceVersionNumber, null);
});

runTest('canonical artifact paths are version-specific', () => {
    assert.strictEqual(
        buildCanonicalFlowArtifactRelativePath('Get_Customer_Details-1'),
        'force-app/main/default/flows/Get_Customer_Details-1.flow-meta.xml'
    );
    assert.strictEqual(
        buildCanonicalFlowArtifactRelativePath('Get_Customer_Details-2'),
        'force-app/main/default/flows/Get_Customer_Details-2.flow-meta.xml'
    );
});

runTest('parseFlowArtifactBasename does not infer version from unversioned file', () => {
    const parsed = parseFlowArtifactBasename(
        'force-app/main/default/flows/Get_Customer_Details.flow-meta.xml'
    );

    assert.strictEqual(parsed.isVersionQualified, false);
    assert.strictEqual(parsed.sourceVersionNumber, null);
});

runTest('two Flow versions do not deduplicate in package generation', () => {
    const generated = generateDeploymentPackage({
        selectedMetadata: [
            {
                metadataType: 'Flow',
                metadataName: 'Get_Customer_Details-1',
                filePath:
                    'force-app/main/default/flows/Get_Customer_Details-1.flow-meta.xml'
            },
            {
                metadataType: 'Flow',
                metadataName: 'Get_Customer_Details-2',
                filePath:
                    'force-app/main/default/flows/Get_Customer_Details-2.flow-meta.xml'
            }
        ]
    });

    assert.strictEqual(generated.metadata.length, 2);
    assert.ok(
        generated.metadata.some(
            (item) => item.metadataName === 'Get_Customer_Details-1'
        )
    );
    assert.ok(
        generated.metadata.some(
            (item) => item.metadataName === 'Get_Customer_Details-2'
        )
    );
});

runTest('multi-version same definition deployment is blocked', () => {
    const result = validateFlowDeploymentSelections([
        { metadataType: 'Flow', metadataName: 'Get_Customer_Details-1' },
        { metadataType: 'Flow', metadataName: 'Get_Customer_Details-2' }
    ]);

    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.code, FLOW_MULTIPLE_VERSIONS_CODE);
});

runTest('single version selection remains valid', () => {
    const result = validateFlowDeploymentSelections([
        { metadataType: 'Flow', metadataName: 'Get_Customer_Details-2' }
    ]);

    assert.strictEqual(result.ok, true);
});

runTest('package XML preserves version-qualified Flow member', () => {
    const generated = generateDeploymentPackage({
        selectedMetadata: [
            {
                metadataType: 'Flow',
                metadataName: 'Get_Customer_Details-2'
            }
        ]
    });
    const manifest = generateManifest(generated, {
        deploymentApiVersion: '61.0'
    });

    assert.ok(
        manifest.packageXml.includes(
            '<members>Get_Customer_Details-2</members>'
        )
    );
});

runTest('Flow uniqueness keys include version suffix', () => {
    const key1 = getMetadataUniquenessKey({
        metadataType: 'Flow',
        metadataName: 'Get_Customer_Details-1'
    });
    const key2 = getMetadataUniquenessKey({
        metadataType: 'Flow',
        metadataName: 'Get_Customer_Details-2'
    });

    assert.notStrictEqual(key1, key2);
    assert.strictEqual(key1, 'Flow:Get_Customer_Details-1');
});
