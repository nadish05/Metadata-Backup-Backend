const {
    createPassFinding,
    createBlockFinding
} = require('../compatibilityModel');

const RULE_ID = 'flexiPage.lightningComponentReference';

/**
 * Verify Lightning component references exist in the deployment graph.
 */
const lightningComponentReferenceRule = {
    id: RULE_ID,
    metadataTypes: ['FlexiPage', 'LightningComponentBundle'],

    applies(context) {
        return (context.discoveredReferences || []).some(
            (reference) =>
                reference.referenceType === 'LightningComponent' ||
                reference.metadataType === 'LightningComponentBundle'
        );
    },

    analyze(context) {
        const findings = [];
        const references = (context.discoveredReferences || []).filter(
            (reference) =>
                reference.referenceType === 'LightningComponent' ||
                reference.metadataType === 'LightningComponentBundle'
        );

        for (const reference of references) {
            const available = context.availability.isAvailable(
                'LightningComponentBundle',
                reference.name
            );

            if (available) {
                findings.push(
                    createPassFinding({
                        metadataName: reference.name,
                        metadataType: 'LightningComponentBundle',
                        ruleId: RULE_ID,
                        reason:
                            'Referenced Lightning component exists in the deployment graph.',
                        requiredBy: reference.sourceMetadata
                            ? `FlexiPage:${reference.sourceMetadata}`
                            : null
                    })
                );
                continue;
            }

            findings.push(
                createBlockFinding({
                    metadataName: reference.name,
                    metadataType: 'LightningComponentBundle',
                    ruleId: RULE_ID,
                    reason:
                        'Referenced Lightning component is missing from the deployment graph.',
                    requiredBy: reference.sourceMetadata
                        ? `FlexiPage:${reference.sourceMetadata}`
                        : null,
                    recommendedAction:
                        'Add the LightningComponentBundle to the deployment selection or remove it from the FlexiPage.'
                })
            );
        }

        return findings;
    }
};

module.exports = lightningComponentReferenceRule;
