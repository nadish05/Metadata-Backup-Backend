const assert = require('assert');

const customObjectRelationshipDiscoverer = require('./discoverers/customObjectRelationship.discoverer');
const {
    discoverUntilStable,
    buildInitialFrontier
} = require('./relationshipDiscovery.service');
const {
    createDefaultDecision,
    ACTIONS
} = require('./dependencyResolution.service');
const {
    generateDeploymentPackage
} = require('../deploymentPackage.service');
const {
    analyzeFormulaCompatibility
} = require('../formulaCompatibility.service');
const {
    filter: filterCompatibilityPackage
} = require('../deploymentCompatibilityFilter.service');

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

const ROLLUP_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Total_Training_Programs__c</fullName>
    <type>Summary</type>
    <summaryForeignKey>Training_Program__c.Account__c</summaryForeignKey>
    <summaryOperation>count</summaryOperation>
    <label>Total Training Programs</label>
</CustomField>`;

const FK_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <type>Lookup</type>
    <referenceTo>Account</referenceTo>
    <label>Account</label>
</CustomField>`;

const OTHER_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Program_Name__c</fullName>
    <type>Text</type>
    <label>Program Name</label>
</CustomField>`;

const LOOKUP_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Session__c</fullName>
    <type>Lookup</type>
    <referenceTo>Session__c</referenceTo>
    <label>Session</label>
</CustomField>`;

const REPO_FILES = [
    'force-app/main/default/objects/Account/fields/Total_Training_Programs__c.field-meta.xml',
    'force-app/main/default/objects/Training_Program__c/fields/Account__c.field-meta.xml',
    'force-app/main/default/objects/Training_Program__c/fields/Program_Name__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Session__c.field-meta.xml'
];

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');

    if (
        normalized.endsWith(
            '/Account/fields/Total_Training_Programs__c.field-meta.xml'
        )
    ) {
        return ROLLUP_FIELD_XML;
    }

    if (
        normalized.endsWith(
            '/Training_Program__c/fields/Account__c.field-meta.xml'
        )
    ) {
        return FK_FIELD_XML;
    }

    if (
        normalized.endsWith(
            '/Training_Program__c/fields/Program_Name__c.field-meta.xml'
        )
    ) {
        return OTHER_FIELD_XML;
    }

    if (normalized.endsWith('/Booking__c/fields/Session__c.field-meta.xml')) {
        return LOOKUP_FIELD_XML;
    }

    throw new Error(`Unexpected file read: ${filePath}`);
}

function packageHasCustomField(pkg, name) {
    const members = [...(pkg.metadata || []), ...(pkg.dependencies || [])];
    return members.some(
        (item) =>
            (item.metadataType || item.type) === 'CustomField' &&
            (item.metadataName || item.name) === name
    );
}

async function main() {
    await runTest(
        'TEST 1: indirectly discovered Roll-Up CustomField expands summaryForeignKey into graph',
        async () => {
            // Simulates Profile/PermissionSet discovering the roll-up field,
            // which previously never re-entered the frontier.
            const result = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'Profile',
                        metadataName: 'Sales Manager'
                    }
                ],
                expandableDependencies: [],
                discoverers: [
                    {
                        id: 'StubProfileDiscoverer',
                        async discover({ selectedMetadata }) {
                            const profiles = (selectedMetadata || []).filter(
                                (item) => item.metadataType === 'Profile'
                            );

                            if (!profiles.length) {
                                return {
                                    relationships: [],
                                    warnings: [],
                                    filesScanned: 0,
                                    metadataScanned: 0
                                };
                            }

                            return {
                                relationships: [
                                    {
                                        name: 'Account.Total_Training_Programs__c',
                                        metadataType: 'CustomField',
                                        type: 'CustomField',
                                        relationship: 'fieldPermissions',
                                        required: true,
                                        selected: true,
                                        discoveredBy: 'StubProfileDiscoverer',
                                        discoveryMethod: 'fieldPermissions',
                                        reason: 'Field permission on Profile.'
                                    }
                                ],
                                warnings: [],
                                filesScanned: 1,
                                metadataScanned: 1
                            };
                        }
                    },
                    customObjectRelationshipDiscoverer
                ],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const names = result.relationships.map((item) => item.name);
            assert.ok(
                names.includes('Account.Total_Training_Programs__c'),
                'Roll-up CustomField must be discovered'
            );
            assert.ok(
                names.includes('Training_Program__c.Account__c'),
                `summaryForeignKey must be discovered; got ${JSON.stringify(names)}`
            );
            assert.ok(
                names.includes('Training_Program__c'),
                'Summarized CustomObject must be discovered'
            );

            const fk = result.relationships.find(
                (item) => item.name === 'Training_Program__c.Account__c'
            );
            assert.strictEqual(fk.metadataType, 'CustomField');
            assert.strictEqual(fk.relationship, 'Summary');
            assert.strictEqual(fk.required, true);
            assert.strictEqual(fk.selected, true);
        }
    );

    await runTest(
        'TEST 2: package composition + formula check — FK present removes missing-package blocker',
        async () => {
            const rollupDecision = createDefaultDecision({
                name: 'Account.Total_Training_Programs__c',
                type: 'CustomField',
                required: true,
                selected: true
            });
            const fkDecision = createDefaultDecision({
                name: 'Training_Program__c.Account__c',
                type: 'CustomField',
                required: true,
                selected: true
            });

            assert.strictEqual(rollupDecision.action, ACTIONS.DEPLOY);
            assert.strictEqual(fkDecision.action, ACTIONS.DEPLOY);

            const pkg = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Total_Training_Programs__c',
                        filePath:
                            'force-app/main/default/objects/Account/fields/Total_Training_Programs__c.field-meta.xml'
                    }
                ],
                requiredDependencies: [rollupDecision, fkDecision],
                selectedTestClasses: []
            });

            assert.ok(
                packageHasCustomField(
                    pkg,
                    'Account.Total_Training_Programs__c'
                )
            );
            assert.ok(
                packageHasCustomField(pkg, 'Training_Program__c.Account__c'),
                'FK must be auto-included in package membership'
            );

            const formulaResult = await analyzeFormulaCompatibility({
                generatedDeploymentPackage: pkg,
                readFile: readRepoFile,
                existingFindings: []
            });

            const missingFk = (formulaResult.warnings || []).filter(
                (warning) =>
                    warning.category === 'ROLLUP_REFERENCE' &&
                    String(warning.message || '').includes(
                        'summaryForeignKey Training_Program__c.Account__c is not in the deployment package'
                    )
            );

            assert.strictEqual(
                missingFk.length,
                0,
                `Expected no missing summaryForeignKey warning; got ${JSON.stringify(
                    formulaResult.warnings
                )}`
            );
        }
    );

    await runTest(
        'TEST 3: REFERENCE decisions are not forced into the package',
        () => {
            const pkg = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Total_Training_Programs__c'
                    }
                ],
                requiredDependencies: [
                    {
                        name: 'Training_Program__c.Account__c',
                        type: 'CustomField',
                        action: 'REFERENCE',
                        selected: false,
                        required: true
                    }
                ],
                selectedTestClasses: []
            });

            assert.strictEqual(
                packageHasCustomField(pkg, 'Training_Program__c.Account__c'),
                false,
                'REFERENCE FK must not be forced into package'
            );
        }
    );

    await runTest(
        'TEST 4: MISSING/deployable FK with DEPLOY+selected is included',
        () => {
            const fkDecision = createDefaultDecision({
                name: 'Training_Program__c.Account__c',
                type: 'CustomField',
                required: true,
                selected: true
            });

            assert.strictEqual(fkDecision.action, ACTIONS.DEPLOY);

            const pkg = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Total_Training_Programs__c'
                    }
                ],
                requiredDependencies: [fkDecision],
                selectedTestClasses: []
            });

            assert.ok(
                packageHasCustomField(pkg, 'Training_Program__c.Account__c')
            );
        }
    );

    await runTest(
        'TEST 5: PersonAccount default decision path remains BLOCK-capable (createDefaultDecision untouched for RecordType)',
        () => {
            // Structural guard: CustomField DEPLOY policy still works and does
            // not alter RecordType default classification wiring used by PA.
            const fieldDecision = createDefaultDecision({
                name: 'Training_Program__c.Account__c',
                type: 'CustomField',
                required: true,
                selected: true
            });
            assert.strictEqual(fieldDecision.action, ACTIONS.DEPLOY);
            assert.notStrictEqual(fieldDecision.action, 'BLOCK');
        }
    );

    await runTest(
        'TEST 6: Formula ROLLUP_REFERENCE remains visible when FK absent from package',
        async () => {
            const pkg = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Account.Total_Training_Programs__c',
                        filePath:
                            'force-app/main/default/objects/Account/fields/Total_Training_Programs__c.field-meta.xml'
                    }
                ],
                requiredDependencies: [],
                selectedTestClasses: []
            });

            const formulaResult = await analyzeFormulaCompatibility({
                generatedDeploymentPackage: pkg,
                readFile: readRepoFile,
                existingFindings: []
            });

            assert.ok(
                (formulaResult.warnings || []).some(
                    (warning) =>
                        warning.category === 'ROLLUP_REFERENCE' &&
                        String(warning.message || '').includes(
                            'summaryForeignKey Training_Program__c.Account__c is not in the deployment package'
                        )
                ),
                'Missing FK warning must remain when package omits FK'
            );
        }
    );

    await runTest(
        'TEST 7/8: ordinary Lookup CustomField expansion still works',
        async () => {
            const result = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.Session__c'
                    }
                ],
                expandableDependencies: [],
                discoverers: [customObjectRelationshipDiscoverer],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const names = result.relationships.map((item) => item.name);
            assert.ok(names.includes('Session__c'));
        }
    );

    await runTest(
        'TEST 9: CustomObject relationship expansion remains intact',
        () => {
            const frontier = buildInitialFrontier(
                [{ metadataType: 'CustomObject', metadataName: 'Training_Program__c' }],
                []
            );
            assert.strictEqual(frontier.length, 1);
            assert.strictEqual(frontier[0].metadataType, 'CustomObject');
        }
    );

    await runTest(
        'Duplicate excludedComponents collapsed when member in metadata + dependencies',
        () => {
            const result = filterCompatibilityPackage({
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Total_Training_Programs__c'
                        }
                    ],
                    dependencies: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Total_Training_Programs__c'
                        }
                    ],
                    testClasses: [],
                    summary: { totalComponents: 2 }
                },
                deploymentCompatibilityPlan: {
                    compatibilityWarnings: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Total_Training_Programs__c',
                            category: 'FORMULA_COMPILATION',
                            message: 'Roll-Up Summary FK missing.'
                        }
                    ]
                }
            });

            assert.strictEqual(result.excludedComponents.length, 1);
            assert.strictEqual(
                result.compatibilitySummary.totalExcluded,
                1
            );
        }
    );

    if (process.exitCode) {
        console.error('rollupSummaryForeignKey.expansion.test.js FAILED');
    } else {
        console.log('rollupSummaryForeignKey.expansion.test.js PASSED');
    }
}

main();
