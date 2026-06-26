const axios = require('axios');
const util = require('util');
const { exec } = require('child_process');

const { getOAuthResult } = require('./oauthStore');
const testExecution = require('./sourceValidation/testExecution.service');

const execAsync = util.promisify(exec);

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

function resolveSelectedTestClassNames(selectedTestClasses) {
    if (!Array.isArray(selectedTestClasses)) {
        return [];
    }

    return selectedTestClasses
        .filter((testClass) => {
            if (typeof testClass === 'string') {
                return true;
            }

            return testClass.selected !== false;
        })
        .map((testClass) => {
            if (typeof testClass === 'string') {
                return testClass;
            }

            return testClass.name;
        })
        .filter(Boolean);
}

async function validateSource({
    sourceOrgId,
    selectedMetadata,
    selectedTestClasses
}) {
    const org = getOAuthResult();

    if (
        !org?.refreshToken ||
        !org?.instanceUrl ||
        !orgIdsMatch(org.orgId, sourceOrgId)
    ) {
        throw new Error('Source org credentials not found');
    }

    const testClassNames = resolveSelectedTestClassNames(
        selectedTestClasses
    );

    const alias = `source-validate-${Date.now()}`;

    const accessToken = await refreshAccessToken(org.refreshToken);

    await loginSfOrg(
        accessToken,
        org.instanceUrl,
        alias
    );

    const testExecutionResult = await testExecution.executeSelectedTests(
        testClassNames,
        alias
    );

    return {
        success: true,
        sourceValidation: {
            testExecution: testExecutionResult
        }
    };
}

module.exports = {
    validateSource
};
