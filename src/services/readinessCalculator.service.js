async function calculateReadiness(validationResults) {
    return {
        status: 'NOT_EVALUATED',
        checks: []
    };
}

module.exports = {
    calculateReadiness
};
