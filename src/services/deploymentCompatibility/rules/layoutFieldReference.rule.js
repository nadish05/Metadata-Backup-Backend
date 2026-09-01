const {
    createPassFinding,
    createBlockFinding
} = require('../compatibilityModel');
const { ACTIONS } = require('../../dependencyResolution/decisionModel');
const {
    resolveEffectiveDestinationState,
    canScheduleMissingDependency
} = require('./layoutDependencyState.util');

const RULE_ID = 'layout.fieldReference';

function isLayoutFieldReference(reference) {
    return (
        reference?.discoveryMethod === 'layoutReference' &&
        reference?.metadataType === 'CustomField' &&
        reference?.referenceType === 'Field'
    );
}

/**
 * Verify Layout custom field references are satisfied in the deployment graph
 * or destination org before deployment.
 */
const layoutFieldReferenceRule = {
    id: RULE_ID,
    metadataTypes: ['Layout', 'CustomField'],

    applies(context) {
        return (context.discoveredReferences || []).some(isLayoutFieldReference);
    },

    analyze(context) {
        const findings = [];
        const references = (context.discoveredReferences || []).filter(
            isLayoutFieldReference
        );

        for (const reference of references) {
            if (reference.deployable !== true || reference.blocking !== true) {
                continue;
            }

            const decision = context.availability.getDecision(
                'CustomField',
                reference.name
            );
            const destinationState = resolveEffectiveDestinationState(
                decision,
                'CustomField',
                reference.name,
                context
            );

            if (destinationState === 'EXISTS') {
                findings.push(
                    createPassFinding({
                        metadataName: reference.name,
                        metadataType: 'CustomField',
                        ruleId: RULE_ID,
                        reason:
                            'Referenced field exists in the destination org.',
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
                        metadataType: 'CustomField',
                        ruleId: RULE_ID,
                        reason:
                            'Referenced field is missing in destination and scheduled for deployment.',
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
                        metadataType: 'CustomField',
                        ruleId: RULE_ID,
                        reason:
                            decision.reason ||
                            'Referenced field is blocked by dependency resolution.',
                        requiredBy: reference.sourceMetadata
                            ? `Layout:${reference.sourceMetadata}`
                            : null,
                        recommendedAction:
                            'Resolve the blocked CustomField dependency before deployment.'
                    })
                );
                continue;
            }

            if (destinationState === 'MISSING') {
                findings.push(
                    createBlockFinding({
                        metadataName: reference.name,
                        metadataType: 'CustomField',
                        ruleId: RULE_ID,
                        reason:
                            'Referenced field is missing from the destination org and is not scheduled for deployment.',
                        requiredBy: reference.sourceMetadata
                            ? `Layout:${reference.sourceMetadata}`
                            : null,
                        recommendedAction:
                            'Add the CustomField to the deployment selection, ensure it exists in the destination org, or remove it from the Layout.'
                    })
                );
            }
        }

        return findings;
    }
};

module.exports = layoutFieldReferenceRule;
