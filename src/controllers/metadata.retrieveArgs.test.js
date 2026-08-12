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
    collectEmiPostRetrieveDebug,
    EXPLICIT_EMI_RETRIEVE_MEMBER,
    extractOrgIdFromOrgDisplayJson,
    inspectExplicitEmiRetrieveFilesystem,
    buildExplicitEmiRetrieveDebugPayload,
    parseDiscoveredCustomObjectNames,
    toExplicitCustomObjectMembers,
    mergeRetrieveMetadataMembers,
    buildRetrieveMetadataMembersWithDiscovery
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

    await runTest('does not hardcode EMI CustomObject member without discovery', () => {
        const members = buildRetrieveMetadataMembers();
        const args = buildRetrieveMetadataArgs();

        assert.ok(members.includes('CustomObject'));
        assert.ok(!members.includes('CustomObject:Equipment_Maintenance_Item__c'));
        assert.ok(!args.includes('CustomObject:Equipment_Maintenance_Item__c'));
        assert.ok(!args.includes('CustomObject:Maintenance_Request__c'));
    });

    await runTest('parseDiscoveredCustomObjectNames extracts unique fullNames', () => {
        const parsed = parseDiscoveredCustomObjectNames(JSON.stringify({
            status: 0,
            result: [
                { fullName: 'Account', type: 'CustomObject' },
                { fullName: 'Opportunity', type: 'CustomObject' },
                { fullName: 'Equipment_Maintenance_Item__c', type: 'CustomObject' },
                { fullName: 'Vehicle__c', type: 'CustomObject' },
                { fullName: 'Vehicle__c', type: 'CustomObject' }
            ]
        }));

        assert.deepStrictEqual(parsed.names, [
            'Account',
            'Opportunity',
            'Equipment_Maintenance_Item__c',
            'Vehicle__c'
        ]);
        assert.ok(!parsed.names.includes('Maintenance_Request__c'));
    });

    await runTest('discovered CustomObject names become explicit CustomObject members', () => {
        assert.deepStrictEqual(
            toExplicitCustomObjectMembers([
                'Equipment_Maintenance_Item__c',
                'Vehicle__c'
            ]),
            [
                'CustomObject:Equipment_Maintenance_Item__c',
                'CustomObject:Vehicle__c'
            ]
        );
    });

    await runTest('EMI is included only when discovered, not hardcoded', () => {
        const withoutDiscovery = buildRetrieveMetadataMembersWithDiscovery([]);
        const withDiscovery = buildRetrieveMetadataMembersWithDiscovery([
            'Equipment_Maintenance_Item__c',
            'Vehicle__c'
        ]);

        assert.ok(
            !withoutDiscovery.includes('CustomObject:Equipment_Maintenance_Item__c')
        );
        assert.ok(
            withDiscovery.includes('CustomObject:Equipment_Maintenance_Item__c')
        );
        assert.ok(withDiscovery.includes('CustomObject:Vehicle__c'));
        assert.ok(
            !withDiscovery.includes('CustomObject:Maintenance_Request__c')
        );
    });

    await runTest('Maintenance_Request__c is not treated as CustomObject unless discovered', () => {
        const members = buildRetrieveMetadataMembersWithDiscovery([
            'Equipment_Maintenance_Item__c'
        ]);

        assert.ok(
            members.includes('CustomObject:Equipment_Maintenance_Item__c')
        );
        assert.ok(!members.includes('CustomObject:Maintenance_Request__c'));
        assert.ok(!members.includes('Maintenance_Request__c'));
    });

    await runTest('merge removes duplicate Account and Opportunity members', () => {
        const merged = mergeRetrieveMetadataMembers({
            baseMembers: buildRetrieveMetadataMembers(),
            discoveredCustomObjectNames: [
                'Account',
                'Opportunity',
                'Equipment_Maintenance_Item__c',
                'Vehicle__c'
            ]
        });

        const accountMatches = merged.filter(
            (member) => member === 'CustomObject:Account'
        );
        const opportunityMatches = merged.filter(
            (member) => member === 'CustomObject:Opportunity'
        );

        assert.strictEqual(accountMatches.length, 1);
        assert.strictEqual(opportunityMatches.length, 1);
        assert.ok(merged.includes('CustomObject'));
        assert.ok(merged.includes('CustomObject:Account'));
        assert.ok(merged.includes('CustomObject:Opportunity'));
        assert.ok(merged.includes('CustomObject:Equipment_Maintenance_Item__c'));
        assert.ok(merged.includes('CustomObject:Vehicle__c'));
        assert.ok(merged.includes('ApexClass'));
        assert.ok(merged.includes('Profile'));
        assert.ok(merged.includes('CustomField'));
        assert.ok(merged.includes('RecordType'));
    });

    await runTest('discovery-backed args keep existing metadata types', () => {
        const args = buildRetrieveMetadataArgs(
            buildRetrieveMetadataMembersWithDiscovery([
                'Equipment_Maintenance_Item__c'
            ])
        );

        assert.ok(args.includes('-m ApexClass'));
        assert.ok(args.includes('-m CustomObject'));
        assert.ok(args.includes('-m CustomField'));
        assert.ok(args.includes('-m RecordType'));
        assert.ok(args.includes('-m Profile'));
        assert.ok(args.includes('-m CustomObject:Account'));
        assert.ok(args.includes('-m CustomObject:Opportunity'));
        assert.ok(
            args.includes('-m CustomObject:Equipment_Maintenance_Item__c')
        );
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

    await runTest('explicit EMI diagnostic member is isolated from default production retrieve args', () => {
        const args = buildRetrieveMetadataArgs();

        assert.strictEqual(
            EXPLICIT_EMI_RETRIEVE_MEMBER,
            'CustomObject:Equipment_Maintenance_Item__c'
        );
        assert.ok(args.includes('-m CustomObject'));
        assert.ok(!args.includes(EXPLICIT_EMI_RETRIEVE_MEMBER));
        assert.ok(!args.includes('CustomObject:Equipment_Maintenance_Item__c'));
    });

    await runTest('extractOrgIdFromOrgDisplayJson returns org id without exposing tokens', () => {
        const orgId = extractOrgIdFromOrgDisplayJson(JSON.stringify({
            status: 0,
            result: {
                id: '00Dd200000OVtFoEAL',
                accessToken: 'SECRET_ACCESS_TOKEN',
                refreshToken: 'SECRET_REFRESH_TOKEN',
                alias: 'temporg'
            }
        }));

        assert.strictEqual(orgId, '00Dd200000OVtFoEAL');
    });

    await runTest('inspectExplicitEmiRetrieveFilesystem reports object xml and fields', () => {
        const projectPath = fs.mkdtempSync(
            path.join(os.tmpdir(), 'emi-explicit-found-')
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

            const inspected = inspectExplicitEmiRetrieveFilesystem(projectPath);
            const payload = buildExplicitEmiRetrieveDebugPayload({
                orgId: '00Dd200000OVtFoEAL',
                exitCode: 0,
                stdout: JSON.stringify({
                    status: 0,
                    result: {
                        files: [
                            {
                                fullName: 'Equipment_Maintenance_Item__c',
                                type: 'CustomObject',
                                filePath:
                                    'force-app/main/default/objects/Equipment_Maintenance_Item__c/Equipment_Maintenance_Item__c.object-meta.xml'
                            }
                        ],
                        failures: []
                    }
                }),
                projectPath
            });

            assert.strictEqual(inspected.objectDirectoryExists, true);
            assert.strictEqual(inspected.objectFileExists, true);
            assert.strictEqual(inspected.fieldFileCount, 1);
            assert.strictEqual(payload.alias, 'temporg');
            assert.strictEqual(
                payload.conclusion,
                'Explicit member retrieval succeeds.'
            );
            assert.ok(
                !JSON.stringify(payload).includes('SECRET')
            );
        } finally {
            fs.rmSync(projectPath, { recursive: true, force: true });
        }
    });
}

main();
