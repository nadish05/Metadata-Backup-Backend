/**
 * Decision resolver registry.
 * The engine must not contain metadata-type-specific logic.
 */

const customObjectResolver = require('./resolvers/customObject.resolver');
const personAccountRecordTypeResolver = require('./resolvers/personAccountRecordType.resolver');
const structuralActionOverrideFieldResolver = require('./resolvers/structuralActionOverrideField.resolver');

function getRegisteredResolvers() {
    return [
        structuralActionOverrideFieldResolver,
        customObjectResolver,
        personAccountRecordTypeResolver
    ];
}

module.exports = {
    getRegisteredResolvers
};
