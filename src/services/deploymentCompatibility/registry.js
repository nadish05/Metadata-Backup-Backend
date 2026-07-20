/**
 * Deployment Compatibility Analyzer rule registry.
 * Future rules plug in here without redesigning the analyzer.
 */

const flexiPageFieldReferenceRule = require('./rules/flexiPageFieldReference.rule');
const lightningComponentReferenceRule = require('./rules/lightningComponentReference.rule');
const actionOverrideReferenceRule = require('./rules/actionOverrideReference.rule');
const lookupTargetRule = require('./rules/lookupTarget.rule');
const masterDetailTargetRule = require('./rules/masterDetailTarget.rule');
const artifactExistsRule = require('./rules/artifactExists.rule');

function getRegisteredCompatibilityRules() {
    return [
        artifactExistsRule,
        flexiPageFieldReferenceRule,
        lightningComponentReferenceRule,
        actionOverrideReferenceRule,
        lookupTargetRule,
        masterDetailTargetRule
    ];
}

module.exports = {
    getRegisteredCompatibilityRules
};
