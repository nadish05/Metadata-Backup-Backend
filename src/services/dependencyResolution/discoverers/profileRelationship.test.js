/**
 * Phase 19.2 — ProfileRelationshipDiscoverer objectPermissions tests.
 * Does not exercise PermissionSet discovery behavior beyond registry isolation.
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
                    <fieldPermissions>
                        <field>Invoice__c.Amount__c</field>
                        <editable>true</editable>
                        <readable>true</readable>
                    </fieldPermissions>
                    <tabVisibilities>
                        <tab>Invoice__c</tab>
                        <visibility>DefaultOn</visibility>
                    </tabVisibilities>
                </Profile>
            `);

            assert.deepStrictEqual(result.relationships, []);
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
