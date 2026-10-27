'use strict';

const assert = require('assert');

const packageXmlService = require('./packageXml.service');
const { analyze } = require('./deploymentCompatibilityImpact.service');
const {
    applyCompatibilityPackageFilterWithShapePolicy,
    resolveAutoExcludeShapeFormulaConflictsPolicy,
    classifyShapePolicyRevertBlockers,
    buildDeploymentValidationScope,
    RESIDUAL_DISCOVERY_RISK_NOTE
} = require('./deploymentShapeFormulaExclusionPolicy.service');
const {
    analyzeDeploymentCompatibilityPlan
} = require('./deploymentCompatibility.service');

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

function destinationShapeIndex(entries) {
    const shapes = new Map();

    for (const [metadataName, attributes] of Object.entries(entries)) {
        shapes.set(`CustomField:${metadataName}`, {
            metadataType: 'CustomField',
            metadataName,
            found: attributes.found !== false,
            queried: attributes.queried !== false,
            attributes
        });
    }

    return { shapes };
}

function sourceShape(metadataName, attrs) {
    const map = new Map();
    map.set(`CustomField:${metadataName}`, {
        metadataType: 'CustomField',
        metadataName,
        attributes: attrs,
        warning: null
    });
    return map;
}

async function buildSessionIncidentPlan() {
    const endTime = 'Session__c.End_Time__c';
    const status = 'Session__c.Status__c';
    const packageObj = {
        metadata: [
            { metadataType: 'CustomField', metadataName: endTime },
            { metadataType: 'CustomField', metadataName: status },
            {
                metadataType: 'FlexiPage',
                metadataName: 'Session_Record_Page'
            },
            { metadataType: 'Profile', metadataName: 'Sales Manager' }
        ],
        dependencies: []
    };

    const plan = await analyzeDeploymentCompatibilityPlan({
        generatedDeploymentPackage: packageObj,
        sourceShapeIndex: new Map([
            [
                `CustomField:${endTime}`,
                {
                    metadataName: endTime,
                    attributes: {
                        type: 'time',
                        mdapiType: 'Time',
                        calculated: false
                    }
                }
            ],
            [
                `CustomField:${status}`,
                {
                    metadataName: status,
                    attributes: {
                        type: 'picklist',
                        mdapiType: 'Picklist',
                        calculated: false
                    }
                }
            ]
        ]),
        destinationShapeIndex: destinationShapeIndex({
            [endTime]: { type: 'time', calculated: true },
            [status]: { type: 'string', calculated: true }
        })
    });

    return { packageObj, plan, endTime, status };
}

async function main() {
    await runTest(
        'A — Session incident: Profile + FlexiPage do not revert when dest formulas confirmed',
        async () => {
            const { packageObj, plan, endTime, status } =
                await buildSessionIncidentPlan();

            const result = applyCompatibilityPackageFilterWithShapePolicy({
                generatedDeploymentPackage: packageObj,
                deploymentCompatibilityPlan: plan,
                autoExcludeShapeFormulaConflicts: true,
                destinationShapeIndex: destinationShapeIndex({
                    [endTime]: { type: 'time', calculated: true },
                    [status]: { type: 'string', calculated: true }
                }),
                discoveredReferences: [
                    {
                        metadataType: 'CustomField',
                        name: endTime,
                        sourceMetadata: 'Session_Record_Page'
                    },
                    {
                        metadataType: 'CustomField',
                        name: status,
                        sourceMetadata: 'Session_Record_Page'
                    }
                ],
                discoveredRelationships: [
                    {
                        metadataType: 'CustomField',
                        name: endTime,
                        sourceMetadata: 'Sales Manager',
                        discoveryMethod: 'fieldPermissions'
                    },
                    {
                        metadataType: 'CustomField',
                        name: status,
                        sourceMetadata: 'Sales Manager',
                        discoveryMethod: 'fieldPermissions'
                    }
                ]
            });

            assert.strictEqual(
                result.shapeFormulaExclusionPolicy.applied,
                true
            );
            assert.strictEqual(
                result.shapeFormulaExclusionPolicy
                    .revertedDueToBlockingDependencies,
                false
            );
            assert.strictEqual(result.excludedComponents.length, 2);
            assert.ok(
                result.deploymentPackage.metadata.some(
                    (item) => item.metadataName === 'Session_Record_Page'
                )
            );
            assert.ok(
                result.deploymentPackage.metadata.some(
                    (item) => item.metadataName === 'Sales Manager'
                )
            );
            assert.ok(
                !result.deploymentPackage.metadata.some(
                    (item) => item.metadataName === endTime
                )
            );
            assert.ok(
                !result.deploymentPackage.metadata.some(
                    (item) => item.metadataName === status
                )
            );

            const manifest = packageXmlService.generateManifest(
                result.deploymentPackage
            );
            assert.ok(!manifest.packageXml.includes('End_Time__c'));
            assert.ok(!manifest.packageXml.includes('Status__c'));
            assert.ok(
                result.shapeFormulaExclusionPolicy
                    .suppressedExistingDestinationReferences.length >= 1
            );
            assert.strictEqual(
                result.shapeFormulaExclusionPolicy.residualDiscoveryRiskNote,
                RESIDUAL_DISCOVERY_RISK_NOTE
            );
        }
    );

    await runTest(
        'B — Destination field missing still reverts exclusions',
        async () => {
            const conflict = 'Session__c.Status__c';
            const packageObj = {
                metadata: [
                    { metadataType: 'CustomField', metadataName: conflict },
                    { metadataType: 'Profile', metadataName: 'Sales Manager' }
                ],
                dependencies: []
            };
            const planDestinationIndex = destinationShapeIndex({
                [conflict]: { type: 'string', calculated: true, found: true }
            });
            const policyDestinationIndex = destinationShapeIndex({
                [conflict]: {
                    type: 'string',
                    calculated: true,
                    found: false
                }
            });

            const plan = await analyzeDeploymentCompatibilityPlan({
                generatedDeploymentPackage: packageObj,
                sourceShapeIndex: sourceShape(conflict, {
                    type: 'picklist',
                    mdapiType: 'Picklist',
                    calculated: false
                }),
                destinationShapeIndex: planDestinationIndex
            });

            const result = applyCompatibilityPackageFilterWithShapePolicy({
                generatedDeploymentPackage: packageObj,
                deploymentCompatibilityPlan: plan,
                autoExcludeShapeFormulaConflicts: true,
                destinationShapeIndex: policyDestinationIndex,
                discoveredRelationships: [
                    {
                        metadataType: 'CustomField',
                        name: conflict,
                        sourceMetadata: 'Sales Manager'
                    }
                ]
            });

            assert.strictEqual(
                result.shapeFormulaExclusionPolicy
                    .revertedDueToBlockingDependencies,
                true
            );
            assert.strictEqual(result.excludedComponents.length, 0);
        }
    );

    await runTest(
        'C — Unknown destination state does not activate exception',
        async () => {
            const conflict = 'Session__c.End_Time__c';
            const packageObj = {
                metadata: [
                    { metadataType: 'CustomField', metadataName: conflict },
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Session_Record_Page'
                    }
                ],
                dependencies: []
            };
            const planDestinationIndex = destinationShapeIndex({
                [conflict]: { type: 'time', calculated: true, found: true }
            });
            const unknownIndex = destinationShapeIndex({
                [conflict]: { type: 'time', calculated: true, queried: false }
            });
            unknownIndex.shapes.get(`CustomField:${conflict}`).queried = false;

            const plan = await analyzeDeploymentCompatibilityPlan({
                generatedDeploymentPackage: packageObj,
                sourceShapeIndex: sourceShape(conflict, {
                    type: 'time',
                    mdapiType: 'Time',
                    calculated: false
                }),
                destinationShapeIndex: planDestinationIndex
            });

            const result = applyCompatibilityPackageFilterWithShapePolicy({
                generatedDeploymentPackage: packageObj,
                deploymentCompatibilityPlan: plan,
                autoExcludeShapeFormulaConflicts: true,
                destinationShapeIndex: unknownIndex,
                discoveredReferences: [
                    {
                        metadataType: 'CustomField',
                        name: conflict,
                        sourceMetadata: 'Session_Record_Page'
                    }
                ]
            });

            assert.strictEqual(
                result.shapeFormulaExclusionPolicy
                    .revertedDueToBlockingDependencies,
                true
            );
        }
    );

    await runTest(
        'C2 — Missing destinationShapeIndex reverts eligible Profile/FlexiPage blockers',
        async () => {
            const { packageObj, plan, endTime, status } =
                await buildSessionIncidentPlan();

            const result = applyCompatibilityPackageFilterWithShapePolicy({
                generatedDeploymentPackage: packageObj,
                deploymentCompatibilityPlan: plan,
                autoExcludeShapeFormulaConflicts: true,
                destinationShapeIndex: null,
                discoveredReferences: [
                    {
                        metadataType: 'CustomField',
                        name: endTime,
                        sourceMetadata: 'Session_Record_Page'
                    },
                    {
                        metadataType: 'CustomField',
                        name: status,
                        sourceMetadata: 'Session_Record_Page'
                    }
                ],
                discoveredRelationships: [
                    {
                        metadataType: 'CustomField',
                        name: endTime,
                        sourceMetadata: 'Sales Manager'
                    }
                ]
            });

            assert.strictEqual(
                result.shapeFormulaExclusionPolicy
                    .revertedDueToBlockingDependencies,
                true
            );
            assert.strictEqual(result.shapeFormulaExclusionPolicy.applied, false);
            assert.strictEqual(result.excludedComponents.length, 0);
            assert.ok(
                result.shapeFormulaExclusionPolicy.suppressedExclusions.length >=
                    1
            );
        }
    );

    await runTest('D — Opt-in disabled preserves original behavior', async () => {
        const { packageObj, plan } = await buildSessionIncidentPlan();

        const result = applyCompatibilityPackageFilterWithShapePolicy({
            generatedDeploymentPackage: packageObj,
            deploymentCompatibilityPlan: plan,
            autoExcludeShapeFormulaConflicts: false,
            destinationShapeIndex: destinationShapeIndex({
                'Session__c.End_Time__c': { type: 'time', calculated: true },
                'Session__c.Status__c': { type: 'string', calculated: true }
            }),
            discoveredReferences: [
                {
                    metadataType: 'CustomField',
                    name: 'Session__c.Status__c',
                    sourceMetadata: 'Session_Record_Page'
                }
            ]
        });

        assert.strictEqual(result.excludedComponents.length, 0);
        assert.strictEqual(result.shapeFormulaExclusionPolicy.applied, false);
    });

    await runTest(
        'E — Unrelated Flow dependency still reverts shape exclusions',
        async () => {
            const conflict = 'Session__c.Status__c';
            const packageWithFlow = {
                metadata: [
                    { metadataType: 'Flow', metadataName: 'Get_Sessions' },
                    { metadataType: 'CustomField', metadataName: conflict }
                ],
                dependencies: []
            };
            const plan = await analyzeDeploymentCompatibilityPlan({
                generatedDeploymentPackage: packageWithFlow,
                sourceShapeIndex: sourceShape(conflict, {
                    type: 'picklist',
                    mdapiType: 'Picklist',
                    calculated: false
                }),
                destinationShapeIndex: destinationShapeIndex({
                    [conflict]: { type: 'string', calculated: true }
                })
            });

            const blocked = applyCompatibilityPackageFilterWithShapePolicy({
                generatedDeploymentPackage: packageWithFlow,
                deploymentCompatibilityPlan: plan,
                autoExcludeShapeFormulaConflicts: true,
                destinationShapeIndex: destinationShapeIndex({
                    [conflict]: { type: 'string', calculated: true }
                }),
                discoveredReferences: [
                    {
                        metadataType: 'CustomField',
                        name: conflict,
                        sourceMetadata: 'Get_Sessions'
                    }
                ]
            });

            assert.strictEqual(
                blocked.shapeFormulaExclusionPolicy
                    .revertedDueToBlockingDependencies,
                true
            );
            assert.strictEqual(blocked.excludedComponents.length, 0);
        }
    );

    await runTest(
        'F0 — blockedBy non-CustomField metadata type cannot be suppressed',
        () => {
            const field = 'Session__c.Status__c';
            const classified = classifyShapePolicyRevertBlockers({
                blockingComponents: [
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Session_Record_Page',
                        blockedBy: [
                            {
                                metadataType: 'Flow',
                                metadataName: field
                            }
                        ]
                    }
                ],
                shapeExcluded: [
                    {
                        metadataType: 'CustomField',
                        metadataName: field
                    }
                ],
                compatibilityWarnings: [
                    {
                        detectionSource: 'SHAPE_INDEX',
                        metadataType: 'CustomField',
                        metadataName: field,
                        conflictFacts: {
                            source: { calculated: false },
                            destination: { calculated: true }
                        }
                    }
                ],
                destinationShapeIndex: destinationShapeIndex({
                    [field]: { type: 'string', calculated: true }
                })
            });

            assert.strictEqual(classified.revertBlockers.length, 1);
            assert.strictEqual(
                classified.suppressedExistingDestinationReferences.length,
                0
            );
        }
    );

    await runTest(
        'F — FlexiPage blocked by excluded LWC unchanged (non shape-field dep)',
        async () => {
            const result = analyze({
                filteredDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'FlexiPage',
                            metadataName: 'Experience_Record_Page'
                        }
                    ],
                    dependencies: []
                },
                excludedComponents: [
                    {
                        metadataType: 'LightningComponentBundle',
                        metadataName: 'experienceSchedule',
                        category: 'FORMULA_COMPILATION'
                    }
                ],
                discoveredReferences: [
                    {
                        metadataType: 'LightningComponentBundle',
                        name: 'experienceSchedule',
                        sourceMetadata: 'Experience_Record_Page'
                    }
                ]
            });

            assert.strictEqual(result.blockingComponents.length, 1);

            const classified = classifyShapePolicyRevertBlockers({
                blockingComponents: result.blockingComponents,
                shapeExcluded: [],
                compatibilityWarnings: [],
                destinationShapeIndex: destinationShapeIndex({
                    'Obj__c.A__c': { calculated: true }
                })
            });

            assert.strictEqual(classified.revertBlockers.length, 1);
        }
    );

    await runTest(
        'G — Partial eligibility: one missing destination field reverts',
        async () => {
            const endTime = 'Session__c.End_Time__c';
            const status = 'Session__c.Status__c';
            const packageObj = {
                metadata: [
                    { metadataType: 'CustomField', metadataName: endTime },
                    { metadataType: 'CustomField', metadataName: status },
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Session_Record_Page'
                    }
                ],
                dependencies: []
            };
            const planDestinationIndex = destinationShapeIndex({
                [endTime]: { type: 'time', calculated: true },
                [status]: { type: 'string', calculated: true, found: true }
            });
            const destIndex = destinationShapeIndex({
                [endTime]: { type: 'time', calculated: true },
                [status]: { type: 'string', calculated: true, found: false }
            });

            const plan = await analyzeDeploymentCompatibilityPlan({
                generatedDeploymentPackage: packageObj,
                sourceShapeIndex: new Map([
                    [
                        `CustomField:${endTime}`,
                        {
                            metadataName: endTime,
                            attributes: {
                                type: 'time',
                                mdapiType: 'Time',
                                calculated: false
                            }
                        }
                    ],
                    [
                        `CustomField:${status}`,
                        {
                            metadataName: status,
                            attributes: {
                                type: 'picklist',
                                mdapiType: 'Picklist',
                                calculated: false
                            }
                        }
                    ]
                ]),
                destinationShapeIndex: planDestinationIndex
            });

            const result = applyCompatibilityPackageFilterWithShapePolicy({
                generatedDeploymentPackage: packageObj,
                deploymentCompatibilityPlan: plan,
                autoExcludeShapeFormulaConflicts: true,
                destinationShapeIndex: destIndex,
                discoveredReferences: [
                    {
                        metadataType: 'CustomField',
                        name: endTime,
                        sourceMetadata: 'Session_Record_Page'
                    },
                    {
                        metadataType: 'CustomField',
                        name: status,
                        sourceMetadata: 'Session_Record_Page'
                    }
                ]
            });

            assert.strictEqual(
                result.shapeFormulaExclusionPolicy
                    .revertedDueToBlockingDependencies,
                true
            );
        }
    );

    await runTest('H — Request flag strict boolean precedence', () => {
        assert.strictEqual(
            resolveAutoExcludeShapeFormulaConflictsPolicy({
                topLevel: true,
                deploymentPackage: { autoExcludeShapeFormulaConflicts: false }
            }),
            true
        );
        assert.strictEqual(
            resolveAutoExcludeShapeFormulaConflictsPolicy({
                deploymentPackage: { autoExcludeShapeFormulaConflicts: 'true' }
            }),
            false
        );
    });

    await runTest('I — Final scope reflects reduced package after applied exclusions', async () => {
        const { packageObj, plan } = await buildSessionIncidentPlan();
        const filtered = applyCompatibilityPackageFilterWithShapePolicy({
            generatedDeploymentPackage: packageObj,
            deploymentCompatibilityPlan: plan,
            autoExcludeShapeFormulaConflicts: true,
            destinationShapeIndex: destinationShapeIndex({
                'Session__c.End_Time__c': { type: 'time', calculated: true },
                'Session__c.Status__c': { type: 'string', calculated: true }
            }),
            discoveredReferences: [
                {
                    metadataType: 'CustomField',
                    name: 'Session__c.End_Time__c',
                    sourceMetadata: 'Session_Record_Page'
                }
            ],
            discoveredRelationships: [
                {
                    metadataType: 'CustomField',
                    name: 'Session__c.Status__c',
                    sourceMetadata: 'Sales Manager'
                }
            ]
        });

        const scope = buildDeploymentValidationScope({
            deploymentPackage: packageObj,
            packageComponentCountBeforeFilter:
                filtered.packageComponentCountBeforeFilter,
            packageComponentCountAfterFilter:
                filtered.packageComponentCountAfterFilter,
            excludedComponents: filtered.excludedComponents,
            blockingComponents: [],
            compatibilityWarnings: plan.compatibilityWarnings,
            finalDeploymentPackage: filtered.deploymentPackage,
            autoExcludeShapeFormulaConflicts: true,
            shapeFormulaExclusionPolicy: filtered.shapeFormulaExclusionPolicy,
            checkOnlyDeployment: { executed: true, success: true },
            compatibilityDeploymentSkipped: false
        });

        assert.strictEqual(filtered.shapeFormulaExclusionPolicy.applied, true);
        assert.strictEqual(scope.excludedComponentCount, 2);
        assert.strictEqual(scope.validatesReducedPackageOnly, true);
        assert.strictEqual(scope.validatesAllSelectedComponents, false);
        assert.strictEqual(scope.allSelectedComponentsValidated, false);
    });
}

main();
