const assert = require('assert');

const {
    CLASSIFICATIONS,
    classifyDependency
} = require('./dependencyClassification.service');
const {
    createDefaultDecision,
    resolveDependencies,
    mergeDeployableReferences,
    ACTIONS
} = require('./dependencyResolution.service');
const artifactExistsRule = require('../deploymentCompatibility/rules/artifactExists.rule');

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
    await runTest('CustomObject classifies as DEPLOYABLE_METADATA', () => {
        const result = classifyDependency({
            type: 'CustomObject',
            name: 'Experience__c'
        });

        assert.strictEqual(
            result.classification,
            CLASSIFICATIONS.DEPLOYABLE_METADATA
        );
        assert.strictEqual(result.artifactRequired, true);
        assert.strictEqual(result.packageable, true);
        assert.strictEqual(result.defaultResolutionPolicy, ACTIONS.DEPLOY);
    });

    await runTest('Flow / CustomField / LWC remain deployable', () => {
        for (const type of [
            'Flow',
            'CustomField',
            'LightningComponentBundle',
            'FlexiPage',
            'AuraDefinitionBundle',
            'Layout',
            'PermissionSet',
            'ValidationRule',
            'Profile',
            'ApexClass'
        ]) {
            const result = classifyDependency({ type, name: 'Sample' });
            assert.strictEqual(
                result.classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA,
                type
            );
            assert.strictEqual(result.artifactRequired, true, type);
        }
    });

    await runTest(
        'RelationshipReference classifies as RUNTIME_REFERENCE (type-driven)',
        () => {
            const result = classifyDependency({
                type: 'RelationshipReference',
                name: 'Experience__r'
            });

            assert.strictEqual(
                result.classification,
                CLASSIFICATIONS.RUNTIME_REFERENCE
            );
            assert.strictEqual(result.artifactRequired, false);
            assert.strictEqual(result.packageable, false);
            assert.strictEqual(result.defaultResolutionPolicy, ACTIONS.SKIP);
        }
    );

    await runTest(
        'System Apex from SYSTEM_CLASSES registry → PLATFORM_REFERENCE',
        () => {
            const result = classifyDependency({
                type: 'ApexClass',
                name: 'URL'
            });

            assert.strictEqual(
                result.classification,
                CLASSIFICATIONS.PLATFORM_REFERENCE
            );
            assert.strictEqual(result.artifactRequired, false);
            assert.strictEqual(result.defaultResolutionPolicy, ACTIONS.SKIP);
        }
    );

    await runTest('User ApexClass remains DEPLOYABLE', () => {
        const result = classifyDependency({
            type: 'ApexClass',
            name: 'InvoiceService'
        });

        assert.strictEqual(
            result.classification,
            CLASSIFICATIONS.DEPLOYABLE_METADATA
        );
        assert.strictEqual(result.artifactRequired, true);
    });

    await runTest('Unknown metadata type does not auto-DEPLOY', () => {
        const decision = createDefaultDecision({
            type: 'SomeFutureType',
            name: 'Thing',
            required: true,
            selected: true
        });

        assert.strictEqual(decision.action, ACTIONS.SKIP);
        assert.strictEqual(decision.source, 'CLASSIFICATION');
    });

    await runTest(
        'createDefaultDecision: RelationshipReference → SKIP not DEPLOY',
        () => {
            const decision = createDefaultDecision({
                type: 'RelationshipReference',
                name: 'Experience__r',
                required: true,
                selected: true
            });

            assert.strictEqual(decision.action, ACTIONS.SKIP);
        }
    );

    await runTest(
        'createDefaultDecision: CustomField required → DEPLOY (compat)',
        () => {
            const decision = createDefaultDecision({
                type: 'CustomField',
                name: 'Session__c.Experience__c',
                required: true,
                selected: true
            });

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
        }
    );

    await runTest(
        'artifact.exists ignores RUNTIME_REFERENCE even if action were DEPLOY',
        () => {
            const findings = artifactExistsRule.analyze({
                selectedMetadata: [],
                resolvedDependencies: [
                    {
                        type: 'RelationshipReference',
                        metadataType: 'RelationshipReference',
                        name: 'Experience__r',
                        action: ACTIONS.DEPLOY,
                        selected: true,
                        artifactResolved: false,
                        sourceExists: false,
                        artifactRequired: false,
                        classification: CLASSIFICATIONS.RUNTIME_REFERENCE
                    }
                ],
                discoveredReferences: []
            });

            assert.strictEqual(findings.length, 0);
        }
    );

    await runTest(
        'artifact.exists still fails for missing deployable CustomObject',
        () => {
            const findings = artifactExistsRule.analyze({
                selectedMetadata: [],
                resolvedDependencies: [
                    {
                        type: 'CustomObject',
                        metadataType: 'CustomObject',
                        name: 'Experience__c',
                        action: ACTIONS.DEPLOY,
                        selected: true,
                        artifactResolved: false,
                        sourceExists: false,
                        artifactRequired: true,
                        classification: CLASSIFICATIONS.DEPLOYABLE_METADATA
                    }
                ],
                discoveredReferences: []
            });

            assert.strictEqual(findings.length, 1);
            assert.strictEqual(findings[0].status, 'FAIL');
            assert.strictEqual(findings[0].blocking, true);
        }
    );

    await runTest(
        'artifact.exists ignores platform Apex via SYSTEM_CLASSES registry',
        () => {
            const findings = artifactExistsRule.analyze({
                selectedMetadata: [],
                resolvedDependencies: [
                    {
                        type: 'ApexClass',
                        metadataType: 'ApexClass',
                        name: 'URL',
                        action: ACTIONS.DEPLOY,
                        selected: true,
                        artifactResolved: false,
                        sourceExists: false
                    }
                ],
                discoveredReferences: []
            });

            assert.strictEqual(findings.length, 0);
        }
    );

    await runTest(
        'resolveDependencies attaches classification and skips runtime refs',
        async () => {
            const result = await resolveDependencies({
                requiredDependencies: [
                    {
                        type: 'CustomField',
                        name: 'Session__c.Experience__c',
                        required: true,
                        selected: true
                    },
                    {
                        type: 'RelationshipReference',
                        name: 'Experience__r',
                        required: true,
                        selected: true
                    },
                    {
                        type: 'ApexClass',
                        name: 'URL',
                        required: true,
                        selected: true
                    }
                ],
                selectedMetadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Get_Sessions'
                    }
                ]
            });

            const byName = Object.fromEntries(
                result.resolvedDependencies.map((item) => [item.name, item])
            );

            assert.strictEqual(byName['Session__c.Experience__c'].action, 'DEPLOY');
            assert.strictEqual(
                byName['Session__c.Experience__c'].classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA
            );
            assert.strictEqual(byName.Experience__r.action, 'SKIP');
            assert.strictEqual(byName.Experience__r.artifactRequired, false);
            assert.strictEqual(byName.URL.action, 'SKIP');
            assert.strictEqual(byName.URL.artifactRequired, false);
        }
    );

    await runTest(
        'mergeDeployableReferences excludes non-packageable classifications',
        () => {
            const merged = mergeDeployableReferences(
                [],
                [
                    {
                        name: 'Experience__r',
                        metadataType: 'RelationshipReference',
                        deployable: true,
                        blocking: true
                    },
                    {
                        name: 'InvoiceCard',
                        metadataType: 'LightningComponentBundle',
                        deployable: true,
                        blocking: true
                    }
                ]
            );

            assert.strictEqual(merged.length, 1);
            assert.strictEqual(merged[0].name, 'InvoiceCard');
            assert.strictEqual(merged[0].packageable, true);
        }
    );

    await runTest(
        'deployable:false discovery signal → PLATFORM_REFERENCE',
        () => {
            const result = classifyDependency({
                type: 'CustomTab',
                name: 'standard-Account',
                deployable: false
            });

            assert.strictEqual(
                result.classification,
                CLASSIFICATIONS.PLATFORM_REFERENCE
            );
            assert.strictEqual(result.artifactRequired, false);
        }
    );
}

main();
