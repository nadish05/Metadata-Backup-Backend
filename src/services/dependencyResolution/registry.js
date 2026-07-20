/**
 * Decision resolver registry.
 * The engine must not contain metadata-type-specific logic.
 */

const customObjectResolver = require('./resolvers/customObject.resolver');

function getRegisteredResolvers() {
    return [customObjectResolver];
}

module.exports = {
    getRegisteredResolvers
};
