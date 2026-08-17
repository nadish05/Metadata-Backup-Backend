/**
 * Phase 2A — backend-owned AI Resolution enrichment.
 * Does not add Flow/Profile/CompactLayout classifiers or package evidence.
 */

'use strict';

const assert = require('assert');

const {
    buildAiResolutionFactPack
} = require('./aiResolutionFactPack.service');
const {
    collectKnownItems,
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

    return shapes;
}

function buildDestinationShapeIndex() {
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
        unsupported: false
    });

    return { shapes, summary: { requested: 1, resolved: 1 } };
}

function conversionFactPack() {
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
        sourceShapeIndex: buildSourceShapeMap(),
        destinationShapeIndex: buildDestinationShapeIndex()
    });
}

function conversionContext(extra = {}) {
    return {
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
        aiResolutionFactPack: conversionFactPack(),
        ...extra
    };
}

function inventedAiPayload(overrides = {}) {
    return JSON.stringify({
        summary: 'invented',
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

async function main() {
    await runTest(
        'TEST 1: FIELD_TYPE_CONVERSION fact pack → fixOwner MANUAL_METADATA',
        async () => {
            const report = await generateWithText(
                conversionContext(),
                inventedAiPayload()
            );

            assert.strictEqual(
                report.explanations[0].fixOwner,
                FIX_OWNERS.MANUAL_METADATA
            );
        }
    );

    await runTest(
        'TEST 2: FIELD_TYPE_CONVERSION backendResolution uses source/destination facts',
        async () => {
            const report = await generateWithText(
                conversionContext(),
                inventedAiPayload()
            );
            const explanation = report.explanations[0];

            assert.strictEqual(explanation.source.type, 'Time');
            assert.strictEqual(explanation.source.calculated, false);
            assert.strictEqual(explanation.destination.type, 'datetime');
            assert.strictEqual(explanation.destination.calculated, true);
            assert.match(explanation.backendResolution, /Time/);
            assert.match(explanation.backendResolution, /calculated=false/);
            assert.match(explanation.backendResolution, /datetime/);
            assert.match(explanation.backendResolution, /calculated=true/);
            assert.match(
                explanation.backendResolution,
                /does not allow this in-place conversion/i
            );
            assert.deepStrictEqual(explanation.resolution.steps.length > 0, true);
        }
    );

    await runTest(
        'TEST 3: AI fixOwner is stripped; backend value remains',
        async () => {
            const report = await generateWithText(
                conversionContext(),
                inventedAiPayload({ fixOwner: 'RUNTIME_AUTOFIX' })
            );

            assert.strictEqual(
                report.explanations[0].fixOwner,
                FIX_OWNERS.MANUAL_METADATA
            );
            assert.notStrictEqual(
                report.explanations[0].fixOwner,
                'RUNTIME_AUTOFIX'
            );
        }
    );

    await runTest(
        'TEST 4: AI backendResolution is stripped',
        async () => {
            const report = await generateWithText(
                conversionContext(),
                inventedAiPayload({
                    backendResolution: 'Invented backend already fixed this.'
                })
            );

            assert.notStrictEqual(
                report.explanations[0].backendResolution,
                'Invented backend already fixed this.'
            );
            assert.match(
                report.explanations[0].backendResolution,
                /Salesforce does not allow this in-place conversion/
            );
        }
    );

    await runTest(
        'TEST 5: AI backendCanAutoFix=true does not override backend',
        async () => {
            const report = await generateWithText(
                conversionContext(),
                inventedAiPayload({ backendCanAutoFix: true })
            );

            assert.strictEqual(report.explanations[0].backendCanAutoFix, false);
        }
    );

    await runTest(
        'TEST 6: AI safeToSkip=true does not override backend',
        async () => {
            const report = await generateWithText(
                conversionContext(),
                inventedAiPayload({ safeToSkip: true })
            );

            assert.strictEqual(report.explanations[0].safeToSkip, null);
        }
    );

    await runTest(
        'TEST 7: Check_Amount invalid $Record reference → fixOwner UNKNOWN',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'Flow',
                                metadataName: 'Check_Amount',
                                category: 'MANUAL_ACTION',
                                reason: 'field integrity exception: unknown',
                                evidence: {
                                    problem:
                                        'The element has an invalid reference to "$Record.Approved__c".'
                                }
                            }
                        ]
                    },
                    resolutionReport: { resolutions: [] },
                    autoFixReport: { fixes: [] }
                },
                JSON.stringify({
                    summary: 'flow',
                    explanations: [
                        {
                            metadataType: 'Flow',
                            metadataName: 'Check_Amount',
                            title: 'Flow failed',
                            why: 'backend Flow discovery should auto-fix this',
                            impact: 'blocked',
                            recommendedAction: 'Let the backend add the field',
                            bestPractice: 'none',
                            confidence: 'HIGH',
                            fixOwner: 'RUNTIME_AUTOFIX'
                        }
                    ]
                })
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.UNKNOWN);
            assert.strictEqual(explanation.backendResolution, null);
            assert.strictEqual(explanation.backendCanAutoFix, false);
        }
    );

    await runTest(
        'TEST 8: Active_Customer missing Customer_Status__c → fixOwner UNKNOWN',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'Flow',
                                metadataName: 'Active_Customer',
                                category: 'MANUAL_ACTION',
                                evidence: {
                                    problem:
                                        'The field "Customer_Status__c" for the object "Opportunity" doesn\'t exist.'
                                }
                            }
                        ]
                    },
                    resolutionReport: { resolutions: [] },
                    autoFixReport: { fixes: [] }
                },
                JSON.stringify({
                    summary: 'flow',
                    explanations: [
                        {
                            metadataType: 'Flow',
                            metadataName: 'Active_Customer',
                            title: 'Missing field',
                            why: 'destination org is missing the field',
                            impact: 'blocked',
                            recommendedAction: 'create in destination',
                            bestPractice: 'none',
                            confidence: 'HIGH',
                            fixOwner: 'DESTINATION_FEATURE'
                        }
                    ]
                })
            );

            assert.strictEqual(
                report.explanations[0].fixOwner,
                FIX_OWNERS.UNKNOWN
            );
            assert.strictEqual(report.explanations[0].backendResolution, null);
        }
    );

    await runTest(
        'TEST 9: CreateWorkBadgeDefinition → UNKNOWN and permission is not stripped',
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
                            fixOwner: 'RUNTIME_AUTOFIX'
                        }
                    ]
                })
            );

            const explanation = report.explanations[0];

            assert.strictEqual(explanation.fixOwner, FIX_OWNERS.UNKNOWN);
            assert.strictEqual(explanation.backendResolution, null);
            assert.strictEqual(explanation.backendCanAutoFix, false);
            assert.strictEqual(explanation.source, undefined);
        }
    );

    await runTest(
        'TEST 10: CompactLayout failure → fixOwner UNKNOWN',
        async () => {
            const report = await generateWithText(
                {
                    failureClassification: {
                        failures: [
                            {
                                metadataType: 'RecordType',
                                metadataName: 'Opportunity.New_Business',
                                category: 'MANUAL_ACTION',
                                evidence: {
                                    problem:
                                        'invalid compact layout assigned: Opportunity_Highlights'
                                }
                            }
                        ]
                    },
                    resolutionReport: { resolutions: [] },
                    autoFixReport: { fixes: [] }
                },
                JSON.stringify({
                    summary: 'rt',
                    explanations: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Opportunity.New_Business',
                            title: 'Compact layout',
                            why: 'destination compatibility',
                            impact: 'blocked',
                            recommendedAction: 'fix destination',
                            bestPractice: 'none',
                            confidence: 'HIGH',
                            fixOwner: 'DESTINATION_FEATURE'
                        }
                    ]
                })
            );

            assert.strictEqual(
                report.explanations[0].fixOwner,
                FIX_OWNERS.UNKNOWN
            );
            assert.strictEqual(report.explanations[0].backendResolution, null);
        }
    );

    await runTest(
        'TEST 11: Failure + resolution same key merges resolutionType without duplicating',
        () => {
            const items = collectKnownItems({
                failureClassification: {
                    failures: [
                        {
                            metadataType: 'Flow',
                            metadataName: 'Check_Amount',
                            category: 'MANUAL_ACTION',
                            reason: 'field integrity exception: unknown',
                            evidence: {
                                problem:
                                    'The element has an invalid reference to "$Record.Approved__c".'
                            }
                        }
                    ]
                },
                resolutionReport: {
                    resolutions: [
                        {
                            metadataType: 'Flow',
                            metadataName: 'Check_Amount',
                            resolutionType: 'MANUAL_CONFIGURATION',
                            recommendation: 'Review the failure manually.'
                        }
                    ]
                },
                autoFixReport: { fixes: [] }
            });

            assert.strictEqual(items.length, 1);
            assert.strictEqual(items[0].resolutionType, 'MANUAL_CONFIGURATION');
            assert.strictEqual(
                items[0].cliProblem,
                'The element has an invalid reference to "$Record.Approved__c".'
            );
            assert.strictEqual(
                items[0].reason,
                'field integrity exception: unknown'
            );
        }
    );

    await runTest(
        'TEST 12: Phase 1 CustomField facts remain unchanged',
        async () => {
            const report = await generateWithText(
                conversionContext(),
                inventedAiPayload({
                    source: { type: 'INVENTED', calculated: true },
                    destination: { type: 'INVENTED', calculated: false },
                    conflict: { type: 'INVENTED' },
                    resolution: { action: 'SKIP', steps: [] }
                })
            );
            const explanation = report.explanations[0];

            assert.strictEqual(explanation.source.type, 'Time');
            assert.strictEqual(explanation.source.calculated, false);
            assert.strictEqual(explanation.destination.type, 'datetime');
            assert.strictEqual(explanation.destination.calculated, true);
            assert.strictEqual(explanation.conflict.type, 'FIELD_TYPE_CONVERSION');
            assert.strictEqual(explanation.resolution.action, 'BOTH');
            assert.ok(Array.isArray(explanation.resolution.steps));
            assert.ok(explanation.resolution.steps.length > 0);
            assert.notStrictEqual(explanation.resolution.action, 'SKIP');
        }
    );
}

main().then(() => {
    if (process.exitCode) {
        console.error('aiResolution.phase2a.test.js FAILED');
    } else {
        console.log('aiResolution.phase2a.test.js PASSED');
    }
});
