'use strict';

const assert = require('assert');

const deploymentReadinessService = require('./deploymentReadiness.service');
const deploymentCompatibilityGateService = require('./deploymentCompatibilityGate.service');
const packageXmlService = require('./packageXml.service');
const {
    applyCompatibilityPackageFilterWithShapePolicy,
    resolveReadinessBlockingComponents
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

function shapeExcludedComponent(metadataName) {
    return {
        metadataType: 'CustomField',
        metadataName,
        exclusionPolicy: 'SHAPE_DESTINATION_FORMULA',
        exclusionSource: 'SHAPE_FORMULA_POLICY',
        category: 'FORMULA_TYPE_CHANGE'
    };
}

function eligibleWarnings(endTime, status) {
    return [endTime, status].map((metadataName) => ({
        detectionSource: 'SHAPE_INDEX',
        metadataType: 'CustomField',
        metadataName,
        category: 'FORMULA_TYPE_CHANGE',
        conflictFacts: {
            source: { calculated: false },
            destination: { calculated: true }
        }
    }));
}

function incidentFullBlockers(endTime, status) {
    return [
        {
            metadataType: 'FlexiPage',
            metadataName: 'Session_Record_Page',
            blockedBy: [
                {
                    metadataType: 'CustomField',
                    metadataName: endTime
                },
                {
                    metadataType: 'CustomField',
                    metadataName: status
                }
            ],
            action: 'BLOCKING'
        },
        {
            metadataType: 'Profile',
            metadataName: 'Sales Manager',
            blockedBy: [
                {
                    metadataType: 'CustomField',
                    metadataName: endTime
                },
                {
                    metadataType: 'CustomField',
                    metadataName: status
                }
            ],
            action: 'BLOCKING'
        }
    ];
}

async function main() {
    const endTime = 'Session__c.End_Time__c';
    const status = 'Session__c.Status__c';
    const destIndex = destinationShapeIndex({
        [endTime]: { type: 'time', calculated: true },
        [status]: { type: 'string', calculated: true }
    });
    const warnings = eligibleWarnings(endTime, status);
    const excluded = [
        shapeExcludedComponent(endTime),
        shapeExcludedComponent(status)
    ];
    const policyApplied = { enabled: true, applied: true };

    await runTest('A — Incident: readiness clears qualifying Profile/FlexiPage blockers', () => {
        const full = incidentFullBlockers(endTime, status);
        const { readinessBlockingComponents, suppressedForReadiness } =
            resolveReadinessBlockingComponents({
                autoExcludeShapeFormulaConflicts: true,
                shapeFormulaExclusionPolicy: policyApplied,
                compatibilityBlockingComponents: full,
                excludedComponents: excluded,
                compatibilityWarnings: warnings,
                destinationShapeIndex: destIndex
            });

        assert.strictEqual(readinessBlockingComponents.length, 0);
        assert.strictEqual(suppressedForReadiness.length, 2);

        const readiness =
            deploymentReadinessService.planCompatibilityDeploymentReadiness({
                filteredDeploymentPackage: { metadata: [], dependencies: [] },
                excludedComponents: excluded,
                blockingComponents: readinessBlockingComponents
            });

        assert.strictEqual(readiness.readyForDeployment, true);
        assert.strictEqual(
            deploymentCompatibilityGateService.shouldSkipDeploymentForCompatibility(
                readiness
            ),
            false
        );
    });

    await runTest('B — Full impact blockers preserved separately from readiness', () => {
        const full = incidentFullBlockers(endTime, status);
        const { readinessBlockingComponents, suppressedForReadiness } =
            resolveReadinessBlockingComponents({
                autoExcludeShapeFormulaConflicts: true,
                shapeFormulaExclusionPolicy: policyApplied,
                compatibilityBlockingComponents: full,
                excludedComponents: excluded,
                compatibilityWarnings: warnings,
                destinationShapeIndex: destIndex
            });

        assert.strictEqual(full.length, 2);
        assert.strictEqual(readinessBlockingComponents.length, 0);
        assert.ok(suppressedForReadiness.length > 0);
    });

    await runTest('C — Flow blocker still blocks readiness when policy applied', () => {
        const full = [
            ...incidentFullBlockers(endTime, status),
            {
                metadataType: 'Flow',
                metadataName: 'Get_Sessions',
                blockedBy: [
                    {
                        metadataType: 'CustomField',
                        metadataName: status
                    }
                ],
                action: 'BLOCKING'
            }
        ];

        const { readinessBlockingComponents } =
            resolveReadinessBlockingComponents({
                autoExcludeShapeFormulaConflicts: true,
                shapeFormulaExclusionPolicy: policyApplied,
                compatibilityBlockingComponents: full,
                excludedComponents: excluded,
                compatibilityWarnings: warnings,
                destinationShapeIndex: destIndex
            });

        assert.strictEqual(readinessBlockingComponents.length, 1);
        assert.strictEqual(
            readinessBlockingComponents[0].metadataName,
            'Get_Sessions'
        );

        const readiness =
            deploymentReadinessService.planCompatibilityDeploymentReadiness({
                filteredDeploymentPackage: { metadata: [], dependencies: [] },
                excludedComponents: excluded,
                blockingComponents: readinessBlockingComponents
            });

        assert.strictEqual(readiness.readyForDeployment, false);
    });

    await runTest('D — Unknown destination does not suppress readiness blockers', () => {
        const unknownIndex = destinationShapeIndex({
            [endTime]: { type: 'time', calculated: true, queried: false }
        });
        unknownIndex.shapes.get(`CustomField:${endTime}`).queried = false;

        const { readinessBlockingComponents, suppressedForReadiness } =
            resolveReadinessBlockingComponents({
                autoExcludeShapeFormulaConflicts: true,
                shapeFormulaExclusionPolicy: policyApplied,
                compatibilityBlockingComponents: incidentFullBlockers(
                    endTime,
                    status
                ),
                excludedComponents: excluded,
                compatibilityWarnings: warnings,
                destinationShapeIndex: unknownIndex
            });

        assert.strictEqual(suppressedForReadiness.length, 0);
        assert.ok(readinessBlockingComponents.length > 0);
    });

    await runTest('E — Partial destination eligibility keeps consumer blocked', () => {
        const partialIndex = destinationShapeIndex({
            [endTime]: { type: 'time', calculated: true },
            [status]: { type: 'string', calculated: true, found: false }
        });

        const { readinessBlockingComponents } =
            resolveReadinessBlockingComponents({
                autoExcludeShapeFormulaConflicts: true,
                shapeFormulaExclusionPolicy: policyApplied,
                compatibilityBlockingComponents: incidentFullBlockers(
                    endTime,
                    status
                ),
                excludedComponents: excluded,
                compatibilityWarnings: warnings,
                destinationShapeIndex: partialIndex
            });

        assert.ok(readinessBlockingComponents.length > 0);
    });

    await runTest('F — Opt-in disabled uses full blockers for readiness', () => {
        const full = incidentFullBlockers(endTime, status);
        const { readinessBlockingComponents, suppressedForReadiness } =
            resolveReadinessBlockingComponents({
                autoExcludeShapeFormulaConflicts: false,
                shapeFormulaExclusionPolicy: policyApplied,
                compatibilityBlockingComponents: full,
                excludedComponents: excluded,
                compatibilityWarnings: warnings,
                destinationShapeIndex: destIndex
            });

        assert.strictEqual(readinessBlockingComponents.length, 2);
        assert.strictEqual(suppressedForReadiness.length, 0);
    });

    await runTest('G — Policy not applied retains full blocking list', () => {
        const full = incidentFullBlockers(endTime, status);
        const { readinessBlockingComponents } =
            resolveReadinessBlockingComponents({
                autoExcludeShapeFormulaConflicts: true,
                shapeFormulaExclusionPolicy: {
                    enabled: true,
                    applied: false,
                    revertedDueToBlockingDependencies: true
                },
                compatibilityBlockingComponents: full,
                excludedComponents: [],
                compatibilityWarnings: warnings,
                destinationShapeIndex: destIndex
            });

        assert.strictEqual(readinessBlockingComponents.length, 2);
    });

    await runTest('H — Final package and manifest omit eligible fields', async () => {
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

        const plan = await analyzeDeploymentCompatibilityPlan({
            generatedDeploymentPackage: packageObj,
            sourceShapeIndex: new Map([
                [
                    `CustomField:${endTime}`,
                    {
                        metadataName: endTime,
                        attributes: {
                            type: 'time',
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
                            calculated: false
                        }
                    }
                ]
            ]),
            destinationShapeIndex: destIndex
        });

        const filtered = applyCompatibilityPackageFilterWithShapePolicy({
            generatedDeploymentPackage: packageObj,
            deploymentCompatibilityPlan: plan,
            autoExcludeShapeFormulaConflicts: true,
            destinationShapeIndex: destIndex,
            discoveredReferences: [
                {
                    metadataType: 'CustomField',
                    name: endTime,
                    sourceMetadata: 'Session_Record_Page'
                }
            ]
        });

        const manifest = packageXmlService.generateManifest(
            filtered.deploymentPackage
        );

        assert.ok(!manifest.packageXml.includes('End_Time__c'));
        assert.ok(!manifest.packageXml.includes('Status__c'));
    });

    await runTest('I — CustomField-on-CustomField blocker remains effective', () => {
        const full = [
            {
                metadataType: 'CustomField',
                metadataName: 'Booking__c.Status_Label__c',
                blockedBy: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.Is_Canceled__c'
                    }
                ],
                action: 'BLOCKING'
            }
        ];

        const { readinessBlockingComponents, suppressedForReadiness } =
            resolveReadinessBlockingComponents({
                autoExcludeShapeFormulaConflicts: true,
                shapeFormulaExclusionPolicy: policyApplied,
                compatibilityBlockingComponents: full,
                excludedComponents: [
                    shapeExcludedComponent('Booking__c.Is_Canceled__c')
                ],
                compatibilityWarnings: [
                    {
                        detectionSource: 'SHAPE_INDEX',
                        metadataType: 'CustomField',
                        metadataName: 'Booking__c.Is_Canceled__c',
                        conflictFacts: {
                            source: { calculated: false },
                            destination: { calculated: true }
                        }
                    }
                ],
                destinationShapeIndex: destinationShapeIndex({
                    'Booking__c.Is_Canceled__c': {
                        type: 'boolean',
                        calculated: true
                    }
                })
            });

        assert.strictEqual(suppressedForReadiness.length, 0);
        assert.strictEqual(readinessBlockingComponents.length, 1);
        assert.strictEqual(
            readinessBlockingComponents[0].metadataType,
            'CustomField'
        );
    });
}

main();
