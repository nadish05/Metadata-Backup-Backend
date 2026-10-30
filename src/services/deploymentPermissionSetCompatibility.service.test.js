const assert = require('assert');

const {
    analyzePermissionSetCompatibility,
    inspectXmlStructure
} = require('./deploymentPermissionSetCompatibility.service');

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

function packageWith(...items) {
    return {
        metadata: items.map((item) => ({
            metadataType: 'PermissionSet',
            metadataName: item.name,
            filePath: `force-app/main/default/permissionsets/${item.name}.permissionset-meta.xml`,
            content: item.xml
        })),
        dependencies: []
    };
}

const POLICY_61 = { deploymentApiVersion: '61.0' };

async function main() {
    await runTest('PermissionSet with supported properties', async () => {
        const result = await analyzePermissionSetCompatibility({
            generatedDeploymentPackage: packageWith({
                name: 'Subscription_Access',
                xml: `<?xml version="1.0" encoding="UTF-8"?>
<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>Subscription access</description>
    <fieldPermissions>
        <editable>false</editable>
        <field>Account.Name</field>
        <readable>true</readable>
    </fieldPermissions>
    <label>Subscription Access</label>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>false</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Account</object>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
</PermissionSet>`
            }),
            deploymentApiVersionPolicy: POLICY_61
        });

        assert.strictEqual(result.overallStatus, 'PASS');
        assert.strictEqual(result.summary.analyzed, 1);
        assert.strictEqual(result.summary.compatible, 1);
        assert.deepStrictEqual(
            result.permissionSets[0].unsupportedProperties,
            []
        );
        assert.deepStrictEqual(result.permissionSets[0].unknownNodes, []);
    });

    await runTest('PermissionSet containing viewAllFields', async () => {
        const result = await analyzePermissionSetCompatibility({
            generatedDeploymentPackage: packageWith({
                name: 'Subscription_Access',
                xml: `<PermissionSet>
    <label>Subscription Access</label>
    <objectPermissions>
        <allowCreate>false</allowCreate>
        <allowDelete>false</allowDelete>
        <allowEdit>false</allowEdit>
        <allowRead>true</allowRead>
        <modifyAllRecords>false</modifyAllRecords>
        <object>Subscription__c</object>
        <viewAllFields>true</viewAllFields>
        <viewAllRecords>false</viewAllRecords>
    </objectPermissions>
</PermissionSet>`
            }),
            deploymentApiVersionPolicy: POLICY_61
        });

        const diagnostic = result.permissionSets[0];
        const finding = diagnostic.compatibilityFindings.find(
            (item) => item.property === 'objectPermissions.viewAllFields'
        );

        assert.ok(finding);
        assert.strictEqual(result.overallStatus, 'WARNING');
        assert.deepStrictEqual(diagnostic.unsupportedProperties, [
            'objectPermissions.viewAllFields'
        ]);
        assert.strictEqual(finding.additive, true);
        assert.strictEqual(finding.optional, true);
        assert.strictEqual(finding.mandatory, false);
        assert.strictEqual(finding.safeToRemove, false);
        assert.strictEqual(finding.safeToIgnore, false);
        assert.strictEqual(finding.requiresVersionUpgrade, true);
        assert.strictEqual(finding.requiredForDeployment, false);
        assert.strictEqual(finding.requiredToPreserveIntent, true);
        assert.strictEqual(
            finding.rootCause,
            'PERMISSION_SET_XML_SCHEMA_EVOLUTION'
        );
        assert.match(finding.reason, /API 63\.0 and later/);
        assert.match(finding.omissionBehavior, /NOT_RECREATED/);
        assert.strictEqual(diagnostic.requiresUserAttention, true);
    });

    await runTest('Multiple unsupported properties', async () => {
        const result = await analyzePermissionSetCompatibility({
            generatedDeploymentPackage: packageWith({
                name: 'Future_Access',
                xml: `<PermissionSet>
    <agentAccesses>
        <agentName>Employee_Agent</agentName>
        <enabled>true</enabled>
    </agentAccesses>
    <emailRoutingAddressAccesses>
        <emailRoutingAddress>Support</emailRoutingAddress>
    </emailRoutingAddressAccesses>
    <label>Future Access</label>
    <objectPermissions>
        <allowRead>true</allowRead>
        <object>Account</object>
        <viewAllFields>true</viewAllFields>
    </objectPermissions>
</PermissionSet>`
            }),
            deploymentApiVersionPolicy: POLICY_61
        });

        assert.deepStrictEqual(
            result.permissionSets[0].unsupportedProperties.sort(),
            [
                'agentAccesses',
                'emailRoutingAddressAccesses',
                'objectPermissions.viewAllFields'
            ].sort()
        );
        assert.strictEqual(result.summary.unsupportedPropertyCount, 3);
        assert.strictEqual(result.summary.incompatible, 1);
    });

    await runTest('No PermissionSets', async () => {
        const result = await analyzePermissionSetCompatibility({
            generatedDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'SubscriptionService'
                    }
                ],
                dependencies: []
            },
            deploymentApiVersionPolicy: POLICY_61
        });

        assert.strictEqual(result.overallStatus, 'PASS');
        assert.strictEqual(result.summary.analyzed, 0);
        assert.deepStrictEqual(result.permissionSets, []);
        assert.deepStrictEqual(result.compatibilityFindings, []);
    });

    await runTest('Malformed XML', async () => {
        const result = await analyzePermissionSetCompatibility({
            generatedDeploymentPackage: packageWith({
                name: 'Broken_Access',
                xml: `<PermissionSet>
    <label>Broken Access</description>
</PermissionSet>`
            }),
            deploymentApiVersionPolicy: POLICY_61
        });

        assert.strictEqual(result.overallStatus, 'WARNING');
        assert.strictEqual(result.summary.malformed, 1);
        assert.strictEqual(result.permissionSets[0].malformedXml, true);
        assert.strictEqual(
            result.permissionSets[0].compatibilityFindings[0].category,
            'PERMISSION_SET_MALFORMED_XML'
        );
        assert.throws(
            () => inspectXmlStructure('<PermissionSet><label>x</PermissionSet>'),
            /Malformed XML/
        );
    });

    await runTest('Profile XML with viewAllFields reports structural minimum 63', async () => {
        const {
            analyzeProfileMetadataCompatibility,
            inspectXmlStructure
        } = require('./deploymentPermissionSetCompatibility.service');

        const structure = inspectXmlStructure(
            `<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <objectPermissions>
        <object>Account</object>
        <viewAllFields>true</viewAllFields>
    </objectPermissions>
</Profile>`,
            { expectedRoot: 'Profile' }
        );

        assert.ok(structure.paths.includes('objectPermissions.viewAllFields'));

        const result = await analyzeProfileMetadataCompatibility({
            generatedDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'Profile',
                        metadataName: 'Sales Manager',
                        content: `<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <objectPermissions>
        <object>Account</object>
        <viewAllFields>true</viewAllFields>
    </objectPermissions>
</Profile>`
                    }
                ]
            },
            deploymentApiVersionPolicy: POLICY_61
        });

        assert.strictEqual(result.structuralMinimumApiVersion, '63.0');
        assert.strictEqual(
            result.profiles[0].unsupportedProperties[0],
            'objectPermissions.viewAllFields'
        );
    });

    await runTest('Profile XML resolves from conventional repository paths', async () => {
        const { analyzeProfileMetadataCompatibility } = require(
            './deploymentPermissionSetCompatibility.service'
        );

        const result = await analyzeProfileMetadataCompatibility({
            generatedDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'Profile',
                        metadataName: 'Admin'
                    }
                ]
            },
            readFile: async (relativePath) => {
                if (
                    String(relativePath).includes(
                        'profiles/Admin.profile-meta.xml'
                    )
                ) {
                    return `<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <objectPermissions>
        <object>Account</object>
        <viewAllFields>true</viewAllFields>
    </objectPermissions>
</Profile>`;
                }

                throw new Error(`Unexpected path: ${relativePath}`);
            }
        });

        assert.strictEqual(result.structuralMinimumApiVersion, '63.0');
    });

    await runTest('Profile XML without viewAllFields has no structural minimum', async () => {
        const { analyzeProfileMetadataCompatibility } = require(
            './deploymentPermissionSetCompatibility.service'
        );

        const result = await analyzeProfileMetadataCompatibility({
            generatedDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'Profile',
                        metadataName: 'Admin',
                        content: `<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <objectPermissions>
        <object>Account</object>
        <allowRead>true</allowRead>
    </objectPermissions>
</Profile>`
                    }
                ]
            },
            deploymentApiVersionPolicy: POLICY_61
        });

        assert.strictEqual(result.structuralMinimumApiVersion, null);
        assert.deepStrictEqual(result.profiles[0].unsupportedProperties, []);
    });
}

main();
