const assert = require('assert');

const {
    analyzeDeploymentReadiness,
    analyzeRollUpSummaryField,
    analyzeFormulaField,
    buildPackageMembership,
    buildEmptyAnalysis,
    buildSchemaConflictPlaceholders
} = require('./deploymentReadinessAnalysis.service');

const BOOKED_SLOTS_XML = `
<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Booked_Slots__c</fullName>
    <type>Summary</type>
    <summaryForeignKey>Booking__c.Session__c</summaryForeignKey>
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

const HEALTHY_NUMBER_XML = `
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
    await runTest('Empty deployment → PASS with empty collections', async () => {
        const report = await analyzeDeploymentReadiness({
            generatedDeploymentPackage: { metadata: [], dependencies: [] }
        });

        assert.strictEqual(report.overallStatus, 'PASS');
        assert.deepStrictEqual(report.missingDependencies, []);
        assert.deepStrictEqual(report.blockingComponents, []);
        assert.deepStrictEqual(report.apiCompatibilityWarnings, []);
        assert.deepStrictEqual(report.schemaConflicts, []);
        assert.deepStrictEqual(report.dependencyChains, []);
    });

    await runTest('buildEmptyAnalysis helper', async () => {
        const empty = buildEmptyAnalysis('No members');
        assert.strictEqual(empty.overallStatus, 'PASS');
        assert.strictEqual(empty.summary.reason, 'No members');
    });

    await runTest('Roll-Up Summary dependency detection', async () => {
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
        assert.strictEqual(findings[0].code, 'Missing Roll-Up Dependency');
        assert.strictEqual(findings[0].requiredObject, 'Booking__c');
        assert.strictEqual(findings[0].severity, 'BLOCKING');
        assert.strictEqual(findings[0].status, 'BLOCKING');
    });

    await runTest('Formula dependency detection', async () => {
        const membership = buildPackageMembership({
            metadata: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Available_Slots__c',
                    content: AVAILABLE_SLOTS_XML
                },
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Capacity__c',
                    content: HEALTHY_NUMBER_XML
                }
            ],
            dependencies: []
        });

        const findings = analyzeFormulaField(
            membership.byType.get('CustomField')[0],
            AVAILABLE_SLOTS_XML,
            membership
        );

        assert.ok(
            findings.some(
                (finding) =>
                    finding.code === 'Missing Formula Dependency' &&
                    finding.missingName === 'Session__c.Booked_Slots__c'
            )
        );
        assert.ok(
            !findings.some(
                (finding) => finding.missingName === 'Session__c.Capacity__c'
            )
        );
    });

    await runTest(
        'Blocked Apex / LWC / FlexiPage chain from missing roll-up parent',
        async () => {
            const report = await analyzeDeploymentReadiness({
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Booked_Slots__c',
                            content: BOOKED_SLOTS_XML
                        },
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'ExperienceController',
                            content: `
public with sharing class ExperienceController {
    @AuraEnabled
    public static Integer getBooked(Id sessionId) {
        Session__c row = [
            SELECT Booked_Slots__c FROM Session__c WHERE Id = :sessionId
        ];
        return Integer.valueOf(row.Booked_Slots__c);
    }
}
`
                        },
                        {
                            metadataType: 'LightningComponentBundle',
                            metadataName: 'experienceSchedule',
                            content: `
import getBooked from '@salesforce/apex/ExperienceController.getBooked';
export default class ExperienceSchedule {}
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

            assert.strictEqual(report.overallStatus, 'FAIL');
            assert.ok(
                report.missingDependencies.some(
                    (item) =>
                        item.code === 'Missing Roll-Up Dependency' &&
                        item.requiredObject === 'Booking__c'
                )
            );
            assert.strictEqual(
                report.rollupSummaryValidation.overallStatus,
                'BLOCKING'
            );
            assert.ok(
                report.blockingComponents.some(
                    (item) =>
                        item.code === 'Blocked Apex Compilation' &&
                        item.metadataName === 'ExperienceController'
                )
            );
            assert.ok(
                report.blockingComponents.some(
                    (item) =>
                        item.code === 'Blocked Lightning Component' &&
                        item.metadataName === 'experienceSchedule'
                )
            );
            assert.ok(
                report.blockingComponents.some(
                    (item) =>
                        item.code === 'Blocked FlexiPage' &&
                        item.metadataName === 'Experience_Record_Page'
                )
            );
            assert.ok(
                report.dependencyChains.some((chain) =>
                    String(chain.rendered).includes('ExperienceController')
                )
            );
        }
    );

    await runTest('Flow API compatibility warning', async () => {
        const report = await analyzeDeploymentReadiness({
            generatedDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Session_Booking_Flow',
                        content: `
<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <areMetricsLoggedToDataCloud>false</areMetricsLoggedToDataCloud>
    <apiVersion>58.0</apiVersion>
    <status>Active</status>
</Flow>
`
                    }
                ],
                dependencies: []
            },
            deploymentApiVersionPolicy: {
                deploymentApiVersion: 58
            }
        });

        assert.strictEqual(report.overallStatus, 'WARNING');
        assert.ok(
            report.apiCompatibilityWarnings.some(
                (item) =>
                    item.code === 'API Compatibility Warning' &&
                    item.metadataName === 'Session_Booking_Flow'
            )
        );
    });

    await runTest('Healthy deployment → PASS', async () => {
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
                    },
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.Capacity__c',
                        content: HEALTHY_NUMBER_XML
                    },
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.Available_Slots__c',
                        content: AVAILABLE_SLOTS_XML
                    },
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'ExperienceController',
                        content: `
public with sharing class ExperienceController {
    public static Integer getBooked(Id sessionId) {
        Session__c row = [
            SELECT Booked_Slots__c, Available_Slots__c FROM Session__c WHERE Id = :sessionId
        ];
        return Integer.valueOf(row.Booked_Slots__c);
    }
}
`
                    }
                ],
                dependencies: []
            },
            deploymentApiVersionPolicy: {
                deploymentApiVersion: 64
            }
        });

        assert.strictEqual(report.overallStatus, 'PASS');
        assert.strictEqual(report.missingDependencies.length, 0);
        assert.strictEqual(report.blockingComponents.length, 0);
    });

    await runTest('Schema conflict placeholder framework only', async () => {
        const empty = buildSchemaConflictPlaceholders();
        assert.deepStrictEqual(empty, []);

        const seeded = buildSchemaConflictPlaceholders({
            priorSchemaConflicts: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Status__c',
                    message:
                        'Cannot update a field to a Formula from something else'
                }
            ]
        });

        assert.strictEqual(seeded.length, 1);
        assert.strictEqual(seeded[0].code, 'Potential Schema Conflict');
    });

    await runTest(
        'Analysis does not mutate generated deployment package',
        async () => {
            const generatedDeploymentPackage = {
                metadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Session__c.Booked_Slots__c',
                        content: BOOKED_SLOTS_XML
                    }
                ],
                dependencies: []
            };
            const before = JSON.stringify(generatedDeploymentPackage);

            await analyzeDeploymentReadiness({ generatedDeploymentPackage });

            assert.strictEqual(
                JSON.stringify(generatedDeploymentPackage),
                before
            );
        }
    );
}

main();
