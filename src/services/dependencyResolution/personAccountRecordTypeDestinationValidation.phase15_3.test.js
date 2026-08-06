const assert = require('assert');

const {
    buildRecordTypeSoql
} = require('../destinationInventory/destinationExistenceQueries');
const {
    resolveDependencies,
    ACTIONS,
    DESTINATION_STATES
} = require('./dependencyResolution.service');
const {
    CLASSIFICATIONS
} = require('./dependencyClassification.service');
const artifactExistsRule = require('../deploymentCompatibility/rules/artifactExists.rule');
const {
    generateDeploymentPackage
} = require('../deploymentPackage.service');

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

function recordTypeDependency(name) {
    return {
        type: 'RecordType',
        name,
        required: true,
        selected: true,
        relationship: 'PermissionSetRecordTypeVisibility',
        artifactResolved: false,
        sourceExists: false
    };
}

async function resolveRecordType(name, destinationState) {
    return resolveDependencies({
        requiredDependencies: [recordTypeDependency(name)],
        selectedMetadata: [],
        destinationStates: new Map([
            [`RecordType:${name}`, destinationState]
        ])
    });
}

async function main() {
    await runTest(
        'PersonAccount RecordType query maps to the Account SObject',
        () => {
            assert.strictEqual(
                buildRecordTypeSoql('PersonAccount.PersonAccount'),
                "SELECT Id, DeveloperName, SobjectType FROM RecordType WHERE DeveloperName = 'PersonAccount' AND SobjectType = 'Account' LIMIT 1"
            );
            assert.strictEqual(
                buildRecordTypeSoql('PersonAccount.Customer_Person'),
                "SELECT Id, DeveloperName, SobjectType FROM RecordType WHERE DeveloperName = 'Customer_Person' AND SobjectType = 'Account' LIMIT 1"
            );
        }
    );

    await runTest(
        'existing destination PersonAccount RecordType is satisfied without artifact',
        async () => {
            const result = await resolveRecordType(
                'PersonAccount.PersonAccount',
                DESTINATION_STATES.EXISTS
            );
            const decision = result.resolvedDependencies[0];

            assert.strictEqual(decision.action, ACTIONS.REFERENCE);
            assert.strictEqual(decision.selected, false);
            assert.strictEqual(
                decision.destinationState,
                DESTINATION_STATES.EXISTS
            );
            assert.strictEqual(
                decision.classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA
            );
            assert.strictEqual(decision.artifactRequired, false);
            assert.strictEqual(decision.sourceExists, false);
            assert.strictEqual(decision.artifactResolved, false);
            assert.ok(decision.reason.includes('exists in the destination'));
            assert.strictEqual(result.summary.reference, 1);
            assert.strictEqual(result.summary.block, 0);

            const findings = artifactExistsRule.analyze({
                selectedMetadata: [],
                resolvedDependencies: result.resolvedDependencies,
                discoveredReferences: []
            });

            assert.deepStrictEqual(findings, []);
        }
    );

    await runTest(
        'missing destination PersonAccount RecordType blocks with helpful reason',
        async () => {
            const result = await resolveRecordType(
                'PersonAccount.PersonAccount',
                DESTINATION_STATES.MISSING
            );
            const decision = result.resolvedDependencies[0];

            assert.strictEqual(decision.action, ACTIONS.BLOCK);
            assert.strictEqual(decision.selected, false);
            assert.strictEqual(decision.artifactRequired, false);
            assert.strictEqual(result.summary.block, 1);
            assert.ok(decision.reason.includes('Enable Person Accounts'));
            assert.ok(
                decision.reason.includes(
                    'Person Account RecordType is unavailable'
                )
            );
        }
    );

    await runTest(
        'unknown PersonAccount destination state blocks safely',
        async () => {
            const result = await resolveRecordType(
                'PersonAccount.PersonAccount',
                DESTINATION_STATES.UNKNOWN
            );
            const decision = result.resolvedDependencies[0];

            assert.strictEqual(decision.action, ACTIONS.BLOCK);
            assert.strictEqual(decision.artifactRequired, false);
            assert.ok(decision.reason.includes('Unable to verify'));
        }
    );

    await runTest(
        'custom-object RecordType retains existing deploy behavior and query',
        async () => {
            assert.strictEqual(
                buildRecordTypeSoql('Member__c.Standard'),
                "SELECT Id, DeveloperName, SobjectType FROM RecordType WHERE DeveloperName = 'Standard' AND SobjectType = 'Member__c' LIMIT 1"
            );

            const result = await resolveRecordType(
                'Member__c.Standard',
                DESTINATION_STATES.EXISTS
            );
            const decision = result.resolvedDependencies[0];

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.selected, true);
            assert.strictEqual(decision.artifactRequired, true);
        }
    );

    await runTest(
        'standard-object custom RecordType retains existing deploy behavior and query',
        async () => {
            assert.strictEqual(
                buildRecordTypeSoql('Account.Customer'),
                "SELECT Id, DeveloperName, SobjectType FROM RecordType WHERE DeveloperName = 'Customer' AND SobjectType = 'Account' LIMIT 1"
            );

            const result = await resolveRecordType(
                'Account.Customer',
                DESTINATION_STATES.EXISTS
            );
            const decision = result.resolvedDependencies[0];

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.selected, true);
            assert.strictEqual(decision.artifactRequired, true);
        }
    );

    await runTest(
        'package generation excludes destination-backed and blocked PersonAccount dependencies',
        async () => {
            const existing = await resolveRecordType(
                'PersonAccount.PersonAccount',
                DESTINATION_STATES.EXISTS
            );
            const missing = await resolveRecordType(
                'PersonAccount.Other_Person',
                DESTINATION_STATES.MISSING
            );
            const normal = await resolveRecordType(
                'Member__c.Standard',
                DESTINATION_STATES.MISSING
            );
            const generated = generateDeploymentPackage({
                selectedMetadata: [],
                requiredDependencies: [
                    ...existing.resolvedDependencies,
                    ...missing.resolvedDependencies,
                    ...normal.resolvedDependencies
                ]
            });

            assert.deepStrictEqual(
                generated.metadata.map(
                    (item) => `${item.metadataType}:${item.metadataName}`
                ),
                ['RecordType:Member__c.Standard']
            );
            assert.deepStrictEqual(
                generated.dependencies.map(
                    (item) => `${item.type}:${item.name}`
                ),
                ['RecordType:Member__c.Standard']
            );
        }
    );
}

main();
