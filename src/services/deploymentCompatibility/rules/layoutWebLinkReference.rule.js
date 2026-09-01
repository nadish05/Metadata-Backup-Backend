const {
    createPassFinding,
    createBlockFinding
} = require('../compatibilityModel');
const { ACTIONS } = require('../../dependencyResolution/decisionModel');
const {
    resolveEffectiveDestinationState,
    canScheduleMissingDependency
} = require('./layoutDependencyState.util');

const RULE_ID = 'layout.webLinkReference';

function isLayoutWebLinkReference(reference) {
    return (
        reference?.discoveryMethod === 'layoutReference' &&
        reference?.metadataType === 'WebLink' &&
        reference?.referenceType === 'CustomButton'
    );
}

/**
 * Verify Layout custom button (WebLink) references are satisfied before deployment.
 */
const layoutWebLinkReferenceRule = {
    id: RULE_ID,
    metadataTypes: ['Layout', 'WebLink'],

    applies(context) {
        return (context.discoveredReferences || []).some(isLayoutWebLinkReference);
    },

    analyze(context) {
        const findings = [];
        const references = (context.discoveredReferences || []).filter(
            isLayoutWebLinkReference
        );

        for (const reference of references) {
            if (reference.deployable !== true || reference.blocking !== true) {
                continue;
            }

            const decision = context.availability.getDecision(
                'WebLink',
                reference.name
            );
            const destinationState = resolveEffectiveDestinationState(
                decision,
                'WebLink',
                reference.name,
                context
            );

            if (destinationState === 'EXISTS') {
                findings.push(
                    createPassFinding({
                        metadataName: reference.name,
                        metadataType: 'WebLink',
                        ruleId: RULE_ID,
                        reason:
                            'Referenced WebLink exists in the destination org.',
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
                        metadataType: 'WebLink',
                        ruleId: RULE_ID,
                        reason:
                            'Referenced WebLink is missing in destination and scheduled for deployment.',
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
                        metadataType: 'WebLink',
                        ruleId: RULE_ID,
                        reason:
                            decision.reason ||
                            'Referenced WebLink is blocked by dependency resolution.',
                        requiredBy: reference.sourceMetadata
                            ? `Layout:${reference.sourceMetadata}`
                            : null,
                        recommendedAction:
                            'Resolve the blocked WebLink dependency before deployment.'
                    })
                );
                continue;
            }

            if (destinationState === 'MISSING') {
                findings.push(
                    createBlockFinding({
                        metadataName: reference.name,
                        metadataType: 'WebLink',
                        ruleId: RULE_ID,
                        reason:
                            'Referenced WebLink is missing from the destination org and is not scheduled for deployment.',
                        requiredBy: reference.sourceMetadata
                            ? `Layout:${reference.sourceMetadata}`
                            : null,
                        recommendedAction:
                            'Add the WebLink to the deployment selection, ensure it exists in the destination org, or remove it from the Layout.'
                    })
                );
            }
        }

        return findings;
    }
};

module.exports = layoutWebLinkReferenceRule;
