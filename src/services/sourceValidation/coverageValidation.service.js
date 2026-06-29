const MINIMUM_REQUIRED = 85;

const COVERAGE_FAILURE_MESSAGE =
    'Increase code coverage to at least 85% or remove this Apex class from the deployment package.';

function buildCoverageLookup(normalizedCoverage) {
    return new Map(
        normalizedCoverage.map((entry) => [
            entry.className,
            entry.coverage
        ])
    );
}

function validateCoverage(normalizedCoverage, selectedApexClasses) {
    const coverageLookup = buildCoverageLookup(normalizedCoverage);

    const results = selectedApexClasses.map((apexClass) => {
        const coverage = coverageLookup.get(apexClass) ?? 0;
        const difference = coverage - MINIMUM_REQUIRED;
        const passed = coverage >= MINIMUM_REQUIRED;

        const result = {
            apexClass,
            coverage,
            minimumRequired: MINIMUM_REQUIRED,
            difference,
            passed
        };

        if (!passed) {
            result.message = COVERAGE_FAILURE_MESSAGE;
        }

        return result;
    });

    const overallStatus =
        results.length === 0 ||
        results.every((result) => result.passed)
            ? 'PASS'
            : 'FAIL';

    return {
        minimumRequired: MINIMUM_REQUIRED,
        overallStatus,
        results
    };
}

module.exports = {
    validateCoverage
};
