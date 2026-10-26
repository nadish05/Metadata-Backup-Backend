'use strict';

const { compareUserLicenses } = require('../services/orgLicense/orgUserLicenseCompare.service');
const {
    fetchUserLicensesForOrg,
    validateCompareCredentials,
    OrgLicenseSideError,
    stripSensitiveText
} = require('../services/orgLicense/orgUserLicenseQuery.service');

function buildSidePayload(orgResult) {
    return {
        orgId: orgResult.orgId,
        instanceUrl: orgResult.instanceUrl,
        apiVersion: orgResult.apiVersion,
        licenses: orgResult.licenses
    };
}

exports.compareOrgUserLicenses = async (req, res) => {
    const validation = validateCompareCredentials(req.body);

    if (!validation.ok) {
        return res.status(400).json({
            success: false,
            error: validation.error
        });
    }

    const { source, destination } = req.body;

    let sourceResult;

    try {
        sourceResult = await fetchUserLicensesForOrg({
            side: 'source',
            refreshToken: source.refreshToken,
            instanceUrl: source.instanceUrl,
            orgId: source.orgId
        });
    } catch (error) {
        if (error instanceof OrgLicenseSideError) {
            return res.status(error.statusCode).json({
                success: false,
                failedSide: error.side,
                code: error.code,
                error: stripSensitiveText(error.message)
            });
        }

        return res.status(502).json({
            success: false,
            failedSide: 'source',
            code: 'RETRIEVAL_FAILED',
            error: 'Source org licence retrieval failed.'
        });
    }

    let destinationResult;

    try {
        destinationResult = await fetchUserLicensesForOrg({
            side: 'destination',
            refreshToken: destination.refreshToken,
            instanceUrl: destination.instanceUrl,
            orgId: destination.orgId
        });
    } catch (error) {
        if (error instanceof OrgLicenseSideError) {
            return res.status(error.statusCode).json({
                success: false,
                failedSide: error.side,
                code: error.code,
                error: stripSensitiveText(error.message)
            });
        }

        return res.status(502).json({
            success: false,
            failedSide: 'destination',
            code: 'RETRIEVAL_FAILED',
            error: 'Destination org licence retrieval failed.'
        });
    }

    const comparison = compareUserLicenses(
        sourceResult.licenses,
        destinationResult.licenses
    );

    return res.json({
        success: true,
        sourceOrgId: sourceResult.orgId,
        destinationOrgId: destinationResult.orgId,
        comparisonKeyField: comparison.comparisonKeyField,
        source: {
            orgId: sourceResult.orgId,
            instanceUrl: sourceResult.instanceUrl,
            licenses: comparison.sourceLicenses
        },
        destination: {
            orgId: destinationResult.orgId,
            instanceUrl: destinationResult.instanceUrl,
            licenses: comparison.destinationLicenses
        },
        both: comparison.both,
        sourceOnly: comparison.sourceOnly,
        destinationOnly: comparison.destinationOnly,
        unmatched: comparison.unmatched,
        warnings: comparison.warnings
    });
};
