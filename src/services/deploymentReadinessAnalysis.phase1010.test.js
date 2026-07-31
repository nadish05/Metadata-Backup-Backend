const assert = require('assert');

const {
    analyzeDeploymentReadiness,
    analyzeRollUpSummaryField,
    analyzeFormulaField,
    buildPackageMembership,
    extractRollUpSummarySemantics,
    buildRollupSummaryValidation
} = require('./deploymentReadinessAnalysis.service');
const {
    evaluateDeploymentReadiness
} = require('./deploymentReadiness.service');

const BOOKED_SLOTS_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summarizedObject>Booking__c</summarizedObject>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
    <relationshipName>Bookings</relationshipName>
    <summaryOperation>count</summaryOperation>
</CustomField>
`;

const AVAILABLE_SLOTS_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Available_Slots__c</fullName>
    <type>Formula</type>
    <formula>Capacity__c - Booked_Slots__c</formula>
</CustomField>
`;

const PERCENTAGE_BOOKED_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Percentage_Booked__c</fullName>
    <type>Formula</type>
    <formula>Booked_Slots__c / Capacity__c</formula>
</CustomField>
`;

const CAPACITY_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Capacity__c</fullName>
    <type>Number</type>
    <precision>18</precision>
    <scale>0</scale>
</CustomField>
`;

async function runTest(name, fn) {
    try {
        await fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

async function main() {
    await runTest(
        'Roll-Up Summary with valid child object → PASS',
        async () => {
            const report = await analyzeDeploymentReadiness({
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'CustomObject',
                            metadataName: 'Booking__c'
                        },
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Booked_Slots__c',
                            content: BOOKED_SLOTS_XML
                        }
                    ],
                    dependencies: []
                }
            });

            assert.strictEqual(report.overallStatus, 'PASS');
            assert.strictEqual(
                report.rollupSummaryValidation.overallStatus,
                'PASS'
            );
            assert.strictEqual(report.rollupSummaryValidation.blockingCount, 0);
            assert.strictEqual(report.rollupSummaryValidation.validatedCount, 1);
            assert.deepStrictEqual(report.rollupSummaryValidation.issues, []);
        }
    );

    await runTest(
        'Roll-Up Summary with missing child object → BLOCKING',
        async () => {
            const membership = buildPackageMembership({
                metadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.Booked_Slots__c',
                        content: BOOKED_SLOTS_XML
                    }
                ],
                dependencies: []
            });

            const findings = analyzeRollUpSummaryField(
                membership.byType.get('CustomField')[0],
                BOOKED_SLOTS_XML,
                membership
            );

            assert.strictEqual(findings.length, 1);
            assert.strictEqual(findings[0].type, 'Missing Roll-Up Dependency');
            assert.strictEqual(findings[0].component, 'Session__c.Booked_Slots__c');
            assert.strictEqual(findings[0].requiredObject, 'Booking__c');
            assert.strictEqual(findings[0].severity, 'BLOCKING');
            assert.strictEqual(findings[0].status, 'BLOCKING');
            assert.ok(
                String(findings[0].reason).includes(
                    'requires child object Booking__c'
                )
            );

            const semantics = extractRollUpSummarySemantics(
                BOOKED_SLOTS_XML,
                'Session__c'
            );
            assert.strictEqual(semantics.summarizedObject, 'Booking__c');
            assert.strictEqual(
                semantics.summaryForeignKey,
                'Booking__c.Session__c'
            );
            assert.strictEqual(semantics.relationshipName, 'Bookings');
            assert.strictEqual(semantics.summaryOperation, 'count');
            assert.strictEqual(semantics.requiredChildObject, 'Booking__c');

            const report = await analyzeDeploymentReadiness({
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Booked_Slots__c',
                            content: BOOKED_SLOTS_XML
                        },
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Capacity__c',
                            content: CAPACITY_XML
                        },
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Available_Slots__c',
                            content: AVAILABLE_SLOTS_XML
                        },
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Percentage_Booked__c',
                            content: PERCENTAGE_BOOKED_XML
                        },
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'ExperienceController',
                            content: `
public class ExperienceController {
    public static Decimal pct(Id id) {
        return [SELECT Percentage_Booked__c FROM Session__c WHERE Id = :id].Percentage_Booked__c;
    }
}
`
                        },
                        {
                            metadataType: 'LightningComponentBundle',
                            metadataName: 'experienceSchedule',
                            content: `
import pct from '@salesforce/apex/ExperienceController.pct';
`
                        },
                        {
                            metadataType: 'FlexiPage',
                            metadataName: 'Experience_Record_Page'
                        }
                    ],
                    dependencies: []
                },
                discoveredReferences: [
                    {
                        metadataType: 'LightningComponentBundle',
                        name: 'experienceSchedule',
                        sourceMetadata: 'Experience_Record_Page'
                    }
                ]
            });

            assert.strictEqual(
                report.rollupSummaryValidation.overallStatus,
                'BLOCKING'
            );
            assert.strictEqual(report.rollupSummaryValidation.issues.length, 1);
            assert.strictEqual(
                report.rollupSummaryValidation.issues[0].requiredObject,
                'Booking__c'
            );
            assert.ok(
                report.dependencyChains.some((chain) =>
                    /Booked_Slots__c.*Available_Slots__c.*Percentage_Booked__c.*ExperienceController.*experienceSchedule.*Experience_Record_Page/.test(
                        chain.rendered.replace(/\s/g, '')
                    ) ||
                    (chain.rendered.includes('Booked_Slots__c') &&
                        chain.rendered.includes('Available_Slots__c') &&
                        chain.rendered.includes('Percentage_Booked__c') &&
                        chain.rendered.includes('ExperienceController') &&
                        chain.rendered.includes('experienceSchedule') &&
                        chain.rendered.includes('Experience_Record_Page'))
                )
            );
        }
    );

    await runTest('Non Roll-Up Summary fields → unaffected', async () => {
        const membership = buildPackageMembership({
            metadata: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Capacity__c',
                    content: CAPACITY_XML
                },
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Available_Slots__c',
                    content: AVAILABLE_SLOTS_XML
                }
            ],
            dependencies: []
        });

        const numberFindings = analyzeRollUpSummaryField(
            membership.byType.get('CustomField')[0],
            CAPACITY_XML,
            membership
        );
        assert.deepStrictEqual(numberFindings, []);

        const formulaFindings = analyzeFormulaField(
            membership.byType.get('CustomField')[1],
            AVAILABLE_SLOTS_XML,
            membership
        );
        // Formula still reports missing Booked_Slots — roll-up rule does not fire.
        assert.ok(
            !formulaFindings.some((finding) =>
                String(finding.rule || '').includes('ROLLUP')
            )
        );

        const rollupValidation = buildRollupSummaryValidation(formulaFindings);
        assert.strictEqual(rollupValidation.overallStatus, 'PASS');
        assert.strictEqual(rollupValidation.validatedCount, 0);
    });

    await runTest(
        'Existing Deployment Validation gate remains unchanged',
        async () => {
            const gate = evaluateDeploymentReadiness({
                deploymentValidation: { status: 'READY' },
                metadataValidation: { overallStatus: 'PASS', results: [] },
                dependencyValidation: { overallStatus: 'PASS', results: [] },
                deploymentApiVersionPolicy: {
                    compatible: true,
                    deploymentApiVersion: 61
                }
            });

            assert.strictEqual(gate.overallStatus, 'READY');
            assert.strictEqual(gate.canDeploy, true);
            assert.ok(!('rollupSummaryValidation' in gate));

            // Simulates validation wiring: additive only.
            gate.rollupSummaryValidation = {
                overallStatus: 'BLOCKING',
                issues: [
                    {
                        component: 'Session__c.Booked_Slots__c',
                        requiredObject: 'Booking__c',
                        severity: 'BLOCKING'
                    }
                ]
            };

            assert.strictEqual(gate.canDeploy, true);
            assert.strictEqual(gate.overallStatus, 'READY');
        }
    );
}

main();
