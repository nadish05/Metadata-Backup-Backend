'use strict';

const COMPARISON_KEY_FIELD = 'LicenseDefinitionKey';

function isValidComparisonKey(value) {
    if (value === undefined || value === null) {
        return false;
    }

    return String(value).trim().length > 0;
}

function normalizeLicenseRow(record) {
    return {
        id: record.Id || record.id || null,
        name: record.Name || record.name || null,
        licenseDefinitionKey:
            record.LicenseDefinitionKey || record.licenseDefinitionKey || null,
        status: record.Status || record.status || null,
        totalLicenses:
            record.TotalLicenses ?? record.totalLicenses ?? null,
        usedLicenses: record.UsedLicenses ?? record.usedLicenses ?? null
    };
}

/**
 * Compare UserLicense rows from source and destination orgs.
 * Matches only on LicenseDefinitionKey when present and non-blank.
 */
function compareUserLicenses(sourceRecords, destinationRecords) {
    const warnings = [];
    const unmatched = {
        source: [],
        destination: []
    };

    const sourceLicenses = (sourceRecords || []).map(normalizeLicenseRow);
    const destinationLicenses = (destinationRecords || []).map(
        normalizeLicenseRow
    );

    const destinationByKey = new Map();
    const destinationOnlyKeyed = [];

    for (const license of destinationLicenses) {
        if (!isValidComparisonKey(license.licenseDefinitionKey)) {
            unmatched.destination.push({
                ...license,
                classification: 'MISSING_COMPARISON_KEY',
                comparisonKeyField: COMPARISON_KEY_FIELD
            });
            warnings.push(
                `Destination licence "${license.name || license.id}" has no ${COMPARISON_KEY_FIELD} and was not matched across orgs.`
            );
            continue;
        }

        const key = String(license.licenseDefinitionKey).trim();

        if (destinationByKey.has(key)) {
            warnings.push(
                `Destination org returned duplicate ${COMPARISON_KEY_FIELD} "${key}"; using the last row for comparison.`
            );
        }

        destinationByKey.set(key, license);
    }

    const both = [];
    const sourceOnly = [];

    for (const license of sourceLicenses) {
        if (!isValidComparisonKey(license.licenseDefinitionKey)) {
            unmatched.source.push({
                ...license,
                classification: 'MISSING_COMPARISON_KEY',
                comparisonKeyField: COMPARISON_KEY_FIELD
            });
            warnings.push(
                `Source licence "${license.name || license.id}" has no ${COMPARISON_KEY_FIELD} and was not matched across orgs.`
            );
            continue;
        }

        const key = String(license.licenseDefinitionKey).trim();
        const destinationMatch = destinationByKey.get(key);

        if (destinationMatch) {
            both.push({
                licenseDefinitionKey: key,
                source: license,
                destination: destinationMatch
            });
            destinationByKey.delete(key);
        } else {
            sourceOnly.push({
                licenseDefinitionKey: key,
                license
            });
        }
    }

    const destinationOnly = [];

    for (const [key, license] of destinationByKey.entries()) {
        destinationOnly.push({
            licenseDefinitionKey: key,
            license
        });
    }

    return {
        comparisonKeyField: COMPARISON_KEY_FIELD,
        sourceLicenses,
        destinationLicenses,
        both,
        sourceOnly,
        destinationOnly,
        unmatched,
        warnings
    };
}

module.exports = {
    compareUserLicenses,
    isValidComparisonKey,
    normalizeLicenseRow,
    COMPARISON_KEY_FIELD
};
