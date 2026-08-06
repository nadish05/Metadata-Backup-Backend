const assert = require('assert');

const {
    buildDeploymentCompatibilityAdvisor,
    buildDeploymentCompatibilityAdvisorSafe,
    emptyAdvisor,
    resolveOverallRisk
} = require('./deploymentCompatibilityAdvisor.service');

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

async function main() {
    await runTest('formula exclusion recommendation', async () => {
        const result = buildDeploymentCompatibilityAdvisor({
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Status_Label__c',
                    category: 'FORMULA_TYPE_CHANGE',
                    reason: 'Excluded due to FORMULA_TYPE_CHANGE.'
                }
            ],
            blockingComponents: [],
            compatibilityWarnings: []
        });

        assert.strictEqual(result.recommendations.length, 1);
        const rec = result.recommendations[0];
        assert.strictEqual(rec.category, 'FORMULA_TYPE_CHANGE');
        assert.strictEqual(rec.severity, 'WARNING');
        assert.ok(/Formula conversion not supported/i.test(rec.reason));
        assert.ok(/Recreate field manually/i.test(rec.recommendedAction));
        assert.ok(/Excluded automatically/i.test(rec.deploymentImpact));
    });

    await runTest('field type recommendation', async () => {
        const result = buildDeploymentCompatibilityAdvisor({
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Account.Legacy_Code__c',
                    category: 'FIELD_TYPE_CHANGE'
                }
            ],
            blockingComponents: [],
            compatibilityWarnings: []
        });

        const rec = result.recommendations[0];
        assert.strictEqual(rec.category, 'FIELD_TYPE_CHANGE');
        assert.ok(/incompatible field type/i.test(rec.reason));
        assert.ok(/Manual migration required/i.test(rec.recommendedAction));
        assert.strictEqual(rec.severity, 'WARNING');
    });

    await runTest('flow recommendation', async () => {
        const result = buildDeploymentCompatibilityAdvisor({
            excludedComponents: [],
            blockingComponents: [],
            compatibilityWarnings: [
                {
                    metadataType: 'Flow',
                    metadataName: 'Booking_Flow',
                    category: 'FLOW_API_VERSION',
                    severity: 'WARNING',
                    message: 'Flow API too new',
                    recommendation:
                        'Retrieve using supported API version or upgrade destination.'
                }
            ]
        });

        assert.strictEqual(result.recommendations.length, 1);
        const rec = result.recommendations[0];
        assert.strictEqual(rec.category, 'FLOW_API_VERSION');
        assert.ok(/Flow metadata version newer/i.test(rec.reason));
        assert.ok(
            /supported API version|upgrade destination/i.test(
                rec.recommendedAction
            )
        );
    });

    await runTest('LWC recommendation', async () => {
        const result = buildDeploymentCompatibilityAdvisor({
            excludedComponents: [],
            blockingComponents: [],
            compatibilityWarnings: [
                {
                    metadataType: 'LightningComponentBundle',
                    metadataName: 'bookingCard',
                    category: 'LWC_DEPENDENCY',
                    message: 'Missing c/sharedUtils'
                }
            ]
        });

        const rec = result.recommendations[0];
        assert.strictEqual(rec.category, 'LWC_DEPENDENCY');
        assert.ok(/LWC module missing/i.test(rec.reason));
        assert.ok(/Deploy dependency bundle first/i.test(rec.recommendedAction));
        assert.strictEqual(rec.severity, 'WARNING');
    });

    await runTest('blocker severity', async () => {
        const result = buildDeploymentCompatibilityAdvisor({
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
                            metadataType: 'CustomField',
                            metadataName: 'Booking__c.Status__c',
                            category: 'FORMULA_TYPE_CHANGE'
                        }
                    ],
                    action: 'BLOCKING'
                }
            ],
            compatibilityWarnings: []
        });

        const blocker = result.recommendations.find(
            (item) => item.severity === 'BLOCKER'
        );
        assert.ok(blocker);
        assert.strictEqual(blocker.component, 'Booking__c');
        assert.ok(/Depends on excluded/i.test(blocker.reason));
        assert.strictEqual(result.summary.overallRisk, 'HIGH');
    });

    await runTest('warning severity', async () => {
        const result = buildDeploymentCompatibilityAdvisor({
            excludedComponents: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Booking__c.Type__c',
                    category: 'PICKLIST_TYPE_CHANGE'
                }
            ],
            blockingComponents: [],
            compatibilityWarnings: []
        });

        assert.strictEqual(result.recommendations[0].severity, 'WARNING');
        assert.strictEqual(result.summary.overallRisk, 'MEDIUM');
        assert.ok(
            /Picklist\/Text conversion unsupported/i.test(
                result.recommendations[0].reason
            )
        );
    });

    await runTest('low risk summary', async () => {
        const result = buildDeploymentCompatibilityAdvisor({
            excludedComponents: [],
            blockingComponents: [],
            compatibilityWarnings: []
        });

        assert.deepStrictEqual(result.summary, {
            overallRisk: 'LOW',
            totalExcluded: 0,
            totalBlocking: 0,
            manualActionsRequired: 0,
            currentDeploymentApi: null,
            negotiatedApi: null
        });
        assert.strictEqual(result.recommendations.length, 0);
        assert.strictEqual(resolveOverallRisk(0, 0), 'LOW');
    });

    await runTest('exposes current and negotiated API versions', async () => {
        const result = buildDeploymentCompatibilityAdvisor({
            excludedComponents: [],
            blockingComponents: [],
            compatibilityWarnings: [],
            deploymentApiNegotiation: {
                currentDeploymentApiVersion: '61.0',
                negotiatedApiVersion: '64.0',
                negotiationStatus: 'READY_FOR_UPGRADE'
            }
        });

        assert.strictEqual(result.summary.currentDeploymentApi, '61.0');
        assert.strictEqual(result.summary.negotiatedApi, '64.0');
    });

    await runTest('high risk summary', async () => {
        const result = buildDeploymentCompatibilityAdvisor({
            deploymentCompatibilityImpact: {
                blockingComponents: [
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Booking_Record_Page',
                        blockedBy: [
                            {
                                metadataType: 'LightningComponentBundle',
                                metadataName: 'bookingCard',
                                category: 'LWC_DEPENDENCY'
                            }
                        ]
                    }
                ]
            },
            excludedComponents: [],
            blockingComponents: null,
            compatibilityWarnings: []
        });

        assert.strictEqual(result.summary.overallRisk, 'HIGH');
        assert.strictEqual(result.summary.totalBlocking, 1);
        assert.ok(result.summary.manualActionsRequired >= 1);
    });

    await runTest('fail-safe returns empty advisor', async () => {
        const original = Array.isArray;
        Array.isArray = () => {
            throw new Error('boom');
        };

        try {
            const result = buildDeploymentCompatibilityAdvisorSafe({
                excludedComponents: [{ metadataName: 'x' }]
            });
            assert.deepStrictEqual(result, emptyAdvisor());
        } finally {
            Array.isArray = original;
        }
    });
}

main();
