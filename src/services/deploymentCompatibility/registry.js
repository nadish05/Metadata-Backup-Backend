/**
 * Deployment Compatibility Analyzer rule registry.
 * Future rules plug in here without redesigning the analyzer.
 */

const flexiPageFieldReferenceRule = require('./rules/flexiPageFieldReference.rule');
const flexiPageRelatedListRelationshipRule = require('./rules/flexiPageRelatedListRelationship.rule');
const layoutFieldReferenceRule = require('./rules/layoutFieldReference.rule');
const layoutWebLinkReferenceRule = require('./rules/layoutWebLinkReference.rule');
const layoutParentObjectRule = require('./rules/layoutParentObject.rule');
const lightningComponentReferenceRule = require('./rules/lightningComponentReference.rule');
const actionOverrideReferenceRule = require('./rules/actionOverrideReference.rule');
const lookupTargetRule = require('./rules/lookupTarget.rule');
const masterDetailTargetRule = require('./rules/masterDetailTarget.rule');
const artifactExistsRule = require('./rules/artifactExists.rule');

function getRegisteredCompatibilityRules() {
    return [
        artifactExistsRule,
        flexiPageFieldReferenceRule,
        flexiPageRelatedListRelationshipRule,
        layoutFieldReferenceRule,
        layoutWebLinkReferenceRule,
        layoutParentObjectRule,
        lightningComponentReferenceRule,
        actionOverrideReferenceRule,
        lookupTargetRule,
        masterDetailTargetRule
    ];
}

module.exports = {
    getRegisteredCompatibilityRules
};
