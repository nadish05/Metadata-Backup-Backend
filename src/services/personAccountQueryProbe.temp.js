/**
 * TEMPORARY DEBUG ONLY — Phase 15.3.2 Person Account destination query probe.
 *
 * Executes the exact destination existence query for
 * RecordType:PersonAccount.PersonAccount against a real destination org so the
 * precise Salesforce status, errorCode, and message can be captured without
 * running a deployment.
 *
 * The SOQL is NOT modified — it is taken from the shared query catalog.
 * Read-only: one existence query plus one RecordType describe.
 *
 * Run with either credential pair:
 *   $env:SF_DESTINATION_ACCESS_TOKEN=...; $env:SF_DESTINATION_INSTANCE_URL=https://xxx.my.salesforce.com
 *   $env:SF_DESTINATION_REFRESH_TOKEN=...  (also needs SF_CLIENT_ID + SF_CLIENT_SECRET)
 *
 *   node src/services/personAccountQueryProbe.temp.js
 */

require('dotenv').config();

const axios = require('axios');

const personAccountQueryTrace = require('./personAccountQueryTrace.temp');
const {
    buildExistenceQuery,
    usesToolingApi
} = require('./destinationInventory/destinationExistenceQueries');

const TRACED_CONTEXT = {
    metadataType: 'RecordType',
    metadataName: 'PersonAccount.PersonAccount'
};

async function resolveCredentials() {
    const instanceUrl =
        process.env.SF_DESTINATION_INSTANCE_URL || process.env.SF_INSTANCE_URL;
    const accessToken =
        process.env.SF_DESTINATION_ACCESS_TOKEN || process.env.SF_ACCESS_TOKEN;
    const refreshToken =
        process.env.SF_DESTINATION_REFRESH_TOKEN ||
        process.env.SF_REFRESH_TOKEN;

    if (accessToken && instanceUrl) {
        return { accessToken, instanceUrl };
    }

    if (!refreshToken) {
        return null;
    }

    const tokenResponse = await axios.post(
        'https://login.salesforce.com/services/oauth2/token',
        null,
        {
            params: {
                grant_type: 'refresh_token',
                client_id: process.env.SF_CLIENT_ID,
                client_secret: process.env.SF_CLIENT_SECRET,
                refresh_token: refreshToken
            },
            timeout: 15000
        }
    );

    return {
        accessToken: tokenResponse.data.access_token,
        instanceUrl: tokenResponse.data.instance_url || instanceUrl
    };
}

async function resolveApiVersion({ accessToken, instanceUrl }) {
    const response = await axios.get(`${instanceUrl}/services/data/`, {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 15000
    });

    const versions = response.data;

    return Array.isArray(versions) && versions.length
        ? versions[versions.length - 1].version
        : '59.0';
}

async function runTracedQuery({ accessToken, instanceUrl, apiVersion }) {
    const soql = buildExistenceQuery(
        TRACED_CONTEXT.metadataType,
        TRACED_CONTEXT.metadataName
    );
    const useTooling = usesToolingApi(TRACED_CONTEXT.metadataType);
    const queryPath = useTooling ? 'tooling/query' : 'query';
    const endpoint = `${instanceUrl}/services/data/v${apiVersion}/${queryPath}/?q=${encodeURIComponent(
        soql
    )}`;

    personAccountQueryTrace.logQueryRequest({
        ...TRACED_CONTEXT,
        endpoint,
        soql,
        apiVersion,
        api: useTooling ? 'TOOLING' : 'REST'
    });

    try {
        const response = await axios.get(endpoint, {
            headers: { Authorization: `Bearer ${accessToken}` },
            timeout: 15000
        });

        personAccountQueryTrace.logQueryResponse({
            ...TRACED_CONTEXT,
            status: response.status,
            data: response.data
        });
    } catch (error) {
        personAccountQueryTrace.logQueryError({ ...TRACED_CONTEXT, error });
    }
}

/**
 * Read-only describe used purely as evidence: shows whether the destination org
 * exposes RecordType.IsPersonType at all.
 */
async function describeRecordTypeFields({
    accessToken,
    instanceUrl,
    apiVersion
}) {
    console.log('====================================================');
    console.log('PERSON ACCOUNT QUERY FIELD AVAILABILITY');
    console.log('====================================================');
    console.log('');

    try {
        const describe = await axios.get(
            `${instanceUrl}/services/data/v${apiVersion}/sobjects/RecordType/describe`,
            {
                headers: { Authorization: `Bearer ${accessToken}` },
                timeout: 15000
            }
        );

        const fields = (describe.data?.fields || []).map((field) => field.name);

        console.log('RecordType.IsPersonType present in describe:');
        console.log('');
        console.log(fields.includes('IsPersonType') ? 'YES' : 'NO');
        console.log('');
        console.log('RecordType fields:');
        console.log('');
        console.log(fields.join(', '));
    } catch (error) {
        console.log('Describe failed:');
        console.log('');
        console.log(error.response?.status || error.message);
    }

    console.log('');
    console.log('====================================================');
}

async function main() {
    const credentials = await resolveCredentials();

    if (!credentials?.accessToken || !credentials?.instanceUrl) {
        console.log('====================================================');
        console.log('PERSON ACCOUNT QUERY PROBE — NO CREDENTIALS');
        console.log('====================================================');
        console.log('');
        console.log(
            'Set SF_DESTINATION_ACCESS_TOKEN + SF_DESTINATION_INSTANCE_URL, or'
        );
        console.log(
            'SF_DESTINATION_REFRESH_TOKEN + SF_CLIENT_ID + SF_CLIENT_SECRET.'
        );
        console.log('');
        console.log('====================================================');
        process.exitCode = 1;
        return;
    }

    personAccountQueryTrace.beginQueryTrace();

    const apiVersion = await resolveApiVersion(credentials);

    await runTracedQuery({ ...credentials, apiVersion });
    await describeRecordTypeFields({ ...credentials, apiVersion });
}

main().catch((error) => {
    console.error('PERSON ACCOUNT QUERY PROBE ERROR');
    console.error(error.response?.data || error.message);
    process.exitCode = 1;
});
