/**
 * P0-6 — Custom Metadata parent origin enables full CustomObject field enumeration.
 */

const assert = require('assert');

const customMetadataParentDiscoverer = require('./customMetadataParent.discoverer');
const { getRegisteredDiscoverers } = require('../relationshipRegistry');
const {
    discoverUntilStable
} = require('../relationshipDiscovery.service');
const {
    METADATA_ORIGINS,
    shouldEnumerateCustomObjectChildren
} = require('../metadataGraphOrigin.model');
const {
    reviewDeployableMetadataItems
} = require('../../deploymentReview.service');
const { classifyDependency } = require('../dependencyClassification.service');
const {
    generateDeploymentPackage
} = require('../../deploymentPackage.service');
const genericFileArtifactResolver = require('../../repositoryArtifacts/resolvers/genericFile.resolver');
const { enrichNode } = require('../../repositoryArtifacts/artifactResolution.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function customMetadataItem(name) {
    return {
        metadataType: 'CustomMetadata',
        type: 'CustomMetadata',
        metadataName: name,
        name
    };
}

const PARENT_OBJECT_PATH =
    'force-app/main/default/objects/Weather_Config__mdt/Weather_Config__mdt.object-meta.xml';
const API_KEY_FIELD_PATH =
    'force-app/main/default/objects/Weather_Config__mdt/fields/api_key__c.field-meta.xml';
const REGION_FIELD_PATH =
    'force-app/main/default/objects/Weather_Config__mdt/fields/Region__c.field-meta.xml';
const CM_DEFAULT_PATH =
    'force-app/main/default/customMetadata/Weather_Config.Default.md-meta.xml';
const CM_PRODUCTION_PATH =
    'force-app/main/default/customMetadata/Weather_Config.Production.md-meta.xml';
const CM_TEST_PATH =
    'force-app/main/default/customMetadata/Weather_Config.Test.md-meta.xml';

const SESSION_OBJECT_PATH =
    'force-app/main/default/objects/Session__c/Session__c.object-meta.xml';
const SESSION_FIELD_PATH =
    'force-app/main/default/objects/Session__c/fields/Price__c.field-meta.xml';

const CMDT_REPO_FILES = [
    PARENT_OBJECT_PATH,
    API_KEY_FIELD_PATH,
    REGION_FIELD_PATH,
    CM_DEFAULT_PATH,
    CM_PRODUCTION_PATH,
    CM_TEST_PATH
];

const OBJECT_META_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Weather Config</label>
    <pluralLabel>Weather Configs</pluralLabel>
    <visibility>Public</visibility>
</CustomObject>`;

async function readRepoFile(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/');

    if (normalized.endsWith('.object-meta.xml')) {
        return OBJECT_META_XML;
    }

    if (normalized.endsWith('.field-meta.xml')) {
        return `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>placeholder</fullName>
    <type>Text</type>
    <length>255</length>
</CustomField>`;
    }

    return '';
}

function customFieldNames(relationships) {
    return (relationships || [])
        .filter((item) => (item.metadataType || item.type) === 'CustomField')
        .map((item) => item.name)
        .sort();
}

function customObjectNames(relationships) {
    return (relationships || [])
        .filter((item) => (item.metadataType || item.type) === 'CustomObject')
        .map((item) => item.name)
        .sort();
}

async function main() {
    await runTest(
        'gate: CUSTOM_METADATA_PARENT enumerates; RELATIONSHIP_TARGET does not',
        () => {
            assert.strictEqual(
                shouldEnumerateCustomObjectChildren(
                    METADATA_ORIGINS.CUSTOM_METADATA_PARENT
                ),
                true
            );
            assert.strictEqual(
                shouldEnumerateCustomObjectChildren(
                    METADATA_ORIGINS.RELATIONSHIP_TARGET
                ),
                false
            );
            assert.strictEqual(
                shouldEnumerateCustomObjectChildren(
                    METADATA_ORIGINS.PRIMARY_SELECTION
                ),
                true
            );
        }
    );

    await runTest(
        'TEST 1: CMDT parent enumerates CustomField:Weather_Config__mdt.api_key__c',
        async () => {
            const parentResult = await customMetadataParentDiscoverer.discover({
                selectedMetadata: [customMetadataItem('Weather_Config.Default')]
            });

            assert.strictEqual(parentResult.relationships.length, 1);
            assert.strictEqual(
                parentResult.relationships[0].origin,
                METADATA_ORIGINS.CUSTOM_METADATA_PARENT
            );
            assert.strictEqual(
                parentResult.relationships[0].name,
                'Weather_Config__mdt'
            );

            const expansion = await discoverUntilStable({
                selectedMetadata: [customMetadataItem('Weather_Config.Default')],
                expandableDependencies: [],
                discoverers: getRegisteredDiscoverers(),
                repoFiles: CMDT_REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => CMDT_REPO_FILES
            });

            assert.deepStrictEqual(customObjectNames(expansion.relationships), [
                'Weather_Config__mdt'
            ]);

            const parent = expansion.relationships.find(
                (item) => item.name === 'Weather_Config__mdt'
            );
            assert.strictEqual(
                parent.origin,
                METADATA_ORIGINS.CUSTOM_METADATA_PARENT
            );

            const fields = customFieldNames(expansion.relationships);
            assert.ok(
                fields.includes('Weather_Config__mdt.api_key__c'),
                `Expected api_key__c, got: ${fields.join(', ')}`
            );
            assert.ok(fields.includes('Weather_Config__mdt.Region__c'));
        }
    );

    await runTest(
        'TEST 2: multiple CMDT records dedupe parent and fields',
        async () => {
            const expansion = await discoverUntilStable({
                selectedMetadata: [
                    customMetadataItem('Weather_Config.Default'),
                    customMetadataItem('Weather_Config.Production'),
                    customMetadataItem('Weather_Config.Test')
                ],
                expandableDependencies: [],
                discoverers: getRegisteredDiscoverers(),
                repoFiles: CMDT_REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => CMDT_REPO_FILES
            });

            assert.deepStrictEqual(customObjectNames(expansion.relationships), [
                'Weather_Config__mdt'
            ]);

            const apiKeyFields = expansion.relationships.filter(
                (item) => item.name === 'Weather_Config__mdt.api_key__c'
            );
            assert.strictEqual(apiKeyFields.length, 1);
        }
    );

    await runTest(
        'TEST 3: normal RELATIONSHIP_TARGET remains RELATIONSHIP_ONLY',
        async () => {
            const result = await reviewDeployableMetadataItems({
                items: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Session__c',
                        filePath: SESSION_OBJECT_PATH,
                        origin: METADATA_ORIGINS.RELATIONSHIP_TARGET
                    }
                ],
                readRepoFile,
                listRepoFiles: async () => [
                    SESSION_OBJECT_PATH,
                    SESSION_FIELD_PATH
                ],
                defaultOrigin: METADATA_ORIGINS.RELATIONSHIP_TARGET
            });

            assert.strictEqual(
                result.deploymentReview[0].reviewStrategy,
                'RELATIONSHIP_ONLY'
            );
            assert.deepStrictEqual(result.requiredDependencies, []);
            assert.ok(
                !customFieldNames(result.requiredDependencies).includes(
                    'Session__c.Price__c'
                )
            );
        }
    );

    await runTest(
        'TEST 4: PRIMARY_SELECTION CustomObject still enumerates fields',
        async () => {
            const result = await reviewDeployableMetadataItems({
                items: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Session__c',
                        filePath: SESSION_OBJECT_PATH,
                        origin: METADATA_ORIGINS.PRIMARY_SELECTION
                    }
                ],
                readRepoFile,
                listRepoFiles: async () => [
                    SESSION_OBJECT_PATH,
                    SESSION_FIELD_PATH
                ],
                defaultOrigin: METADATA_ORIGINS.PRIMARY_SELECTION
            });

            assert.strictEqual(
                result.deploymentReview[0].reviewStrategy,
                'FULL_OBJECT'
            );
            assert.ok(
                customFieldNames(result.requiredDependencies).includes(
                    'Session__c.Price__c'
                )
            );
        }
    );

    await runTest(
        'TEST 5 P0-5 regression: CustomMetadata → CustomObject parent',
        async () => {
            const result = await customMetadataParentDiscoverer.discover({
                selectedMetadata: [customMetadataItem('Weather_Config.Default')]
            });

            assert.deepStrictEqual(
                result.relationships.map((item) => item.name),
                ['Weather_Config__mdt']
            );
            assert.strictEqual(
                result.relationships[0].origin,
                METADATA_ORIGINS.CUSTOM_METADATA_PARENT
            );
        }
    );

    await runTest(
        'TEST 6 P0-4 regression: Weather_Config.Default artifact path',
        () => {
            const resolved = genericFileArtifactResolver.resolve({
                name: 'Weather_Config.Default',
                metadataType: 'CustomMetadata',
                repoFiles: [CM_DEFAULT_PATH]
            });

            assert.strictEqual(resolved, CM_DEFAULT_PATH);

            const enriched = enrichNode(
                {
                    metadataType: 'CustomMetadata',
                    name: 'Weather_Config.Default',
                    metadataName: 'Weather_Config.Default'
                },
                [CM_DEFAULT_PATH]
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(enriched.name, 'Weather_Config.Default');
        }
    );

    await runTest(
        'E2E: api_key__c reaches generated deployment package',
        async () => {
            const expansion = await discoverUntilStable({
                selectedMetadata: [customMetadataItem('Weather_Config.Default')],
                expandableDependencies: [],
                discoverers: getRegisteredDiscoverers(),
                repoFiles: CMDT_REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => CMDT_REPO_FILES
            });

            const requiredDependencies = expansion.relationships.map(
                (item) => ({
                    type: item.metadataType || item.type,
                    name: item.name,
                    required: item.required !== false,
                    selected: item.selected !== false,
                    origin: item.origin
                })
            );

            for (const dependency of requiredDependencies) {
                const classified = classifyDependency(dependency);
                assert.strictEqual(
                    classified.classification,
                    'DEPLOYABLE_METADATA',
                    `${dependency.type}:${dependency.name} should be deployable`
                );
            }

            const generated = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'CustomMetadata',
                        metadataName: 'Weather_Config.Default'
                    }
                ],
                requiredDependencies
            });

            const keys = generated.metadata
                .map((item) => `${item.metadataType}:${item.metadataName}`)
                .sort();

            assert.ok(keys.includes('CustomMetadata:Weather_Config.Default'));
            assert.ok(keys.includes('CustomObject:Weather_Config__mdt'));
            assert.ok(
                keys.includes('CustomField:Weather_Config__mdt.api_key__c'),
                `Expected api_key__c in package metadata, got: ${keys.join(', ')}`
            );
        }
    );

    await runTest(
        'artifact safety: missing field file is not invented',
        async () => {
            const repoWithoutApiKey = [
                PARENT_OBJECT_PATH,
                REGION_FIELD_PATH,
                CM_DEFAULT_PATH
            ];

            const expansion = await discoverUntilStable({
                selectedMetadata: [customMetadataItem('Weather_Config.Default')],
                expandableDependencies: [],
                discoverers: getRegisteredDiscoverers(),
                repoFiles: repoWithoutApiKey,
                readRepoFile,
                listRepoFiles: async () => repoWithoutApiKey
            });

            const fields = customFieldNames(expansion.relationships);
            assert.ok(!fields.includes('Weather_Config__mdt.api_key__c'));
            assert.ok(fields.includes('Weather_Config__mdt.Region__c'));
        }
    );
}

main();
