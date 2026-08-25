'use strict';

const axios = require('axios');

const { OrgLockIdentityError } = require('./deploymentOrgLock.errors');
const { refreshAccessToken } = require('../checkOnlyDeployment.service');

function normalizeOrgId(value) {
    if (value === undefined || value === null || value === '') {
        return null;
    }

    return String(value).trim();
}

function orgIdsMatch(left, right) {
    const a = normalizeOrgId(left);
    const b = normalizeOrgId(right);

    if (!a || !b) {
        return false;
    }

    return a.toUpperCase() === b.toUpperCase();
}

async function fetchSalesforceUserInfo({ accessToken, instanceUrl }) {
    const response = await axios.get(
        `${String(instanceUrl).replace(/\/$/, '')}/services/oauth2/userinfo`,
        {
            headers: {
                Authorization: `Bearer ${accessToken}`
            },
            timeout: 15000
        }
    );

    return response.data || {};
}

async function resolveVerifiedDestinationOrgId({
    refreshToken,
    instanceUrl,
    requestedOrgId = null,
    refreshAccessTokenFn = refreshAccessToken,
    fetchUserInfo = fetchSalesforceUserInfo
} = {}) {
    if (!refreshToken || !instanceUrl) {
        throw new OrgLockIdentityError(
            'Destination org identity verification failed: missing credentials.'
        );
    }

    let tokenResult;

    try {
        tokenResult = await refreshAccessTokenFn(refreshToken);
    } catch (error) {
        throw new OrgLockIdentityError(
            'Destination org identity verification failed: unable to authenticate.'
        );
    }

    const accessToken = tokenResult?.accessToken;
    const resolvedInstanceUrl = tokenResult?.instanceUrl || instanceUrl;

    if (!accessToken || !resolvedInstanceUrl) {
        throw new OrgLockIdentityError(
            'Destination org identity verification failed: missing access token.'
        );
    }

    let identity;

    try {
        identity = await fetchUserInfo({
            accessToken,
            instanceUrl: resolvedInstanceUrl
        });
    } catch (error) {
        throw new OrgLockIdentityError(
            'Destination org identity verification failed: identity lookup failed.'
        );
    }

    const verifiedOrgId = normalizeOrgId(
        identity.organization_id || identity.organizationId || identity.orgId
    );

    if (!verifiedOrgId) {
        throw new OrgLockIdentityError(
            'Destination org identity verification failed: organization id missing.'
        );
    }

    const requested = normalizeOrgId(requestedOrgId);

    if (requested && !orgIdsMatch(requested, verifiedOrgId)) {
        throw new OrgLockIdentityError(
            'Destination org identity verification failed: request orgId does not match authenticated org.'
        );
    }

    return verifiedOrgId;
}

module.exports = {
    resolveVerifiedDestinationOrgId,
    fetchSalesforceUserInfo,
    orgIdsMatch,
    normalizeOrgId
};
