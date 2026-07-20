/**
 * Compatibility rule registry.
 * Registers rule modules; the processor must not contain metadata-type-specific logic.
 */

const flexiPageRules = require('./rules/flexiPage.rules');

function getRegisteredRules() {
    return [...flexiPageRules];
}

module.exports = {
    getRegisteredRules
};
