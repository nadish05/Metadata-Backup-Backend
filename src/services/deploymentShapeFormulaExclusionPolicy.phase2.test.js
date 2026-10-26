'use strict';

const assert = require('assert');

const {
    parseAutoExcludeShapeFormulaConflictsPolicy,
    isEligibleShapeFormulaAutoExcludeWarning,
    applyCompatibilityPackageFilterWithShapePolicy,
    buildDeploymentValidationScope,
    RESIDUAL_DISCOVERY_RISK_NOTE
} = require('./deploymentShapeFormulaExclusionPolicy.service');
const {
    analyzeDeploymentCompatibilityPlan
} = require('./deploymentCompatibility.service');
const {
    analyzeCustomFieldShapeCompatibilityConflicts
} = require('./customFieldShapeCompatibility.service');
const { filter } = require('./deploymentCompatibilityFilter.service');
const deploymentReadinessService = require('./deploymentReadiness.service');

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

function buildPackage(fieldNames, { dependencies = [] } = {}) {
    return {
        metadata: fieldNames.map((metadataName) => ({
            metadataType: 'CustomField',
            metadataName
        })),
        dependencies
    };
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

function destinationShapeIndex(entries) {
    const shapes = new Map();
    for (const [metadataName, attributes] of Object.entries(entries)) {
        shapes.set(`CustomField:${metadataName}`, {
            metadataType: 'CustomField',
            metadataName,
            found: true,
            queried: true,
            attributes
        });
    }
    return { shapes };
}

async function buildPlanForFields(fieldConfigs, shapes) {
    const fieldNames = fieldConfigs.map((c) => c.name);
    const packageObj = buildPackage(
        fieldNames,
        fieldConfigs[0]?.dependencies ? { dependencies: fieldConfigs[0].dependencies } : {}
    );

    for (const config of fieldConfigs) {
        if (config.dependencies) {
            packageObj.dependencies = config.dependencies;
        }
    }

    const sourceIndex = new Map();
    const destEntries = {};

    for (const config of fieldConfigs) {
        sourceIndex.set(`CustomField:${config.name}`, {
            metadataType: 'CustomField',
            metadataName: config.name,
            attributes: config.source,
            warning: null
        });
        destEntries[config.name] = config.destination;
    }

    const plan = await analyzeDeploymentCompatibilityPlan({
        generatedDeploymentPackage: packageObj,
        sourceShapeIndex: sourceIndex,
        destinationShapeIndex: destinationShapeIndex(destEntries)
    });

    return { packageObj, plan };
}

function shapeWarning(plan, metadataName) {
    return (plan.compatibilityWarnings || []).find(
        (w) => w.metadataName === metadataName
    );
}

async function main() {
    await runTest('1. Policy omitted → shape warnings stay non-excluding', async () => {
        const name = 'Obj__c.A__c';
        const { packageObj, plan } = await buildPlanForFields(
            [
                {
                    name,
                    source: {
                        type: 'time',
                        mdapiType: 'Time',
                        calculated: false
                    },
                    destination: { type: 'time', calculated: true }
                }
            ],
            []
        );

        const warning = shapeWarning(plan, name);
        assert.ok(warning);
        assert.strictEqual(warning.autoExclude, false);

        const result = applyCompatibilityPackageFilterWithShapePolicy({
            generatedDeploymentPackage: packageObj,
            deploymentCompatibilityPlan: plan,
            autoExcludeShapeFormulaConflicts: false
        });

        assert.strictEqual(result.excludedComponents.length, 0);
        assert.strictEqual(result.shapeFormulaExclusionPolicy.applied, false);
    });

    await runTest('2. Policy false → same as Phase 1', async () => {
        assert.strictEqual(
            parseAutoExcludeShapeFormulaConflictsPolicy({}),
            false
        );
        assert.strictEqual(
            parseAutoExcludeShapeFormulaConflictsPolicy({
                autoExcludeShapeFormulaConflicts: false
            }),
            false
        );
    });

    await runTest(
        '3. Policy true → destination-Formula / source-non-Formula excluded',
        async () => {
            const conflict = 'Obj__c.Conflict__c';
            const ok = 'Obj__c.Ok__c';
            const packageObj = buildPackage([conflict, ok]);
            const plan = await analyzeDeploymentCompatibilityPlan({
                generatedDeploymentPackage: packageObj,
                sourceShapeIndex: sourceShape(conflict, {
                    type: 'time',
                    mdapiType: 'Time',
                    calculated: false
                }),
                destinationShapeIndex: destinationShapeIndex({
                    [conflict]: { type: 'time', calculated: true },
                    [ok]: { type: 'string', calculated: false }
                })
            });
            plan.compatibilityWarnings.push(
                ...(analyzeCustomFieldShapeCompatibilityConflicts({
                    generatedDeploymentPackage: packageObj,
                    sourceShapeIndex: new Map([
                        [
                            `CustomField:${ok}`,
                            {
                                metadataName: ok,
                                attributes: {
                                    type: 'string',
                                    mdapiType: 'Text',
                                    calculated: false
                                }
                            }
                        ],
                        [
                            `CustomField:${conflict}`,
                            {
                                metadataName: conflict,
                                attributes: {
                                    type: 'time',
                                    mdapiType: 'Time',
                                    calculated: false
                                }
                            }
                        ]
                    ]),
                    destinationShapeIndex: destinationShapeIndex({
                        [conflict]: { type: 'time', calculated: true },
                        [ok]: { type: 'string', calculated: false }
                    })
                }).warnings || [])
            );

            const uniquePlan = {
                ...plan,
                compatibilityWarnings: plan.compatibilityWarnings.filter(
                    (w, i, arr) =>
                        arr.findIndex(
                            (x) =>
                                x.metadataName === w.metadataName &&
                                x.message === w.message
                        ) === i
                )
            };

            const result = applyCompatibilityPackageFilterWithShapePolicy({
                generatedDeploymentPackage: packageObj,
                deploymentCompatibilityPlan: uniquePlan,
                autoExcludeShapeFormulaConflicts: true
            });

            assert.strictEqual(result.excludedComponents.length, 1);
            assert.strictEqual(
                result.excludedComponents[0].metadataName,
                conflict
            );
            assert.ok(result.excludedComponents[0].reason.includes('formula'));
            assert.strictEqual(result.shapeFormulaExclusionPolicy.applied, true);
            assert.strictEqual(
                result.deploymentPackage.metadata.length,
                1
            );
            assert.strictEqual(
                result.deploymentPackage.metadata[0].metadataName,
                ok
            );
        }
    );

    await runTest('4. Unknown source shape → no shape exclusion', async () => {
        const name = 'Obj__c.Gap__c';
        const packageObj = buildPackage([name]);
        const plan = await analyzeDeploymentCompatibilityPlan({
            generatedDeploymentPackage: packageObj,
            sourceShapeIndex: new Map(),
            destinationShapeIndex: destinationShapeIndex({
                [name]: { type: 'string', calculated: true }
            })
        });

        const result = applyCompatibilityPackageFilterWithShapePolicy({
            generatedDeploymentPackage: packageObj,
            deploymentCompatibilityPlan: plan,
            autoExcludeShapeFormulaConflicts: true
        });

        assert.strictEqual(result.excludedComponents.length, 0);
    });

    await runTest('5. Unknown destination existence → no exclusion', async () => {
        const { warnings } = analyzeCustomFieldShapeCompatibilityConflicts({
            generatedDeploymentPackage: buildPackage(['Obj__c.New__c']),
            sourceShapeIndex: sourceShape('Obj__c.New__c', {
                type: 'string',
                mdapiType: 'Text',
                calculated: false
            }),
            destinationShapeIndex: { shapes: new Map() }
        });

        assert.strictEqual(warnings.length, 0);
    });

    await runTest('6. Reverse Formula direction → not eligible', () => {
        const warning = {
            detectionSource: 'SHAPE_INDEX',
            metadataType: 'CustomField',
            metadataName: 'Obj__c.X__c',
            conflictFacts: {
                source: { calculated: true },
                destination: { calculated: false }
            }
        };

        assert.strictEqual(
            isEligibleShapeFormulaAutoExcludeWarning(warning),
            false
        );
    });

    await runTest('7. Non-CustomField warning → not eligible', () => {
        const warning = {
            detectionSource: 'SHAPE_INDEX',
            metadataType: 'Flow',
            metadataName: 'My_Flow',
            conflictFacts: {
                source: { calculated: false },
                destination: { calculated: true }
            }
        };

        assert.strictEqual(
            isEligibleShapeFormulaAutoExcludeWarning(warning),
            false
        );
    });

    await runTest('8–9. Conflict in dependencies[] excluded', async () => {
        const conflict = 'Obj__c.Conflict__c';
        const packageObj = {
            metadata: [{ metadataType: 'CustomObject', metadataName: 'Obj__c' }],
            dependencies: [
                {
                    metadataType: 'CustomField',
                    metadataName: conflict
                }
            ]
        };
        const { warnings } = analyzeCustomFieldShapeCompatibilityConflicts({
            generatedDeploymentPackage: packageObj,
            sourceShapeIndex: sourceShape(conflict, {
                type: 'picklist',
                mdapiType: 'Picklist',
                calculated: false
            }),
            destinationShapeIndex: destinationShapeIndex({
                [conflict]: { type: 'string', calculated: true }
            })
        });

        const plan = {
            overallStatus: 'WARNING',
            compatibilityWarnings: warnings
        };

        const result = applyCompatibilityPackageFilterWithShapePolicy({
            generatedDeploymentPackage: packageObj,
            deploymentCompatibilityPlan: plan,
            autoExcludeShapeFormulaConflicts: true
        });

        assert.strictEqual(result.excludedComponents.length, 1);
        assert.strictEqual(result.deploymentPackage.dependencies.length, 0);
    });

    await runTest(
        '10. Blocking dependent reverts shape exclusion; readiness allows check-only',
        async () => {
            const conflict = 'Session__c.Status__c';
            const packageObj = buildPackage([conflict]);
            const plan = await analyzeDeploymentCompatibilityPlan({
                generatedDeploymentPackage: packageObj,
                sourceShapeIndex: sourceShape(conflict, {
                    type: 'picklist',
                    mdapiType: 'Picklist',
                    calculated: false
                }),
                destinationShapeIndex: destinationShapeIndex({
                    [conflict]: { type: 'string', calculated: true }
                })
            });

            const result = applyCompatibilityPackageFilterWithShapePolicy({
                generatedDeploymentPackage: packageObj,
                deploymentCompatibilityPlan: plan,
                autoExcludeShapeFormulaConflicts: true,
                discoveredReferences: [
                    {
                        metadataType: 'CustomField',
                        name: conflict,
                        sourceMetadata: 'Get_Sessions'
                    }
                ]
            });

            assert.strictEqual(
                result.shapeFormulaExclusionPolicy
                    .revertedDueToBlockingDependencies,
                false
            );

            const packageWithFlow = {
                metadata: [
                    { metadataType: 'Flow', metadataName: 'Get_Sessions' },
                    { metadataType: 'CustomField', metadataName: conflict }
                ],
                dependencies: []
            };

            const planWithFlow = await analyzeDeploymentCompatibilityPlan({
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
                deploymentCompatibilityPlan: planWithFlow,
                autoExcludeShapeFormulaConflicts: true,
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
            assert.strictEqual(
                blocked.deploymentPackage.metadata.length,
                2
            );

            const readinessIfNotReverted =
                deploymentReadinessService.planCompatibilityDeploymentReadiness({
                    filteredDeploymentPackage: blocked.deploymentPackage,
                    excludedComponents: [],
                    blockingComponents: blocked.shapeFormulaExclusionPolicy
                        .blockedDependents
                });
            assert.strictEqual(
                readinessIfNotReverted.readyForDeployment,
                false
            );

            const readinessAfterRevert =
                deploymentReadinessService.planCompatibilityDeploymentReadiness({
                    filteredDeploymentPackage: blocked.deploymentPackage,
                    excludedComponents: blocked.excludedComponents,
                    blockingComponents: []
                });
            assert.strictEqual(readinessAfterRevert.readyForDeployment, true);
        }
    );

    await runTest(
        '11. Residual discovery risk note is exposed; empty blockers not proof of safety',
        () => {
            const scope = buildDeploymentValidationScope({
                deploymentPackage: { selectedMetadata: [] },
                packageComponentCountBeforeFilter: 2,
                packageComponentCountAfterFilter: 1,
                excludedComponents: [
                    {
                        metadataName: 'Obj__c.A__c',
                        exclusionSource: 'SHAPE_FORMULA_POLICY',
                        reason: 'test'
                    }
                ],
                blockingComponents: [],
                autoExcludeShapeFormulaConflicts: true,
                shapeFormulaExclusionPolicy: { enabled: true, applied: true },
                checkOnlyDeployment: { executed: true, success: true },
                compatibilityDeploymentSkipped: false
            });

            assert.strictEqual(
                scope.residualDiscoveryRiskNote,
                RESIDUAL_DISCOVERY_RISK_NOTE
            );
            assert.strictEqual(scope.allSelectedComponentsValidated, false);
            assert.strictEqual(scope.validatesReducedPackageOnly, true);
        }
    );

    await runTest('12. Excluded reason preserved in response path', async () => {
        const conflict = 'Obj__c.KeepReason__c';
        const packageObj = buildPackage([conflict]);
        const plan = await analyzeDeploymentCompatibilityPlan({
            generatedDeploymentPackage: packageObj,
            sourceShapeIndex: sourceShape(conflict, {
                type: 'time',
                mdapiType: 'Time',
                calculated: false
            }),
            destinationShapeIndex: destinationShapeIndex({
                [conflict]: { type: 'time', calculated: true }
            })
        });

        const result = applyCompatibilityPackageFilterWithShapePolicy({
            generatedDeploymentPackage: packageObj,
            deploymentCompatibilityPlan: plan,
            autoExcludeShapeFormulaConflicts: true
        });

        assert.ok(result.excludedComponents[0].reason.includes('CustomField'));
        assert.ok(
            result.excludedComponents[0].reason.includes('Cannot update')
        );
    });

    await runTest('13–14. Validation scope reflects check-only outcomes', () => {
        const reduced = buildDeploymentValidationScope({
            deploymentPackage: {},
            packageComponentCountBeforeFilter: 2,
            packageComponentCountAfterFilter: 1,
            excludedComponents: [{ metadataName: 'A', exclusionSource: 'SHAPE_FORMULA_POLICY' }],
            blockingComponents: [],
            autoExcludeShapeFormulaConflicts: true,
            shapeFormulaExclusionPolicy: { applied: true },
            checkOnlyDeployment: { executed: true, success: true },
            compatibilityDeploymentSkipped: false
        });

        assert.strictEqual(reduced.checkOnlyExecuted, true);
        assert.strictEqual(reduced.checkOnlySuccess, true);
        assert.strictEqual(reduced.validatesReducedPackageOnly, true);

        const failed = buildDeploymentValidationScope({
            deploymentPackage: {},
            packageComponentCountBeforeFilter: 2,
            packageComponentCountAfterFilter: 1,
            excludedComponents: [{ metadataName: 'A' }],
            blockingComponents: [],
            autoExcludeShapeFormulaConflicts: true,
            checkOnlyDeployment: { executed: true, success: false },
            compatibilityDeploymentSkipped: false
        });

        assert.strictEqual(failed.checkOnlySuccess, false);
        assert.strictEqual(failed.allSelectedComponentsValidated, false);
    });

    await runTest('15. Legacy FORMULA_TYPE_CHANGE without autoExclude false still excludes', () => {
        const result = filter({
            generatedDeploymentPackage: buildPackage(['Obj__c.Legacy__c']),
            deploymentCompatibilityPlan: {
                compatibilityWarnings: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Obj__c.Legacy__c',
                        category: 'FORMULA_TYPE_CHANGE',
                        message: 'Cannot update a field to a Formula from something else'
                    }
                ]
            }
        });

        assert.strictEqual(result.excludedComponents.length, 1);
    });

    await runTest('16. No-conflict package unchanged with policy true', async () => {
        const name = 'Obj__c.Clean__c';
        const packageObj = buildPackage([name]);
        const plan = await analyzeDeploymentCompatibilityPlan({
            generatedDeploymentPackage: packageObj,
            sourceShapeIndex: sourceShape(name, {
                type: 'string',
                mdapiType: 'Text',
                calculated: false
            }),
            destinationShapeIndex: destinationShapeIndex({
                [name]: { type: 'string', calculated: false }
            })
        });

        const result = applyCompatibilityPackageFilterWithShapePolicy({
            generatedDeploymentPackage: packageObj,
            deploymentCompatibilityPlan: plan,
            autoExcludeShapeFormulaConflicts: true
        });

        assert.strictEqual(result.excludedComponents.length, 0);
        assert.strictEqual(result.deploymentPackage.metadata.length, 1);
    });
}

main();
