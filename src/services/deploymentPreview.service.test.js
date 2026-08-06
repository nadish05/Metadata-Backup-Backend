const assert = require('assert');

const {
    buildDeploymentPreview,
    buildDeploymentPreviewSafe,
    emptyPreview,
    resolveDeploymentMode,
    resolveEstimatedRisk
} = require('./deploymentPreview.service');

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

function buildPackage(members) {
    return {
        metadata: members.map((member) => ({
            metadataType: member.metadataType,
            metadataName: member.metadataName
        })),
        dependencies: [],
        testClasses: [],
        summary: {
            metadataCount: members.length,
            dependencyCount: 0,
            testClassCount: 0,
            totalComponents: members.length
        }
    };
}

async function main() {
    await runTest('Full deployment', async () => {
        const result = buildDeploymentPreview({
            generatedDeploymentPackage: buildPackage([
                { metadataType: 'CustomObject', metadataName: 'Booking__c' },
                { metadataType: 'ApexClass', metadataName: 'BookingService' }
            ]),
            excludedComponents: [],
            blockingComponents: [],
            compatibilityWarnings: []
        });

        assert.strictEqual(result.deploymentMode, 'FULL');
        assert.strictEqual(result.estimatedRisk, 'LOW');
        assert.strictEqual(result.summary.deployableCount, 2);
        assert.strictEqual(result.summary.excludedCount, 0);
        assert.strictEqual(result.summary.blockingCount, 0);
        assert.ok(
            result.notes.some((note) =>
                /no blocking dependencies/i.test(note)
            )
        );
        assert.ok(
            result.notes.some((note) => /Apex metadata/i.test(note))
        );
    });

    await runTest('Partial deployment', async () => {
        const result = buildDeploymentPreview({
            generatedDeploymentPackage: buildPackage([
                { metadataType: 'CustomField', metadataName: 'Booking__c.Name__c' }
            ]),
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Status_Label__c',
                    category: 'FORMULA_TYPE_CHANGE'
                }
            ],
            blockingComponents: [],
            compatibilityWarnings: [
                {
                    category: 'FORMULA_TYPE_CHANGE',
                    metadataName: 'Booking__c.Status_Label__c'
                }
            ]
        });

        assert.strictEqual(result.deploymentMode, 'PARTIAL');
        assert.strictEqual(result.estimatedRisk, 'MEDIUM');
        assert.strictEqual(result.summary.excludedCount, 1);
        assert.strictEqual(result.summary.blockingCount, 0);
        assert.strictEqual(result.summary.warningCount, 1);
        assert.ok(
            result.notes.some((note) =>
                /exclude incompatible Formula/i.test(note)
            )
        );
        assert.strictEqual(result.deploymentStatistics.excludedMetadata, 1);
        assert.strictEqual(result.deploymentStatistics.deployableMetadata, 1);
        assert.strictEqual(result.deploymentStatistics.totalMetadata, 2);
    });

    await runTest('Blocked deployment', async () => {
        const result = buildDeploymentPreview({
            generatedDeploymentPackage: buildPackage([
                { metadataType: 'CustomObject', metadataName: 'Booking__c' }
            ]),
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Status__c',
                    category: 'FORMULA_TYPE_CHANGE'
                }
            ],
            blockingComponents: [
                {
                    metadataType: 'CustomObject',
                    metadataName: 'Booking__c',
                    blockedBy: [
                        {
                            metadataName: 'Booking__c.Status__c',
                            category: 'FORMULA_TYPE_CHANGE'
                        }
                    ]
                }
            ],
            compatibilityWarnings: []
        });

        assert.strictEqual(result.deploymentMode, 'BLOCKED');
        assert.strictEqual(result.estimatedRisk, 'HIGH');
        assert.strictEqual(result.summary.blockingCount, 1);
        assert.ok(
            result.notes.some((note) =>
                /blocked until compatibility issues/i.test(note)
            )
        );
    });

    await runTest('Metadata grouping', async () => {
        const result = buildDeploymentPreview({
            generatedDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.A__c'
                    },
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.B__c'
                    },
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Booking__c'
                    },
                    { metadataType: 'Flow', metadataName: 'Booking_Flow' }
                ],
                dependencies: [
                    {
                        type: 'LightningComponentBundle',
                        name: 'bookingCard'
                    },
                    { type: 'ApexClass', name: 'BookingService' }
                ],
                testClasses: []
            },
            excludedComponents: [],
            blockingComponents: [],
            compatibilityWarnings: []
        });

        const byType = Object.fromEntries(
            result.metadataBreakdown.map((entry) => [
                entry.metadataType,
                entry.count
            ])
        );

        assert.strictEqual(byType.CustomField, 2);
        assert.strictEqual(byType.CustomObject, 1);
        assert.strictEqual(byType.Flow, 1);
        assert.strictEqual(byType.LightningComponentBundle, 1);
        assert.strictEqual(byType.ApexClass, 1);
        assert.strictEqual(result.summary.deployableCount, 6);
        assert.ok(result.notes.some((note) => /Flow metadata/i.test(note)));
        assert.ok(result.notes.some((note) => /LWC bundles/i.test(note)));
    });

    await runTest('Risk calculation', async () => {
        assert.strictEqual(resolveEstimatedRisk(0, 0), 'LOW');
        assert.strictEqual(resolveEstimatedRisk(2, 0), 'MEDIUM');
        assert.strictEqual(resolveEstimatedRisk(0, 1), 'HIGH');
        assert.strictEqual(resolveEstimatedRisk(3, 2), 'HIGH');

        assert.strictEqual(resolveDeploymentMode(0, 0), 'FULL');
        assert.strictEqual(resolveDeploymentMode(1, 0), 'PARTIAL');
        assert.strictEqual(resolveDeploymentMode(0, 1), 'BLOCKED');
        assert.strictEqual(resolveDeploymentMode(5, 1), 'BLOCKED');
    });

    await runTest('Empty package', async () => {
        const result = buildDeploymentPreview({
            generatedDeploymentPackage: {
                metadata: [],
                dependencies: [],
                testClasses: []
            },
            excludedComponents: [],
            blockingComponents: [],
            compatibilityWarnings: []
        });

        assert.strictEqual(result.deploymentMode, 'FULL');
        assert.strictEqual(result.estimatedRisk, 'LOW');
        assert.deepStrictEqual(result.summary, {
            deployableCount: 0,
            excludedCount: 0,
            blockingCount: 0,
            warningCount: 0
        });
        assert.deepStrictEqual(result.metadataBreakdown, []);
        assert.strictEqual(result.deploymentStatistics.totalMetadata, 0);
        assert.deepStrictEqual(result.metadataApi, {
            currentDeploymentApi: null,
            sourceOrg: null,
            destinationOrg: null,
            negotiatedApi: null,
            status: 'UNKNOWN'
        });
    });

    await runTest('displays negotiated Metadata API informationally', async () => {
        const result = buildDeploymentPreview({
            generatedDeploymentPackage: {
                metadata: [],
                dependencies: [],
                testClasses: []
            },
            excludedComponents: [],
            blockingComponents: [],
            compatibilityWarnings: [],
            deploymentApiNegotiation: {
                sourceApiVersion: '66.0',
                destinationApiVersion: '64.0',
                currentDeploymentApiVersion: '61.0',
                negotiatedApiVersion: '64.0',
                negotiationStatus: 'READY_FOR_UPGRADE'
            }
        });

        assert.deepStrictEqual(result.metadataApi, {
            currentDeploymentApi: '61.0',
            sourceOrg: '66.0',
            destinationOrg: '64.0',
            negotiatedApi: '64.0',
            status: 'READY_FOR_UPGRADE'
        });
        assert.ok(
            result.notes.some((note) =>
                note.includes('Metadata API upgrade available')
            )
        );
    });

    await runTest('fail-safe returns empty preview', async () => {
        const original = Array.isArray;
        Array.isArray = () => {
            throw new Error('boom');
        };

        try {
            const result = buildDeploymentPreviewSafe({
                excludedComponents: [{ metadataName: 'x' }]
            });
            assert.deepStrictEqual(result, emptyPreview());
        } finally {
            Array.isArray = original;
        }
    });
}

main();
