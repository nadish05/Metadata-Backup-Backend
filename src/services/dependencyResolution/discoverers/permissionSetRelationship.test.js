const assert = require('assert');

const permissionSetRelationshipDiscoverer = require('./permissionSetRelationship.discoverer');
const {
    getRegisteredDiscoverers
} = require('../relationshipRegistry');

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

async function discover(xml, selectedMetadata = null) {
    return permissionSetRelationshipDiscoverer.discover({
        selectedMetadata:
            selectedMetadata ||
            [
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Subscription_Access',
                    filePath: PERMISSION_SET_PATH
                }
            ],
        repoFiles: [PERMISSION_SET_PATH],
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
    await runTest(
        'objectPermissions emits CustomObject',
        async () => {
            const result = await discover(`
                <PermissionSet>
                    <objectPermissions>
                        <object>Gym_Trainer__c</object>
                    </objectPermissions>
                </PermissionSet>
            `);

            assert.deepStrictEqual(result.relationships, [
                {
                    name: 'Gym_Trainer__c',
                    metadataType: 'CustomObject',
                    type: 'CustomObject',
                    relationship: 'PermissionSetObjectPermission',
                    sourceMetadata: 'Subscription_Access',
                    sourceField: null,
                    discoveredBy: 'PermissionSetRelationshipDiscoverer',
                    discoveryMethod: 'objectPermissions',
                    required: true,
                    selected: true,
                    depth: 1,
                    reason: 'PermissionSet object permission'
                }
            ]);
        }
    );

    await runTest(
        'fieldPermissions emits parent object and CustomField',
        async () => {
            const result = await discover(`
                <PermissionSet>
                    <fieldPermissions>
                        <field>Gym_Trainer__c.Name__c</field>
                    </fieldPermissions>
                </PermissionSet>
            `);

            assert.deepStrictEqual(
                result.relationships.map((item) => [
                    item.metadataType,
                    item.name
                ]),
                [
                    ['CustomObject', 'Gym_Trainer__c'],
                    ['CustomField', 'Gym_Trainer__c.Name__c']
                ]
            );
        }
    );

    await runTest(
        'duplicate object references emit one CustomObject',
        async () => {
            const result = await discover(`
                <PermissionSet>
                    <objectPermissions>
                        <object>Gym_Trainer__c</object>
                    </objectPermissions>
                    <fieldPermissions>
                        <field>Gym_Trainer__c.Name__c</field>
                    </fieldPermissions>
                    <fieldPermissions>
                        <field>Gym_Trainer__c.Name__c</field>
                    </fieldPermissions>
                </PermissionSet>
            `);

            assert.strictEqual(byType(result, 'CustomObject').length, 1);
            assert.strictEqual(byType(result, 'CustomField').length, 1);
        }
    );

    await runTest(
        'multiple fields emit one object and all unique fields',
        async () => {
            const result = await discover(`
                <PermissionSet>
                    <fieldPermissions>
                        <field>Gym_Trainer__c.Name__c</field>
                    </fieldPermissions>
                    <fieldPermissions>
                        <field>Gym_Trainer__c.Status__c</field>
                    </fieldPermissions>
                    <fieldPermissions>
                        <field>Gym_Trainer__c.Name__c</field>
                    </fieldPermissions>
                </PermissionSet>
            `);

            assert.deepStrictEqual(
                byType(result, 'CustomObject').map((item) => item.name),
                ['Gym_Trainer__c']
            );
            assert.deepStrictEqual(
                byType(result, 'CustomField').map((item) => item.name),
                [
                    'Gym_Trainer__c.Name__c',
                    'Gym_Trainer__c.Status__c'
                ]
            );
        }
    );

    await runTest('standard object permissions emit nothing', async () => {
        const result = await discover(`
            <PermissionSet>
                <objectPermissions>
                    <object>Account</object>
                </objectPermissions>
                <fieldPermissions>
                    <field>Account.Custom_Field__c</field>
                </fieldPermissions>
            </PermissionSet>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('malformed fields are ignored', async () => {
        const result = await discover(`
            <PermissionSet>
                <fieldPermissions><field>Gym_Trainer__c</field></fieldPermissions>
                <fieldPermissions><field>.Name__c</field></fieldPermissions>
                <fieldPermissions><field>Gym_Trainer__c.</field></fieldPermissions>
                <fieldPermissions><field>Gym_Trainer__c.Name</field></fieldPermissions>
                <fieldPermissions><field>A.B.C</field></fieldPermissions>
            </PermissionSet>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('tabSettings emits CustomTab', async () => {
        const result = await discover(`
            <PermissionSet>
                <tabSettings>
                    <tab>Gym_Trainer__c</tab>
                </tabSettings>
            </PermissionSet>
        `);

        assert.deepStrictEqual(result.relationships, [
            {
                name: 'Gym_Trainer__c',
                metadataType: 'CustomTab',
                type: 'CustomTab',
                relationship: 'PermissionSetTabSetting',
                sourceMetadata: 'Subscription_Access',
                sourceField: null,
                discoveredBy: 'PermissionSetRelationshipDiscoverer',
                discoveryMethod: 'tabSettings',
                required: true,
                selected: true,
                depth: 1,
                reason: 'PermissionSet tab access'
            }
        ]);
    });

    await runTest('multiple custom tab settings emit unique dependencies', async () => {
        const result = await discover(`
            <PermissionSet>
                <tabSettings><tab>Gym_Trainer__c</tab></tabSettings>
                <tabSettings><tab>My_Custom_Tab</tab></tabSettings>
            </PermissionSet>
        `);

        assert.deepStrictEqual(
            byType(result, 'CustomTab').map((item) => item.name),
            ['Gym_Trainer__c', 'My_Custom_Tab']
        );
    });

    await runTest('duplicate custom tab settings emit one dependency', async () => {
        const result = await discover(`
            <PermissionSet>
                <tabSettings><tab>Gym_Trainer__c</tab></tabSettings>
                <tabSettings><tab>Gym_Trainer__c</tab></tabSettings>
            </PermissionSet>
        `);

        assert.deepStrictEqual(
            byType(result, 'CustomTab').map((item) => item.name),
            ['Gym_Trainer__c']
        );
    });

    await runTest('standard tab settings are ignored', async () => {
        const result = await discover(`
            <PermissionSet>
                <tabSettings><tab>Account</tab></tabSettings>
                <tabSettings><tab>Contact</tab></tabSettings>
                <tabSettings><tab>Lead</tab></tabSettings>
                <tabSettings><tab>Opportunity</tab></tabSettings>
                <tabSettings><tab>Case</tab></tabSettings>
                <tabSettings><tab>Campaign</tab></tabSettings>
            </PermissionSet>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest('malformed tab settings are ignored', async () => {
        const result = await discover(`
            <PermissionSet>
                <tabSettings><tab></tab></tabSettings>
                <tabSettings><tab>Bad Tab</tab></tabSettings>
                <tabSettings><tab>Bad.Tab</tab></tabSettings>
                <tabSettings><tab>standard-Account</tab></tabSettings>
                <tabSettings><tab>CustomTab</tab></tabSettings>
            </PermissionSet>
        `);

        assert.deepStrictEqual(result.relationships, []);
    });

    await runTest(
        'PermissionSet without object or field permissions emits nothing',
        async () => {
            const result = await discover(`
                <PermissionSet>
                    <label>Subscription Access</label>
                    <classAccesses>
                        <apexClass>SessionController</apexClass>
                    </classAccesses>
                </PermissionSet>
            `);

            assert.deepStrictEqual(result.relationships, []);
            assert.strictEqual(result.metadataScanned, 1);
            assert.strictEqual(result.filesScanned, 1);
        }
    );

    await runTest(
        'registry retains existing discoverers and adds PermissionSet',
        async () => {
            assert.deepStrictEqual(
                getRegisteredDiscoverers().map(
                    (discoverer) => discoverer.id
                ),
                [
                    'CustomObjectRelationshipDiscoverer',
                    'CustomObjectActionOverrideDiscoverer',
                    'PermissionSetRelationshipDiscoverer'
                ]
            );
        }
    );
}

main();
