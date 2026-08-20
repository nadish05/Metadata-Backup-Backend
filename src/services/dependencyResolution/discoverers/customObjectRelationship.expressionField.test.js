const assert = require('assert');

const customObjectRelationshipDiscoverer = require('./customObjectRelationship.discoverer');

const {
    parseRelationshipFromFieldXml,
    extractExpressionCustomFieldNames,
    discoverExpressionFieldDependencies
} = customObjectRelationshipDiscoverer;

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function namesOf(relationships) {
    return (relationships || []).map((item) => item.name).sort();
}

function customFieldNames(relationships) {
    return (relationships || [])
        .filter((item) => item.metadataType === 'CustomField')
        .map((item) => item.name)
        .sort();
}

const FORMULA_SAME_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status__c</fullName>
    <type>Formula</type>
    <formula>IF(Is_Canceled__c, "Canceled", "Active")</formula>
    <formulaTreatBlanksAs>BlankAsZero</formulaTreatBlanksAs>
    <label>Status</label>
</CustomField>`;

const FORMULA_PARENT_RELATIONSHIP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Session_Canceled__c</fullName>
    <type>Formula</type>
    <formula>Session__r.Is_Canceled__c</formula>
    <label>Session Canceled</label>
</CustomField>`;

const FORMULA_MULTIPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Rating__c</fullName>
    <type>Formula</type>
    <formula>IF(
  ISPICKVAL(Status__c, "Active"),
  Sum_of_Guest_Reviews__c / Number_of_Guests__c,
  0
)</formula>
    <label>Rating</label>
</CustomField>`;

const FORMULA_DUPLICATE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Dup__c</fullName>
    <type>Formula</type>
    <formula>Is_Canceled__c || Is_Canceled__c</formula>
    <label>Dup</label>
</CustomField>`;

const FORMULA_STANDARD_AND_FUNCTIONS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Label__c</fullName>
    <type>Formula</type>
    <formula>IF(ISPICKVAL(Status__c, "Open"), CASE(Name, "A", 1, 0), CreatedDate)</formula>
    <label>Label</label>
</CustomField>`;

const SUMMARY_WITH_FILTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
    <summarizedField>Number_of_Guests__c</summarizedField>
    <summaryOperation>sum</summaryOperation>
    <summaryFilterItems>
        <field>Booking__c.Is_Canceled__c</field>
        <operation>equals</operation>
        <value>false</value>
    </summaryFilterItems>
    <label>Booked Slots</label>
</CustomField>`;

const LOOKUP_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Experience__c</fullName>
    <type>Lookup</type>
    <referenceTo>Experience__c</referenceTo>
    <label>Experience</label>
</CustomField>`;

const EMI_EQUIPMENT_LOOKUP_FILTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Equipment__c</fullName>
    <deleteConstraint>SetNull</deleteConstraint>
    <label>Equipment</label>
    <lookupFilter>
        <active>true</active>
        <errorMessage>No spare parts meet this description or name.</errorMessage>
        <filterItems>
            <field>Product2.Replacement_Part__c</field>
            <operation>equals</operation>
            <value>True</value>
        </filterItems>
        <isOptional>false</isOptional>
    </lookupFilter>
    <referenceTo>Product2</referenceTo>
    <relationshipName>Equipment_Maintenance_Items</relationshipName>
    <type>Lookup</type>
</CustomField>`;

const LOOKUP_FILTER_CUSTOM_TARGET_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Equipment__c</fullName>
    <type>Lookup</type>
    <referenceTo>Target__c</referenceTo>
    <lookupFilter>
        <active>true</active>
        <filterItems>
            <field>Target__c.Special_Field__c</field>
            <operation>equals</operation>
            <value>Yes</value>
        </filterItems>
    </lookupFilter>
</CustomField>`;

const LOOKUP_FILTER_MULTIPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Equipment__c</fullName>
    <type>Lookup</type>
    <referenceTo>Target__c</referenceTo>
    <lookupFilter>
        <filterItems>
            <field>Target__c.Field_A__c</field>
            <operation>equals</operation>
            <value>1</value>
        </filterItems>
        <filterItems>
            <field>Target__c.Field_B__c</field>
            <operation>equals</operation>
            <value>2</value>
        </filterItems>
    </lookupFilter>
</CustomField>`;

const LOOKUP_FILTER_DUPLICATE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Equipment__c</fullName>
    <type>Lookup</type>
    <referenceTo>Product2</referenceTo>
    <lookupFilter>
        <filterItems>
            <field>Product2.Replacement_Part__c</field>
            <operation>equals</operation>
            <value>True</value>
        </filterItems>
        <filterItems>
            <field>Product2.Replacement_Part__c</field>
            <operation>equals</operation>
            <value>True</value>
        </filterItems>
    </lookupFilter>
</CustomField>`;

const MASTER_DETAIL_LOOKUP_FILTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Parent_Link__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Parent__c</referenceTo>
    <lookupFilter>
        <filterItems>
            <field>Parent__c.Active_Flag__c</field>
            <operation>equals</operation>
            <value>true</value>
        </filterItems>
    </lookupFilter>
</CustomField>`;

const EXTERNAL_LOOKUP_FILTER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Ext_Ref__c</fullName>
    <type>ExternalLookup</type>
    <referenceTo>ExternalTarget__c</referenceTo>
    <lookupFilter>
        <filterItems>
            <field>ExternalTarget__c.Code__c</field>
            <operation>equals</operation>
            <value>X</value>
        </filterItems>
    </lookupFilter>
</CustomField>`;

const LOOKUP_FILTER_STANDARD_NAME_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Equipment__c</fullName>
    <type>Lookup</type>
    <referenceTo>Product2</referenceTo>
    <lookupFilter>
        <filterItems>
            <field>Product2.Name</field>
            <operation>equals</operation>
            <value>Widget</value>
        </filterItems>
    </lookupFilter>
</CustomField>`;

const LOOKUP_FILTER_MALFORMED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Equipment__c</fullName>
    <type>Lookup</type>
    <referenceTo>Product2</referenceTo>
    <lookupFilter>
        <filterItems>
            <field>Product2.</field>
            <operation>equals</operation>
            <value>1</value>
        </filterItems>
        <filterItems>
            <field>Product2.Parent.Field__c</field>
            <operation>equals</operation>
            <value>1</value>
        </filterItems>
        <filterItems>
            <field>Replacement_Part__c</field>
            <operation>equals</operation>
            <value>1</value>
        </filterItems>
        <filterItems>
            <field>Equipment__r.Replacement_Part__c</field>
            <operation>equals</operation>
            <value>1</value>
        </filterItems>
    </lookupFilter>
</CustomField>`;

const MASTER_DETAIL_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Session__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Session__c</referenceTo>
    <label>Session</label>
</CustomField>`;

const SESSION_LOOKUP_ON_BOOKING_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Session__c</fullName>
    <type>Lookup</type>
    <referenceTo>Session__c</referenceTo>
    <label>Session</label>
</CustomField>`;

const REPO_FILES = [
    'force-app/main/default/objects/Booking__c/fields/Status__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Session_Canceled__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Session__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Dup__c.field-meta.xml',
    'force-app/main/default/objects/Experience__c/fields/Rating__c.field-meta.xml',
    'force-app/main/default/objects/Experience__c/fields/Label__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Booked_Slots__c.field-meta.xml',
    'force-app/main/default/objects/Session__c/fields/Experience__c.field-meta.xml',
    'force-app/main/default/objects/Booking__c/fields/Master_Detail_Probe__c.field-meta.xml',
    'force-app/main/default/objects/Equipment_Maintenance_Item__c/fields/Equipment__c.field-meta.xml',
    'force-app/main/default/objects/Work_Item__c/fields/Equipment__c.field-meta.xml',
    'force-app/main/default/objects/Work_Item__c/fields/Equipment_Multi__c.field-meta.xml',
    'force-app/main/default/objects/Work_Item__c/fields/Equipment_Dup__c.field-meta.xml',
    'force-app/main/default/objects/Child__c/fields/Parent_Link__c.field-meta.xml',
    'force-app/main/default/objects/Ext_Obj__c/fields/Ext_Ref__c.field-meta.xml',
    'force-app/main/default/objects/Work_Item__c/fields/Equipment_StdName__c.field-meta.xml',
    'force-app/main/default/objects/Work_Item__c/fields/Equipment_Bad__c.field-meta.xml'
];

const fileContents = {
    'force-app/main/default/objects/Booking__c/fields/Status__c.field-meta.xml':
        FORMULA_SAME_OBJECT_XML,
    'force-app/main/default/objects/Booking__c/fields/Session_Canceled__c.field-meta.xml':
        FORMULA_PARENT_RELATIONSHIP_XML,
    'force-app/main/default/objects/Booking__c/fields/Session__c.field-meta.xml':
        SESSION_LOOKUP_ON_BOOKING_XML,
    'force-app/main/default/objects/Booking__c/fields/Dup__c.field-meta.xml':
        FORMULA_DUPLICATE_XML,
    'force-app/main/default/objects/Experience__c/fields/Rating__c.field-meta.xml':
        FORMULA_MULTIPLE_XML,
    'force-app/main/default/objects/Experience__c/fields/Label__c.field-meta.xml':
        FORMULA_STANDARD_AND_FUNCTIONS_XML,
    'force-app/main/default/objects/Session__c/fields/Booked_Slots__c.field-meta.xml':
        SUMMARY_WITH_FILTER_XML,
    'force-app/main/default/objects/Session__c/fields/Experience__c.field-meta.xml':
        LOOKUP_FIELD_XML,
    'force-app/main/default/objects/Booking__c/fields/Master_Detail_Probe__c.field-meta.xml':
        MASTER_DETAIL_FIELD_XML,
    'force-app/main/default/objects/Equipment_Maintenance_Item__c/fields/Equipment__c.field-meta.xml':
        EMI_EQUIPMENT_LOOKUP_FILTER_XML,
    'force-app/main/default/objects/Work_Item__c/fields/Equipment__c.field-meta.xml':
        LOOKUP_FILTER_CUSTOM_TARGET_XML,
    'force-app/main/default/objects/Work_Item__c/fields/Equipment_Multi__c.field-meta.xml':
        LOOKUP_FILTER_MULTIPLE_XML,
    'force-app/main/default/objects/Work_Item__c/fields/Equipment_Dup__c.field-meta.xml':
        LOOKUP_FILTER_DUPLICATE_XML,
    'force-app/main/default/objects/Child__c/fields/Parent_Link__c.field-meta.xml':
        MASTER_DETAIL_LOOKUP_FILTER_XML,
    'force-app/main/default/objects/Ext_Obj__c/fields/Ext_Ref__c.field-meta.xml':
        EXTERNAL_LOOKUP_FILTER_XML,
    'force-app/main/default/objects/Work_Item__c/fields/Equipment_StdName__c.field-meta.xml':
        LOOKUP_FILTER_STANDARD_NAME_XML,
    'force-app/main/default/objects/Work_Item__c/fields/Equipment_Bad__c.field-meta.xml':
        LOOKUP_FILTER_MALFORMED_XML
};

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');
    const content = fileContents[normalized];

    if (!content) {
        throw new Error(`Unexpected file read: ${filePath}`);
    }

    return content;
}

async function main() {
    await runTest(
        'Formula references same-object custom field',
        async () => {
            const names = extractExpressionCustomFieldNames(
                FORMULA_SAME_OBJECT_XML,
                'Booking__c'
            );

            assert.deepStrictEqual(names.sort(), [
                'Booking__c.Is_Canceled__c'
            ]);

            const result = await customObjectRelationshipDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.Status__c'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.ok(
                customFieldNames(result.relationships).includes(
                    'Booking__c.Is_Canceled__c'
                )
            );
        }
    );

    await runTest(
        'Formula references parent relationship custom field',
        async () => {
            const relationshipTargetMap = new Map([
                ['Session__r', 'Session__c']
            ]);

            const names = extractExpressionCustomFieldNames(
                FORMULA_PARENT_RELATIONSHIP_XML,
                'Booking__c',
                relationshipTargetMap
            );

            assert.deepStrictEqual(names.sort(), [
                'Session__c.Is_Canceled__c'
            ]);

            const result = await customObjectRelationshipDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.Session_Canceled__c'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.ok(
                customFieldNames(result.relationships).includes(
                    'Session__c.Is_Canceled__c'
                )
            );
        }
    );

    await runTest('Multiple referenced custom fields', async () => {
        const names = extractExpressionCustomFieldNames(
            FORMULA_MULTIPLE_XML,
            'Experience__c'
        );

        assert.deepStrictEqual(names.sort(), [
            'Experience__c.Number_of_Guests__c',
            'Experience__c.Status__c',
            'Experience__c.Sum_of_Guest_Reviews__c'
        ]);
    });

    await runTest('Duplicate references collapse', async () => {
        const deps = discoverExpressionFieldDependencies({
            fieldXml: FORMULA_DUPLICATE_XML,
            ownerObjectApiName: 'Booking__c',
            sourceField: 'Dup__c',
            sourceMetadata: 'Booking__c'
        });

        assert.strictEqual(deps.length, 1);
        assert.strictEqual(deps[0].name, 'Booking__c.Is_Canceled__c');
        assert.strictEqual(deps[0].metadataType, 'CustomField');
    });

    await runTest('Standard fields ignored', async () => {
        const names = extractExpressionCustomFieldNames(
            FORMULA_STANDARD_AND_FUNCTIONS_XML,
            'Experience__c'
        );

        assert.deepStrictEqual(names.sort(), ['Experience__c.Status__c']);
        assert.ok(!names.includes('Experience__c.Name'));
        assert.ok(!names.some((name) => name.endsWith('.CreatedDate')));
    });

    await runTest(
        'Formula with IF(), CASE(), ISPICKVAL() still extracts custom fields',
        async () => {
            const names = extractExpressionCustomFieldNames(
                FORMULA_STANDARD_AND_FUNCTIONS_XML,
                'Experience__c'
            );

            assert.ok(names.includes('Experience__c.Status__c'));
        }
    );

    await runTest(
        'Summary filter expression emits Booking__c.Is_Canceled__c additively',
        async () => {
            const result = await customObjectRelationshipDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.Booked_Slots__c'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            const fields = customFieldNames(result.relationships);

            assert.ok(fields.includes('Booking__c.Is_Canceled__c'));
            assert.ok(fields.includes('Booking__c.Number_of_Guests__c'));
            assert.ok(fields.includes('Booking__c.Session__c'));
            assert.ok(
                result.relationships.some(
                    (item) =>
                        item.name === 'Booking__c' &&
                        item.metadataType === 'CustomObject'
                )
            );
        }
    );

    await runTest('Existing Lookup behavior unchanged', async () => {
        const parsed = parseRelationshipFromFieldXml(LOOKUP_FIELD_XML);

        assert.strictEqual(parsed.relationship, 'Lookup');
        assert.strictEqual(parsed.referencedObject, 'Experience__c');

        const result = await customObjectRelationshipDiscoverer.discover({
            selectedMetadata: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Experience__c'
                }
            ],
            repoFiles: REPO_FILES,
            readRepoFile
        });

        assert.deepStrictEqual(namesOf(result.relationships), [
            'Experience__c'
        ]);
    });

    await runTest(
        'P0-3B: EMI Equipment lookupFilter discovers Product2.Replacement_Part__c',
        async () => {
            const names = extractExpressionCustomFieldNames(
                EMI_EQUIPMENT_LOOKUP_FILTER_XML,
                'Equipment_Maintenance_Item__c'
            );

            assert.deepStrictEqual(names, ['Product2.Replacement_Part__c']);

            const deps = discoverExpressionFieldDependencies({
                fieldXml: EMI_EQUIPMENT_LOOKUP_FILTER_XML,
                ownerObjectApiName: 'Equipment_Maintenance_Item__c',
                sourceField: 'Equipment__c'
            });

            assert.strictEqual(deps.length, 1);
            assert.strictEqual(deps[0].name, 'Product2.Replacement_Part__c');
            assert.strictEqual(deps[0].metadataType, 'CustomField');
            assert.strictEqual(deps[0].type, 'CustomField');
            assert.strictEqual(deps[0].required, true);
            assert.strictEqual(deps[0].selected, true);
            // Decision/DTO layer treats missing editable as false (not user-toggleable).
            assert.strictEqual(deps[0].editable === true, false);
            assert.strictEqual(deps[0].relationship, 'LookupFilter');
            assert.deepStrictEqual(
                {
                    name: deps[0].name,
                    type: deps[0].type,
                    required: deps[0].required,
                    selected: deps[0].selected,
                    editable: deps[0].editable === true
                },
                {
                    name: 'Product2.Replacement_Part__c',
                    type: 'CustomField',
                    required: true,
                    selected: true,
                    editable: false
                }
            );

            const result = await customObjectRelationshipDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName:
                            'Equipment_Maintenance_Item__c.Equipment__c'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.ok(
                customFieldNames(result.relationships).includes(
                    'Product2.Replacement_Part__c'
                )
            );
            assert.ok(
                !result.relationships.some(
                    (item) =>
                        item.name === 'Product2' &&
                        item.metadataType === 'CustomObject'
                )
            );
            assert.ok(
                !customFieldNames(result.relationships).includes(
                    'Equipment__c.Replacement_Part__c'
                )
            );
        }
    );

    await runTest(
        'P0-3B: lookupFilter custom target field discovered',
        async () => {
            const names = extractExpressionCustomFieldNames(
                LOOKUP_FILTER_CUSTOM_TARGET_XML,
                'Work_Item__c'
            );

            assert.deepStrictEqual(names, ['Target__c.Special_Field__c']);
        }
    );

    await runTest(
        'P0-3B: multiple lookupFilter filterItems discovered',
        async () => {
            const names = extractExpressionCustomFieldNames(
                LOOKUP_FILTER_MULTIPLE_XML,
                'Work_Item__c'
            );

            assert.deepStrictEqual(names, [
                'Target__c.Field_A__c',
                'Target__c.Field_B__c'
            ]);
        }
    );

    await runTest(
        'P0-3B: MasterDetail lookupFilter discovers target CustomField',
        async () => {
            const names = extractExpressionCustomFieldNames(
                MASTER_DETAIL_LOOKUP_FILTER_XML,
                'Child__c'
            );

            assert.deepStrictEqual(names, ['Parent__c.Active_Flag__c']);
        }
    );

    await runTest(
        'P0-3B: ExternalLookup lookupFilter discovers target CustomField',
        async () => {
            const names = extractExpressionCustomFieldNames(
                EXTERNAL_LOOKUP_FILTER_XML,
                'Ext_Obj__c'
            );

            assert.deepStrictEqual(names, ['ExternalTarget__c.Code__c']);
        }
    );

    await runTest(
        'P0-3B: standard Product2.Name filter is not a CustomField dependency',
        async () => {
            const names = extractExpressionCustomFieldNames(
                LOOKUP_FILTER_STANDARD_NAME_XML,
                'Work_Item__c'
            );

            assert.deepStrictEqual(names, []);
        }
    );

    await runTest(
        'P0-3B: malformed lookupFilter fields invent nothing',
        async () => {
            const names = extractExpressionCustomFieldNames(
                LOOKUP_FILTER_MALFORMED_XML,
                'Work_Item__c'
            );

            assert.deepStrictEqual(names, []);
        }
    );

    await runTest(
        'P0-3B: referenceTo alone does not invent filter CustomFields',
        async () => {
            const names = extractExpressionCustomFieldNames(
                LOOKUP_FIELD_XML,
                'Session__c'
            );

            assert.deepStrictEqual(names, []);
        }
    );

    await runTest(
        'P0-3B: duplicate lookupFilter field collapses to one dependency',
        async () => {
            const deps = discoverExpressionFieldDependencies({
                fieldXml: LOOKUP_FILTER_DUPLICATE_XML,
                ownerObjectApiName: 'Work_Item__c',
                sourceField: 'Equipment_Dup__c'
            });

            assert.strictEqual(deps.length, 1);
            assert.strictEqual(deps[0].name, 'Product2.Replacement_Part__c');
        }
    );

    await runTest('Existing MasterDetail behavior unchanged', async () => {
        const parsed = parseRelationshipFromFieldXml(MASTER_DETAIL_FIELD_XML);

        assert.strictEqual(parsed.relationship, 'MasterDetail');
        assert.strictEqual(parsed.referencedObject, 'Session__c');

        const result = await customObjectRelationshipDiscoverer.discover({
            selectedMetadata: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Master_Detail_Probe__c'
                }
            ],
            repoFiles: REPO_FILES,
            readRepoFile
        });

        assert.deepStrictEqual(namesOf(result.relationships), ['Session__c']);
    });
}

main();
