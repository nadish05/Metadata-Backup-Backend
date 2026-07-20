const {
    createPassFinding,
    createBlockFinding
} = require('../compatibilityModel');
const { ACTIONS } = require('../../dependencyResolution/decisionModel');

const RULE_ID = 'customObject.masterDetailTarget';

/**
 * Verify Master-Detail parent objects exist in destination or are scheduled to deploy.
 */
const masterDetailTargetRule = {
    id: RULE_ID,
    metadataTypes: ['CustomObject'],

    applies(context) {
        return (context.discoveredRelationships || []).some(
            (relationship) =>
                relationship.relationship === 'MasterDetail' &&
                (relationship.metadataType === 'CustomObject' ||
                    relationship.type === 'CustomObject')
        );
    },

    analyze(context) {
        const findings = [];
        const relationships = (context.discoveredRelationships || []).filter(
            (relationship) =>
                relationship.relationship === 'MasterDetail' &&
                (relationship.metadataType === 'CustomObject' ||
                    relationship.type === 'CustomObject')
        );

        for (const relationship of relationships) {
            const decision = context.availability.getDecision(
                'CustomObject',
                relationship.name
            );
            const available = context.availability.isAvailable(
                'CustomObject',
                relationship.name
            );

            if (available) {
                findings.push(
                    createPassFinding({
                        metadataName: relationship.name,
                        metadataType: 'CustomObject',
                        ruleId: RULE_ID,
                        reason:
                            'Master-Detail parent exists in destination or is scheduled for deployment.',
                        requiredBy: relationship.sourceMetadata
                            ? `CustomObject:${relationship.sourceMetadata}`
                            : null
                    })
                );
                continue;
            }

            if (decision?.action === ACTIONS.BLOCK) {
                findings.push(
                    createBlockFinding({
                        metadataName: relationship.name,
                        metadataType: 'CustomObject',
                        ruleId: RULE_ID,
                        reason:
                            decision.reason ||
                            'Master-Detail parent is blocked by dependency resolution.',
                        requiredBy: relationship.sourceMetadata
                            ? `CustomObject:${relationship.sourceMetadata}`
                            : null,
                        recommendedAction:
                            'Deploy or create the Master-Detail parent CustomObject before deployment.'
                    })
                );
                continue;
            }

            findings.push(
                createBlockFinding({
                    metadataName: relationship.name,
                    metadataType: 'CustomObject',
                    ruleId: RULE_ID,
                    reason:
                        'Master-Detail parent does not exist in destination and is not scheduled for deployment.',
                    requiredBy: relationship.sourceMetadata
                        ? `CustomObject:${relationship.sourceMetadata}`
                        : null,
                    recommendedAction:
                        'Deploy the Master-Detail parent CustomObject or ensure it exists in the destination org.'
                })
            );
        }

        return findings;
    }
};

module.exports = masterDetailTargetRule;
