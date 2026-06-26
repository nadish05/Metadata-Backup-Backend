const axios = require('axios');
const util = require('util');
const path = require('path');
const { exec } = require('child_process');

const { getOAuthResult } = require('./oauthStore');

const execAsync = util.promisify(exec);

const COVERAGE_THRESHOLD = 85;

function orgIdsMatch(storedOrgId, requestedOrgId) {
    if (!storedOrgId || !requestedOrgId) {
        return false;
    }

    return (
        storedOrgId.substring(0, 15) ===
        requestedOrgId.substring(0, 15)
    );
}

async function refreshAccessToken(refreshToken) {
    const tokenResponse = await axios.post(
        'https://login.salesforce.com/services/oauth2/token',
        null,
        {
            params: {
                grant_type: 'refresh_token',
                client_id: process.env.SF_CLIENT_ID,
                client_secret: process.env.SF_CLIENT_SECRET,
                refresh_token: refreshToken
            }
        }
    );

    return tokenResponse.data.access_token;
}

async function loginSfOrg(accessToken, instanceUrl, alias) {
    const loginCommand =
        `export SF_ACCESS_TOKEN="${accessToken}" && ` +
        `sf org login access-token ` +
        `-r ${instanceUrl} ` +
        `--alias ${alias} ` +
        `--no-prompt`;

    await execAsync(loginCommand);
}

function parseCliJson(output) {
    const start = output.indexOf('{');

    if (start === -1) {
        throw new Error('No JSON output from Salesforce CLI');
    }

    return JSON.parse(output.slice(start));
}

async function runApexTests(testClassNames, alias) {
    const testsArg = testClassNames.join(',');

    const command =
        `sf apex run test ` +
        `--tests "${testsArg}" ` +
        `--code-coverage ` +
        `--result-format json ` +
        `--target-org ${alias} ` +
        `--wait 10 ` +
        `--json`;

    try {
        const result = await execAsync(command, {
            maxBuffer: 50 * 1024 * 1024
        });

        return parseCliJson(result.stdout);
    } catch (error) {
        if (error.stdout) {
            return parseCliJson(error.stdout);
        }

        throw error;
    }
}

function getCoverageForClass(testResult, apexClassName) {
    const coverageEntries =
        testResult?.result?.coverage?.coverage || [];

    const match = coverageEntries.find(
        (entry) => entry.name === apexClassName
    );

    if (!match || match.coveredPercent == null) {
        return 0;
    }

    return Math.round(match.coveredPercent);
}

async function validateCoverage(
    metadataType,
    filePath,
    destinationOrgId,
    testValidation
) {
    if (
        !testValidation?.found ||
        !testValidation.testClasses?.length
    ) {
        return {
            coverage: 0,
            passed: false
        };
    }

    const org = getOAuthResult();

    if (
        !org?.refreshToken ||
        !org?.instanceUrl ||
        !orgIdsMatch(org.orgId, destinationOrgId)
    ) {
        return {
            coverage: 0,
            passed: false
        };
    }

    const apexClassName = path.basename(
        filePath,
        path.extname(filePath)
    );

    const testClassNames = testValidation.testClasses.map(
        (testClass) => testClass.name
    );

    const alias = `deployment-review-${Date.now()}`;

    try {
        const accessToken = await refreshAccessToken(
            org.refreshToken
        );

        await loginSfOrg(
            accessToken,
            org.instanceUrl,
            alias
        );

        const testResult = await runApexTests(
            testClassNames,
            alias
        );

        const testRunId =
            testResult?.result?.summary?.testRunId || null;

        const coverage = getCoverageForClass(
            testResult,
            apexClassName
        );

        return {
            coverage,
            passed: coverage >= COVERAGE_THRESHOLD,
            testRunId
        };
    } catch (error) {
        console.error('COVERAGE VALIDATION ERROR');
        console.error(error.stderr || error.stdout || error.message);

        return {
            coverage: 0,
            passed: false
        };
    }
}

module.exports = {
    validateCoverage
};
