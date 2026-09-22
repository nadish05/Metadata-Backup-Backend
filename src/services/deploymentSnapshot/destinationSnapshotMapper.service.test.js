'use strict';

const assert = require('assert');

const {
    DESTINATION_STATE
} = require('../destinationInventory/destinationInventoryBuilder.service');
const { getState } = require('../destinationInventory/destinationInventoryBuilder.service');
const { CHANGE_CLASS } = require('./snapshot.types');
const {
    collectFinalDeploymentMembers,
    collapseRedundantNewCustomObjectChildren,
    resolveCustomObjectChildOwner,
    isCaptureAllowlisted,
    mapExistenceToChangeClass,
    buildMemberIdentityKey
} = require('./destinationSnapshotMapper.service');

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

function inventoryFor(states) {
    const inventory = new Map();

    for (const row of states) {
        inventory.set(`${row.metadataType}:${row.metadataName}`, {
            state: row.state
        });
    }

    return inventory;
}

const FULL_PACKAGE = {
    metadata: [
        {
            metadataType: 'RecordType',
            metadataName: 'Opportunity.Enterprise_Deal',
            filePath:
                'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml'
        },
        {
            metadataType: 'BusinessProcess',
            metadataName: 'Opportunity.New Sales Process',
            filePath:
                'force-app/main/default/objects/Opportunity/businessProcesses/New Sales Process.businessProcess-meta.xml'
        },
        {
            metadataType: 'CustomField',
            metadataName: 'Opportunity.Approval_Status__c',
            filePath:
                'force-app/main/default/objects/Opportunity/fields/Approval_Status__c.field-meta.xml'
        },
        {
            metadataType: 'StandardValueSet',
            metadataName: 'LeadSource',
            filePath:
                'force-app/main/default/standardValueSets/LeadSource.standardValueSet-meta.xml'
        }
    ]
};

runTest(
    'collects every deployed package member regardless of selectedMetadata',
    () => {
        const members = collectFinalDeploymentMembers(
            {
                metadata: [
                    {
                        metadataType: 'CustomMetadata',
                        metadataName: 'Weather_Config.Default',
                        filePath: 'customMetadata/Weather_Config.Default.md-meta.xml'
                    },
                    {
                        type: 'ApexClass',
                        name: 'AccountService',
                        filePath: 'classes/AccountService.cls'
                    },
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'DependencyClass',
                        filePath: 'classes/DependencyClass.cls'
                    }
                ]
            },
            [{ metadataType: 'ApexClass', metadataName: 'AccountService' }]
        );

        assert.deepStrictEqual(
            members
                .map((member) => `${member.metadataType}:${member.metadataName}`)
                .sort(),
            [
                'ApexClass:AccountService',
                'ApexClass:DependencyClass',
                'CustomMetadata:Weather_Config.Default'
            ].sort()
        );
    }
);

runTest(
    'TEST 1: AUTO_INCLUDED ApexClass:B is a rollback candidate when not selected',
    () => {
        const members = collectFinalDeploymentMembers(
            {
                metadata: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'A',
                        filePath: 'classes/A.cls'
                    },
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'B',
                        filePath: 'classes/B.cls'
                    }
                ]
            },
            [{ metadataType: 'ApexClass', metadataName: 'A' }]
        );

        assert.deepStrictEqual(
            members.map((m) => `${m.metadataType}:${m.metadataName}`).sort(),
            ['ApexClass:A', 'ApexClass:B'].sort()
        );
    }
);

runTest(
    'TEST 2: AUTO_INCLUDED CustomField when parent exists in deployment package',
    () => {
        const members = collectFinalDeploymentMembers(
            {
                metadata: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Vehicle__c',
                        filePath:
                            'objects/Vehicle__c/Vehicle__c.object-meta.xml'
                    },
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Vehicle__c.Model__c',
                        filePath:
                            'objects/Vehicle__c/fields/Model__c.field-meta.xml'
                    }
                ]
            },
            [{ metadataType: 'CustomObject', metadataName: 'Vehicle__c' }]
        );

        assert.ok(
            members.some(
                (m) =>
                    m.metadataType === 'CustomField' &&
                    m.metadataName === 'Vehicle__c.Model__c'
            )
        );
    }
);

runTest('TEST 3: AUTO_INCLUDED ListView in deployment package', () => {
    const members = collectFinalDeploymentMembers(
        {
            metadata: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Vehicle__c',
                    filePath: 'objects/Vehicle__c/Vehicle__c.object-meta.xml'
                },
                {
                    metadataType: 'ListView',
                    metadataName: 'Vehicle__c.All',
                    filePath:
                        'objects/Vehicle__c/listViews/All.listView-meta.xml'
                }
            ]
        },
        [{ metadataType: 'CustomObject', metadataName: 'Vehicle__c' }]
    );

    assert.ok(
        members.some(
            (m) =>
                m.metadataType === 'ListView' &&
                m.metadataName === 'Vehicle__c.All'
        )
    );
});

runTest('TEST 4: AUTO_INCLUDED ValidationRule in deployment package', () => {
    const members = collectFinalDeploymentMembers(
        {
            metadata: [
                {
                    metadataType: 'ValidationRule',
                    metadataName: 'Vehicle__c.Require_Model',
                    filePath:
                        'objects/Vehicle__c/validationRules/Require_Model.validationRule-meta.xml'
                }
            ]
        },
        [{ metadataType: 'CustomObject', metadataName: 'Vehicle__c' }]
    );

    assert.strictEqual(members.length, 1);
    assert.strictEqual(members[0].metadataType, 'ValidationRule');
});

runTest('TEST 5: AUTO_INCLUDED RecordType in deployment package', () => {
    const members = collectFinalDeploymentMembers(
        {
            metadata: [
                {
                    metadataType: 'RecordType',
                    metadataName: 'Vehicle__c.Some_RT',
                    filePath:
                        'objects/Vehicle__c/recordTypes/Some_RT.recordType-meta.xml'
                }
            ]
        },
        [{ metadataType: 'CustomObject', metadataName: 'Vehicle__c' }]
    );

    assert.strictEqual(members.length, 1);
    assert.strictEqual(members[0].metadataType, 'RecordType');
});

runTest(
    'TEST 6: unsupported types remain in deployed member list for fail-closed capture',
    () => {
        const members = collectFinalDeploymentMembers(FULL_PACKAGE, [
            { metadataType: 'RecordType', metadataName: 'Opportunity.Enterprise_Deal' }
        ]);

        assert.ok(
            members.some((m) => m.metadataType === 'BusinessProcess')
        );
        assert.ok(
            members.some((m) => m.metadataType === 'StandardValueSet')
        );
        assert.strictEqual(isCaptureAllowlisted('BusinessProcess'), true);
        assert.strictEqual(isCaptureAllowlisted('CompactLayout'), true);
        assert.strictEqual(isCaptureAllowlisted('NamedCredential'), true);
        assert.strictEqual(isCaptureAllowlisted('ExternalCredential'), true);
        assert.strictEqual(isCaptureAllowlisted('StandardValueSet'), true);
        assert.strictEqual(isCaptureAllowlisted('Flow'), true);
    }
);

runTest('dedupes identical deployed members', () => {
    const members = collectFinalDeploymentMembers(
        {
            metadata: [
                {
                    metadataType: 'RecordType',
                    metadataName: 'Opportunity.Enterprise_Deal',
                    filePath: 'a'
                },
                {
                    metadataType: 'RecordType',
                    metadataName: 'Account.Enterprise_Deal',
                    filePath: 'b'
                }
            ]
        },
        []
    );

    assert.strictEqual(members.length, 2);
});

runTest('empty deployment package yields no members', () => {
    assert.deepStrictEqual(collectFinalDeploymentMembers({ metadata: [] }), []);
    assert.deepStrictEqual(collectFinalDeploymentMembers(null), []);
});

runTest(
    'TEST 7: collapse NEW CustomObject removes NEW child members only',
    () => {
        const members = [
            {
                metadataType: 'CustomObject',
                metadataName: 'Vehicle__c',
                filePath: 'objects/Vehicle__c/Vehicle__c.object-meta.xml'
            },
            {
                metadataType: 'CustomField',
                metadataName: 'Vehicle__c.Model__c',
                filePath: 'objects/Vehicle__c/fields/Model__c.field-meta.xml'
            },
            {
                metadataType: 'ListView',
                metadataName: 'Vehicle__c.All',
                filePath: 'objects/Vehicle__c/listViews/All.listView-meta.xml'
            }
        ];
        const inventory = inventoryFor([
            {
                metadataType: 'CustomObject',
                metadataName: 'Vehicle__c',
                state: DESTINATION_STATE.MISSING
            },
            {
                metadataType: 'CustomField',
                metadataName: 'Vehicle__c.Model__c',
                state: DESTINATION_STATE.MISSING
            },
            {
                metadataType: 'ListView',
                metadataName: 'Vehicle__c.All',
                state: DESTINATION_STATE.MISSING
            }
        ]);

        const collapsed = collapseRedundantNewCustomObjectChildren(
            members,
            inventory,
            getState
        );

        assert.deepStrictEqual(
            collapsed.map((m) => `${m.metadataType}:${m.metadataName}`),
            ['CustomObject:Vehicle__c']
        );
    }
);

runTest(
    'TEST 8: existing parent + NEW child does not collapse child away',
    () => {
        const members = [
            {
                metadataType: 'CustomObject',
                metadataName: 'Vehicle__c',
                filePath: 'objects/Vehicle__c/Vehicle__c.object-meta.xml'
            },
            {
                metadataType: 'CustomField',
                metadataName: 'Vehicle__c.Model__c',
                filePath: 'objects/Vehicle__c/fields/Model__c.field-meta.xml'
            }
        ];
        const inventory = inventoryFor([
            {
                metadataType: 'CustomObject',
                metadataName: 'Vehicle__c',
                state: DESTINATION_STATE.EXISTS
            },
            {
                metadataType: 'CustomField',
                metadataName: 'Vehicle__c.Model__c',
                state: DESTINATION_STATE.MISSING
            }
        ]);

        const collapsed = collapseRedundantNewCustomObjectChildren(
            members,
            inventory,
            getState
        );

        assert.strictEqual(collapsed.length, 2);
        assert.ok(
            collapsed.some(
                (m) =>
                    m.metadataType === 'CustomField' &&
                    m.metadataName === 'Vehicle__c.Model__c'
            )
        );
    }
);

runTest(
    'TEST 9: existing parent + MODIFIED child keeps independent child member',
    () => {
        const members = [
            {
                metadataType: 'CustomField',
                metadataName: 'Vehicle__c.Model__c',
                filePath: 'objects/Vehicle__c/fields/Model__c.field-meta.xml'
            }
        ];
        const inventory = inventoryFor([
            {
                metadataType: 'CustomField',
                metadataName: 'Vehicle__c.Model__c',
                state: DESTINATION_STATE.EXISTS
            }
        ]);

        const collapsed = collapseRedundantNewCustomObjectChildren(
            members,
            inventory,
            getState
        );

        assert.strictEqual(collapsed.length, 1);
        assert.strictEqual(
            mapExistenceToChangeClass(
                getState(
                    inventory,
                    'CustomField',
                    'Vehicle__c.Model__c'
                )
            ),
            CHANGE_CLASS.MODIFIED
        );
    }
);

runTest('collapse skipped when unrelated deployed member exists', () => {
    const members = [
        {
            metadataType: 'CustomObject',
            metadataName: 'Vehicle__c',
            filePath: 'x'
        },
        {
            metadataType: 'CustomField',
            metadataName: 'Vehicle__c.Model__c',
            filePath: 'y'
        },
        {
            metadataType: 'ApexClass',
            metadataName: 'Helper',
            filePath: 'classes/Helper.cls'
        }
    ];
    const inventory = inventoryFor([
        {
            metadataType: 'CustomObject',
            metadataName: 'Vehicle__c',
            state: DESTINATION_STATE.MISSING
        },
        {
            metadataType: 'CustomField',
            metadataName: 'Vehicle__c.Model__c',
            state: DESTINATION_STATE.MISSING
        },
        {
            metadataType: 'ApexClass',
            metadataName: 'Helper',
            state: DESTINATION_STATE.MISSING
        }
    ]);

    const collapsed = collapseRedundantNewCustomObjectChildren(
        members,
        inventory,
        getState
    );

    assert.strictEqual(collapsed.length, 3);
});

runTest('resolveCustomObjectChildOwner parses object API name', () => {
    assert.strictEqual(
        resolveCustomObjectChildOwner(
            'CustomField',
            'Vehicle__c.Model__c'
        ),
        'Vehicle__c'
    );
    assert.strictEqual(
        resolveCustomObjectChildOwner('ApexClass', 'Foo'),
        null
    );
});

runTest('V1 allowlist includes StandardValueSet alongside proven snapshot types', () => {
    assert.strictEqual(isCaptureAllowlisted('ApexClass'), true);
    assert.strictEqual(isCaptureAllowlisted('CustomObject'), true);
    assert.strictEqual(isCaptureAllowlisted('CustomField'), true);
    assert.strictEqual(isCaptureAllowlisted('CustomMetadata'), true);
    assert.strictEqual(isCaptureAllowlisted('LightningComponentBundle'), true);
    assert.strictEqual(isCaptureAllowlisted('ListView'), true);
    assert.strictEqual(isCaptureAllowlisted('ValidationRule'), true);
    assert.strictEqual(isCaptureAllowlisted('RecordType'), true);
    assert.strictEqual(isCaptureAllowlisted('BusinessProcess'), true);
    assert.strictEqual(isCaptureAllowlisted('CompactLayout'), true);
    assert.strictEqual(isCaptureAllowlisted('NamedCredential'), true);
    assert.strictEqual(isCaptureAllowlisted('ExternalCredential'), true);
    assert.strictEqual(isCaptureAllowlisted('StandardValueSet'), true);
    assert.strictEqual(isCaptureAllowlisted('Flow'), true);
    assert.strictEqual(isCaptureAllowlisted('CustomMetadataType'), false);
});

runTest('maps destination existence without Git changeType', () => {
    assert.strictEqual(
        mapExistenceToChangeClass(DESTINATION_STATE.EXISTS),
        CHANGE_CLASS.MODIFIED
    );
    assert.strictEqual(
        mapExistenceToChangeClass(DESTINATION_STATE.MISSING),
        CHANGE_CLASS.NEW
    );
    assert.strictEqual(
        mapExistenceToChangeClass(DESTINATION_STATE.UNKNOWN),
        CHANGE_CLASS.UNKNOWN
    );
});

runTest('buildMemberIdentityKey uses metadataType and metadataName', () => {
    assert.strictEqual(
        buildMemberIdentityKey({
            metadataType: 'RecordType',
            metadataName: 'Opportunity.Enterprise_Deal'
        }),
        'RecordType:Opportunity.Enterprise_Deal'
    );
});
