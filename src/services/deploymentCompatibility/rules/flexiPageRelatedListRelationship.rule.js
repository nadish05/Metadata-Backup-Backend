const {
    createPassFinding,
    createBlockFinding,
    createFinding,
    SEVERITY,
    STATUS
} = require('../compatibilityModel');
const { ACTIONS } = require('../../dependencyResolution/decisionModel');
const {
    resolveEffectiveDestinationState,
    canScheduleMissingDependency
} = require('./layoutDependencyState.util');
const {
    parentHasRelatedListRelationship
} = require('../flexiPageParentObjectRelationshipIndex.service');

const RULE_ID = 'flexiPage.relatedListRelationship';
const FINDING_METADATA_TYPE = 'FlexiPageRelatedList';

function isFlexiPageDynamicRelatedListReference(reference) {
    return (
        reference?.discoveryMethod === 'flexiPageReference' &&
        reference?.referenceType === 'FlexiPageDynamicRelatedList' &&
        reference?.metadataType === 'RelatedList'
    );
}

function buildFindingMetadataName(parentObject, relatedListApiName) {
    return `${parentObject}.${relatedListApiName}`;
}

function createWarningFinding({
    metadataName,
    ruleId,
    reason,
    requiredBy = null,
    recommendedAction = null
}) {
    return createFinding({
        id: `${ruleId}:${FINDING_METADATA_TYPE}:${metadataName}:WARNING`,
        metadataName,
        metadataType: FINDING_METADATA_TYPE,
        ruleId,
        severity: SEVERITY.WARNING,
        status: STATUS.WARNING,
        reason,
        requiredBy,
        recommendedAction:
            recommendedAction ||
            'Verify the destination org manually before deployment.',
        blocking: false
    });
}

function relationshipScheduledViaDefiningField(context, qualifiedFieldName) {
    if (!qualifiedFieldName) {
        return false;
    }

    const decision = context.availability.getDecision(
        'CustomField',
        qualifiedFieldName
    );
    const destinationState = resolveEffectiveDestinationState(
        decision,
        'CustomField',
        qualifiedFieldName,
        context
    );

    if (destinationState === 'EXISTS') {
        return true;
    }

    return canScheduleMissingDependency(decision);
}

const flexiPageRelatedListRelationshipRule = {
    id: RULE_ID,
    metadataTypes: ['FlexiPage', 'RelatedList'],

    applies(context) {
        return (context.discoveredReferences || []).some(
            isFlexiPageDynamicRelatedListReference
        );
    },

    analyze(context) {
        const findings = [];
        const references = (context.discoveredReferences || []).filter(
            isFlexiPageDynamicRelatedListReference
        );
        const index =
            context.parentObjectRelationshipIndex instanceof Map
                ? context.parentObjectRelationshipIndex
                : new Map();

        for (const reference of references) {
            const parentObject = String(reference?.sobjectType || '').trim();
            const relatedListApiName = String(reference?.name || '').trim();
            const flexiPageName = reference?.sourceMetadata || null;
            const findingName = buildFindingMetadataName(
                parentObject || 'UnknownParent',
                relatedListApiName || 'UnknownRelatedList'
            );
            const requiredBy = flexiPageName
                ? `FlexiPage:${flexiPageName}`
                : null;

            if (!parentObject || !relatedListApiName) {
                findings.push(
                    createWarningFinding({
                        metadataName: findingName,
                        ruleId: RULE_ID,
                        reason:
                            'Unable to establish FlexiPage parent object or related-list API name from source metadata.',
                        requiredBy
                    })
                );
                continue;
            }

            const parentEntry = index.get(parentObject);

            if (!parentEntry || !parentEntry.queried) {
                findings.push(
                    createWarningFinding({
                        metadataName: findingName,
                        ruleId: RULE_ID,
                        reason:
                            parentEntry?.warning ||
                            'Destination parent object schema was not queried; related-list relationship could not be verified.',
                        requiredBy
                    })
                );
                continue;
            }

            if (!parentEntry.ok) {
                findings.push(
                    createWarningFinding({
                        metadataName: findingName,
                        ruleId: RULE_ID,
                        reason:
                            parentEntry.warning ||
                            `Unable to describe ${parentObject} in the destination org.`,
                        requiredBy
                    })
                );
                continue;
            }

            if (
                parentHasRelatedListRelationship(
                    parentEntry.childRelationships,
                    relatedListApiName
                )
            ) {
                findings.push(
                    createPassFinding({
                        metadataName: findingName,
                        metadataType: FINDING_METADATA_TYPE,
                        ruleId: RULE_ID,
                        reason:
                            'Related list child relationship exists on the destination parent object.',
                        requiredBy
                    })
                );
                continue;
            }

            const definingField =
                reference.relationshipDefiningFieldQualifiedName || null;

            if (relationshipScheduledViaDefiningField(context, definingField)) {
                findings.push(
                    createPassFinding({
                        metadataName: findingName,
                        metadataType: FINDING_METADATA_TYPE,
                        ruleId: RULE_ID,
                        reason:
                            'Related list relationship is missing in the destination org but the defining lookup field is scheduled for deployment.',
                        requiredBy
                    })
                );
                continue;
            }

            const fieldDecision = definingField
                ? context.availability.getDecision(
                      'CustomField',
                      definingField
                  )
                : null;

            if (fieldDecision?.action === ACTIONS.BLOCK) {
                findings.push(
                    createBlockFinding({
                        metadataName: findingName,
                        metadataType: FINDING_METADATA_TYPE,
                        ruleId: RULE_ID,
                        reason:
                            fieldDecision.reason ||
                            'Relationship-defining CustomField is blocked by dependency resolution.',
                        requiredBy,
                        recommendedAction:
                            'Resolve the blocked CustomField dependency or remove the related list from the FlexiPage.'
                    })
                );
                continue;
            }

            findings.push(
                createBlockFinding({
                    metadataName: findingName,
                    metadataType: FINDING_METADATA_TYPE,
                    ruleId: RULE_ID,
                    reason: `Related list ${relatedListApiName} is not available on ${parentObject} in the destination org.`,
                    requiredBy,
                    recommendedAction:
                        'Deploy the child lookup/master-detail field that defines this relationship, ensure it exists in the destination org, or remove the related list from the FlexiPage.'
                })
            );
        }

        return findings;
    }
};

module.exports = flexiPageRelatedListRelationshipRule;
