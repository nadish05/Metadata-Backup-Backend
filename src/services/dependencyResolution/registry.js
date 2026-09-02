/**
 * Decision resolver registry.
 * The engine must not contain metadata-type-specific logic.
 */

const customObjectResolver = require('./resolvers/customObject.resolver');
const personAccountRecordTypeResolver = require('./resolvers/personAccountRecordType.resolver');
const structuralActionOverrideFieldResolver = require('./resolvers/structuralActionOverrideField.resolver');
const structuralFormulaRelatedFieldResolver = require('./resolvers/structuralFormulaRelatedField.resolver');

function getRegisteredResolvers() {
    return [
        structuralFormulaRelatedFieldResolver,
        structuralActionOverrideFieldResolver,
        customObjectResolver,
        personAccountRecordTypeResolver
    ];
}

module.exports = {
    getRegisteredResolvers
};
