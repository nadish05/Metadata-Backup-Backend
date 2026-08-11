/**
 * Phase 19.2 / 19.3 / 19.4 / 19.5 — ProfileRelationshipDiscoverer tests.
 * objectPermissions + fieldPermissions + recordTypeVisibilities + tabVisibilities.
 * Does not change PermissionSet discovery.
 */

'use strict';

const assert = require('assert');

const profileRelationshipDiscoverer = require('./profileRelationship.discoverer');
const permissionSetRelationshipDiscoverer = require('./permissionSetRelationship.discoverer');
const {
    getRegisteredDiscoverers
} = require('../relationshipRegistry');

const PROFILE_PATH =
    'force-app/main/default/profiles/Custom_Admin.profile-meta.xml';
const PERMISSION_SET_PATH =
    'force-app/main/default/permissionsets/Subscription_Access.permissionset-meta.xml';

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

async function discoverProfile(xml, selectedMetadata = null) {
    return profileRelationshipDiscoverer.discover({
        selectedMetadata:
            selectedMetadata ||
            [
                {
                    metadataType: 'Profile',
                    metadataName: 'Custom_Admin',
                    filePath: PROFILE_PATH
                }
            ],
        repoFiles: [PROFILE_PATH],
        readRepoFile: async () => xml,
        depth: 1
    });
}

function byType(result, metadataType) {
    return result.relationships.filter(
        (relationship) => relationship.metadataType === metadataType
    );
}

async function main() {
    await runTest('TEST 1 — single custom object', async () => {
        const result = await discoverProfile(`
            <Profile>
                <objectPermissions>
                    <object>MyObject__c</object>
                    <allowRead>true</allowRead>
                </objectPermissions>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, [
            {
                name: 'MyObject__c',
                metadataType: 'CustomObject',
                type: 'CustomObject',
                relationship: 'ProfileObjectPermission',
                sourceMetadata: 'Custom_Admin',
                sourceField: null,
                discoveredBy: 'ProfileRelationshipDiscoverer',
                discoveryMethod: 'objectPermissions',
                required: true,
                selected: true,
                depth: 1,
                reason: 'Profile object permission'
            }
        ]);
    });

    await runTest('TEST 2 — multiple custom objects', async () => {
        const result = await discoverProfile(`
            <Profile>
                <objectPermissions>
                    <object>ObjectA__c</object>
                </objectPermissions>
                <objectPermissions>
                    <object>ObjectB__c</object>
                </objectPermissions>
                <objectPermissions>
                    <object>ObjectC__c</object>
                </objectPermissions>
            </Profile>
        `);

        assert.deepStrictEqual(
            result.relationships.map((item) => item.name).sort(),
            ['ObjectA__c', 'ObjectB__c', 'ObjectC__c']
        );
        assert.ok(
            result.relationships.every(
                (item) =>
                    item.metadataType === 'CustomObject' &&
                    item.relationship === 'ProfileObjectPermission'
            )
        );
    });

    await runTest('TEST 3 — duplicate object', async () => {
        const result = await discoverProfile(`
            <Profile>
                <objectPermissions>
                    <object>ObjectA__c</object>
                </objectPermissions>
                <objectPermissions>
                    <object>ObjectA__c</object>
                </objectPermissions>
            </Profile>
        `);

        assert.strictEqual(result.relationships.length, 1);
        assert.strictEqual(result.relationships[0].name, 'ObjectA__c');
    });

    await runTest('TEST 4 — standard objects ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <objectPermissions>
                    <object>Account</object>
                </objectPermissions>
                <objectPermissions>
                    <object>Contact</object>
                </objectPermissions>
                <objectPermissions>
                    <object>Case</object>
                </objectPermissions>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TEST 5 — malformed / empty ignored safely', async () => {
        const result = await discoverProfile(`
            <Profile>
                <objectPermissions>
                    <object></object>
                </objectPermissions>
                <objectPermissions>
                    <object> </object>
                </objectPermissions>
                <objectPermissions>
                    <object>NotAValidName</object>
                </objectPermissions>
                <objectPermissions>
                    <allowRead>true</allowRead>
                </objectPermissions>
                <objectPermissions>
                    <object>Bad Object__c</object>
                </objectPermissions>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest(
        'TEST 6 — disabled permissions still discover',
        async () => {
            const result = await discoverProfile(`
                <Profile>
                    <objectPermissions>
                        <object>Invoice__c</object>
                        <allowRead>false</allowRead>
                        <allowCreate>false</allowCreate>
                        <allowEdit>false</allowEdit>
                        <allowDelete>false</allowDelete>
                        <viewAllRecords>false</viewAllRecords>
                        <modifyAllRecords>false</modifyAllRecords>
                    </objectPermissions>
                </Profile>
            `);

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(result.relationships[0].name, 'Invoice__c');
            assert.strictEqual(
                result.relationships[0].relationship,
                'ProfileObjectPermission'
            );
        }
    );

    await runTest('TEST 7 — Profile only; PermissionSet ignored', async () => {
        const profileXml = `
            <Profile>
                <objectPermissions>
                    <object>Invoice__c</object>
                </objectPermissions>
            </Profile>
        `;

        const profileResult = await discoverProfile(profileXml);
        assert.strictEqual(profileResult.relationships.length, 1);
        assert.strictEqual(
            profileResult.relationships[0].discoveredBy,
            'ProfileRelationshipDiscoverer'
        );

        const permissionSetAsSelected = await profileRelationshipDiscoverer.discover(
            {
                selectedMetadata: [
                    {
                        metadataType: 'PermissionSet',
                        metadataName: 'Subscription_Access',
                        filePath: PERMISSION_SET_PATH
                    }
                ],
                repoFiles: [PERMISSION_SET_PATH],
                readRepoFile: async () => `
                    <PermissionSet>
                        <objectPermissions>
                            <object>Gym_Trainer__c</object>
                        </objectPermissions>
                    </PermissionSet>
                `,
                depth: 1
            }
        );

        assert.deepStrictEqual(permissionSetAsSelected.relationships, []);
        assert.strictEqual(permissionSetAsSelected.metadataScanned, 0);

        const psResult = await permissionSetRelationshipDiscoverer.discover({
            selectedMetadata: [
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Subscription_Access',
                    filePath: PERMISSION_SET_PATH
                }
            ],
            repoFiles: [PERMISSION_SET_PATH],
            readRepoFile: async () => `
                <PermissionSet>
                    <objectPermissions>
                        <object>Gym_Trainer__c</object>
                    </objectPermissions>
                </PermissionSet>
            `,
            depth: 1
        });

        assert.strictEqual(psResult.relationships.length, 1);
        assert.strictEqual(
            psResult.relationships[0].relationship,
            'PermissionSetObjectPermission'
        );
        assert.strictEqual(
            psResult.relationships[0].discoveredBy,
            'PermissionSetRelationshipDiscoverer'
        );
    });

    await runTest('registry registers ProfileRelationshipDiscoverer', () => {
        const ids = getRegisteredDiscoverers().map((d) => d.id);
        assert.ok(ids.includes('ProfileRelationshipDiscoverer'));
        assert.ok(ids.includes('PermissionSetRelationshipDiscoverer'));
    });

    await runTest(
        'does not invent other Profile sections in this phase',
        async () => {
            const result = await discoverProfile(`
                <Profile>
                    <classAccesses>
                        <apexClass>SessionController</apexClass>
                        <enabled>true</enabled>
                    </classAccesses>
                    <pageAccesses>
                        <apexPage>Weather_Dashboard</apexPage>
                        <enabled>true</enabled>
                    </pageAccesses>
                    <flowAccesses>
                        <flow>Weather_Sync_Flow</flow>
                        <enabled>true</enabled>
                    </flowAccesses>
                </Profile>
            `);

            assert.deepStrictEqual(result.relationships, []);
        }
    );

    // --- Phase 19.3 fieldPermissions ---

    await runTest('FP1 — single custom field', async () => {
        const result = await discoverProfile(`
            <Profile>
                <fieldPermissions>
                    <field>Invoice__c.Amount__c</field>
                    <editable>true</editable>
                    <readable>true</readable>
                </fieldPermissions>
            </Profile>
        `);

        assert.deepStrictEqual(
            result.relationships.map((item) => [
                item.metadataType,
                item.name,
                item.relationship
            ]),
            [
                [
                    'CustomObject',
                    'Invoice__c',
                    'ProfileFieldPermissionObject'
                ],
                [
                    'CustomField',
                    'Invoice__c.Amount__c',
                    'ProfileFieldPermission'
                ]
            ]
        );
        assert.ok(
            result.relationships.every(
                (item) =>
                    item.discoveredBy === 'ProfileRelationshipDiscoverer' &&
                    item.discoveryMethod === 'fieldPermissions'
            )
        );
    });

    await runTest('FP2 — multiple fields', async () => {
        const result = await discoverProfile(`
            <Profile>
                <fieldPermissions>
                    <field>Invoice__c.Amount__c</field>
                </fieldPermissions>
                <fieldPermissions>
                    <field>Invoice__c.Status__c</field>
                </fieldPermissions>
                <fieldPermissions>
                    <field>Order__c.Total__c</field>
                </fieldPermissions>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomObject').length, 2);
        assert.deepStrictEqual(
            byType(result, 'CustomObject')
                .map((item) => item.name)
                .sort(),
            ['Invoice__c', 'Order__c']
        );
        assert.strictEqual(byType(result, 'CustomField').length, 3);
        assert.deepStrictEqual(
            byType(result, 'CustomField')
                .map((item) => item.name)
                .sort(),
            [
                'Invoice__c.Amount__c',
                'Invoice__c.Status__c',
                'Order__c.Total__c'
            ]
        );
    });

    await runTest('FP3 — duplicate field', async () => {
        const result = await discoverProfile(`
            <Profile>
                <fieldPermissions>
                    <field>Invoice__c.Amount__c</field>
                </fieldPermissions>
                <fieldPermissions>
                    <field>Invoice__c.Amount__c</field>
                </fieldPermissions>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomObject').length, 1);
        assert.strictEqual(byType(result, 'CustomField').length, 1);
        assert.strictEqual(
            byType(result, 'CustomField')[0].name,
            'Invoice__c.Amount__c'
        );
    });

    await runTest(
        'FP4 — parent object deduplication with objectPermissions',
        async () => {
            const result = await discoverProfile(`
                <Profile>
                    <objectPermissions>
                        <object>Invoice__c</object>
                    </objectPermissions>
                    <fieldPermissions>
                        <field>Invoice__c.Amount__c</field>
                    </fieldPermissions>
                </Profile>
            `);

            assert.strictEqual(byType(result, 'CustomObject').length, 1);
            assert.strictEqual(
                byType(result, 'CustomObject')[0].name,
                'Invoice__c'
            );
            // First write wins — objectPermissions relationship name retained.
            assert.strictEqual(
                byType(result, 'CustomObject')[0].relationship,
                'ProfileObjectPermission'
            );
            assert.strictEqual(byType(result, 'CustomField').length, 1);
            assert.strictEqual(
                byType(result, 'CustomField')[0].name,
                'Invoice__c.Amount__c'
            );
        }
    );

    await runTest('FP5 — malformed field references ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <fieldPermissions><field></field></fieldPermissions>
                <fieldPermissions><field> </field></fieldPermissions>
                <fieldPermissions><field>Object__c</field></fieldPermissions>
                <fieldPermissions><field>Object__c.</field></fieldPermissions>
                <fieldPermissions><field>.Field__c</field></fieldPermissions>
                <fieldPermissions><field>A.B.C</field></fieldPermissions>
                <fieldPermissions><field>Object__c.Field</field></fieldPermissions>
                <fieldPermissions><field>Object__c.Field__c.Extra</field></fieldPermissions>
                <fieldPermissions><field>Bad Object__c.Amount__c</field></fieldPermissions>
                <fieldPermissions><field>Object__c.Bad Field__c</field></fieldPermissions>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('FP6 — standard object field ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <fieldPermissions>
                    <field>Account.CustomField__c</field>
                </fieldPermissions>
                <fieldPermissions>
                    <field>Account.Name</field>
                </fieldPermissions>
                <fieldPermissions>
                    <field>Contact.CustomField__c</field>
                </fieldPermissions>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest(
        'FP7 — disabled readable/editable still discover',
        async () => {
            const result = await discoverProfile(`
                <Profile>
                    <fieldPermissions>
                        <field>Invoice__c.Amount__c</field>
                        <editable>false</editable>
                        <readable>false</readable>
                    </fieldPermissions>
                </Profile>
            `);

            assert.strictEqual(byType(result, 'CustomObject').length, 1);
            assert.strictEqual(byType(result, 'CustomField').length, 1);
            assert.strictEqual(
                byType(result, 'CustomField')[0].relationship,
                'ProfileFieldPermission'
            );
        }
    );

    await runTest('FP8 — Profile-only fieldPermissions XML', async () => {
        const result = await discoverProfile(`
            <Profile xmlns="http://soap.sforce.com/2006/04/metadata">
                <fieldPermissions>
                    <field>Invoice__c.Amount__c</field>
                </fieldPermissions>
            </Profile>
        `);

        assert.strictEqual(result.relationships.length, 2);
        assert.ok(
            result.relationships.every(
                (item) => item.sourceMetadata === 'Custom_Admin'
            )
        );
    });

    // --- Phase 19.4 recordTypeVisibilities ---

    await runTest('RT1 — single RecordType', async () => {
        const result = await discoverProfile(`
            <Profile>
                <recordTypeVisibilities>
                    <recordType>Account.Customer</recordType>
                    <visible>true</visible>
                </recordTypeVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, [
            {
                name: 'Account.Customer',
                metadataType: 'RecordType',
                type: 'RecordType',
                relationship: 'ProfileRecordTypeVisibility',
                sourceMetadata: 'Custom_Admin',
                sourceField: 'recordType',
                discoveredBy: 'ProfileRelationshipDiscoverer',
                discoveryMethod: 'recordTypeVisibilities',
                required: true,
                selected: true,
                depth: 1,
                reason: 'Profile record type visibility'
            }
        ]);
    });

    await runTest('RT2 — multiple RecordTypes', async () => {
        const result = await discoverProfile(`
            <Profile>
                <recordTypeVisibilities>
                    <recordType>Account.Customer</recordType>
                </recordTypeVisibilities>
                <recordTypeVisibilities>
                    <recordType>Contact.Person</recordType>
                </recordTypeVisibilities>
                <recordTypeVisibilities>
                    <recordType>Invoice__c.Retail</recordType>
                </recordTypeVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(
            byType(result, 'RecordType')
                .map((item) => item.name)
                .sort(),
            ['Account.Customer', 'Contact.Person', 'Invoice__c.Retail']
        );
        assert.ok(
            byType(result, 'RecordType').every(
                (item) => item.relationship === 'ProfileRecordTypeVisibility'
            )
        );
    });

    await runTest('RT3 — duplicate RecordType', async () => {
        const result = await discoverProfile(`
            <Profile>
                <recordTypeVisibilities>
                    <recordType>Account.Customer</recordType>
                </recordTypeVisibilities>
                <recordTypeVisibilities>
                    <recordType>Account.Customer</recordType>
                </recordTypeVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'RecordType').length, 1);
        assert.strictEqual(
            byType(result, 'RecordType')[0].name,
            'Account.Customer'
        );
    });

    await runTest('RT4 — no parent CustomObject from this section', async () => {
        const result = await discoverProfile(`
            <Profile>
                <recordTypeVisibilities>
                    <recordType>Invoice__c.Retail</recordType>
                </recordTypeVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'RecordType').length, 1);
        assert.strictEqual(byType(result, 'CustomObject').length, 0);
        assert.strictEqual(byType(result, 'CustomField').length, 0);
    });

    await runTest('RT5 — malformed references ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <recordTypeVisibilities><recordType></recordType></recordTypeVisibilities>
                <recordTypeVisibilities><recordType> </recordType></recordTypeVisibilities>
                <recordTypeVisibilities><recordType>ObjectOnly</recordType></recordTypeVisibilities>
                <recordTypeVisibilities><recordType>Object__c.</recordType></recordTypeVisibilities>
                <recordTypeVisibilities><recordType>.RecordType</recordType></recordTypeVisibilities>
                <recordTypeVisibilities><recordType>A.B.C</recordType></recordTypeVisibilities>
                <recordTypeVisibilities><recordType>Object Name.RecordType</recordType></recordTypeVisibilities>
                <recordTypeVisibilities><recordType>Object__c.Record Type</recordType></recordTypeVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('RT6 — standard object RecordType emitted', async () => {
        const result = await discoverProfile(`
            <Profile>
                <recordTypeVisibilities>
                    <recordType>Account.Customer</recordType>
                </recordTypeVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(
            byType(result, 'RecordType').map((item) => item.name),
            ['Account.Customer']
        );
        assert.strictEqual(byType(result, 'CustomObject').length, 0);
    });

    await runTest('RT7 — visible/default false still discover', async () => {
        const result = await discoverProfile(`
            <Profile>
                <recordTypeVisibilities>
                    <recordType>Account.Customer</recordType>
                    <visible>false</visible>
                    <default>false</default>
                    <personAccountDefault>false</personAccountDefault>
                </recordTypeVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'RecordType').length, 1);
        assert.strictEqual(
            byType(result, 'RecordType')[0].name,
            'Account.Customer'
        );
    });

    await runTest('RT8 — coexistence with objectPermissions', async () => {
        const result = await discoverProfile(`
            <Profile>
                <objectPermissions>
                    <object>Invoice__c</object>
                </objectPermissions>
                <recordTypeVisibilities>
                    <recordType>Invoice__c.Retail</recordType>
                </recordTypeVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomObject').length, 1);
        assert.strictEqual(byType(result, 'CustomObject')[0].name, 'Invoice__c');
        assert.strictEqual(
            byType(result, 'CustomObject')[0].relationship,
            'ProfileObjectPermission'
        );
        assert.strictEqual(byType(result, 'RecordType').length, 1);
        assert.strictEqual(
            byType(result, 'RecordType')[0].name,
            'Invoice__c.Retail'
        );
    });

    await runTest('RT9 — coexistence with fieldPermissions', async () => {
        const result = await discoverProfile(`
            <Profile>
                <fieldPermissions>
                    <field>Invoice__c.Amount__c</field>
                </fieldPermissions>
                <recordTypeVisibilities>
                    <recordType>Invoice__c.Retail</recordType>
                </recordTypeVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomObject').length, 1);
        assert.strictEqual(byType(result, 'CustomField').length, 1);
        assert.strictEqual(byType(result, 'RecordType').length, 1);
        assert.strictEqual(
            byType(result, 'CustomField')[0].name,
            'Invoice__c.Amount__c'
        );
        assert.strictEqual(
            byType(result, 'RecordType')[0].name,
            'Invoice__c.Retail'
        );
    });

    await runTest('RT10 — Profile-only RecordType XML', async () => {
        const result = await discoverProfile(`
            <Profile xmlns="http://soap.sforce.com/2006/04/metadata">
                <recordTypeVisibilities>
                    <recordType>Invoice__c.Retail</recordType>
                </recordTypeVisibilities>
            </Profile>
        `);

        assert.strictEqual(result.relationships.length, 1);
        assert.strictEqual(
            result.relationships[0].discoveredBy,
            'ProfileRelationshipDiscoverer'
        );
        assert.strictEqual(
            result.relationships[0].relationship,
            'ProfileRecordTypeVisibility'
        );
    });

    // --- Phase 19.5 tabVisibilities ---

    await runTest('TV1 — single valid tab', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, [
            {
                name: 'My_Custom_Tab',
                metadataType: 'CustomTab',
                type: 'CustomTab',
                relationship: 'ProfileTabVisibility',
                sourceMetadata: 'Custom_Admin',
                sourceField: null,
                discoveredBy: 'ProfileRelationshipDiscoverer',
                discoveryMethod: 'tabVisibilities',
                required: true,
                selected: true,
                depth: 1,
                reason: 'Profile tab visibility'
            }
        ]);
    });

    await runTest('TV2 — multiple valid tabs', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
                <tabVisibilities>
                    <tab>Invoice__c</tab>
                    <visibility>Hidden</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(
            byType(result, 'CustomTab').map((item) => item.name).sort(),
            ['Invoice__c', 'My_Custom_Tab']
        );
        assert.strictEqual(result.relationships.length, 2);
    });

    await runTest('TV3 — duplicate tab → one CustomTab', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Hidden</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomTab').length, 1);
        assert.strictEqual(byType(result, 'CustomTab')[0].name, 'My_Custom_Tab');
    });

    await runTest('TV4 — visibility Visible → discovered', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomTab').length, 1);
    });

    await runTest('TV5 — visibility Hidden → discovered', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Hidden</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomTab').length, 1);
    });

    await runTest('TV6 — DefaultOn → discovered', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>DefaultOn</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomTab').length, 1);
    });

    await runTest('TV6b — DefaultOff → discovered', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>DefaultOff</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomTab').length, 1);
    });

    await runTest('TV7 — empty tab ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab></tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TV8 — whitespace tab ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>   </tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TV9 — tab with spaces ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>Invalid Name</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TV10 — tab with dots ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>A.B</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
                <tabVisibilities>
                    <tab>A.B.C</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TV11 — tab with hyphens ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>standard-Account</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TV12 — Account ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>Account</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TV13 — Contact ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>Contact</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TV14 — CustomTab without _ or __c ignored', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>CustomTab</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('TV15 — My_Custom_Tab accepted', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomTab')[0].name, 'My_Custom_Tab');
    });

    await runTest('TV16 — Object__c accepted', async () => {
        const result = await discoverProfile(`
            <Profile>
                <tabVisibilities>
                    <tab>Object__c</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomTab')[0].name, 'Object__c');
    });

    await runTest('TV17 — Profile-only tabVisibilities XML', async () => {
        const result = await discoverProfile(`
            <Profile xmlns="http://soap.sforce.com/2006/04/metadata">
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(result.relationships.length, 1);
        assert.strictEqual(
            result.relationships[0].discoveredBy,
            'ProfileRelationshipDiscoverer'
        );
        assert.strictEqual(
            result.relationships[0].relationship,
            'ProfileTabVisibility'
        );
    });

    await runTest('TV18 — coexists with objectPermissions', async () => {
        const result = await discoverProfile(`
            <Profile>
                <objectPermissions>
                    <object>Invoice__c</object>
                    <allowRead>true</allowRead>
                </objectPermissions>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomObject').length, 1);
        assert.strictEqual(byType(result, 'CustomTab').length, 1);
        assert.strictEqual(byType(result, 'CustomTab')[0].name, 'My_Custom_Tab');
    });

    await runTest('TV19 — coexists with fieldPermissions', async () => {
        const result = await discoverProfile(`
            <Profile>
                <fieldPermissions>
                    <field>Invoice__c.Amount__c</field>
                    <readable>true</readable>
                </fieldPermissions>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'CustomObject').length, 1);
        assert.strictEqual(byType(result, 'CustomField').length, 1);
        assert.strictEqual(byType(result, 'CustomTab').length, 1);
    });

    await runTest('TV20 — coexists with recordTypeVisibilities', async () => {
        const result = await discoverProfile(`
            <Profile>
                <recordTypeVisibilities>
                    <recordType>Invoice__c.Retail</recordType>
                    <visible>true</visible>
                </recordTypeVisibilities>
                <tabVisibilities>
                    <tab>My_Custom_Tab</tab>
                    <visibility>Visible</visibility>
                </tabVisibilities>
            </Profile>
        `);

        assert.strictEqual(byType(result, 'RecordType').length, 1);
        assert.strictEqual(byType(result, 'CustomTab').length, 1);
        assert.strictEqual(
            byType(result, 'RecordType')[0].name,
            'Invoice__c.Retail'
        );
    });

    await runTest(
        'TV21 — all Profile sections coexist with tabVisibilities',
        async () => {
            const result = await discoverProfile(`
                <Profile>
                    <objectPermissions>
                        <object>Invoice__c</object>
                        <allowRead>true</allowRead>
                    </objectPermissions>
                    <fieldPermissions>
                        <field>Invoice__c.Amount__c</field>
                        <readable>true</readable>
                    </fieldPermissions>
                    <recordTypeVisibilities>
                        <recordType>Invoice__c.Retail</recordType>
                        <visible>true</visible>
                    </recordTypeVisibilities>
                    <tabVisibilities>
                        <tab>My_Custom_Tab</tab>
                        <visibility>Visible</visibility>
                    </tabVisibilities>
                </Profile>
            `);

            assert.strictEqual(byType(result, 'CustomObject').length, 1);
            assert.strictEqual(byType(result, 'CustomField').length, 1);
            assert.strictEqual(byType(result, 'RecordType').length, 1);
            assert.strictEqual(byType(result, 'CustomTab').length, 1);
            assert.strictEqual(
                byType(result, 'CustomTab')[0].relationship,
                'ProfileTabVisibility'
            );
        }
    );

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
