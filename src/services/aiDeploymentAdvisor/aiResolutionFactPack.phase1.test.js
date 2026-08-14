/**
 * Phase 1 — AI Resolution deterministic CustomField fact pack tests.
 */

'use strict';

const assert = require('assert');

const {
    buildAiResolutionFactPack,
    sanitizeFactPackForAi,
    serializeSourceCustomFieldShapeIndex,
    getComponentFactPack
} = require('./aiResolutionFactPack.service');
const {
    buildStructuredContext,
    sanitizeAiResolutionContext,
    generateAiResolutionReport,
    ALLOWED_CONTEXT_KEYS,
    buildDeterministicExplanation
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

function buildSourceShapeMap() {
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

    shapes.set('CustomField:Session__c.Status__c', {
        metadataType: 'CustomField',
        metadataName: 'Session__c.Status__c',
        parentObject: 'Session__c',
        apiName: 'Status__c',
        attributes: {
            type: 'picklist',
            mdapiType: 'Picklist',
            calculated: false,
            label: 'Status',
            length: null,
            precision: null,
            scale: null,
            required: false,
            referenceTo: [],
            picklistValues: [
                { value: 'Scheduled', label: 'Scheduled', active: true }
            ]
        },
        warning: null
    });

    return shapes;
}

function buildDestinationShapeIndex(overrides = {}) {
    const shapes = new Map();

    shapes.set('CustomField:Session__c.End_Time__c', {
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
        unsupported: false,
        ...overrides.endTime
    });

    shapes.set('CustomField:Session__c.Status__c', {
        metadataType: 'CustomField',
        metadataName: 'Session__c.Status__c',
        parentObject: 'Session__c',
        apiName: 'Status__c',
        found: true,
        queried: true,
        attributes: {
            type: 'string',
            calculated: true,
            label: 'Status',
            length: 255,
            precision: null,
            scale: null,
            required: false,
            referenceTo: [],
            picklistValues: null,
            custom: true
        },
        warning: null,
        unsupported: false,
        ...overrides.status
    });

    return { shapes, summary: { requested: 2, resolved: 2 } };
}

function baseFailureContext() {
    return {
        failureClassification: {
            overallStatus: 'CLASSIFIED',
            failures: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.End_Time__c',
                    category: 'MANUAL_ACTION',
                    reason:
                        'Formula or field type conversion is not supported by Metadata API deploy.',
                    evidence: {
                        problem:
                            'Cannot update a field from a Formula to something else',
                        source: 'CLI'
                    }
                },
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Status__c',
                    category: 'MANUAL_ACTION',
                    reason:
                        'Formula or field type conversion is not supported by Metadata API deploy.',
                    evidence: {
                        problem:
                            'Cannot update a field from a Formula to something else',
                        source: 'CLI'
                    }
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
                },
                {
                    metadataType: 'CustomField',
                    metadataName: 'Session__c.Status__c',
                    problem:
                        'Cannot update a field from a Formula to something else'
                }
            ]
        }
    };
}

async function main() {
    await runTest(
        'TEST 1: CustomField source + destination facts are included in AI context',
        () => {
            const pack = buildAiResolutionFactPack({
                ...baseFailureContext(),
                sourceShapeIndex: buildSourceShapeMap(),
                destinationShapeIndex: buildDestinationShapeIndex()
            });

            const structured = buildStructuredContext({
                ...baseFailureContext(),
                aiResolutionFactPack: pack
            });

            assert.ok(structured.aiResolutionFactPack);
            assert.strictEqual(
                structured.aiResolutionFactPack.components.length,
                2
            );

            const endTime = getComponentFactPack(
                structured.aiResolutionFactPack,
                'CustomField',
                'Session__c.End_Time__c'
            );

            assert.strictEqual(endTime.source.type, 'Time');
            assert.strictEqual(endTime.source.calculated, false);
            assert.strictEqual(endTime.destination.calculated, true);
            assert.ok(endTime.destination.type);
        }
    );

    await runTest('TEST 2: Original Salesforce CLI error is preserved', () => {
        const pack = buildAiResolutionFactPack({
            ...baseFailureContext(),
            sourceShapeIndex: buildSourceShapeMap(),
            destinationShapeIndex: buildDestinationShapeIndex()
        });

        const endTime = getComponentFactPack(
            pack,
            'CustomField',
            'Session__c.End_Time__c'
        );

        assert.strictEqual(
            endTime.cliProblem,
            'Cannot update a field from a Formula to something else'
        );
        assert.ok(endTime.classifiedReason);
        assert.notStrictEqual(endTime.cliProblem, endTime.classifiedReason);

        const structured = buildStructuredContext({
            ...baseFailureContext(),
            aiResolutionFactPack: pack
        });

        assert.strictEqual(
            structured.failureClassification.failures[0].cliProblem,
            'Cannot update a field from a Formula to something else'
        );
    });

    await runTest(
        'TEST 3: Source Time + destination Formula produces structured comparison facts',
        () => {
            const pack = buildAiResolutionFactPack({
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.End_Time__c',
                            category: 'MANUAL_ACTION',
                            reason: 'classified'
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
                sourceShapeIndex: buildSourceShapeMap(),
                destinationShapeIndex: buildDestinationShapeIndex()
            });

            const endTime = pack.components[0];

            assert.strictEqual(endTime.source.type, 'Time');
            assert.strictEqual(endTime.source.calculated, false);
            assert.strictEqual(endTime.destination.calculated, true);
            assert.strictEqual(
                endTime.comparison.conflictType,
                'FIELD_TYPE_CONVERSION'
            );
            assert.strictEqual(endTime.comparison.confidence, 'HIGH');
        }
    );

    await runTest(
        'TEST 4: Source Picklist + destination Formula produces structured comparison facts',
        () => {
            const pack = buildAiResolutionFactPack({
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Status__c',
                            category: 'MANUAL_ACTION',
                            reason: 'classified'
                        }
                    ]
                },
                deploymentDiagnostics: {
                    componentFailures: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.Status__c',
                            problem:
                                'Cannot update a field from a Formula to something else'
                        }
                    ]
                },
                sourceShapeIndex: buildSourceShapeMap(),
                destinationShapeIndex: buildDestinationShapeIndex()
            });

            const status = pack.components[0];

            assert.strictEqual(status.source.type, 'Picklist');
            assert.strictEqual(status.source.calculated, false);
            assert.strictEqual(status.destination.calculated, true);
            assert.strictEqual(
                status.comparison.conflictType,
                'FIELD_TYPE_CONVERSION'
            );
        }
    );

    await runTest(
        'TEST 5: Unknown destination produces explicit UNKNOWN/null values',
        () => {
            const pack = buildAiResolutionFactPack({
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.End_Time__c',
                            category: 'MANUAL_ACTION',
                            reason: 'classified'
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
                sourceShapeIndex: buildSourceShapeMap(),
                destinationShapeIndex: { shapes: new Map() }
            });

            const endTime = pack.components[0];

            assert.strictEqual(endTime.destination.exists, null);
            assert.strictEqual(endTime.destination.type, null);
            assert.strictEqual(endTime.destination.calculated, null);
            assert.strictEqual(endTime.destination.confidence, 'UNKNOWN');
            assert.strictEqual(endTime.comparison.confidence, 'UNKNOWN');
            assert.strictEqual(endTime.comparison.conflictType, null);
        }
    );

    await runTest(
        'TEST 6: AI context does not contain credentials/tokens',
        () => {
            const sanitized = sanitizeAiResolutionContext({
                failureClassification: { failures: [] },
                accessToken: 'SECRET_TOKEN',
                refreshToken: 'SECRET_REFRESH',
                apiKey: 'SECRET_KEY',
                credentials: { password: 'x' },
                aiResolutionFactPack: {
                    version: 1,
                    accessToken: 'LEAK',
                    components: [
                        {
                            metadata: {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.End_Time__c'
                            },
                            cliProblem: 'Cannot update a field from a Formula to something else',
                            source: {
                                exists: true,
                                type: 'Time',
                                calculated: false,
                                confidence: 'HIGH'
                            },
                            destination: {
                                exists: null,
                                type: null,
                                calculated: null,
                                confidence: 'UNKNOWN'
                            }
                        }
                    ]
                }
            });

            assert.strictEqual(sanitized.accessToken, undefined);
            assert.strictEqual(sanitized.refreshToken, undefined);
            assert.strictEqual(sanitized.apiKey, undefined);
            assert.strictEqual(sanitized.credentials, undefined);
            assert.ok(ALLOWED_CONTEXT_KEYS.includes('aiResolutionFactPack'));
            assert.strictEqual(
                sanitized.aiResolutionFactPack.accessToken,
                undefined
            );
            assert.strictEqual(
                sanitized.aiResolutionFactPack.components[0].cliProblem,
                'Cannot update a field from a Formula to something else'
            );
        }
    );

    await runTest(
        'TEST 7: Existing AI output fields remain backward compatible',
        async () => {
            const pack = buildAiResolutionFactPack({
                ...baseFailureContext(),
                sourceShapeIndex: buildSourceShapeMap(),
                destinationShapeIndex: buildDestinationShapeIndex()
            });

            const report = await generateAiResolutionReport(
                {
                    ...baseFailureContext(),
                    resolutionReport: {
                        resolutions: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.End_Time__c',
                                resolutionType: 'MANUAL_METADATA_CHANGE',
                                severity: 'HIGH',
                                recommendation: 'Reconcile field types.'
                            }
                        ]
                    },
                    autoFixReport: { fixes: [] },
                    aiResolutionFactPack: pack
                },
                {
                    enabled: true,
                    provider: 'gemini',
                    generateText: async () => ({
                        provider: 'gemini',
                        text: JSON.stringify({
                            summary: 'Field type conflict',
                            explanations: [
                                {
                                    metadataType: 'CustomField',
                                    metadataName: 'Session__c.End_Time__c',
                                    severity: 'HIGH',
                                    title: 'Field type conflict',
                                    why: 'Types differ',
                                    impact: 'Deploy blocked',
                                    recommendedAction: 'Reconcile manually',
                                    bestPractice: 'Plan field migrations',
                                    confidence: 'HIGH',
                                    safeToSkip: true,
                                    backendCanAutoFix: true,
                                    source: {
                                        type: 'INVENTED',
                                        calculated: true
                                    },
                                    destination: {
                                        type: 'INVENTED',
                                        calculated: false
                                    }
                                }
                            ]
                        })
                    })
                }
            );

            const explanation = report.explanations[0];

            assert.ok(explanation.title);
            assert.ok(explanation.why);
            assert.ok(explanation.impact);
            assert.ok(explanation.recommendedAction);
            assert.ok(explanation.bestPractice);
            assert.ok(explanation.confidence);
            assert.ok(explanation.resolutionCategory);
            assert.strictEqual(typeof explanation.backendCanAutoFix, 'boolean');
            assert.strictEqual(typeof explanation.userActionRequired, 'boolean');
            assert.ok('safeToSkip' in explanation);
            assert.ok(explanation.skipGuidance);
            assert.strictEqual(explanation.source.type, 'Time');
            assert.strictEqual(explanation.source.calculated, false);
            assert.notStrictEqual(explanation.source.type, 'INVENTED');
            assert.notStrictEqual(explanation.destination.type, 'INVENTED');
            assert.ok(explanation.conflict);
            assert.ok(explanation.resolution);
        }
    );

    await runTest(
        'TEST 8: SAFE_SKIP and backendCanAutoFix remain backend-controlled',
        async () => {
            const pack = buildAiResolutionFactPack({
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.End_Time__c',
                            category: 'MANUAL_ACTION',
                            canAutoFix: false,
                            canSafeSkip: false,
                            reason: 'manual'
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
                sourceShapeIndex: buildSourceShapeMap(),
                destinationShapeIndex: buildDestinationShapeIndex()
            });

            const report = await generateAiResolutionReport(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'CustomField',
                                metadataName: 'Session__c.End_Time__c',
                                category: 'MANUAL_ACTION',
                                canAutoFix: false,
                                reason: 'manual'
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
                {
                    enabled: true,
                    provider: 'openai',
                    generateText: async () => ({
                        provider: 'openai',
                        text: JSON.stringify({
                            summary: 'x',
                            explanations: [
                                {
                                    metadataType: 'CustomField',
                                    metadataName: 'Session__c.End_Time__c',
                                    severity: 'HIGH',
                                    title: 't',
                                    why: 'w',
                                    impact: 'i',
                                    recommendedAction: 'r',
                                    bestPractice: 'b',
                                    confidence: 'HIGH',
                                    safeToSkip: true,
                                    backendCanAutoFix: true
                                }
                            ]
                        })
                    })
                }
            );

            assert.strictEqual(report.explanations[0].safeToSkip, null);
            assert.strictEqual(report.explanations[0].backendCanAutoFix, false);
            assert.match(
                report.explanations[0].skipGuidance,
                /not marked this component as safe to skip/i
            );
        }
    );

    await runTest('TEST 9: Non-CustomField failures do not break', () => {
        const pack = buildAiResolutionFactPack({
            failureClassification: {
                failures: [
                    {
                        metadataType: 'Profile',
                        metadataName: 'Sales Manager',
                        category: 'MANUAL_ACTION',
                        reason: 'Unknown user permission: CreateWorkBadgeDefinition'
                    }
                ]
            },
            deploymentDiagnostics: {
                componentFailures: [
                    {
                        metadataType: 'Profile',
                        metadataName: 'Sales Manager',
                        problem:
                            'Unknown user permission: CreateWorkBadgeDefinition'
                    }
                ]
            },
            sourceShapeIndex: buildSourceShapeMap(),
            destinationShapeIndex: buildDestinationShapeIndex()
        });

        assert.deepStrictEqual(pack.components, []);

        const structured = buildStructuredContext({
            failureClassification: {
                failures: [
                    {
                        metadataType: 'Profile',
                        metadataName: 'Sales Manager',
                        category: 'MANUAL_ACTION',
                        reason: 'Unknown user permission: CreateWorkBadgeDefinition',
                        evidence: {
                            problem:
                                'Unknown user permission: CreateWorkBadgeDefinition'
                        }
                    }
                ]
            },
            aiResolutionFactPack: pack
        });

        assert.strictEqual(
            structured.failureClassification.failures[0].metadataType,
            'Profile'
        );
        assert.strictEqual(structured.aiResolutionFactPack.components.length, 0);
    });

    await runTest(
        'TEST 10: Existing AI advisor/planner path remains unaffected',
        () => {
            // Fact pack module must not be required by semantic advisor.
            const advisorPath = require.resolve(
                '../aiSemanticAdvisor/aiAdvisor.service'
            );
            const factPackPath = require.resolve(
                './aiResolutionFactPack.service'
            );

            assert.notStrictEqual(advisorPath, factPackPath);

            const explanation = buildDeterministicExplanation({
                metadataType: 'RecordType',
                metadataName: 'PersonAccount.PersonAccount',
                reason: 'Person Account RecordType is unavailable.',
                resolutionType: 'ENABLE_FEATURE'
            });

            assert.strictEqual(
                explanation.resolutionCategory,
                'ENABLE_FEATURE'
            );
            assert.strictEqual(explanation.source, undefined);
        }
    );

    await runTest(
        'sanitizeFactPackForAi drops non-CustomField and secrets',
        () => {
            const sanitized = sanitizeFactPackForAi({
                version: 1,
                refreshToken: 'nope',
                components: [
                    {
                        metadata: {
                            metadataType: 'Profile',
                            metadataName: 'Sales Manager'
                        },
                        cliProblem: 'x'
                    },
                    {
                        metadata: {
                            metadataType: 'CustomField',
                            metadataName: 'Session__c.End_Time__c'
                        },
                        cliProblem:
                            'Cannot update a field from a Formula to something else',
                        source: {
                            exists: true,
                            type: 'Time',
                            calculated: false,
                            confidence: 'HIGH'
                        },
                        destination: {
                            exists: null,
                            type: null,
                            calculated: null,
                            confidence: 'UNKNOWN'
                        },
                        comparison: {
                            conflictType: null,
                            confidence: 'UNKNOWN'
                        }
                    }
                ]
            });

            assert.strictEqual(sanitized.components.length, 1);
            assert.strictEqual(sanitized.refreshToken, undefined);
            assert.strictEqual(
                sanitized.components[0].metadata.metadataName,
                'Session__c.End_Time__c'
            );
        }
    );

    await runTest('serializeSourceCustomFieldShapeIndex works', () => {
        const serialized = serializeSourceCustomFieldShapeIndex(
            buildSourceShapeMap()
        );

        assert.strictEqual(
            serialized.byType.CustomField['Session__c.End_Time__c'].attributes
                .mdapiType,
            'Time'
        );
    });

    if (process.exitCode) {
        console.error('aiResolutionFactPack.phase1.test.js FAILED');
    } else {
        console.log('aiResolutionFactPack.phase1.test.js PASSED');
    }
}

main();
