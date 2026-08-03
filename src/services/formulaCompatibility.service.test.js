const assert = require('assert');

const {
    analyzeFormulaCompatibility,
    detectPicklistUsageWarnings,
    mapFormulaConversionWarnings,
    CATEGORIES
} = require('./formulaCompatibility.service');

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

const VALID_FORMULA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status_Label__c</fullName>
    <type>Formula</type>
    <formula>IF(Is_Canceled__c, "Canceled", "Active")</formula>
</CustomField>`;

const MISSING_RELATION_FORMULA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Session_Status__c</fullName>
    <type>Formula</type>
    <formula>Session__r.Status__c</formula>
</CustomField>`;

const PICKLIST_FORMULA_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Open_Flag__c</fullName>
    <type>Formula</type>
    <formula>IF(Status__c = "Open", 1, 0)</formula>
</CustomField>`;

const SUMMARY_MISSING_ROLLUP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
    <summarizedField>Number_of_Guests__c</summarizedField>
    <summaryFilterItems>
        <field>Booking__c.Is_Canceled__c</field>
        <operation>equals</operation>
        <value>false</value>
    </summaryFilterItems>
</CustomField>`;

const SUMMARY_FILTER_ONLY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Active_Count__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
    <summaryOperation>count</summaryOperation>
    <summaryFilterItems>
        <field>Is_Canceled__c</field>
        <operation>equals</operation>
        <value>false</value>
    </summaryFilterItems>
</CustomField>`;

function packageWith(fields) {
    return {
        metadata: fields.map((field) => ({
            metadataType: 'CustomField',
            metadataName: field.name,
            filePath: field.filePath,
            content: field.xml
        })),
        dependencies: fieldDependencies(fields)
    };
}

function fieldDependencies(fields) {
    return (fields[0]?.deps || []).map((name) => ({
        type: 'CustomField',
        name,
        metadataType: 'CustomField',
        metadataName: name
    }));
}

async function main() {
    await runTest('valid formula — no missing-field warnings', async () => {
        const result = await analyzeFormulaCompatibility({
            generatedDeploymentPackage: packageWith([
                {
                    name: 'Booking__c.Status_Label__c',
                    filePath:
                        'force-app/main/default/objects/Booking__c/fields/Status_Label__c.field-meta.xml',
                    xml: VALID_FORMULA_XML,
                    deps: ['Booking__c.Is_Canceled__c']
                }
            ])
        });

        assert.strictEqual(result.overallStatus, 'PASS');
        assert.strictEqual(result.warnings.length, 0);
        assert.strictEqual(result.summary.analyzed, 1);
    });

    await runTest('missing related field warning', async () => {
        const result = await analyzeFormulaCompatibility({
            generatedDeploymentPackage: packageWith([
                {
                    name: 'Booking__c.Session_Status__c',
                    filePath:
                        'force-app/main/default/objects/Booking__c/fields/Session_Status__c.field-meta.xml',
                    xml: MISSING_RELATION_FORMULA_XML,
                    deps: []
                }
            ])
        });

        assert.strictEqual(result.overallStatus, 'WARNING');
        assert.ok(
            result.warnings.some(
                (warning) =>
                    warning.category === CATEGORIES.MISSING_RELATION &&
                    warning.message.includes('Session__c.Status__c')
            )
        );
    });

    await runTest('missing roll-up field warning', async () => {
        const result = await analyzeFormulaCompatibility({
            generatedDeploymentPackage: packageWith([
                {
                    name: 'Session__c.Booked_Slots__c',
                    filePath:
                        'force-app/main/default/objects/Session__c/fields/Booked_Slots__c.field-meta.xml',
                    xml: SUMMARY_MISSING_ROLLUP_XML,
                    deps: []
                }
            ])
        });

        assert.strictEqual(result.overallStatus, 'WARNING');
        assert.ok(
            result.warnings.some(
                (warning) =>
                    warning.category === CATEGORIES.ROLLUP_REFERENCE &&
                    warning.message.includes('Number_of_Guests__c')
            )
        );
        assert.ok(
            result.warnings.some(
                (warning) =>
                    warning.category === CATEGORIES.ROLLUP_REFERENCE &&
                    warning.message.includes('Booking__c.Session__c')
            )
        );
    });

    await runTest('picklist comparison warning', async () => {
        const warnings = detectPicklistUsageWarnings(
            PICKLIST_FORMULA_XML,
            'Booking__c.Open_Flag__c'
        );

        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(warnings[0].category, CATEGORIES.PICKLIST_USAGE);

        const result = await analyzeFormulaCompatibility({
            generatedDeploymentPackage: packageWith([
                {
                    name: 'Booking__c.Open_Flag__c',
                    filePath:
                        'force-app/main/default/objects/Booking__c/fields/Open_Flag__c.field-meta.xml',
                    xml: PICKLIST_FORMULA_XML,
                    deps: ['Booking__c.Status__c']
                }
            ])
        });

        assert.ok(
            result.warnings.some(
                (warning) => warning.category === CATEGORIES.PICKLIST_USAGE
            )
        );
    });

    await runTest('summaryFilterItems reference warning', async () => {
        const result = await analyzeFormulaCompatibility({
            generatedDeploymentPackage: packageWith([
                {
                    name: 'Session__c.Active_Count__c',
                    filePath:
                        'force-app/main/default/objects/Session__c/fields/Active_Count__c.field-meta.xml',
                    xml: SUMMARY_FILTER_ONLY_XML,
                    deps: ['Booking__c.Session__c']
                }
            ])
        });

        assert.ok(
            result.warnings.some(
                (warning) =>
                    warning.category === CATEGORIES.ROLLUP_REFERENCE &&
                    warning.message.includes('Booking__c.Is_Canceled__c')
            )
        );
    });

    await runTest('formula conversion warning mapping', async () => {
        const mapped = mapFormulaConversionWarnings([
            {
                metadataName: 'Booking__c.Status__c',
                message:
                    'Cannot update a field to a Formula from something else'
            }
        ]);

        assert.strictEqual(mapped.length, 1);
        assert.strictEqual(mapped[0].category, CATEGORIES.FORMULA_CONVERSION);
        assert.ok(mapped[0].message.includes('Booking__c.Status__c'));

        const result = await analyzeFormulaCompatibility({
            generatedDeploymentPackage: packageWith([
                {
                    name: 'Booking__c.Status_Label__c',
                    filePath:
                        'force-app/main/default/objects/Booking__c/fields/Status_Label__c.field-meta.xml',
                    xml: VALID_FORMULA_XML,
                    deps: ['Booking__c.Is_Canceled__c']
                }
            ]),
            existingFindings: [
                {
                    metadataName: 'Booking__c.Status__c',
                    message:
                        'Cannot update a field to a Formula from something else'
                }
            ]
        });

        assert.ok(
            result.warnings.some(
                (warning) =>
                    warning.category === CATEGORIES.FORMULA_CONVERSION
            )
        );
    });
}

main();
