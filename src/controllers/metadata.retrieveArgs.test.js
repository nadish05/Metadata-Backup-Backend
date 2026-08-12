const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    RETRIEVAL_METADATA_TYPES,
    RETRIEVAL_STANDARD_OBJECT_MEMBERS,
    buildRetrieveMetadataMembers,
    buildRetrieveMetadataArgs,
    summarizeRetrieveResultJson,
    collectEmiPostRetrieveDebug
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

    await runTest('does not add explicit EMI CustomObject member to retrieve args', () => {
        const members = buildRetrieveMetadataMembers();
        const args = buildRetrieveMetadataArgs();

        assert.ok(members.includes('CustomObject'));
        assert.ok(!members.includes('CustomObject:Equipment_Maintenance_Item__c'));
        assert.ok(!args.includes('CustomObject:Equipment_Maintenance_Item__c'));
        assert.ok(!args.includes('CustomObject:Maintenance_Request__c'));
    });

    await runTest('collectEmiPostRetrieveDebug reports missing EMI directory', () => {
        const projectPath = fs.mkdtempSync(
            path.join(os.tmpdir(), 'emi-post-retrieve-missing-')
        );

        try {
            const debug = collectEmiPostRetrieveDebug(projectPath);

            assert.strictEqual(debug.emiObjectDirectoryExists, false);
            assert.deepStrictEqual(debug.emiFiles, []);
            assert.deepStrictEqual(debug.maintenanceRequestMatches, []);
            assert.ok(
                debug.emiObjectDirectory.endsWith(
                    path.join(
                        'objects',
                        'Equipment_Maintenance_Item__c'
                    )
                )
            );
        } finally {
            fs.rmSync(projectPath, { recursive: true, force: true });
        }
    });

    await runTest('collectEmiPostRetrieveDebug lists EMI files and Maintenance_Request field path', () => {
        const projectPath = fs.mkdtempSync(
            path.join(os.tmpdir(), 'emi-post-retrieve-found-')
        );

        try {
            const emiDir = path.join(
                projectPath,
                'force-app',
                'main',
                'default',
                'objects',
                'Equipment_Maintenance_Item__c'
            );
            const fieldsDir = path.join(emiDir, 'fields');
            fs.mkdirSync(fieldsDir, { recursive: true });
            fs.writeFileSync(
                path.join(emiDir, 'Equipment_Maintenance_Item__c.object-meta.xml'),
                '<CustomObject/>'
            );
            fs.writeFileSync(
                path.join(fieldsDir, 'Maintenance_Request__c.field-meta.xml'),
                '<CustomField/>'
            );

            const debug = collectEmiPostRetrieveDebug(projectPath);

            assert.strictEqual(debug.emiObjectDirectoryExists, true);
            assert.ok(
                debug.emiFiles.includes(
                    'force-app/main/default/objects/Equipment_Maintenance_Item__c/Equipment_Maintenance_Item__c.object-meta.xml'
                )
            );
            assert.ok(
                debug.emiFiles.includes(
                    'force-app/main/default/objects/Equipment_Maintenance_Item__c/fields/Maintenance_Request__c.field-meta.xml'
                )
            );
            assert.ok(
                debug.maintenanceRequestMatches.includes(
                    'force-app/main/default/objects/Equipment_Maintenance_Item__c/fields/Maintenance_Request__c.field-meta.xml'
                )
            );
            assert.ok(
                !debug.emiFiles.some((file) => file.includes('Equipment__c'))
            );
        } finally {
            fs.rmSync(projectPath, { recursive: true, force: true });
        }
    });
}

main();
