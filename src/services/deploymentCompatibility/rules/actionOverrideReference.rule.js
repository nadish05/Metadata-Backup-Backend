const {
    createPassFinding,
    createBlockFinding
} = require('../compatibilityModel');

const RULE_ID = 'customObject.actionOverrideReference';

/**
 * Verify Action Override FlexiPage targets exist in the deployment graph.
 */
const actionOverrideReferenceRule = {
    id: RULE_ID,
    metadataTypes: ['CustomObject', 'FlexiPage'],

    applies(context) {
        return (context.discoveredRelationships || []).some(
            (relationship) =>
                relationship.relationship === 'ActionOverride' &&
                (relationship.metadataType === 'FlexiPage' ||
                    relationship.type === 'FlexiPage')
        );
    },

    analyze(context) {
        const findings = [];
        const relationships = (context.discoveredRelationships || []).filter(
            (relationship) =>
                relationship.relationship === 'ActionOverride' &&
                (relationship.metadataType === 'FlexiPage' ||
                    relationship.type === 'FlexiPage')
        );

        for (const relationship of relationships) {
            const available = context.availability.isAvailable(
                'FlexiPage',
                relationship.name
            );

            if (available) {
                findings.push(
                    createPassFinding({
                        metadataName: relationship.name,
                        metadataType: 'FlexiPage',
                        ruleId: RULE_ID,
                        reason:
                            'Action Override FlexiPage exists in the deployment graph.',
                        requiredBy: relationship.sourceMetadata
                            ? `CustomObject:${relationship.sourceMetadata}`
                            : null
                    })
                );
                continue;
            }

            findings.push(
                createBlockFinding({
                    metadataName: relationship.name,
                    metadataType: 'FlexiPage',
                    ruleId: RULE_ID,
                    reason:
                        'Action Override FlexiPage is missing from the deployment graph.',
                    requiredBy: relationship.sourceMetadata
                        ? `CustomObject:${relationship.sourceMetadata}`
                        : null,
                    recommendedAction:
                        'Add the FlexiPage to the deployment selection or remove the Action Override.'
                })
            );
        }

        return findings;
    }
};

module.exports = actionOverrideReferenceRule;
