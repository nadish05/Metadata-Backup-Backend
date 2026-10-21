const assert = require('assert');

const { buildAvailabilityIndex } = require('./availabilityIndex');
const { ACTIONS, DESTINATION_STATES } = require('../dependencyResolution/decisionModel');
const flexiPageRelatedListRelationshipRule = require('./rules/flexiPageRelatedListRelationship.rule');
const {
    parentHasRelatedListRelationship
} = require('./flexiPageParentObjectRelationshipIndex.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

function buildDynamicRelatedListReference({
    parentObject,
    relatedListApiName,
    flexiPageName = 'Member_Record_Page',
    relationshipDefiningFieldQualifiedName = null
}) {
    return {
        metadataType: 'RelatedList',
        name: relatedListApiName,
        sourceMetadata: flexiPageName,
        discoveryMethod: 'flexiPageReference',
        referenceType: 'FlexiPageDynamicRelatedList',
        sobjectType: parentObject,
        relationshipDefiningFieldQualifiedName
    };
}

function analyzeWithContext({
    references,
    resolvedDependencies = [],
    parentObjectRelationshipIndex,
    destinationStates = new Map()
}) {
    const availability = buildAvailabilityIndex({
        selectedMetadata: [
            {
                metadataType: 'FlexiPage',
                metadataName: 'Member_Record_Page'
            }
        ],
        resolvedDependencies
    });

    return flexiPageRelatedListRelationshipRule.analyze({
        discoveredReferences: references,
        resolvedDependencies,
        availability,
        destinationStates,
        parentObjectRelationshipIndex
    });
}

async function main() {
    await runTest('parentHasRelatedListRelationship matches custom __r API name', () => {
        assert.strictEqual(
            parentHasRelatedListRelationship(
                [{ relationshipName: 'Subscriptions' }],
                'Subscriptions__r'
            ),
            true
        );
        assert.strictEqual(
            parentHasRelatedListRelationship(
                [{ relationshipName: 'Sessions' }],
                'Sessions__r'
            ),
            true
        );
        assert.strictEqual(
            parentHasRelatedListRelationship(
                [{ relationshipName: 'Sessions' }],
                'Subscriptions__r'
            ),
            false
        );
    });

    await runTest('relationship exists in destination describe -> PASS', () => {
        const findings = analyzeWithContext({
            references: [
                buildDynamicRelatedListReference({
                    parentObject: 'Member__c',
                    relatedListApiName: 'Sessions__r'
                })
            ],
            parentObjectRelationshipIndex: new Map([
                [
                    'Member__c',
                    {
                        queried: true,
                        ok: true,
                        warning: null,
                        childRelationships: [{ relationshipName: 'Sessions' }]
                    }
                ]
            ])
        });

        assert.ok(
            findings.some(
                (finding) =>
                    finding.ruleId === 'flexiPage.relatedListRelationship' &&
                    finding.status === 'PASS' &&
                    finding.metadataName === 'Member__c.Sessions__r'
            )
        );
    });

    await runTest('relationship missing and not deployable -> BLOCK', () => {
        const findings = analyzeWithContext({
            references: [
                buildDynamicRelatedListReference({
                    parentObject: 'Member__c',
                    relatedListApiName: 'Subscriptions__r'
                })
            ],
            parentObjectRelationshipIndex: new Map([
                [
                    'Member__c',
                    {
                        queried: true,
                        ok: true,
                        warning: null,
                        childRelationships: [{ relationshipName: 'Sessions' }]
                    }
                ]
            ])
        });

        const blocker = findings.find(
            (finding) =>
                finding.ruleId === 'flexiPage.relatedListRelationship' &&
                finding.status === 'BLOCK'
        );

        assert.ok(blocker);
        assert.strictEqual(blocker.metadataName, 'Member__c.Subscriptions__r');
        assert.strictEqual(blocker.blocking, true);
    });

    await runTest('relationship scheduled via defining CustomField -> PASS', () => {
        const findings = analyzeWithContext({
            references: [
                buildDynamicRelatedListReference({
                    parentObject: 'Member__c',
                    relatedListApiName: 'Subscriptions__r',
                    relationshipDefiningFieldQualifiedName:
                        'Subscription__c.Member__c'
                })
            ],
            resolvedDependencies: [
                {
                    metadataType: 'CustomField',
                    metadataName: 'Subscription__c.Member__c',
                    name: 'Subscription__c.Member__c',
                    type: 'CustomField',
                    action: ACTIONS.DEPLOY,
                    selected: true,
                    artifactResolved: true,
                    sourceExists: true,
                    destinationState: DESTINATION_STATES.MISSING
                }
            ],
            parentObjectRelationshipIndex: new Map([
                [
                    'Member__c',
                    {
                        queried: true,
                        ok: true,
                        warning: null,
                        childRelationships: []
                    }
                ]
            ])
        });

        assert.ok(
            findings.some(
                (finding) =>
                    finding.ruleId === 'flexiPage.relatedListRelationship' &&
                    finding.status === 'PASS' &&
                    finding.metadataName === 'Member__c.Subscriptions__r'
            )
        );
    });

    await runTest('destination schema not queried -> WARNING', () => {
        const findings = analyzeWithContext({
            references: [
                buildDynamicRelatedListReference({
                    parentObject: 'Member__c',
                    relatedListApiName: 'Subscriptions__r'
                })
            ],
            parentObjectRelationshipIndex: new Map([
                [
                    'Member__c',
                    {
                        queried: false,
                        ok: false,
                        warning: 'Missing destination credentials',
                        childRelationships: []
                    }
                ]
            ])
        });

        const warning = findings.find(
            (finding) =>
                finding.ruleId === 'flexiPage.relatedListRelationship' &&
                finding.status === 'WARNING'
        );

        assert.ok(warning);
        assert.strictEqual(warning.blocking, false);
    });

    await runTest('describe API fails -> WARNING not PASS', () => {
        const findings = analyzeWithContext({
            references: [
                buildDynamicRelatedListReference({
                    parentObject: 'Member__c',
                    relatedListApiName: 'Subscriptions__r'
                })
            ],
            parentObjectRelationshipIndex: new Map([
                [
                    'Member__c',
                    {
                        queried: true,
                        ok: false,
                        warning: 'INSUFFICIENT_ACCESS',
                        childRelationships: []
                    }
                ]
            ])
        });

        const warning = findings.find(
            (finding) =>
                finding.ruleId === 'flexiPage.relatedListRelationship' &&
                finding.status === 'WARNING'
        );

        assert.ok(warning);
        assert.ok(
            !findings.some(
                (finding) =>
                    finding.ruleId === 'flexiPage.relatedListRelationship' &&
                    finding.status === 'PASS'
            )
        );
    });

    await runTest('two related lists on one page -> independent findings', () => {
        const findings = analyzeWithContext({
            references: [
                buildDynamicRelatedListReference({
                    parentObject: 'Member__c',
                    relatedListApiName: 'Sessions__r'
                }),
                buildDynamicRelatedListReference({
                    parentObject: 'Member__c',
                    relatedListApiName: 'Subscriptions__r'
                })
            ],
            parentObjectRelationshipIndex: new Map([
                [
                    'Member__c',
                    {
                        queried: true,
                        ok: true,
                        warning: null,
                        childRelationships: [{ relationshipName: 'Sessions' }]
                    }
                ]
            ])
        });

        assert.ok(
            findings.some(
                (finding) =>
                    finding.metadataName === 'Member__c.Sessions__r' &&
                    finding.status === 'PASS'
            )
        );
        assert.ok(
            findings.some(
                (finding) =>
                    finding.metadataName === 'Member__c.Subscriptions__r' &&
                    finding.status === 'BLOCK'
            )
        );
    });

    await runTest('rule analyze does not throw on malformed reference', () => {
        const findings = flexiPageRelatedListRelationshipRule.analyze({
            discoveredReferences: [
                {
                    discoveryMethod: 'flexiPageReference',
                    referenceType: 'FlexiPageDynamicRelatedList',
                    metadataType: 'RelatedList',
                    name: '',
                    sobjectType: null
                }
            ],
            availability: buildAvailabilityIndex({}),
            parentObjectRelationshipIndex: new Map()
        });

        assert.ok(findings.length >= 1);
        assert.strictEqual(findings[0].status, 'WARNING');
    });

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

main();
