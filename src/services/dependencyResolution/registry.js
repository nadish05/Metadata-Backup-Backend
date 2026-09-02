/**
 * Decision resolver registry.
 * The engine must not contain metadata-type-specific logic.
 */

const customObjectResolver = require('./resolvers/customObject.resolver');
const personAccountRecordTypeResolver = require('./resolvers/personAccountRecordType.resolver');
const structuralActionOverrideFieldResolver = require('./resolvers/structuralActionOverrideField.resolver');
const structuralFormulaRelatedFieldResolver = require('./resolvers/structuralFormulaRelatedField.resolver');
const structuralActionOverrideComponentResolver = require('./resolvers/structuralActionOverrideComponent.resolver');
const structuralActionOverrideApexResolver = require('./resolvers/structuralActionOverrideApex.resolver');

function getRegisteredResolvers() {
    return [
        structuralFormulaRelatedFieldResolver,
        structuralActionOverrideComponentResolver,
        structuralActionOverrideApexResolver,
        structuralActionOverrideFieldResolver,
        customObjectResolver,
        personAccountRecordTypeResolver
    ];
}

module.exports = {
    getRegisteredResolvers
};
