const assert = require('assert');

const {
    parseSourceCustomFieldXml
} = require('./sourceCustomFieldShape.parser');
const {
    evaluateContractCapability,
    evaluateCustomFieldContractRules,
    CONTRACT_RULE_IDS
} = require('./contractEvaluator.service');
const {
    buildCapabilities,
    CAPABILITY_STATUS
} = require('../deploymentPlannerCompatibility.analyzer.service');
const { TRUST_POLICY } = require('../../deploymentPlanner/deploymentPlanner.service');
const {
    authorizeCapabilities
} = require('../../deploymentPlanner/plannerAuthorization.service');

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

const sampleSourceXml = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Amount__c</fullName>
    <label>Amount</label>
    <precision>18</precision>
    <required>false</required>
    <scale>2</scale>
    <type>Currency</type>
    <unique>false</unique>
    <externalId>false</externalId>
</CustomField>`;

runTest('parseSourceCustomFieldXml maps Currency to soap currency', () => {
    const parsed = parseSourceCustomFieldXml(
        sampleSourceXml,
        'Opportunity.Amount__c'
    );

    assert.strictEqual(parsed.attributes.type, 'currency');
    assert.strictEqual(parsed.attributes.precision, 18);
    assert.strictEqual(parsed.attributes.scale, 2);
    assert.strictEqual(parsed.attributes.required, false);
});

runTest('CONTRACT PASS when source and destination attributes match', () => {
    const source = parseSourceCustomFieldXml(
        sampleSourceXml,
        'Opportunity.Amount__c'
    ).attributes;

    const evaluation = evaluateCustomFieldContractRules({
        sourceAttributes: source,
        destinationAttributes: {
            type: 'currency',
            length: 0,
            precision: 18,
            scale: 2,
            required: false,
            unique: false,
            externalId: false,
            referenceTo: [],
            picklistValues: null
        }
    });

    assert.strictEqual(evaluation.status, 'PASS');
    assert.ok(evaluation.rulesChecked.includes(CONTRACT_RULE_IDS.FIELD_TYPE));
    assert.strictEqual(evaluation.mismatches.length, 0);
});

runTest('CONTRACT FAIL on field type mismatch with evidence', () => {
    const source = parseSourceCustomFieldXml(
        sampleSourceXml,
        'Opportunity.Amount__c'
    ).attributes;

    const evaluation = evaluateCustomFieldContractRules({
        sourceAttributes: source,
        destinationAttributes: {
            type: 'double',
            length: 0,
            precision: 18,
            scale: 2,
            required: false,
            unique: false,
            externalId: false,
            referenceTo: [],
            picklistValues: null
        }
    });

    assert.strictEqual(evaluation.status, 'FAIL');
    assert.ok(
        evaluation.mismatches.some(
            (item) => item.ruleId === CONTRACT_RULE_IDS.FIELD_TYPE
        )
    );
});

runTest('CONTRACT UNKNOWN when destination facts missing', () => {
    const capability = evaluateContractCapability({
        metadataType: 'CustomField',
        metadataName: 'Account.Name',
        existsInDestination: true,
        destinationShapeIndex: { shapes: new Map() },
        sourceShapeIndex: new Map([
            [
                'CustomField:Account.Name',
                {
                    attributes: {
                        type: 'string',
                        length: 80,
                        required: false,
                        unique: false,
                        externalId: false,
                        referenceTo: []
                    }
                }
            ]
        ])
    });

    assert.strictEqual(capability.status, 'UNKNOWN');
});

runTest('Non-CustomField remains NOT_EVALUATED', () => {
    const capability = evaluateContractCapability({
        metadataType: 'CustomObject',
        metadataName: 'Account',
        existsInDestination: true
    });

    assert.strictEqual(capability.status, 'NOT_EVALUATED');
});

runTest('buildCapabilities wires CONTRACT for CustomField', () => {
    const destinationShapeIndex = {
        shapes: new Map([
            [
                'CustomField:Account.Status__c',
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Status__c',
                    found: true,
                    attributes: {
                        type: 'picklist',
                        length: 255,
                        precision: null,
                        scale: null,
                        required: false,
                        unique: false,
                        externalId: false,
                        referenceTo: [],
                        picklistValues: [
                            {
                                value: 'Open',
                                label: 'Open',
                                active: true,
                                defaultValue: false
                            },
                            {
                                value: 'Closed',
                                label: 'Closed',
                                active: true,
                                defaultValue: false
                            }
                        ]
                    }
                }
            ]
        ])
    };

    const sourceShapeIndex = new Map([
        [
            'CustomField:Account.Status__c',
            {
                attributes: {
                    type: 'picklist',
                    length: 255,
                    required: false,
                    unique: false,
                    externalId: false,
                    referenceTo: [],
                    picklistValues: [
                        {
                            value: 'Open',
                            label: 'Open',
                            active: true,
                            defaultValue: false
                        }
                    ]
                }
            }
        ]
    ]);

    const capabilities = buildCapabilities({
        destinationState: 'EXISTS',
        existsInDestination: true,
        graphSafe: true,
        graphDeferred: false,
        metadataType: 'CustomField',
        metadataName: 'Account.Status__c',
        destinationShapeIndex,
        sourceShapeIndex
    });

    assert.strictEqual(capabilities.CONTRACT.status, CAPABILITY_STATUS.PASS);
    assert.ok(
        capabilities.CONTRACT.evidence.rulesChecked.includes(
            CONTRACT_RULE_IDS.PICKLIST_VALUES
        )
    );
});

runTest('buildCapabilities keeps ApexClass CONTRACT NOT_EVALUATED', () => {
    const capabilities = buildCapabilities({
        destinationState: 'EXISTS',
        existsInDestination: true,
        graphSafe: true,
        metadataType: 'ApexClass',
        metadataName: 'Foo'
    });

    assert.strictEqual(
        capabilities.CONTRACT.status,
        CAPABILITY_STATUS.NOT_EVALUATED
    );
});

runTest('TRUST_POLICY and authorization ignore CONTRACT', () => {
    assert.ok(!TRUST_POLICY.CustomField.includes('CONTRACT'));
    assert.ok(!TRUST_POLICY.CustomObject.includes('CONTRACT'));

    const auth = authorizeCapabilities({
        trustedCapabilities: [...TRUST_POLICY.CustomObject],
        capabilities: {
            EXISTENCE: { status: 'PASS' },
            GRAPH: { status: 'PASS' },
            CONTRACT: { status: 'FAIL', reason: 'type mismatch' }
        },
        destinationState: 'EXISTS',
        analysisLevel: 'EXISTENCE'
    });

    assert.strictEqual(auth.authorized, true);
    assert.strictEqual(auth.availability, 'GRANTED');
});

if (!process.exitCode) {
    console.log('Phase 9C regression: PASS');
}
