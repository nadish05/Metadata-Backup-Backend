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
    parseDiscoveredStandardValueSetNames,
    toExplicitCustomObjectMembers,
    toExplicitStandardValueSetMembers,
    mergeRetrieveMetadataMembers,
    buildRetrieveMetadataMembersWithDiscovery,
    buildStandardValueSetRawResponseDebug,
    summarizeListMetadataPayloadShape,
    buildStandardValueSetParserDebug,
    STANDARD_VALUE_SET_STDOUT_PREVIEW_LIMIT,
    buildSecondStandardValueSetRetrieveMembers,
    buildSecondStandardValueSetRetrieveArgs,
    shouldSkipSecondStandardValueSetRetrieve,
    runPostFirstRetrieveStandardValueSetRetrieval
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

    await runTest('StandardValueSet is not a wildcard retrieve type', () => {
        const members = buildRetrieveMetadataMembers();

        assert.ok(!RETRIEVAL_METADATA_TYPES.includes('StandardValueSet'));
        assert.ok(!members.includes('StandardValueSet'));
        assert.ok(!members.includes('StandardValueSet:AccountSource'));
        assert.ok(!members.includes('StandardValueSet:LeadSource'));
        assert.ok(!members.includes('StandardValueSet:OpportunityStage'));
    });

    await runTest('parseDiscoveredStandardValueSetNames extracts unique members', () => {
        const parsed = parseDiscoveredStandardValueSetNames(JSON.stringify({
            status: 0,
            result: [
                { fullName: 'AccountSource', type: 'StandardValueSet' },
                { fullName: 'LeadSource', type: 'StandardValueSet' },
                { fullName: 'OpportunityStage', type: 'StandardValueSet' },
                { fullName: 'LeadSource', type: 'StandardValueSet' }
            ]
        }));

        assert.deepStrictEqual(parsed.names, [
            'AccountSource',
            'LeadSource',
            'OpportunityStage'
        ]);
    });

    await runTest('discovered StandardValueSet names become explicit members', () => {
        assert.deepStrictEqual(
            toExplicitStandardValueSetMembers([
                'AccountSource',
                'LeadSource'
            ]),
            [
                'StandardValueSet:AccountSource',
                'StandardValueSet:LeadSource'
            ]
        );
    });

    await runTest('StandardValueSet members are included only when discovered', () => {
        const withoutDiscovery = buildRetrieveMetadataMembersWithDiscovery([]);
        const withDiscovery = buildRetrieveMetadataMembersWithDiscovery(
            [],
            ['AccountSource', 'LeadSource', 'OpportunityStage']
        );

        assert.ok(!withoutDiscovery.includes('StandardValueSet:AccountSource'));
        assert.ok(!withoutDiscovery.includes('StandardValueSet'));
        assert.ok(withDiscovery.includes('StandardValueSet:AccountSource'));
        assert.ok(withDiscovery.includes('StandardValueSet:LeadSource'));
        assert.ok(withDiscovery.includes('StandardValueSet:OpportunityStage'));
        assert.ok(withDiscovery.includes('CustomObject'));
        assert.ok(withDiscovery.includes('ApexClass'));
        assert.ok(withDiscovery.includes('Profile'));
    });

    await runTest('merge keeps CustomObject discovery independent of StandardValueSet', () => {
        const merged = mergeRetrieveMetadataMembers({
            baseMembers: buildRetrieveMetadataMembers(),
            discoveredCustomObjectNames: ['Equipment_Maintenance_Item__c'],
            discoveredStandardValueSetNames: ['AccountSource']
        });

        assert.ok(merged.includes('CustomObject:Equipment_Maintenance_Item__c'));
        assert.ok(merged.includes('StandardValueSet:AccountSource'));
        assert.ok(merged.includes('CustomObject'));
        assert.ok(!merged.includes('StandardValueSet'));
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

    await runTest('StandardValueSet raw debug truncates stdout at 5000 chars', () => {
        const stdout = 'A'.repeat(STANDARD_VALUE_SET_STDOUT_PREVIEW_LIMIT + 25);
        const debug = buildStandardValueSetRawResponseDebug({
            command: 'sf org list metadata -m StandardValueSet -o temporg --json',
            exitStatus: 0,
            stdout,
            stderr: 'warn'
        });

        assert.strictEqual(debug.stdoutLength, stdout.length);
        assert.strictEqual(debug.stderrLength, 4);
        assert.strictEqual(debug.rawStdoutTruncated, true);
        assert.strictEqual(
            debug.rawStdoutPreview.length,
            STANDARD_VALUE_SET_STDOUT_PREVIEW_LIMIT
        );
        assert.strictEqual(debug.exitStatus, 0);
    });

    await runTest('StandardValueSet shape debug reports array result without inventing keys', () => {
        const shape = summarizeListMetadataPayloadShape(JSON.stringify({
            status: 0,
            result: [
                { fullName: 'AccountSource', type: 'StandardValueSet' }
            ]
        }));

        assert.strictEqual(shape.parsed, true);
        assert.strictEqual(shape.resultIsArray, true);
        assert.strictEqual(shape.resultLength, 1);
        assert.ok(!Object.prototype.hasOwnProperty.call(shape, 'resultKeys'));
        assert.ok(!Object.prototype.hasOwnProperty.call(shape, 'metadataIsArray'));
        assert.deepStrictEqual(shape.firstItemKeys, ['fullName', 'type']);
        assert.strictEqual(shape.firstItem.fullName, 'AccountSource');
    });

    await runTest('StandardValueSet shape debug reports object result keys', () => {
        const shape = summarizeListMetadataPayloadShape(JSON.stringify({
            status: 0,
            result: {
                records: [{ fullName: 'AccountSource' }]
            }
        }));

        assert.strictEqual(shape.parsed, true);
        assert.strictEqual(shape.resultIsArray, false);
        assert.deepStrictEqual(shape.resultKeys, ['records']);
        assert.ok(!Object.prototype.hasOwnProperty.call(shape, 'resultLength'));
        assert.ok(!Object.prototype.hasOwnProperty.call(shape, 'metadataIsArray'));
    });

    await runTest('StandardValueSet parser debug previews at most 20 names and does not alter them', () => {
        const names = Array.from({ length: 25 }, (_, index) => `ValueSet${index}`);
        const debug = buildStandardValueSetParserDebug({
            names,
            strategy: 'explicit_discovered_standard_value_sets',
            errorMessage: null
        });

        assert.strictEqual(debug.parsedNameCount, 25);
        assert.strictEqual(debug.parsedNamesPreview.length, 20);
        assert.strictEqual(debug.parsedNamesPreview[0], 'ValueSet0');
        assert.strictEqual(names.length, 25);

        const empty = buildStandardValueSetParserDebug({
            names: [],
            strategy: 'discovery_empty_fallback',
            errorMessage: null
        });
        assert.strictEqual(empty.parsedNameCount, 0);
        assert.deepStrictEqual(empty.parsedNamesPreview, []);
        assert.strictEqual(empty.strategy, 'discovery_empty_fallback');
        assert.strictEqual(empty.errorMessage, null);
    });

    await runTest('first retrieve member list remains unchanged without StandardValueSet', () => {
        const members = buildRetrieveMetadataMembers();
        const args = buildRetrieveMetadataArgs(members);
        const withEmptyDiscovery = buildRetrieveMetadataMembersWithDiscovery(
            [],
            []
        );

        assert.ok(members.includes('ApexClass'));
        assert.ok(members.includes('Profile'));
        assert.ok(members.includes('PermissionSet'));
        assert.ok(members.includes('CustomObject'));
        assert.ok(members.includes('RecordType'));
        assert.ok(!RETRIEVAL_METADATA_TYPES.includes('StandardValueSet'));
        assert.ok(!members.includes('StandardValueSet'));
        assert.ok(!args.includes('-m StandardValueSet'));
        assert.ok(!args.includes('-m StandardValueSet:'));
        assert.deepStrictEqual(withEmptyDiscovery, members);
    });

    await runTest('one discovered member becomes an explicit second-retrieve member', () => {
        const members = buildSecondStandardValueSetRetrieveMembers([
            'AccountSource'
        ]);
        const args = buildSecondStandardValueSetRetrieveArgs(['AccountSource']);

        assert.deepStrictEqual(members, ['StandardValueSet:AccountSource']);
        assert.strictEqual(args, '-m StandardValueSet:AccountSource');
        assert.ok(!args.includes('-m StandardValueSet '));
        assert.ok(!shouldSkipSecondStandardValueSetRetrieve(['AccountSource']));
    });

    await runTest('multiple discovered members are all passed explicitly', () => {
        const members = buildSecondStandardValueSetRetrieveMembers([
            'AccountSource',
            'LeadSource',
            'OpportunityStage'
        ]);
        const args = buildRetrieveMetadataArgs(members);

        assert.deepStrictEqual(members, [
            'StandardValueSet:AccountSource',
            'StandardValueSet:LeadSource',
            'StandardValueSet:OpportunityStage'
        ]);
        assert.ok(args.includes('-m StandardValueSet:AccountSource'));
        assert.ok(args.includes('-m StandardValueSet:LeadSource'));
        assert.ok(args.includes('-m StandardValueSet:OpportunityStage'));
        assert.ok(!args.split(' ').includes('StandardValueSet'));
    });

    await runTest('second retrieve never passes wildcard StandardValueSet', () => {
        const members = buildSecondStandardValueSetRetrieveMembers([
            'AccountSource'
        ]);
        const args = buildRetrieveMetadataArgs(members);

        assert.deepStrictEqual(members, ['StandardValueSet:AccountSource']);
        assert.ok(!members.includes('StandardValueSet'));
        assert.ok(!RETRIEVAL_METADATA_TYPES.includes('StandardValueSet'));
        assert.ok(args.includes('-m StandardValueSet:AccountSource'));
        assert.ok(!/(^|\s)-m StandardValueSet(\s|$)/.test(` ${args} `));
    });

    await runTest('zero StandardValueSet dependencies skip the second retrieve', async () => {
        let execCalled = false;

        const result = await runPostFirstRetrieveStandardValueSetRetrieval({
            projectPath: '/tmp/unused-project',
            discoverNamesFn: async () => [],
            execFn: async () => {
                execCalled = true;
                throw new Error('second retrieve must not run');
            }
        });

        assert.strictEqual(result.skipped, true);
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.members, []);
        assert.strictEqual(execCalled, false);
        assert.strictEqual(shouldSkipSecondStandardValueSetRetrieve([]), true);
    });

    await runTest('second retrieve receives explicit members from discovered names', async () => {
        let executedCommand = null;

        const result = await runPostFirstRetrieveStandardValueSetRetrieval({
            projectPath: '/tmp/backup-project',
            alias: 'temporg',
            discoverNamesFn: async () => ['AccountSource', 'LeadSource'],
            execFn: async (command) => {
                executedCommand = command;
                return {
                    stdout: JSON.stringify({ status: 0, result: { files: [] } }),
                    stderr: ''
                };
            }
        });

        assert.strictEqual(result.skipped, false);
        assert.strictEqual(result.success, true);
        assert.deepStrictEqual(result.members, [
            'StandardValueSet:AccountSource',
            'StandardValueSet:LeadSource'
        ]);
        assert.ok(executedCommand.includes('-m StandardValueSet:AccountSource'));
        assert.ok(executedCommand.includes('-m StandardValueSet:LeadSource'));
        assert.ok(executedCommand.includes('-o temporg'));
        assert.ok(executedCommand.includes('sf project retrieve start'));
        assert.ok(!/(^|\s)-m StandardValueSet(\s|$)/.test(` ${executedCommand} `));
    });

    await runTest('second retrieve CLI failure is surfaced and not marked successful', async () => {
        let completedSuccessfully = false;

        try {
            await runPostFirstRetrieveStandardValueSetRetrieval({
                projectPath: '/tmp/backup-project',
                discoverNamesFn: async () => ['AccountSource'],
                execFn: async () => {
                    const error = new Error('retrieve failed');
                    error.stdout = JSON.stringify({
                        status: 1,
                        result: { files: [], failures: [{ message: 'missing' }] }
                    });
                    error.stderr = 'CLI retrieve failed';
                    throw error;
                }
            });
            completedSuccessfully = true;
        } catch (error) {
            assert.strictEqual(error.message, 'retrieve failed');
        }

        assert.strictEqual(completedSuccessfully, false);
    });

    await runTest('second retrieve non-zero JSON status fails the migration retrieve', async () => {
        let completedSuccessfully = false;

        try {
            await runPostFirstRetrieveStandardValueSetRetrieval({
                projectPath: '/tmp/backup-project',
                discoverNamesFn: async () => ['LeadSource'],
                execFn: async () => ({
                    stdout: JSON.stringify({
                        status: 1,
                        result: { files: [], failures: [{ message: 'denied' }] }
                    }),
                    stderr: ''
                })
            });
            completedSuccessfully = true;
        } catch (error) {
            assert.strictEqual(
                error.message,
                'Salesforce CLI retrieve reported status 1'
            );
        }

        assert.strictEqual(completedSuccessfully, false);
    });

    await runTest('Git add occurs after retrieveMetadataInternal in runMigration', () => {
        const githubSource = fs.readFileSync(
            path.join(__dirname, 'github.controller.js'),
            'utf8'
        );
        const controllerSource = fs.readFileSync(
            path.join(__dirname, 'metadata.controller.js'),
            'utf8'
        );

        const retrieveCallIndex = githubSource.indexOf(
            'retrieveMetadataInternal('
        );
        const gitAddIndex = githubSource.indexOf('git add .');
        const secondRetrieveIndex = controllerSource.indexOf(
            'await runPostFirstRetrieveStandardValueSetRetrieval('
        );
        const stepCompleteIndex = controllerSource.indexOf(
            "console.log('STEP 5 COMPLETE')"
        );

        assert.ok(retrieveCallIndex >= 0, 'expected retrieveMetadataInternal call');
        assert.ok(gitAddIndex > retrieveCallIndex, 'git add must follow retrieve');
        assert.ok(
            secondRetrieveIndex >= 0,
            'expected post-first-retrieve StandardValueSet retrieve'
        );
        assert.ok(
            stepCompleteIndex > secondRetrieveIndex,
            'second retrieve must complete before retrieveMetadataInternal returns'
        );
    });
}

main();
