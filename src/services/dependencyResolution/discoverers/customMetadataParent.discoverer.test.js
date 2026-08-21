/**
 * P0-5 — CustomMetadata record → parent Custom Metadata Type (CustomObject:Type__mdt).
 */

const assert = require('assert');

const customMetadataParentDiscoverer = require('./customMetadataParent.discoverer');
const { getRegisteredDiscoverers } = require('../relationshipRegistry');
const {
    discoverUntilStable,
    EXPANDABLE_DEPENDENCY_TYPES
} = require('../relationshipDiscovery.service');
const { classifyDependency } = require('../dependencyClassification.service');
const {
    generateDeploymentPackage
} = require('../../deploymentPackage.service');
const customObjectArtifactResolver = require('../../repositoryArtifacts/resolvers/customObject.resolver');
const genericFileArtifactResolver = require('../../repositoryArtifacts/resolvers/genericFile.resolver');
const { enrichNode } = require('../../repositoryArtifacts/artifactResolution.service');
const { METADATA_TYPE_RULES } = require('../../../config/metadataTypes');

const {
    deriveCustomMetadataParentObjectName
} = customMetadataParentDiscoverer;

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

function parentCustomObjectKeys(relationships) {
    return (relationships || [])
        .filter(
            (item) =>
                (item.metadataType || item.type) === 'CustomObject' &&
                String(item.name || '').endsWith('__mdt')
        )
        .map((item) => `CustomObject:${item.name}`)
        .sort();
}

const PARENT_OBJECT_PATH =
    'force-app/main/default/objects/Weather_Config__mdt/Weather_Config__mdt.object-meta.xml';
const CM_DEFAULT_PATH =
    'force-app/main/default/customMetadata/Weather_Config.Default.md-meta.xml';
const CM_SUFFIX = METADATA_TYPE_RULES.CustomMetadata.extension;

async function main() {
    await runTest(
        'TEST 1: Weather_Config.Default → CustomObject:Weather_Config__mdt',
        async () => {
            const result = await customMetadataParentDiscoverer.discover({
                selectedMetadata: [customMetadataItem('Weather_Config.Default')]
            });

            assert.deepStrictEqual(parentCustomObjectKeys(result.relationships), [
                'CustomObject:Weather_Config__mdt'
            ]);
            assert.strictEqual(result.relationships[0].required, true);
            assert.strictEqual(result.relationships[0].selected, true);
            assert.strictEqual(
                result.relationships[0].discoveredBy,
                'CustomMetadataParentDiscoverer'
            );
            assert.strictEqual(
                result.relationships[0].origin,
                'CUSTOM_METADATA_PARENT'
            );
        }
    );

    await runTest(
        'TEST 2: Weather_Config.Production → CustomObject:Weather_Config__mdt',
        async () => {
            const result = await customMetadataParentDiscoverer.discover({
                selectedMetadata: [
                    customMetadataItem('Weather_Config.Production')
                ]
            });

            assert.deepStrictEqual(parentCustomObjectKeys(result.relationships), [
                'CustomObject:Weather_Config__mdt'
            ]);
        }
    );

    await runTest(
        'TEST 3: multiple records → exactly one parent CustomObject',
        async () => {
            const result = await customMetadataParentDiscoverer.discover({
                selectedMetadata: [
                    customMetadataItem('Weather_Config.Default'),
                    customMetadataItem('Weather_Config.Production'),
                    customMetadataItem('Weather_Config.Test')
                ]
            });

            assert.deepStrictEqual(parentCustomObjectKeys(result.relationships), [
                'CustomObject:Weather_Config__mdt'
            ]);
            assert.strictEqual(result.relationships.length, 1);
        }
    );

    await runTest(
        'TEST 4: existing parent from another path is not duplicated',
        async () => {
            const expansion = await discoverUntilStable({
                selectedMetadata: [customMetadataItem('Weather_Config.Default')],
                expandableDependencies: [
                    {
                        type: 'CustomObject',
                        metadataType: 'CustomObject',
                        name: 'Weather_Config__mdt',
                        metadataName: 'Weather_Config__mdt',
                        required: true,
                        selected: true
                    }
                ],
                discoverers: getRegisteredDiscoverers(),
                repoFiles: [],
                readRepoFile: async () => '',
                listRepoFiles: async () => []
            });

            const parentRels = expansion.relationships.filter(
                (item) =>
                    (item.metadataType || item.type) === 'CustomObject' &&
                    item.name === 'Weather_Config__mdt'
            );

            assert.strictEqual(
                parentRels.length,
                1,
                'discoverUntilStable must emit parent at most once'
            );

            // Simulate merge with an already-present parent dependency.
            const existing = [
                {
                    type: 'CustomObject',
                    name: 'Weather_Config__mdt',
                    required: true,
                    selected: true
                }
            ];
            const keySet = new Set(['CustomObject:Weather_Config__mdt']);
            const merged = [...existing];

            for (const relationship of parentRels) {
                const key = `CustomObject:${relationship.name}`;

                if (keySet.has(key)) {
                    continue;
                }

                keySet.add(key);
                merged.push(relationship);
            }

            assert.strictEqual(merged.length, 1);
        }
    );

    await runTest('TEST 5: malformed bare type emits no parent', async () => {
        const result = await customMetadataParentDiscoverer.discover({
            selectedMetadata: [customMetadataItem('Weather_Config')]
        });

        assert.deepStrictEqual(result.relationships, []);
        assert.strictEqual(
            deriveCustomMetadataParentObjectName('Weather_Config'),
            null
        );
    });

    await runTest('TEST 6: malformed trailing dot emits no parent', async () => {
        const result = await customMetadataParentDiscoverer.discover({
            selectedMetadata: [customMetadataItem('Weather_Config.')]
        });

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TEST 7: malformed leading dot emits no parent', async () => {
        const result = await customMetadataParentDiscoverer.discover({
            selectedMetadata: [customMetadataItem('.Default')]
        });

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TEST 8: malformed multi-dot emits no parent', async () => {
        const result = await customMetadataParentDiscoverer.discover({
            selectedMetadata: [
                customMetadataItem('Weather_Config.Default.Extra')
            ]
        });

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest(
        'TEST 9: unrelated ApexClass does not emit CustomObject parent',
        async () => {
            const result = await customMetadataParentDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'ApexClass',
                        type: 'ApexClass',
                        metadataName: 'Weather_Config.Default',
                        name: 'Weather_Config.Default'
                    }
                ]
            });

            assert.deepStrictEqual(result.relationships, []);
            assert.strictEqual(result.metadataScanned, 0);
        }
    );

    await runTest(
        'TEST 10: parent artifact resolves via existing CustomObject resolver',
        () => {
            const resolved = customObjectArtifactResolver.resolve({
                name: 'Weather_Config__mdt',
                metadataType: 'CustomObject',
                repoFiles: [PARENT_OBJECT_PATH]
            });

            assert.strictEqual(resolved, PARENT_OBJECT_PATH);

            const enriched = enrichNode(
                {
                    metadataType: 'CustomObject',
                    name: 'Weather_Config__mdt',
                    metadataName: 'Weather_Config__mdt'
                },
                [PARENT_OBJECT_PATH]
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(enriched.sourceExists, true);
            assert.strictEqual(enriched.filePath, PARENT_OBJECT_PATH);
        }
    );

    await runTest(
        'TEST 11: destination-missing parent stays deployable CustomObject',
        () => {
            const classification = classifyDependency({
                type: 'CustomObject',
                metadataType: 'CustomObject',
                name: 'Weather_Config__mdt',
                required: true,
                selected: true
            });

            assert.strictEqual(
                classification.classification,
                'DEPLOYABLE_METADATA'
            );
            assert.strictEqual(classification.packageable, true);

            // No destination override invented — package composition still
            // includes required+selected CustomObject when action is unset.
            const generated = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'CustomMetadata',
                        metadataName: 'Weather_Config.Default'
                    }
                ],
                requiredDependencies: [
                    {
                        type: 'CustomObject',
                        name: 'Weather_Config__mdt',
                        required: true,
                        selected: true
                    }
                ]
            });

            const keys = generated.metadata.map(
                (item) => `${item.metadataType}:${item.metadataName}`
            );

            assert.ok(keys.includes('CustomObject:Weather_Config__mdt'));
            assert.ok(keys.includes('CustomMetadata:Weather_Config.Default'));
        }
    );

    await runTest(
        'TEST 12 regression: P0-4 CustomMetadata artifact path unchanged',
        () => {
            const resolved = genericFileArtifactResolver.resolve({
                name: 'Weather_Config.Default',
                metadataType: 'CustomMetadata',
                repoFiles: [CM_DEFAULT_PATH]
            });

            assert.strictEqual(resolved, CM_DEFAULT_PATH);
            assert.ok(resolved.endsWith(`Weather_Config.Default${CM_SUFFIX}`));

            const enriched = enrichNode(
                {
                    metadataType: 'CustomMetadata',
                    name: 'Weather_Config.Default',
                    metadataName: 'Weather_Config.Default'
                },
                [CM_DEFAULT_PATH]
            );

            assert.strictEqual(enriched.name, 'Weather_Config.Default');
            assert.strictEqual(enriched.artifactResolved, true);
        }
    );

    await runTest(
        'TEST 13 regression: CustomMetadata metadataName remains Type.Record',
        () => {
            // P0-4B lives in LWC (outside this repo). Backend contract: member
            // names stay Type.Record through discovery → package composition.
            const memberName = 'Weather_Config.Default';
            const generated = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'CustomMetadata',
                        metadataName: memberName
                    }
                ],
                requiredDependencies: []
            });

            assert.strictEqual(
                generated.metadata[0].metadataName,
                'Weather_Config.Default'
            );
            assert.notStrictEqual(
                generated.metadata[0].metadataName,
                'Weather_Config'
            );
        }
    );

    await runTest(
        'E2E local: discovery → classification → package includes both members',
        async () => {
            assert.ok(
                EXPANDABLE_DEPENDENCY_TYPES.includes('CustomMetadata'),
                'CustomMetadata must be expandable for relationship seeds'
            );

            const expansion = await discoverUntilStable({
                selectedMetadata: [customMetadataItem('Weather_Config.Default')],
                expandableDependencies: [],
                discoverers: getRegisteredDiscoverers(),
                repoFiles: [CM_DEFAULT_PATH, PARENT_OBJECT_PATH],
                readRepoFile: async () => '',
                listRepoFiles: async () => [CM_DEFAULT_PATH, PARENT_OBJECT_PATH]
            });

            assert.deepStrictEqual(
                parentCustomObjectKeys(expansion.relationships),
                ['CustomObject:Weather_Config__mdt']
            );

            const parentDep = expansion.relationships.find(
                (item) => item.name === 'Weather_Config__mdt'
            );
            const classified = classifyDependency(parentDep);

            assert.strictEqual(
                classified.classification,
                'DEPLOYABLE_METADATA'
            );

            const generated = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'CustomMetadata',
                        metadataName: 'Weather_Config.Default'
                    }
                ],
                requiredDependencies: expansion.relationships.map((item) => ({
                    type: item.metadataType || item.type,
                    name: item.name,
                    required: item.required !== false,
                    selected: item.selected !== false
                }))
            });

            const keys = generated.metadata
                .map((item) => `${item.metadataType}:${item.metadataName}`)
                .sort();

            assert.ok(keys.includes('CustomMetadata:Weather_Config.Default'));
            assert.ok(keys.includes('CustomObject:Weather_Config__mdt'));
        }
    );

    await runTest(
        'Type__mdt.Record form still derives CustomObject:Type__mdt',
        async () => {
            const result = await customMetadataParentDiscoverer.discover({
                selectedMetadata: [
                    customMetadataItem('Weather_Config__mdt.Default')
                ]
            });

            assert.deepStrictEqual(parentCustomObjectKeys(result.relationships), [
                'CustomObject:Weather_Config__mdt'
            ]);
        }
    );

    await runTest(
        'over-discovery guard: does not emit Default__mdt or CustomMetadataType',
        async () => {
            const result = await customMetadataParentDiscoverer.discover({
                selectedMetadata: [customMetadataItem('Weather_Config.Default')]
            });

            const types = result.relationships.map(
                (item) => item.metadataType || item.type
            );
            const names = result.relationships.map((item) => item.name);

            assert.ok(!types.includes('CustomMetadataType'));
            assert.ok(!names.includes('Default__mdt'));
            assert.ok(!names.includes('Weather_Config'));
            assert.deepStrictEqual(names, ['Weather_Config__mdt']);
        }
    );
}

main();
