/**
 * Phase 2B-1 — deterministic Flow evidence + backend-owned resolution.
 * Advisory only. Does not change Flow discovery or package composition.
 */

'use strict';

const assert = require('assert');

const {
    buildAiResolutionFactPack,
    sanitizeFactPackForAi,
    getFlowEvidence
} = require('./aiResolutionFactPack.service');
const {
    generateAiResolutionReport,
    FIX_OWNERS
} = require('./aiDeploymentAdvisor.service');

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

function checkAmountFailure() {
    return {
        metadataType: 'Flow',
        metadataName: 'Check_Amount',
        category: 'MANUAL_ACTION',
        reason: 'field integrity exception: unknown',
        evidence: {
            problem:
                'The element has an invalid reference to "$Record.Approved__c".'
        }
    };
}

function activeCustomerFailure() {
    return {
        metadataType: 'Flow',
        metadataName: 'Active_Customer',
        category: 'MANUAL_ACTION',
        reason: 'field integrity exception: unknown',
        evidence: {
            problem:
                'The field "Customer_Status__c" for the object "Opportunity" doesn\'t exist.'
        }
    };
}

function reviewField(metadataName, flags = {}) {
    return {
        type: 'CustomField',
        name: metadataName,
        required: flags.required !== false,
        selected: flags.selected !== false
    };
}

function resolvedField(metadataName, artifact = {}) {
    return {
        type: 'CustomField',
        name: metadataName,
        required: true,
        selected: true,
        artifactResolved: artifact.exists !== false,
        sourceExists: artifact.exists !== false,
        filePath:
            artifact.path ||
            `objects/${metadataName.split('.')[0]}/fields/${metadataName.split('.')[1]}.field-meta.xml`
    };
}

function flowFactPack({
    failure,
    incoming = [],
    resolved = incoming,
    generatedDeploymentPackage = { metadata: [], dependencies: [] },
    destinationShapeIndex = null
}) {
    return buildAiResolutionFactPack({
        failureClassification: {
            failures: [failure]
        },
        deploymentDiagnostics: {
            componentFailures: [
                {
                    componentType: failure.metadataType,
                    fullName: failure.metadataName,
                    problem: failure.evidence.problem
                }
            ]
        },
        incomingRequiredDependencies: incoming,
        requiredDependencies: resolved,
        generatedDeploymentPackage,
        destinationShapeIndex
    });
}

function inventedFlowPayload(metadataName, overrides = {}) {
    return JSON.stringify({
        summary: 'invented',
        explanations: [
            {
                metadataType: 'Flow',
                metadataName,
                severity: 'HIGH',
                title: 'Flow failed',
                why: 'backend should auto-fix this',
                impact: 'blocked',
                recommendedAction: 'Let the backend add the field',
                bestPractice: 'none',
                confidence: 'HIGH',
                ...overrides
            }
        ]
    });
}

async function generateWithText(context, text) {
    return generateAiResolutionReport(context, {
        enabled: true,
        provider: 'gemini',
        generateText: async () => ({
            provider: 'gemini',
            text
        })
    });
}

function conversionFactPack() {
    const shapes = new Map();

    shapes.set('CustomField:Session__c.End_Time__c', {
        metadataType: 'CustomField',
        metadataName: 'Session__c.End_Time__c',
        parentObject: 'Session__c',
        apiName: 'End_Time__c',
        attributes: {
            type: 'time',
            mdapiType: 'Time',
            calculated: false,
            label: 'End Time',
            length: null,
            precision: null,
            scale: null,
            required: false,
            referenceTo: [],
            picklistValues: null
        },
        warning: null
    });

    const destinationShapes = new Map();

    destinationShapes.set('CustomField:Session__c.End_Time__c', {
        metadataType: 'CustomField',
        metadataName: 'Session__c.End_Time__c',
        parentObject: 'Session__c',
        apiName: 'End_Time__c',
        found: true,
        queried: true,
        attributes: {
            type: 'datetime',
            calculated: true,
            label: 'End Time',
            length: null,
            precision: null,
            scale: null,
            required: false,
            referenceTo: [],
            picklistValues: null,
            custom: true
        },
        warning: null,
        unsupported: false
    });

    return buildAiResolutionFactPack({
        failureClassification: {
            failures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.End_Time__c',
                    category: 'MANUAL_ACTION',
                    reason:
                        'Formula or field type conversion is not supported by Metadata API deploy.'
                }
            ]
        },
        deploymentDiagnostics: {
            componentFailures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.End_Time__c',
                    problem:
                        'Cannot update a field from a Formula to something else'
                }
            ]
        },
        sourceShapeIndex: shapes,
        destinationShapeIndex: {
            shapes: destinationShapes,
            summary: { requested: 1, resolved: 1 }
        }
    });
}

async function main() {
    await runTest(
        'TEST 1: Check_Amount $Record.Approved__c → Opportunity.Approved__c',
        () => {
            const pack = flowFactPack({
                failure: checkAmountFailure(),
                incoming: [reviewField('Opportunity.Approved__c')],
                resolved: [
                    resolvedField('Opportunity.Approved__c', {
                        exists: true,
                        path: 'objects/Opportunity/fields/Approved__c.field-meta.xml'
                    })
                ]
            });

            const evidence = getFlowEvidence(pack, 'Flow', 'Check_Amount');

            assert.ok(evidence);
            assert.strictEqual(evidence.flowName, 'Check_Amount');
            assert.strictEqual(
                evidence.dependencies[0].metadataName,
                'Opportunity.Approved__c'
            );
            assert.strictEqual(
                evidence.failure.failureType,
                'INVALID_RECORD_FIELD_REFERENCE'
            );
        }
    );

    await runTest(
        'TEST 2: Active_Customer Opportunity.Customer_Status__c',
        () => {
            const pack = flowFactPack({
                failure: activeCustomerFailure(),
                incoming: [reviewField('Opportunity.Customer_Status__c')],
                resolved: [
                    resolvedField('Opportunity.Customer_Status__c', {
                        exists: true,
                        path: 'objects/Opportunity/fields/Customer_Status__c.field-meta.xml'
                    })
                ]
            });

            const evidence = getFlowEvidence(pack, 'Flow', 'Active_Customer');

            assert.ok(evidence);
            assert.strictEqual(
                evidence.dependencies[0].metadataName,
                'Opportunity.Customer_Status__c'
            );
            assert.strictEqual(
                evidence.failure.failureType,
                'MISSING_OBJECT_FIELD'
            );
        }
    );

    await runTest(
        'TEST 3: Flow dependency discovered but not in package',
        async () => {
            const pack = flowFactPack({
                failure: checkAmountFailure(),
                incoming: [reviewField('Opportunity.Approved__c')],
                resolved: [
                    resolvedField('Opportunity.Approved__c', { exists: true })
                ],
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'Flow',
                            metadataName: 'Check_Amount'
                        }
                    ],
                    dependencies: []
                }
            });

            const evidence = getFlowEvidence(pack, 'Flow', 'Check_Amount');
            const dep = evidence.dependencies[0];

            assert.strictEqual(dep.review.discovered, true);
            assert.strictEqual(dep.review.required, true);
            assert.strictEqual(dep.review.selected, true);
            assert.strictEqual(dep.deploymentPackage.included, false);

            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [checkAmountFailure()]
                    },
                    resolutionReport: { resolutions: [] },
                    autoFixReport: { fixes: [] },
                    aiResolutionFactPack: pack
                },
                inventedFlowPayload('Check_Amount')
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.MANUAL_METADATA);
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.match(
                explanation.backendResolution,
                /not included in the deployment package/
            );
            assert.ok(
                explanation.resolution.steps.some((step) =>
                    /Re-run Deployment Review/.test(step)
                )
            );
            assert.ok(
                !explanation.resolution.steps.some((step) =>
                    /destination/i.test(step)
                )
            );
        }
    );

    await runTest(
        'TEST 4: Flow dependency discovered and already in package',
        async () => {
            const pack = flowFactPack({
                failure: checkAmountFailure(),
                incoming: [reviewField('Opportunity.Approved__c')],
                resolved: [
                    resolvedField('Opportunity.Approved__c', { exists: true })
                ],
                generatedDeploymentPackage: {
                    metadata: [
                        {
                            metadataType: 'Flow',
                            metadataName: 'Check_Amount'
                        },
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Opportunity.Approved__c'
                        }
                    ],
                    dependencies: [
                        {
                            type: 'CustomField',
                            name: 'Opportunity.Approved__c',
                            required: true,
                            selected: true
                        }
                    ]
                }
            });

            const dep = getFlowEvidence(pack, 'Flow', 'Check_Amount')
                .dependencies[0];

            assert.strictEqual(dep.review.discovered, true);
            assert.strictEqual(dep.deploymentPackage.included, true);

            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [checkAmountFailure()]
                    },
                    resolutionReport: { resolutions: [] },
                    autoFixReport: { fixes: [] },
                    aiResolutionFactPack: pack
                },
                inventedFlowPayload('Check_Amount')
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.UNKNOWN);
            assert.strictEqual(explanation.backendResolution, null);
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.strictEqual(explanation.resolution, undefined);
        }
    );

    await runTest('TEST 5: Source artifact exists', () => {
        const pack = flowFactPack({
            failure: checkAmountFailure(),
            incoming: [reviewField('Opportunity.Approved__c')],
            resolved: [
                resolvedField('Opportunity.Approved__c', {
                    exists: true,
                    path: 'objects/Opportunity/fields/Approved__c.field-meta.xml'
                })
            ]
        });

        const artifact = getFlowEvidence(pack, 'Flow', 'Check_Amount')
            .dependencies[0].sourceArtifact;

        assert.strictEqual(artifact.exists, true);
        assert.strictEqual(
            artifact.path,
            'objects/Opportunity/fields/Approved__c.field-meta.xml'
        );
        assert.strictEqual(artifact.confidence, 'HIGH');
    });

    await runTest('TEST 6: Source artifact missing', async () => {
        const pack = flowFactPack({
            failure: activeCustomerFailure(),
            incoming: [reviewField('Opportunity.Customer_Status__c')],
            resolved: [
                {
                    type: 'CustomField',
                    name: 'Opportunity.Customer_Status__c',
                    required: true,
                    selected: true,
                    artifactResolved: false,
                    sourceExists: false,
                    filePath: null
                }
            ]
        });

        const artifact = getFlowEvidence(pack, 'Flow', 'Active_Customer')
            .dependencies[0].sourceArtifact;

        assert.strictEqual(artifact.exists, false);
        assert.strictEqual(artifact.path, null);
        assert.strictEqual(artifact.confidence, 'HIGH');

        const report = await generateWithText(
            {
                failureClassification: {
                    failures: [activeCustomerFailure()]
                },
                resolutionReport: { resolutions: [] },
                autoFixReport: { fixes: [] },
                aiResolutionFactPack: pack
            },
            inventedFlowPayload('Active_Customer')
        );

        const explanation = report.explanations[0];

        assert.strictEqual(explanation.fixOwner, FIX_OWNERS.MANUAL_METADATA);
        assert.strictEqual(explanation.backendCanAutoFix, false);
        assert.match(explanation.backendResolution, /No source artifact/);
        assert.ok(
            !/exists in the source branch but is not included/.test(
                explanation.backendResolution
            )
        );
    });

    await runTest('TEST 7: Destination UNKNOWN', () => {
        const pack = flowFactPack({
            failure: checkAmountFailure(),
            incoming: [reviewField('Opportunity.Approved__c')],
            resolved: [
                resolvedField('Opportunity.Approved__c', { exists: true })
            ]
        });

        const destination = getFlowEvidence(pack, 'Flow', 'Check_Amount')
            .dependencies[0].destination;

        assert.strictEqual(destination.exists, null);
        assert.strictEqual(destination.confidence, 'UNKNOWN');
    });

    await runTest('TEST 8: Wrong dependency must NOT match', () => {
        const unrelatedField = flowFactPack({
            failure: checkAmountFailure(),
            incoming: [reviewField('Opportunity.Customer_Status__c')],
            resolved: [
                resolvedField('Opportunity.Customer_Status__c', {
                    exists: true
                })
            ]
        });

        assert.strictEqual(unrelatedField.flowEvidence, null);

        const ambiguousRecordField = flowFactPack({
            failure: checkAmountFailure(),
            incoming: [
                reviewField('Account.Approved__c'),
                reviewField('Opportunity.Approved__c')
            ]
        });

        assert.strictEqual(ambiguousRecordField.flowEvidence, null);

        const wrongObject = flowFactPack({
            failure: activeCustomerFailure(),
            incoming: [reviewField('Account.Customer_Status__c')],
            resolved: [
                resolvedField('Account.Customer_Status__c', { exists: true })
            ]
        });

        assert.strictEqual(wrongObject.flowEvidence, null);
    });

    await runTest('TEST 9: No dependency evidence → flowEvidence null', () => {
        const pack = flowFactPack({
            failure: checkAmountFailure(),
            incoming: [],
            resolved: [],
            generatedDeploymentPackage: {
                metadata: [
                    { metadataType: 'Flow', metadataName: 'Check_Amount' }
                ],
                dependencies: []
            }
        });

        assert.strictEqual(pack.flowEvidence, null);
    });

    await runTest('TEST 10: AI cannot override flowEvidence', async () => {
        const pack = flowFactPack({
            failure: checkAmountFailure(),
            incoming: [reviewField('Opportunity.Approved__c')],
            resolved: [
                resolvedField('Opportunity.Approved__c', { exists: true })
            ]
        });

        const report = await generateWithText(
            {
                failureClassification: {
                    failures: [checkAmountFailure()]
                },
                resolutionReport: { resolutions: [] },
                autoFixReport: { fixes: [] },
                aiResolutionFactPack: pack
            },
            inventedFlowPayload('Check_Amount', {
                flowEvidence: {
                    flowName: 'Invented_Flow',
                    dependencies: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Account.Fake__c'
                        }
                    ]
                }
            })
        );

        const explanation = report.explanations[0];

        assert.strictEqual(explanation.flowEvidence.flowName, 'Check_Amount');
        assert.strictEqual(
            explanation.flowEvidence.dependencies[0].metadataName,
            'Opportunity.Approved__c'
        );
    });

    await runTest('TEST 11: AI cannot override fixOwner', async () => {
        const pack = flowFactPack({
            failure: checkAmountFailure(),
            incoming: [reviewField('Opportunity.Approved__c')],
            resolved: [
                resolvedField('Opportunity.Approved__c', { exists: true })
            ],
            generatedDeploymentPackage: {
                metadata: [
                    { metadataType: 'Flow', metadataName: 'Check_Amount' }
                ],
                dependencies: []
            }
        });

        const report = await generateWithText(
            {
                failureClassification: {
                    failures: [checkAmountFailure()]
                },
                resolutionReport: { resolutions: [] },
                autoFixReport: { fixes: [] },
                aiResolutionFactPack: pack
            },
            inventedFlowPayload('Check_Amount', {
                fixOwner: 'RUNTIME_AUTOFIX'
            })
        );

        assert.strictEqual(
            report.explanations[0].fixOwner,
            FIX_OWNERS.MANUAL_METADATA
        );
    });

    await runTest('TEST 12: AI cannot set backendCanAutoFix', async () => {
        const pack = flowFactPack({
            failure: checkAmountFailure(),
            incoming: [reviewField('Opportunity.Approved__c')],
            resolved: [
                resolvedField('Opportunity.Approved__c', { exists: true })
            ],
            generatedDeploymentPackage: {
                metadata: [
                    { metadataType: 'Flow', metadataName: 'Check_Amount' }
                ],
                dependencies: []
            }
        });

        const report = await generateWithText(
            {
                failureClassification: {
                    failures: [checkAmountFailure()]
                },
                resolutionReport: { resolutions: [] },
                autoFixReport: { fixes: [] },
                aiResolutionFactPack: pack
            },
            inventedFlowPayload('Check_Amount', {
                backendCanAutoFix: true
            })
        );

        assert.strictEqual(report.explanations[0].backendCanAutoFix, false);
    });

    await runTest(
        'TEST 13: Existing FIELD_TYPE_CONVERSION behavior unchanged',
        async () => {
            const pack = conversionFactPack();

            assert.strictEqual(pack.flowEvidence, null);

            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.End_Time__c',
                                category: 'MANUAL_ACTION',
                                canAutoFix: false,
                                reason:
                                    'Formula or field type conversion is not supported by Metadata API deploy.',
                                evidence: {
                                    problem:
                                        'Cannot update a field from a Formula to something else'
                                }
                            }
                        ]
                    },
                    resolutionReport: {
                        resolutions: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.End_Time__c',
                                resolutionType: 'MANUAL_METADATA_CHANGE'
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] },
                    aiResolutionFactPack: pack
                },
                JSON.stringify({
                    summary: 'conversion',
                    explanations: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.End_Time__c',
                            title: 't',
                            why: 'w',
                            impact: 'i',
                            recommendedAction: 'r',
                            bestPractice: 'b',
                            confidence: 'HIGH',
                            fixOwner: 'RUNTIME_AUTOFIX',
                            flowEvidence: { flowName: 'Nope' }
                        }
                    ]
                })
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.MANUAL_METADATA);
            assert.match(
                explanation.backendResolution,
                /Salesforce does not allow this in-place conversion/
            );
            assert.strictEqual(explanation.flowEvidence, null);
            assert.strictEqual(
                explanation.conflict.type,
                'FIELD_TYPE_CONVERSION'
            );
        }
    );

    await runTest(
        'TEST 14: CreateWorkBadgeDefinition behavior unchanged',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'Profile',
                                metadataName: 'Sales Manager',
                                category: 'MANUAL_ACTION',
                                reason:
                                    'Unknown user permission: CreateWorkBadgeDefinition',
                                evidence: {
                                    problem:
                                        'Unknown user permission: CreateWorkBadgeDefinition'
                                }
                            }
                        ]
                    },
                    resolutionReport: { resolutions: [] },
                    autoFixReport: { fixes: [] }
                },
                JSON.stringify({
                    summary: 'profile',
                    explanations: [
                        {
                            metadataType: 'Profile',
                            metadataName: 'Sales Manager',
                            title: 'Unknown permission',
                            why: 'strip the permission',
                            impact: 'blocked',
                            recommendedAction:
                                'Remove CreateWorkBadgeDefinition from the Profile',
                            bestPractice: 'none',
                            confidence: 'HIGH',
                            backendCanAutoFix: true,
                            fixOwner: 'RUNTIME_AUTOFIX',
                            flowEvidence: { flowName: 'Check_Amount' }
                        }
                    ]
                })
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.UNKNOWN);
            assert.strictEqual(explanation.backendResolution, null);
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.strictEqual(explanation.flowEvidence, null);
            assert.strictEqual(explanation.source, undefined);
        }
    );

    await runTest(
        'sanitizeFactPackForAi keeps Flow evidence and drops invented keys',
        () => {
            const sanitized = sanitizeFactPackForAi({
                version: 1,
                refreshToken: 'nope',
                flowEvidence: [
                    {
                        flowName: 'Check_Amount',
                        accessToken: 'secret',
                        failure: {
                            cliProblem: '$Record.Approved__c',
                            failureType: 'INVALID_RECORD_FIELD_REFERENCE'
                        },
                        dependencies: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Opportunity.Approved__c',
                                review: {
                                    discovered: true,
                                    required: true,
                                    selected: true
                                },
                                sourceArtifact: {
                                    exists: true,
                                    path: 'objects/Opportunity/fields/Approved__c.field-meta.xml',
                                    confidence: 'HIGH'
                                },
                                deploymentPackage: { included: false },
                                destination: {
                                    exists: null,
                                    confidence: 'UNKNOWN'
                                }
                            }
                        ]
                    }
                ],
                components: []
            });

            assert.strictEqual(sanitized.refreshToken, undefined);
            assert.strictEqual(sanitized.flowEvidence[0].accessToken, undefined);
            assert.strictEqual(
                sanitized.flowEvidence[0].dependencies[0].metadataName,
                'Opportunity.Approved__c'
            );
        }
    );

    if (process.exitCode) {
        console.error('aiResolution.phase2b1.test.js FAILED');
    } else {
        console.log('aiResolution.phase2b1.test.js PASSED');
    }
}

main();
