const {
    createPassFinding,
    createBlockFinding
} = require('../compatibilityModel');
const { ACTIONS } = require('../../dependencyResolution/decisionModel');
const {
    resolveEffectiveDestinationState,
    canScheduleMissingDependency
} = require('./layoutDependencyState.util');

const RULE_ID = 'layout.parentObject';

function isLayoutParentObjectReference(reference) {
    return (
        reference?.discoveryMethod === 'layoutReference' &&
        reference?.metadataType === 'CustomObject' &&
        reference?.referenceType === 'ParentObject'
    );
}

/**
 * Verify Layout parent objects exist in destination or are scheduled to deploy.
 */
const layoutParentObjectRule = {
    id: RULE_ID,
    metadataTypes: ['Layout', 'CustomObject'],

    applies(context) {
        return (context.discoveredReferences || []).some(
            isLayoutParentObjectReference
        );
    },

    analyze(context) {
        const findings = [];
        const references = (context.discoveredReferences || []).filter(
            isLayoutParentObjectReference
        );

        for (const reference of references) {
            if (reference.blocking !== true) {
                continue;
            }

            const decision = context.availability.getDecision(
                'CustomObject',
                reference.name
            );
            const destinationState = resolveEffectiveDestinationState(
                decision,
                'CustomObject',
                reference.name,
                context
            );

            if (destinationState === 'EXISTS') {
                findings.push(
                    createPassFinding({
                        metadataName: reference.name,
                        metadataType: 'CustomObject',
                        ruleId: RULE_ID,
                        reason:
                            'Layout parent object exists in the destination org.',
                        requiredBy: reference.sourceMetadata
                            ? `Layout:${reference.sourceMetadata}`
                            : null
                    })
                );
                continue;
            }

            if (
                destinationState === 'MISSING' &&
                canScheduleMissingDependency(decision)
            ) {
                findings.push(
                    createPassFinding({
                        metadataName: reference.name,
                        metadataType: 'CustomObject',
                        ruleId: RULE_ID,
                        reason:
                            'Layout parent object is missing in destination and scheduled for deployment.',
                        requiredBy: reference.sourceMetadata
                            ? `Layout:${reference.sourceMetadata}`
                            : null
                    })
                );
                continue;
            }

            if (decision?.action === ACTIONS.BLOCK) {
                findings.push(
                    createBlockFinding({
                        metadataName: reference.name,
                        metadataType: 'CustomObject',
                        ruleId: RULE_ID,
                        reason:
                            decision.reason ||
                            'Layout parent object is blocked by dependency resolution.',
                        requiredBy: reference.sourceMetadata
                            ? `Layout:${reference.sourceMetadata}`
                            : null,
                        recommendedAction:
                            'Resolve the blocked parent object before deployment.'
                    })
                );
                continue;
            }

            if (destinationState === 'MISSING') {
                findings.push(
                    createBlockFinding({
                        metadataName: reference.name,
                        metadataType: 'CustomObject',
                        ruleId: RULE_ID,
                        reason:
                            'Layout parent object is missing from the destination org and is not scheduled for deployment.',
                        requiredBy: reference.sourceMetadata
                            ? `Layout:${reference.sourceMetadata}`
                            : null,
                        recommendedAction:
                            'Deploy the parent CustomObject, ensure it exists in the destination org, or remove the Layout from deployment.'
                    })
                );
            }
        }

        return findings;
    }
};

module.exports = layoutParentObjectRule;
