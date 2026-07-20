const {
    createPassFinding,
    createBlockFinding
} = require('../compatibilityModel');

const RULE_ID = 'flexiPage.fieldReference';

/**
 * Verify FlexiPage field references exist in the deployment graph
 * (selected or scheduled for deployment).
 */
const flexiPageFieldReferenceRule = {
    id: RULE_ID,
    metadataTypes: ['FlexiPage', 'CustomField'],

    applies(context) {
        return (context.discoveredReferences || []).some(
            (reference) =>
                reference.referenceType === 'Field' ||
                reference.metadataType === 'CustomField'
        );
    },

    analyze(context) {
        const findings = [];
        const references = (context.discoveredReferences || []).filter(
            (reference) =>
                reference.referenceType === 'Field' ||
                reference.metadataType === 'CustomField'
        );

        for (const reference of references) {
            // Trust Reference Discovery classification. Non-deployable /
            // non-blocking field refs (e.g. Salesforce system fields) must
            // never become compatibility blockers or recommendations.
            if (reference.deployable !== true || reference.blocking !== true) {
                continue;
            }

            const available = context.availability.isAvailable(
                'CustomField',
                reference.name
            );

            if (available) {
                findings.push(
                    createPassFinding({
                        metadataName: reference.name,
                        metadataType: 'CustomField',
                        ruleId: RULE_ID,
                        reason:
                            'Referenced field exists in the deployment graph.',
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
                    metadataType: 'CustomField',
                    ruleId: RULE_ID,
                    reason: 'Referenced field missing from the deployment graph.',
                    requiredBy: reference.sourceMetadata
                        ? `FlexiPage:${reference.sourceMetadata}`
                        : null,
                    recommendedAction:
                        'Add the CustomField to the deployment selection or remove it from the FlexiPage.'
                })
            );
        }

        return findings;
    }
};

module.exports = flexiPageFieldReferenceRule;
