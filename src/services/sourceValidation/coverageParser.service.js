function parseCoverageFromTestResult(testResult) {
    if (!testResult) {
        return [];
    }

    const coverageEntries =
        testResult?.result?.coverage?.coverage || [];

    return coverageEntries
        .filter(
            (entry) =>
                entry?.name != null &&
                entry?.coveredPercent != null
        )
        .map((entry) => ({
            className: entry.name,
            coverage: Math.round(entry.coveredPercent)
        }));
}

module.exports = {
    parseCoverageFromTestResult
};
