const assert = require('assert');

const customObjectRelationshipDiscoverer = require('./discoverers/customObjectRelationship.discoverer');
const {
    buildInitialFrontier,
    discoverUntilStable,
    EXPANDABLE_DEPENDENCY_TYPES
} = require('./relationshipDiscovery.service');

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

const EXPERIENCE_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Experience__c</fullName>
    <type>Lookup</type>
    <referenceTo>Experience__c</referenceTo>
    <label>Experience</label>
</CustomField>`;

const DATE_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Date__c</fullName>
    <type>Date</type>
    <label>Date</label>
</CustomField>`;

const PARENT_LOOKUP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <type>Lookup</type>
    <referenceTo>Related_Account__c</referenceTo>
    <label>Account</label>
</CustomField>`;

const REPO_FILES = [
    'force-app/main/default/objects/Session__c/fields/Experience__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Date__c.field-meta.xml',
    'force-app/main/default/objects/Experience__c/fields/Account__c.field-meta.xml'
];

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');

    if (normalized.endsWith('/Session__c/fields/Experience__c.field-meta.xml')) {
        return EXPERIENCE_FIELD_XML;
    }

    if (normalized.endsWith('/Session__c/fields/Date__c.field-meta.xml')) {
        return DATE_FIELD_XML;
    }

    if (normalized.endsWith('/Experience__c/fields/Account__c.field-meta.xml')) {
        return PARENT_LOOKUP_XML;
    }

    throw new Error(`Unexpected file read: ${filePath}`);
}

async function main() {
    await runTest('EXPANDABLE_DEPENDENCY_TYPES includes CustomField only', () => {
        assert.deepStrictEqual([...EXPANDABLE_DEPENDENCY_TYPES], ['CustomField']);
    });

    await runTest(
        'buildInitialFrontier seeds selected metadata + CustomField deps',
        () => {
            const frontier = buildInitialFrontier(
                [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Get_Sessions'
                    }
                ],
                [
                    {
                        type: 'CustomField',
                        name: 'Session__c.Experience__c'
                    },
                    {
                        type: 'CustomField',
                        name: 'Session__c.Date__c'
                    },
                    {
                        type: 'ApexClass',
                        name: 'SessionService'
                    },
                    {
                        type: 'CustomObject',
                        name: 'Session__c'
                    }
                ]
            );

            const keys = frontier.map(
                (item) => `${item.metadataType}:${item.metadataName}`
            );

            assert.ok(keys.includes('Flow:Get_Sessions'));
            assert.ok(keys.includes('CustomField:Session__c.Experience__c'));
            assert.ok(keys.includes('CustomField:Session__c.Date__c'));
            assert.ok(!keys.includes('ApexClass:SessionService'));
            assert.ok(!keys.includes('CustomObject:Session__c'));
        }
    );

    await runTest('buildInitialFrontier deduplicates CustomField seeds', () => {
        const frontier = buildInitialFrontier(
            [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Experience__c'
                }
            ],
            [
                {
                    type: 'CustomField',
                    name: 'Session__c.Experience__c'
                }
            ]
        );

        assert.strictEqual(frontier.length, 1);
    });

    await runTest(
        'CustomField dependency expands via existing referenceTo parser',
        async () => {
            const result = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Get_Sessions'
                    }
                ],
                expandableDependencies: [
                    {
                        type: 'CustomField',
                        name: 'Session__c.Experience__c'
                    },
                    {
                        type: 'CustomField',
                        name: 'Session__c.Date__c'
                    }
                ],
                discoverers: [customObjectRelationshipDiscoverer],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const names = result.relationships.map((item) => item.name);

            assert.ok(
                names.includes('Experience__c'),
                `Expected Experience__c in ${JSON.stringify(names)}`
            );

            const experience = result.relationships.find(
                (item) => item.name === 'Experience__c'
            );

            assert.strictEqual(experience.metadataType, 'CustomObject');
            assert.strictEqual(experience.relationship, 'Lookup');
            assert.strictEqual(experience.discoveryMethod, 'referenceTo');
            assert.strictEqual(
                experience.discoveredBy,
                'CustomObjectRelationshipDiscoverer'
            );
            assert.strictEqual(experience.sourceField, 'Experience__c');
        }
    );

    await runTest(
        'Newly discovered CustomObject continues expansion (depth-limited)',
        async () => {
            const result = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Get_Sessions'
                    }
                ],
                expandableDependencies: [
                    {
                        type: 'CustomField',
                        name: 'Session__c.Experience__c'
                    }
                ],
                discoverers: [customObjectRelationshipDiscoverer],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const names = result.relationships.map((item) => item.name);

            assert.ok(names.includes('Experience__c'));
            assert.ok(
                names.includes('Related_Account__c'),
                'Experience__c fields should expand recursively'
            );
            assert.ok(
                result.graphExpansionSummary.graphDepth <= 10,
                'Must respect MAX_GRAPH_DEPTH'
            );
        }
    );

    await runTest(
        'No duplicate Experience__c relationships when field appears twice',
        async () => {
            const result = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Get_Sessions'
                    }
                ],
                expandableDependencies: [
                    {
                        type: 'CustomField',
                        name: 'Session__c.Experience__c'
                    },
                    {
                        type: 'CustomField',
                        name: 'Session__c.Experience__c'
                    }
                ],
                discoverers: [customObjectRelationshipDiscoverer],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const experienceCount = result.relationships.filter(
                (item) => item.name === 'Experience__c'
            ).length;

            assert.strictEqual(experienceCount, 1);
        }
    );

    await runTest(
        'Selected CustomObject path unchanged (still discovers Lookup targets)',
        async () => {
            const result = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Session__c'
                    }
                ],
                expandableDependencies: [],
                discoverers: [customObjectRelationshipDiscoverer],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const names = result.relationships.map((item) => item.name);

            assert.ok(names.includes('Experience__c'));
        }
    );

    await runTest(
        'Without CustomField seeds, Flow-only selection discovers nothing',
        async () => {
            const result = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Get_Sessions'
                    }
                ],
                expandableDependencies: [],
                discoverers: [customObjectRelationshipDiscoverer],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            assert.strictEqual(result.relationships.length, 0);
        }
    );
}

main();
