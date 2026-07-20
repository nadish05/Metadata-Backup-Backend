/**
 * Deployment Compatibility Analyzer rule registry.
 * Future rules plug in here without redesigning the analyzer.
 */

const flexiPageFieldReferenceRule = require('./rules/flexiPageFieldReference.rule');
const lightningComponentReferenceRule = require('./rules/lightningComponentReference.rule');
const actionOverrideReferenceRule = require('./rules/actionOverrideReference.rule');
const lookupTargetRule = require('./rules/lookupTarget.rule');
const masterDetailTargetRule = require('./rules/masterDetailTarget.rule');

function getRegisteredCompatibilityRules() {
    return [
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
