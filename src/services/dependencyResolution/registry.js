/**
 * Decision resolver registry.
 * The engine must not contain metadata-type-specific logic.
 */

const customObjectResolver = require('./resolvers/customObject.resolver');
const personAccountRecordTypeResolver = require('./resolvers/personAccountRecordType.resolver');

function getRegisteredResolvers() {
    return [customObjectResolver, personAccountRecordTypeResolver];
}

module.exports = {
    getRegisteredResolvers
};
