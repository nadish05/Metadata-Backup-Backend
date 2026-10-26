'use strict';

const axios = require('axios');

const { refreshAccessToken } = require('../checkOnlyDeployment.service');
const {
    fetchSalesforceUserInfo,
    orgIdsMatch,
    normalizeOrgId
} = require('../deploymentOrgLock/destinationOrgIdentity.service');
const USER_LICENSE_SOQL =
    'SELECT Id, Name, LicenseDefinitionKey, Status, TotalLicenses, UsedLicenses FROM UserLicense ORDER BY Name';

class OrgLicenseSideError extends Error {
    constructor(side, code, message, statusCode = 502) {
        super(message);
        this.name = 'OrgLicenseSideError';
        this.side = side;
        this.code = code;
        this.statusCode = statusCode;
    }
}

function stripSensitiveText(value) {
    const text = String(value || '');

    return text
        .replace(/refresh[_ ]?token[=:]\s*["']?[^"'\s]+/gi, 'refresh_token=[REDACTED]')
        .replace(/access[_ ]?token[=:]\s*["']?[^"'\s]+/gi, 'access_token=[REDACTED]')
        .replace(/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, 'Bearer [REDACTED]')
        .replace(/client[_ ]?secret[=:]\s*["']?[^"'\s]+/gi, 'client_secret=[REDACTED]')
        .replace(/\b[A-Za-z0-9]{20,}\.[A-Za-z0-9]{10,}\b/g, '[REDACTED_TOKEN]');
}

function mapSalesforceQueryError(error) {
    const status = error?.response?.status;
    const firstMessage = error?.response?.data?.[0]?.message;

    if (status === 401 || status === 403) {
        return {
            code: 'AUTHORIZATION_FAILED',
            message:
                stripSensitiveText(firstMessage) ||
                'Salesforce rejected the licence query for this org.',
            statusCode: status === 401 ? 401 : 403
        };
    }

    return {
        code: 'QUERY_FAILED',
        message:
            stripSensitiveText(firstMessage) ||
            stripSensitiveText(error?.message) ||
            'Salesforce UserLicense query failed.',
        statusCode: 502
    };
}

async function getLatestApiVersion(instanceUrl, accessToken, httpGet = axios.get) {
    const response = await httpGet(`${instanceUrl.replace(/\/$/, '')}/services/data/`, {
        headers: {
            Authorization: `Bearer ${accessToken}`
        },
        timeout: 15000
    });

    const versions = response.data;

    if (!Array.isArray(versions) || !versions.length) {
        return '59.0';
    }

    return versions[versions.length - 1].version;
}

function resolveQueryUrl(instanceUrl, nextRecordsUrl) {
    if (!nextRecordsUrl) {
        return null;
    }

    if (String(nextRecordsUrl).startsWith('http')) {
        return nextRecordsUrl;
    }

    return `${instanceUrl.replace(/\/$/, '')}${nextRecordsUrl}`;
}

async function queryAllUserLicenses({
    instanceUrl,
    accessToken,
    apiVersion,
    httpGet = axios.get
}) {
    const baseUrl = instanceUrl.replace(/\/$/, '');
    let url =
        `${baseUrl}/services/data/v${apiVersion}/query/?q=` +
        `${encodeURIComponent(USER_LICENSE_SOQL)}`;
    const records = [];

    while (url) {
        const response = await httpGet(url, {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 30000
        });

        const batch = Array.isArray(response.data?.records)
            ? response.data.records
            : [];

        records.push(...batch);

        if (response.data?.done === true) {
            break;
        }

        url = resolveQueryUrl(baseUrl, response.data?.nextRecordsUrl);
    }

    return records;
}

async function authenticateOrgSide({
    side,
    refreshToken,
    instanceUrl,
    orgId,
    refreshAccessTokenFn = refreshAccessToken,
    fetchUserInfo = fetchSalesforceUserInfo
}) {
    if (!refreshToken || !instanceUrl || !orgId) {
        throw new OrgLicenseSideError(
            side,
            'INVALID_CREDENTIALS',
            `${capitalizeSide(side)} org credentials are incomplete.`,
            400
        );
    }

    let tokenResult;

    try {
        tokenResult = await refreshAccessTokenFn(refreshToken);
    } catch (error) {
        throw new OrgLicenseSideError(
            side,
            'AUTHENTICATION_FAILED',
            `${capitalizeSide(side)} org authentication failed.`,
            401
        );
    }

    const accessToken = tokenResult?.accessToken;
    const resolvedInstanceUrl =
        tokenResult?.instanceUrl || instanceUrl;

    if (!accessToken || !resolvedInstanceUrl) {
        throw new OrgLicenseSideError(
            side,
            'AUTHENTICATION_FAILED',
            `${capitalizeSide(side)} org authentication failed.`,
            401
        );
    }

    let identity;

    try {
        identity = await fetchUserInfo({
            accessToken,
            instanceUrl: resolvedInstanceUrl
        });
    } catch (error) {
        throw new OrgLicenseSideError(
            side,
            'AUTHENTICATION_FAILED',
            `${capitalizeSide(side)} org identity verification failed.`,
            401
        );
    }

    const verifiedOrgId = normalizeOrgId(
        identity.organization_id ||
            identity.organizationId ||
            identity.orgId
    );
    const requestedOrgId = normalizeOrgId(orgId);

    if (!verifiedOrgId) {
        throw new OrgLicenseSideError(
            side,
            'AUTHENTICATION_FAILED',
            `${capitalizeSide(side)} org identity verification failed.`,
            401
        );
    }

    if (requestedOrgId && !orgIdsMatch(requestedOrgId, verifiedOrgId)) {
        throw new OrgLicenseSideError(
            side,
            'ORG_ID_MISMATCH',
            `${capitalizeSide(side)} orgId does not match the authenticated org.`,
            401
        );
    }

    return {
        accessToken,
        instanceUrl: resolvedInstanceUrl,
        orgId: verifiedOrgId
    };
}

function capitalizeSide(side) {
    if (side === 'source') {
        return 'Source';
    }

    if (side === 'destination') {
        return 'Destination';
    }

    return String(side || 'Org');
}

async function fetchUserLicensesForOrg({
    side,
    refreshToken,
    instanceUrl,
    orgId,
    refreshAccessTokenFn = refreshAccessToken,
    fetchUserInfo = fetchSalesforceUserInfo,
    httpGet = axios.get
}) {
    const session = await authenticateOrgSide({
        side,
        refreshToken,
        instanceUrl,
        orgId,
        refreshAccessTokenFn,
        fetchUserInfo
    });

    let apiVersion;

    try {
        apiVersion = await getLatestApiVersion(
            session.instanceUrl,
            session.accessToken,
            httpGet
        );
    } catch (error) {
        throw new OrgLicenseSideError(
            side,
            'API_VERSION_FAILED',
            `${capitalizeSide(side)} org API version discovery failed.`,
            502
        );
    }

    try {
        const records = await queryAllUserLicenses({
            instanceUrl: session.instanceUrl,
            accessToken: session.accessToken,
            apiVersion,
            httpGet
        });

        return {
            orgId: session.orgId,
            instanceUrl: session.instanceUrl,
            apiVersion,
            licenses: records
        };
    } catch (error) {
        const mapped = mapSalesforceQueryError(error);

        throw new OrgLicenseSideError(
            side,
            mapped.code,
            `${capitalizeSide(side)} org licence retrieval failed: ${mapped.message}`,
            mapped.statusCode
        );
    }
}

function validateCompareCredentials(body) {
    const errors = [];

    if (!body || typeof body !== 'object') {
        return {
            ok: false,
            error: 'Request body must be a JSON object.'
        };
    }

    const source = body.source;
    const destination = body.destination;

    if (!source || typeof source !== 'object') {
        errors.push('source is required.');
    } else {
        if (!text(source.refreshToken)) {
            errors.push('source.refreshToken is required.');
        }
        if (!text(source.instanceUrl)) {
            errors.push('source.instanceUrl is required.');
        }
        if (!text(source.orgId)) {
            errors.push('source.orgId is required.');
        }
    }

    if (!destination || typeof destination !== 'object') {
        errors.push('destination is required.');
    } else {
        if (!text(destination.refreshToken)) {
            errors.push('destination.refreshToken is required.');
        }
        if (!text(destination.instanceUrl)) {
            errors.push('destination.instanceUrl is required.');
        }
        if (!text(destination.orgId)) {
            errors.push('destination.orgId is required.');
        }
    }

    if (errors.length) {
        return {
            ok: false,
            error: errors.join(' ')
        };
    }

    return { ok: true };
}

function text(value) {
    return value !== undefined && value !== null && String(value).trim() !== '';
}

module.exports = {
    USER_LICENSE_SOQL,
    OrgLicenseSideError,
    authenticateOrgSide,
    fetchUserLicensesForOrg,
    getLatestApiVersion,
    queryAllUserLicenses,
    validateCompareCredentials,
    stripSensitiveText,
    mapSalesforceQueryError
};
