const assert = require('assert');

const {
    RETRIEVAL_METADATA_TYPES,
    RETRIEVAL_STANDARD_OBJECT_MEMBERS,
    buildRetrieveMetadataMembers,
    buildRetrieveMetadataArgs,
    summarizeRetrieveResultJson
} = require('./metadata.controller');

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

async function main() {
    await runTest('keeps existing metadata type allowlist members', () => {
        const members = buildRetrieveMetadataMembers();
        const requiredTypes = [
            'ApexClass',
            'ApexTrigger',
            'CustomObject',
            'CustomField',
            'RecordType',
            'Profile',
            'PermissionSet',
            'CustomMetadata'
        ];

        for (const type of requiredTypes) {
            assert.ok(
                members.includes(type),
                `expected member list to include ${type}`
            );
            assert.ok(
                RETRIEVAL_METADATA_TYPES.includes(type),
                `expected RETRIEVAL_METADATA_TYPES to include ${type}`
            );
        }
    });

    await runTest('adds Account and Opportunity standard object members', () => {
        const members = buildRetrieveMetadataMembers();

        assert.deepStrictEqual(
            RETRIEVAL_STANDARD_OBJECT_MEMBERS,
            ['CustomObject:Account', 'CustomObject:Opportunity']
        );
        assert.ok(members.includes('CustomObject:Account'));
        assert.ok(members.includes('CustomObject:Opportunity'));
    });

    await runTest('keeps generic CustomObject alongside named standard members', () => {
        const members = buildRetrieveMetadataMembers();
        const args = buildRetrieveMetadataArgs();

        assert.ok(members.includes('CustomObject'));
        assert.ok(args.includes('-m CustomObject'));
        assert.ok(args.includes('-m CustomObject:Account'));
        assert.ok(args.includes('-m CustomObject:Opportunity'));
        assert.ok(args.includes('-m RecordType'));
        assert.ok(args.includes('-m CustomField'));
        assert.ok(args.includes('-m Profile'));
        assert.ok(args.includes('-m ApexClass'));
    });

    await runTest('does not request Equipment__c', () => {
        const members = buildRetrieveMetadataMembers();
        const args = buildRetrieveMetadataArgs();

        assert.ok(!members.includes('Equipment__c'));
        assert.ok(!members.includes('CustomObject:Equipment__c'));
        assert.ok(!args.includes('Equipment__c'));
    });

    await runTest('summarizeRetrieveResultJson probes EMI and Maintenance_Request__c', () => {
        const summary = summarizeRetrieveResultJson(JSON.stringify({
            status: 0,
            result: {
                files: [
                    {
                        fullName: 'Equipment_Maintenance_Item__c',
                        type: 'CustomObject',
                        filePath:
                            'force-app/main/default/objects/Equipment_Maintenance_Item__c/Equipment_Maintenance_Item__c.object-meta.xml'
                    },
                    {
                        fullName: 'Training_Program__c',
                        type: 'CustomObject',
                        filePath:
                            'force-app/main/default/objects/Training_Program__c/Training_Program__c.object-meta.xml'
                    }
                ],
                failures: []
            }
        }));

        assert.strictEqual(summary.parsed, true);
        assert.strictEqual(summary.status, 0);
        assert.strictEqual(summary.fileCount, 2);
        assert.strictEqual(summary.failureCount, 0);
        assert.strictEqual(
            summary.probes.Equipment_Maintenance_Item__c,
            true
        );
        assert.strictEqual(
            summary.probes.Maintenance_Request__c,
            false
        );
    });

    await runTest('summarizeRetrieveResultJson reports failures without dumping tokens', () => {
        const summary = summarizeRetrieveResultJson(JSON.stringify({
            status: 1,
            result: {
                files: [],
                failures: [
                    { name: 'Maintenance_Request__c', message: 'Not found' }
                ]
            }
        }));

        assert.strictEqual(summary.parsed, true);
        assert.strictEqual(summary.status, 1);
        assert.strictEqual(summary.failureCount, 1);
        assert.strictEqual(
            summary.probes.Maintenance_Request__c,
            true
        );
        assert.strictEqual(
            summary.probes.Equipment_Maintenance_Item__c,
            false
        );
    });
}

main();
