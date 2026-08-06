const assert = require('assert');

const {
    CATEGORIES,
    analyzeDeploymentCompatibilityPlan,
    mapPermissionSetCompatibilityWarnings,
    mergeCompatibilityBlockingComponents,
    buildBlockingSummary
} = require('./deploymentCompatibility.service');
const {
    planCompatibilityDeploymentReadiness
} = require('./deploymentReadiness.service');
const {
    buildDeploymentCompatibilityAdvisor
} = require('./deploymentCompatibilityAdvisor.service');
const { buildDeploymentPreview } = require('./deploymentPreview.service');

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

function permissionDiagnostic({
    name,
    unsupportedProperties = [],
    unknownNodes = [],
    malformedXml = false,
    currentApi = '61.0',
    requiredApi = '63.0'
}) {
    const findings = unsupportedProperties.map((property) => ({
        permissionSet: name,
        property,
        category: CATEGORIES.PERMISSION_SET_API_VERSION,
        currentApiVersion: currentApi,
        requiredApiVersion: requiredApi,
        recommendedAction: `Deploy using Metadata API ${requiredApi}+`,
        safeToRemove: false
    }));

    if (malformedXml) {
        findings.push({
            permissionSet: name,
            property: null,
            category: 'PERMISSION_SET_MALFORMED_XML',
            reason: 'Malformed XML'
        });
    }

    return {
        permissionSet: name,
        detectedApiVersion: currentApi,
        unsupportedProperties,
        unknownNodes,
        compatibilityFindings: findings,
        recommendedAction: unsupportedProperties.length
            ? `Deploy using Metadata API ${requiredApi}+ or review the PermissionSet security model.`
            : 'Review PermissionSet XML.',
        requiresUserAttention:
            unsupportedProperties.length > 0 ||
            unknownNodes.length > 0 ||
            malformedXml,
        malformedXml
    };
}

function packageWith(items) {
    return {
        metadata: items,
        dependencies: [],
        testClasses: []
    };
}

async function buildPlan({
    permissionSets = [],
    metadata = [],
    formulaCompatibility = null,
    deploymentApiVersion = '61.0'
} = {}) {
    return analyzeDeploymentCompatibilityPlan({
        generatedDeploymentPackage: packageWith(metadata),
        formulaCompatibility,
        permissionSetCompatibility: {
            permissionSets
        },
        deploymentApiVersionPolicy: {
            deploymentApiVersion
        }
    });
}

async function main() {
    await runTest('Compatible PermissionSet', async () => {
        const plan = await buildPlan({
            permissionSets: [
                permissionDiagnostic({ name: 'Compatible_Access' })
            ],
            metadata: [
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Compatible_Access',
                    content:
                        '<PermissionSet><label>Compatible</label></PermissionSet>'
                }
            ]
        });

        assert.strictEqual(plan.overallStatus, 'PASS');
        assert.deepStrictEqual(plan.compatibilityWarnings, []);
        assert.deepStrictEqual(plan.blockingComponents, []);
    });

    await runTest('PermissionSet requiring API 63 blocks readiness', async () => {
        const plan = await buildPlan({
            permissionSets: [
                permissionDiagnostic({
                    name: 'Subscription_Access',
                    unsupportedProperties: [
                        'objectPermissions.viewAllFields'
                    ]
                })
            ],
            metadata: [
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Subscription_Access'
                }
            ]
        });
        const warning = plan.compatibilityWarnings[0];

        assert.strictEqual(
            warning.category,
            CATEGORIES.PERMISSION_SET_API_VERSION
        );
        assert.strictEqual(warning.status, 'INCOMPATIBLE');
        assert.strictEqual(warning.currentApi, '61.0');
        assert.strictEqual(warning.requiredApi, '63.0');
        assert.deepStrictEqual(warning.unsupportedProperties, [
            'viewAllFields'
        ]);
        assert.strictEqual(warning.severity, 'BLOCKER');

        const readiness = planCompatibilityDeploymentReadiness({
            filteredDeploymentPackage: packageWith([
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Subscription_Access'
                }
            ]),
            blockingComponents: plan.blockingComponents,
            blockingSummary: plan.blockingSummary
        });

        assert.strictEqual(readiness.readyForDeployment, false);
        assert.strictEqual(
            readiness.reason,
            CATEGORIES.PERMISSION_SET_API_VERSION
        );
    });

    await runTest('Multiple version-gated properties', async () => {
        const warnings = mapPermissionSetCompatibilityWarnings({
            permissionSets: [
                permissionDiagnostic({
                    name: 'Future_Access',
                    unsupportedProperties: [
                        'agentAccesses',
                        'emailRoutingAddressAccesses',
                        'objectPermissions.viewAllFields'
                    ]
                })
            ]
        });

        assert.strictEqual(warnings.length, 1);
        assert.deepStrictEqual(warnings[0].unsupportedProperties.sort(), [
            'agentAccesses',
            'emailRoutingAddressAccesses',
            'viewAllFields'
        ]);
        assert.match(warnings[0].message, /Automatic removal is unsafe/);
    });

    await runTest(
        'Mixed compatible and incompatible PermissionSets update preview',
        async () => {
            const permissionSets = [
                permissionDiagnostic({ name: 'Compatible_Access' }),
                permissionDiagnostic({
                    name: 'Subscription_Access',
                    unsupportedProperties: [
                        'objectPermissions.viewAllFields'
                    ]
                })
            ];
            const metadata = [
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Compatible_Access'
                },
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Subscription_Access'
                }
            ];
            const plan = await buildPlan({ permissionSets, metadata });
            const blocking = mergeCompatibilityBlockingComponents(
                [],
                plan.blockingComponents
            );
            const summary = buildBlockingSummary(blocking);
            const readiness = planCompatibilityDeploymentReadiness({
                filteredDeploymentPackage: packageWith(metadata),
                blockingComponents: blocking,
                blockingSummary: summary,
                totalWarnings: plan.compatibilityWarnings.length
            });
            const advisor = buildDeploymentCompatibilityAdvisor({
                deploymentCompatibilityPlan: plan,
                deploymentReadiness: readiness,
                excludedComponents: [],
                blockingComponents: blocking,
                compatibilityWarnings: plan.compatibilityWarnings
            });
            const preview = buildDeploymentPreview({
                generatedDeploymentPackage: packageWith(metadata),
                deploymentReadiness: readiness,
                deploymentCompatibilityAdvisor: advisor,
                excludedComponents: [],
                blockingComponents: blocking,
                compatibilityWarnings: plan.compatibilityWarnings
            });

            assert.strictEqual(summary.totalBlocking, 1);
            assert.strictEqual(
                summary.blockingByCategory.PERMISSION_SET_API_VERSION,
                1
            );
            assert.strictEqual(advisor.summary.overallRisk, 'HIGH');
            assert.strictEqual(advisor.recommendations.length, 1);
            assert.strictEqual(
                advisor.recommendations[0].category,
                CATEGORIES.PERMISSION_SET_API_VERSION
            );
            assert.match(
                advisor.recommendations[0].recommendedAction,
                /Metadata API 63/
            );
            assert.strictEqual(preview.deploymentMode, 'BLOCKED');
            assert.strictEqual(preview.estimatedRisk, 'HIGH');
            assert.deepStrictEqual(
                preview.deploymentStatistics.permissionSets,
                {
                    compatible: 1,
                    blocked: 1,
                    requiresNewerMetadataApi: 1
                }
            );
        }
    );

    await runTest('Malformed XML is advisory, not a compatibility blocker', () => {
        const warnings = mapPermissionSetCompatibilityWarnings({
            permissionSets: [
                permissionDiagnostic({
                    name: 'Broken_Access',
                    malformedXml: true
                })
            ]
        });

        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(warnings[0].status, 'REVIEW_REQUIRED');
        assert.strictEqual(warnings[0].severity, 'WARNING');
        assert.strictEqual(warnings[0].category, 'PERMISSION_SET_API_VERSION');
    });

    await runTest('No PermissionSets', async () => {
        const plan = await buildPlan({
            permissionSets: [],
            metadata: []
        });

        assert.strictEqual(plan.overallStatus, 'PASS');
        assert.strictEqual(plan.summary.blockingCount, 0);
    });

    await runTest('Existing Formula compatibility unaffected', async () => {
        const plan = await buildPlan({
            permissionSets: [
                permissionDiagnostic({
                    name: 'Subscription_Access',
                    unsupportedProperties: [
                        'objectPermissions.viewAllFields'
                    ]
                })
            ],
            formulaCompatibility: {
                warnings: [
                    {
                        metadataName: 'Booking__c.Status__c',
                        metadataType: 'CustomField',
                        category: 'FORMULA_CONVERSION',
                        severity: 'WARNING',
                        message:
                            'Cannot update a field to a Formula from something else'
                    }
                ]
            }
        });

        const categories = new Set(
            plan.compatibilityWarnings.map((warning) => warning.category)
        );
        assert.ok(categories.has('FORMULA_TYPE_CHANGE'));
        assert.ok(categories.has('PERMISSION_SET_API_VERSION'));
    });

    await runTest('Existing Flow compatibility unaffected', async () => {
        const plan = await buildPlan({
            permissionSets: [
                permissionDiagnostic({
                    name: 'Subscription_Access',
                    unsupportedProperties: [
                        'objectPermissions.viewAllFields'
                    ]
                })
            ],
            metadata: [
                {
                    metadataType: 'Flow',
                    metadataName: 'Booking_Flow',
                    content:
                        '<Flow><areMetricsLoggedToDataCloud>true</areMetricsLoggedToDataCloud></Flow>'
                }
            ],
            deploymentApiVersion: '61.0'
        });

        const categories = new Set(
            plan.compatibilityWarnings.map((warning) => warning.category)
        );
        assert.ok(categories.has('FLOW_API_VERSION'));
        assert.ok(categories.has('PERMISSION_SET_API_VERSION'));
    });

    await runTest(
        'Planner merges PermissionSet findings with existing categories',
        async () => {
            const plan = await buildPlan({
                permissionSets: [
                    permissionDiagnostic({
                        name: 'Subscription_Access',
                        unsupportedProperties: [
                            'objectPermissions.viewAllFields'
                        ]
                    })
                ],
                formulaCompatibility: {
                    warnings: [
                        {
                            metadataName: 'Booking__c.Label__c',
                            metadataType: 'CustomField',
                            category: 'MISSING_FIELD',
                            severity: 'WARNING',
                            message: 'Formula references a missing field.'
                        }
                    ]
                },
                metadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Booking_Flow',
                        content:
                            '<Flow><areMetricsLoggedToDataCloud>true</areMetricsLoggedToDataCloud></Flow>'
                    }
                ]
            });

            const categories = new Set(
                plan.compatibilityWarnings.map((warning) => warning.category)
            );
            assert.deepStrictEqual(
                [...categories].sort(),
                [
                    'FLOW_API_VERSION',
                    'FORMULA_COMPILATION',
                    'PERMISSION_SET_API_VERSION'
                ].sort()
            );
            assert.strictEqual(plan.blockingComponents.length, 1);
            assert.strictEqual(
                plan.blockingSummary.blockingByMetadataType.PermissionSet,
                1
            );
        }
    );
}

main();
