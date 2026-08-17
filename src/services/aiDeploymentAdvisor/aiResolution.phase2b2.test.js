/**
 * Phase 2B-2 — AI Resolution ownership alignment with existing execution reports.
 * Does not create auto-fix, SAFE_SKIP, or metadata mutation capabilities.
 */

'use strict';

const assert = require('assert');

const {
    buildAiResolutionFactPack
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

function inventedPayload(metadataType, metadataName, overrides = {}) {
    return JSON.stringify({
        summary: 'invented',
        explanations: [
            {
                metadataType,
                metadataName,
                severity: 'HIGH',
                title: 't',
                why: 'w',
                impact: 'i',
                recommendedAction: 'r',
                bestPractice: 'b',
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
                    category: 'MANUAL_ACTION'
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
        'TEST 1: Successful existing auto-fix include → RUNTIME_AUTOFIX',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'ApexClass',
                                metadataName: 'TrainerService',
                                category: 'MANUAL_ACTION',
                                reason: 'Required dependency not included',
                                canAutoFix: false
                            }
                        ]
                    },
                    resolutionReport: {
                        resolutions: [
                            {
                                metadataType: 'ApexClass',
                                metadataName: 'TrainerService',
                                resolutionType: 'DEPENDENCY',
                                autoFixAvailable: false
                            }
                        ]
                    },
                    autoFixReport: {
                        autoFixApplied: true,
                        fixes: [
                            {
                                metadataType: 'ApexClass',
                                metadataName: 'TrainerService',
                                fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                                executed: true,
                                successful: true
                            }
                        ]
                    }
                },
                inventedPayload('ApexClass', 'TrainerService')
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.RUNTIME_AUTOFIX);
            assert.strictEqual(explanation.backendCanAutoFix, true);
            assert.match(
                explanation.backendResolution,
                /automatically included ApexClass TrainerService/
            );
            assert.doesNotMatch(
                explanation.backendResolution,
                /Salesforce source and destination metadata were changed/
            );
        }
    );

    await runTest(
        'TEST 2: Auto-fix candidate exists but was NOT successfully fixed → not RUNTIME_AUTOFIX',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'ApexClass',
                                metadataName: 'TrainerService',
                                category: 'AUTO_FIX',
                                canAutoFix: true,
                                reason: 'Required dependency not included'
                            }
                        ]
                    },
                    resolutionReport: {
                        resolutions: [
                            {
                                metadataType: 'ApexClass',
                                metadataName: 'TrainerService',
                                resolutionType: 'DEPENDENCY',
                                autoFixAvailable: true
                            }
                        ]
                    },
                    autoFixReport: {
                        autoFixApplied: false,
                        fixes: [
                            {
                                metadataType: 'ApexClass',
                                metadataName: 'TrainerService',
                                fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                                executed: true,
                                successful: false
                            }
                        ]
                    }
                },
                inventedPayload('ApexClass', 'TrainerService', {
                    fixOwner: 'RUNTIME_AUTOFIX',
                    backendCanAutoFix: true
                })
            );

            const explanation = report.explanations[0];

            assert.notStrictEqual(
                explanation.fixOwner,
                FIX_OWNERS.RUNTIME_AUTOFIX
            );
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.doesNotMatch(
                String(explanation.backendResolution || ''),
                /automatically included/
            );
        }
    );

    await runTest(
        'TEST 3: Successful ExternalCredentialPrincipal → parent ExternalCredential',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'ExternalCredentialPrincipal',
                                metadataName: 'Weather-Default',
                                category: 'MANUAL_ACTION',
                                reason: 'Required dependency not included'
                            }
                        ]
                    },
                    autoFixReport: {
                        autoFixApplied: true,
                        fixes: [
                            {
                                metadataType: 'ExternalCredential',
                                metadataName: 'Weather',
                                fixType: 'INCLUDE_DISCOVERED_DEPENDENCY',
                                executed: true,
                                successful: true
                            }
                        ]
                    }
                },
                inventedPayload(
                    'ExternalCredentialPrincipal',
                    'Weather-Default'
                )
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.RUNTIME_AUTOFIX);
            assert.strictEqual(explanation.backendCanAutoFix, true);
            assert.match(
                explanation.backendResolution,
                /ExternalCredential Weather/
            );
        }
    );

    await runTest(
        'TEST 4: Successful SAFE_SKIP → backend-owned skip evidence',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.Status__c',
                                category: 'SAFE_SKIP',
                                canSafeSkip: true,
                                reason: 'Formula incompatibility'
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] },
                    safeSkipReport: {
                        safeSkipApplied: true,
                        decisions: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.Status__c',
                                safeToSkip: true,
                                decision: 'SAFE_SKIP',
                                applied: true
                            }
                        ]
                    }
                },
                inventedPayload('CustomField', 'Session__c.Status__c')
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.safeToSkip, true);
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.notStrictEqual(
                explanation.fixOwner,
                FIX_OWNERS.RUNTIME_AUTOFIX
            );
            assert.match(
                explanation.backendResolution,
                /excluded this component from the deployment package/
            );
            assert.doesNotMatch(
                explanation.backendResolution,
                /converted the field/i
            );
        }
    );

    await runTest(
        'TEST 5: Classifier SAFE_SKIP without applied skip is not executed',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.Status__c',
                                category: 'SAFE_SKIP',
                                canSafeSkip: true,
                                safeToSkip: true,
                                reason: 'Formula incompatibility'
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] },
                    safeSkipReport: {
                        safeSkipApplied: false,
                        decisions: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.Status__c',
                                safeToSkip: true,
                                decision: 'SAFE_SKIP',
                                applied: false
                            }
                        ]
                    }
                },
                inventedPayload('CustomField', 'Session__c.Status__c', {
                    safeToSkip: true
                })
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.safeToSkip, null);
            assert.doesNotMatch(
                String(explanation.backendResolution || ''),
                /excluded this component from the deployment package/
            );
        }
    );

    await runTest(
        'TEST 6: FlexiPage workspace file actually modified → RUNTIME_AUTOFIX',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'FlexiPage',
                                metadataName: 'Gym_Home',
                                category: 'MANUAL_ACTION',
                                reason: 'unsupported tabset label'
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] },
                    compatibilitySummary: {
                        status: 'UPDATED',
                        filesModified: [
                            {
                                file: 'flexipages/Gym_Home.flexipage-meta.xml',
                                ruleId: 'flexipage.remove-tabset-label',
                                summary: 'Removed 1 unsupported tabset label property'
                            }
                        ]
                    }
                },
                inventedPayload('FlexiPage', 'Gym_Home')
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.RUNTIME_AUTOFIX);
            assert.strictEqual(explanation.backendCanAutoFix, true);
            assert.match(
                explanation.backendResolution,
                /temporary deployment workspace copy/
            );
            assert.doesNotMatch(
                explanation.backendResolution,
                /Source Git metadata and Salesforce org metadata were changed/
            );
        }
    );

    await runTest(
        'TEST 7: FlexiPage detected but workspace not modified → not auto-fix',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'FlexiPage',
                                metadataName: 'Gym_Home',
                                category: 'MANUAL_ACTION',
                                reason: 'unsupported tabset label'
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] },
                    compatibilitySummary: {
                        status: 'UNCHANGED',
                        filesModified: []
                    }
                },
                inventedPayload('FlexiPage', 'Gym_Home', {
                    fixOwner: 'RUNTIME_AUTOFIX'
                })
            );

            const explanation = report.explanations[0];

            assert.notStrictEqual(
                explanation.fixOwner,
                FIX_OWNERS.RUNTIME_AUTOFIX
            );
            assert.strictEqual(explanation.backendCanAutoFix, false);
        }
    );

    await runTest(
        'TEST 8: Flow CustomField package gap → MANUAL_METADATA',
        async () => {
            const pack = buildAiResolutionFactPack({
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'Flow',
                            metadataName: 'Check_Amount',
                            evidence: {
                                problem:
                                    'The element has an invalid reference to "$Record.Approved__c".'
                            }
                        }
                    ]
                },
                incomingRequiredDependencies: [
                    {
                        type: 'CustomField',
                        name: 'Opportunity.Approved__c',
                        required: true,
                        selected: true
                    }
                ],
                requiredDependencies: [
                    {
                        type: 'CustomField',
                        name: 'Opportunity.Approved__c',
                        artifactResolved: true,
                        filePath:
                            'objects/Opportunity/fields/Approved__c.field-meta.xml'
                    }
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
                        failures: [
                            {
                                metadataType: 'Flow',
                                metadataName: 'Check_Amount',
                                evidence: {
                                    problem:
                                        'The element has an invalid reference to "$Record.Approved__c".'
                                }
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] },
                    aiResolutionFactPack: pack
                },
                inventedPayload('Flow', 'Check_Amount', {
                    backendCanAutoFix: true
                })
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.MANUAL_METADATA);
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.match(
                explanation.backendResolution,
                /was not included in the deployment package/
            );
        }
    );

    await runTest(
        'TEST 9: FIELD_TYPE_CONVERSION → MANUAL_METADATA',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.End_Time__c',
                                category: 'MANUAL_ACTION',
                                canAutoFix: false,
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
                    excludedComponents: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.End_Time__c',
                            category: 'FIELD_TYPE_CHANGE',
                            action: 'AUTO_EXCLUDED'
                        }
                    ],
                    aiResolutionFactPack: conversionFactPack()
                },
                inventedPayload('CustomField', 'Session__c.End_Time__c')
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.MANUAL_METADATA);
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.match(
                explanation.backendResolution,
                /does not allow this in-place conversion/
            );
            assert.match(
                explanation.backendResolution,
                /excluded this incompatible metadata member/
            );
            assert.doesNotMatch(
                explanation.backendResolution,
                /converted the field/i
            );
            assert.strictEqual(
                explanation.conflict.type,
                'FIELD_TYPE_CONVERSION'
            );
        }
    );

    await runTest(
        'TEST 10: Unknown Profile permission → MANUAL_METADATA',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'Profile',
                                metadataName: 'Sales Manager',
                                reason:
                                    'Unknown user permission: CreateWorkBadgeDefinition',
                                evidence: {
                                    problem:
                                        'Unknown user permission: CreateWorkBadgeDefinition'
                                }
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] }
                },
                inventedPayload('Profile', 'Sales Manager')
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.MANUAL_METADATA);
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.match(
                explanation.backendResolution,
                /permission that is not recognized/
            );
            assert.ok(
                explanation.resolution.steps.some((step) =>
                    /Open the affected Profile/.test(step)
                )
            );
        }
    );

    await runTest(
        'TEST 11: CompactLayout invalid assignment → MANUAL_METADATA',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'RecordType',
                                metadataName: 'Opportunity.New_Business',
                                evidence: {
                                    problem:
                                        'invalid compact layout assigned: Opportunity_Highlights'
                                }
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] }
                },
                inventedPayload('RecordType', 'Opportunity.New_Business')
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.MANUAL_METADATA);
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.match(
                explanation.backendResolution,
                /cannot rewrite CompactLayout/
            );
        }
    );

    await runTest(
        'TEST 12: Unknown/unmatched error → UNKNOWN',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'Layout',
                                metadataName: 'Account-Account Layout',
                                reason: 'field integrity exception: unknown'
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] }
                },
                inventedPayload('Layout', 'Account-Account Layout')
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.UNKNOWN);
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.strictEqual(explanation.backendResolution, null);
        }
    );

    await runTest(
        'TEST 13: AI cannot invent RUNTIME_AUTOFIX',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'Layout',
                                metadataName: 'Account-Account Layout',
                                reason: 'field integrity exception: unknown'
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] }
                },
                inventedPayload('Layout', 'Account-Account Layout', {
                    fixOwner: 'RUNTIME_AUTOFIX',
                    backendCanAutoFix: true
                })
            );

            assert.strictEqual(
                report.explanations[0].fixOwner,
                FIX_OWNERS.UNKNOWN
            );
            assert.strictEqual(report.explanations[0].backendCanAutoFix, false);
        }
    );

    await runTest(
        'TEST 14: AI cannot set safeToSkip true',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'Layout',
                                metadataName: 'Account-Account Layout',
                                reason: 'field integrity exception: unknown'
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] }
                },
                inventedPayload('Layout', 'Account-Account Layout', {
                    safeToSkip: true
                })
            );

            assert.strictEqual(report.explanations[0].safeToSkip, null);
        }
    );

    if (process.exitCode) {
        console.error('aiResolution.phase2b2.test.js FAILED');
    } else {
        console.log('aiResolution.phase2b2.test.js PASSED');
    }
}

main();
