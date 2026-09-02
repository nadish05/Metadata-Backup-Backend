const assert = require('assert');

const {
    collectDestinationInventoryItems
} = require('../../destinationInventory/destinationInventoryCandidateCollector.service');
const {
    DISCOVERY_METHOD: STRUCTURAL_ACTION_OVERRIDE_FIELD_DISCOVERY_METHOD
} = require('./structuralActionOverrideField.discoverer');
const {
    DISCOVERY_METHOD,
    discoverStructuralFormulaRelatedFields,
    extractCrossObjectFormulaPrerequisites
} = require('./structuralFormulaRelatedField.discoverer');
const {
    mergeDeployableReferences,
    resolveDependencies
} = require('../dependencyResolution.service');
const { generateDeploymentPackage } = require('../../deploymentPackage.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

const SUBSCRIPTION_SESSIONS_USED_FIELD_PATH =
    'force-app/main/default/objects/Subscription__c/fields/Sessions_Used__c.field-meta.xml';
const MEMBERSHIP_PLAN_SESSIONS_LIMIT_FIELD_PATH =
    'force-app/main/default/objects/Membership_Plan__c/fields/Sessions_Limit__c.field-meta.xml';
const MEMBERSHIP_PLAN_OTHER_FIELD_PATH =
    'force-app/main/default/objects/Membership_Plan__c/fields/Price__c.field-meta.xml';

const SUBSCRIPTION_SESSIONS_USED_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Sessions_Used__c</fullName>
    <type>Formula</type>
    <formula>Membership_Plan__r.Sessions_Limit__c - Remaining_Sessions__c</formula>
    <formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>
</CustomField>`;

const MEMBERSHIP_PLAN_SESSIONS_LIMIT_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Sessions_Limit__c</fullName>
    <type>Number</type>
    <precision>18</precision>
    <scale>0</scale>
</CustomField>`;

const FILE_CONTENT = {
    [SUBSCRIPTION_SESSIONS_USED_FIELD_PATH]: SUBSCRIPTION_SESSIONS_USED_FIELD_XML,
    [MEMBERSHIP_PLAN_SESSIONS_LIMIT_FIELD_PATH]:
        MEMBERSHIP_PLAN_SESSIONS_LIMIT_FIELD_XML
};

function createReadRepoFile(files = FILE_CONTENT) {
    return async (targetPath) => {
        if (!files[targetPath]) {
            throw new Error(`Missing fixture file: ${targetPath}`);
        }

        return files[targetPath];
    };
}

function createStructuralSessionsUsedDependency() {
    return {
        name: 'Subscription__c.Sessions_Used__c',
        type: 'CustomField',
        metadataType: 'CustomField',
        discoveryMethod: STRUCTURAL_ACTION_OVERRIDE_FIELD_DISCOVERY_METHOD,
        sourceMetadata: 'Subscription_Record_Page',
        relationship: 'Field',
        required: true,
        selected: true,
        deployable: true,
        blocking: true,
        filePath: SUBSCRIPTION_SESSIONS_USED_FIELD_PATH
    };
}

function getPackageMemberNames(generatedPackage, metadataType) {
    return (generatedPackage?.metadata || [])
        .filter((item) => item.metadataType === metadataType)
        .map((item) => item.metadataName);
}

async function main() {
    await runTest(
        'TEST 1: formula reference extraction Sessions_Used__c → Membership_Plan__c.Sessions_Limit__c',
        async () => {
            const prerequisites = extractCrossObjectFormulaPrerequisites(
                SUBSCRIPTION_SESSIONS_USED_FIELD_XML,
                'Subscription__c'
            );

            assert.deepStrictEqual(
                prerequisites.map((item) => item.qualifiedName),
                ['Membership_Plan__c.Sessions_Limit__c']
            );
            assert.strictEqual(
                prerequisites[0].relationshipRef,
                'Membership_Plan__r'
            );
        }
    );

    await runTest(
        'TEST 2: discoverer preserves structuralFormulaRelatedField provenance',
        async () => {
            const result = await discoverStructuralFormulaRelatedFields({
                structuralFieldDependencies: [
                    createStructuralSessionsUsedDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: Object.keys(FILE_CONTENT)
            });

            assert.strictEqual(result.dependencies.length, 1);
            const dependency = result.dependencies[0];

            assert.strictEqual(
                dependency.name,
                'Membership_Plan__c.Sessions_Limit__c'
            );
            assert.strictEqual(dependency.discoveryMethod, DISCOVERY_METHOD);
            assert.strictEqual(
                dependency.sourceMetadata,
                'Subscription__c.Sessions_Used__c'
            );
            assert.strictEqual(dependency.origin, 'Subscription_Record_Page');
            assert.strictEqual(dependency.expansionPolicy, 'PREREQUISITE_ONLY');
            assert.strictEqual(dependency.relationship, 'FormulaRelatedField');
        }
    );

    await runTest(
        'TEST 3: closure candidate enters inventory candidate set',
        async () => {
            const discovery = await discoverStructuralFormulaRelatedFields({
                structuralFieldDependencies: [
                    createStructuralSessionsUsedDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: Object.keys(FILE_CONTENT)
            });

            const inventoryItems = collectDestinationInventoryItems({
                closureCandidates: discovery.closureCandidates
            });

            assert.ok(
                inventoryItems.some(
                    (item) =>
                        item.metadataType === 'CustomField' &&
                        item.metadataName ===
                            'Membership_Plan__c.Sessions_Limit__c'
                )
            );
        }
    );

    await runTest(
        'TEST 4: destination EXISTS → bounded formula prerequisite is skipped',
        async () => {
            const discovery = await discoverStructuralFormulaRelatedFields({
                structuralFieldDependencies: [
                    createStructuralSessionsUsedDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: Object.keys(FILE_CONTENT)
            });

            const merged = mergeDeployableReferences(
                [createStructuralSessionsUsedDependency()],
                []
            );
            const dependencies = [...merged, ...discovery.dependencies];

            const resolution = await resolveDependencies({
                requiredDependencies: dependencies,
                destinationStates: new Map([
                    [
                        'CustomField:Membership_Plan__c.Sessions_Limit__c',
                        'EXISTS'
                    ],
                    ['CustomField:Subscription__c.Sessions_Used__c', 'MISSING']
                ])
            });

            const prerequisiteDecision = resolution.resolvedDependencies.find(
                (item) =>
                    item.name === 'Membership_Plan__c.Sessions_Limit__c'
            );

            assert.ok(prerequisiteDecision);
            assert.strictEqual(prerequisiteDecision.action, 'SKIP');
            assert.strictEqual(prerequisiteDecision.selected, false);
        }
    );

    await runTest(
        'TEST 5: destination MISSING → bounded formula prerequisite is deployed',
        async () => {
            const discovery = await discoverStructuralFormulaRelatedFields({
                structuralFieldDependencies: [
                    createStructuralSessionsUsedDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: Object.keys(FILE_CONTENT)
            });

            const resolution = await resolveDependencies({
                requiredDependencies: [
                    createStructuralSessionsUsedDependency(),
                    ...discovery.dependencies
                ],
                destinationStates: new Map([
                    [
                        'CustomField:Membership_Plan__c.Sessions_Limit__c',
                        'MISSING'
                    ],
                    ['CustomField:Subscription__c.Sessions_Used__c', 'MISSING']
                ])
            });

            const prerequisiteDecision = resolution.resolvedDependencies.find(
                (item) =>
                    item.name === 'Membership_Plan__c.Sessions_Limit__c'
            );

            assert.ok(prerequisiteDecision);
            assert.strictEqual(prerequisiteDecision.action, 'DEPLOY');
            assert.strictEqual(prerequisiteDecision.selected, true);

            const generatedPackage = generateDeploymentPackage({
                selectedMetadata: [],
                requiredDependencies: resolution.resolvedDependencies
            });

            assert.ok(
                getPackageMemberNames(generatedPackage, 'CustomField').includes(
                    'Membership_Plan__c.Sessions_Limit__c'
                )
            );
            assert.strictEqual(
                getPackageMemberNames(generatedPackage, 'CustomObject').includes(
                    'Membership_Plan__c'
                ),
                false
            );
        }
    );

    await runTest(
        'TEST 6: destination UNKNOWN preserves existing fail-open deploy behavior',
        async () => {
            const discovery = await discoverStructuralFormulaRelatedFields({
                structuralFieldDependencies: [
                    createStructuralSessionsUsedDependency()
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: Object.keys(FILE_CONTENT)
            });

            const resolution = await resolveDependencies({
                requiredDependencies: discovery.dependencies,
                destinationStates: new Map()
            });

            const prerequisiteDecision = resolution.resolvedDependencies.find(
                (item) =>
                    item.name === 'Membership_Plan__c.Sessions_Limit__c'
            );

            assert.ok(prerequisiteDecision);
            assert.strictEqual(prerequisiteDecision.destinationState, 'UNKNOWN');
            assert.strictEqual(prerequisiteDecision.action, 'DEPLOY');
        }
    );

    await runTest(
        'TEST 7: no Membership_Plan__c object or unrelated Membership_Plan fields discovered',
        async () => {
            const result = await discoverStructuralFormulaRelatedFields({
                structuralFieldDependencies: [
                    createStructuralSessionsUsedDependency()
                ],
                readRepoFile: createReadRepoFile({
                    ...FILE_CONTENT,
                    [MEMBERSHIP_PLAN_OTHER_FIELD_PATH]: `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Price__c</fullName>
    <type>Currency</type>
</CustomField>`
                }),
                repoFiles: [
                    ...Object.keys(FILE_CONTENT),
                    MEMBERSHIP_PLAN_OTHER_FIELD_PATH
                ]
            });

            assert.deepStrictEqual(
                result.dependencies.map((item) => item.name),
                ['Membership_Plan__c.Sessions_Limit__c']
            );
            assert.strictEqual(
                result.dependencies.some(
                    (item) => item.metadataType === 'CustomObject'
                ),
                false
            );
        }
    );

    await runTest(
        'TEST 8: end-to-end Subscription_Record_Page → Sessions_Used__c → Sessions_Limit__c',
        async () => {
            const structuralField = createStructuralSessionsUsedDependency();
            const discovery = await discoverStructuralFormulaRelatedFields({
                structuralFieldDependencies: [structuralField],
                readRepoFile: createReadRepoFile(),
                repoFiles: Object.keys(FILE_CONTENT)
            });

            const resolution = await resolveDependencies({
                requiredDependencies: [structuralField, ...discovery.dependencies],
                destinationStates: new Map([
                    [
                        'CustomField:Membership_Plan__c.Sessions_Limit__c',
                        'MISSING'
                    ],
                    ['CustomField:Subscription__c.Sessions_Used__c', 'MISSING'],
                    ['FlexiPage:Subscription_Record_Page', 'MISSING']
                ])
            });

            const sessionsUsedDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'Subscription__c.Sessions_Used__c'
            );
            const sessionsLimitDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'Membership_Plan__c.Sessions_Limit__c'
            );

            assert.ok(sessionsUsedDecision);
            assert.strictEqual(sessionsUsedDecision.action, 'DEPLOY');
            assert.ok(sessionsLimitDecision);
            assert.strictEqual(sessionsLimitDecision.action, 'DEPLOY');
            assert.ok(
                discovery.dependencies[0].discoveryMethod === DISCOVERY_METHOD
            );

            const generatedPackage = generateDeploymentPackage({
                selectedMetadata: [],
                requiredDependencies: resolution.resolvedDependencies
            });
            const packageFields = getPackageMemberNames(
                generatedPackage,
                'CustomField'
            );

            assert.ok(packageFields.includes('Subscription__c.Sessions_Used__c'));
            assert.ok(
                packageFields.includes('Membership_Plan__c.Sessions_Limit__c')
            );
            assert.strictEqual(
                getPackageMemberNames(generatedPackage, 'CustomObject').length,
                0
            );
        }
    );
}

main().then(() => {
    if (process.exitCode) {
        console.error('structuralFormulaRelatedField.discoverer.test.js FAILED');
    } else {
        console.log('structuralFormulaRelatedField.discoverer.test.js PASSED');
    }
});
