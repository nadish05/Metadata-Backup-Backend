'use strict';

const assert = require('assert');

const {
    validateCompareCredentials,
    queryAllUserLicenses,
    fetchUserLicensesForOrg,
    stripSensitiveText,
    USER_LICENSE_SOQL
} = require('./orgUserLicenseQuery.service');
const { compareUserLicenses } = require('./orgUserLicenseCompare.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function main() {
    await runTest('invalid request payload validation', async () => {
        const missing = validateCompareCredentials({});

        assert.strictEqual(missing.ok, false);
        assert.ok(/source/.test(missing.error));

        const partial = validateCompareCredentials({
            source: {
                refreshToken: 'rt',
                instanceUrl: 'https://example.my.salesforce.com',
                orgId: '00Dxx'
            }
        });

        assert.strictEqual(partial.ok, false);
        assert.ok(/destination/.test(partial.error));
    });

    await runTest('pagination aggregates all UserLicense rows', async () => {
        const calls = [];

        const httpGet = async (url) => {
            calls.push(url);

            if (calls.length === 1) {
                return {
                    data: {
                        done: false,
                        records: [{ Id: '1', Name: 'A', LicenseDefinitionKey: 'A' }],
                        nextRecordsUrl:
                            '/services/data/v62.0/query/01g000000000001-2000'
                    }
                };
            }

            return {
                data: {
                    done: true,
                    records: [{ Id: '2', Name: 'B', LicenseDefinitionKey: 'B' }]
                }
            };
        };

        const records = await queryAllUserLicenses({
            instanceUrl: 'https://example.my.salesforce.com',
            accessToken: 'access-token',
            apiVersion: '62.0',
            httpGet
        });

        assert.strictEqual(records.length, 2);
        assert.strictEqual(calls.length, 2);
        assert.ok(calls[0].includes(encodeURIComponent(USER_LICENSE_SOQL)));
    });

    await runTest('authentication failure for source org', async () => {
        let failed;

        try {
            await fetchUserLicensesForOrg({
                side: 'source',
                refreshToken: 'bad',
                instanceUrl: 'https://example.my.salesforce.com',
                orgId: '00Dxx',
                refreshAccessTokenFn: async () => {
                    throw new Error('invalid_grant refresh_token=SECRET');
                }
            });
        } catch (error) {
            failed = error;
        }

        assert.ok(failed);
        assert.strictEqual(failed.side, 'source');
        assert.strictEqual(failed.code, 'AUTHENTICATION_FAILED');
        assert.ok(!String(failed.message).includes('SECRET'));
    });

    await runTest('Salesforce query failure is not treated as empty list', async () => {
        let failed;

        try {
            await fetchUserLicensesForOrg({
                side: 'destination',
                refreshToken: 'rt',
                instanceUrl: 'https://example.my.salesforce.com',
                orgId: '00Dyy',
                refreshAccessTokenFn: async () => ({
                    accessToken: 'access-token',
                    instanceUrl: 'https://example.my.salesforce.com'
                }),
                fetchUserInfo: async () => ({
                    organization_id: '00Dyy'
                }),
                httpGet: async (url) => {
                    if (url.includes('/services/data/') && !url.includes('/query/')) {
                        return { data: [{ version: '62.0' }] };
                    }

                    const err = new Error('query failed');
                    err.response = {
                        status: 403,
                        data: [
                            {
                                message:
                                    'insufficient access rights on object UserLicense accessToken=LEAK'
                            }
                        ]
                    };
                    throw err;
                }
            });
        } catch (error) {
            failed = error;
        }

        assert.ok(failed);
        assert.strictEqual(failed.side, 'destination');
        assert.strictEqual(failed.code, 'AUTHORIZATION_FAILED');
        assert.ok(!String(failed.message).includes('LEAK'));
        assert.ok(!String(failed.message).includes('access-token'));
    });

    await runTest('end-to-end fetch + compare with injected dependencies', async () => {
        const source = await fetchUserLicensesForOrg({
            side: 'source',
            refreshToken: 'rt-source',
            instanceUrl: 'https://source.my.salesforce.com',
            orgId: '00Dsource',
            refreshAccessTokenFn: async () => ({
                accessToken: 'source-access',
                instanceUrl: 'https://source.my.salesforce.com'
            }),
            fetchUserInfo: async () => ({
                organization_id: '00Dsource'
            }),
            httpGet: async (url) => {
                if (url.includes('/services/data/') && !url.includes('/query/')) {
                    return { data: [{ version: '62.0' }] };
                }

                return {
                    data: {
                        done: true,
                        records: [
                            {
                                Id: 's1',
                                Name: 'Platform',
                                LicenseDefinitionKey: 'A',
                                Status: 'Active',
                                TotalLicenses: 5,
                                UsedLicenses: 2
                            }
                        ]
                    }
                };
            }
        });

        const destination = await fetchUserLicensesForOrg({
            side: 'destination',
            refreshToken: 'rt-dest',
            instanceUrl: 'https://dest.my.salesforce.com',
            orgId: '00Ddest',
            refreshAccessTokenFn: async () => ({
                accessToken: 'dest-access',
                instanceUrl: 'https://dest.my.salesforce.com'
            }),
            fetchUserInfo: async () => ({
                organization_id: '00Ddest'
            }),
            httpGet: async (url) => {
                if (url.includes('/services/data/') && !url.includes('/query/')) {
                    return { data: [{ version: '62.0' }] };
                }

                return {
                    data: {
                        done: true,
                        records: [
                            {
                                Id: 'd1',
                                Name: 'Other',
                                LicenseDefinitionKey: 'B',
                                Status: 'Active',
                                TotalLicenses: 1,
                                UsedLicenses: 0
                            }
                        ]
                    }
                };
            }
        });

        const comparison = compareUserLicenses(
            source.licenses,
            destination.licenses
        );

        assert.strictEqual(comparison.both.length, 0);
        assert.strictEqual(comparison.sourceOnly.length, 1);
        assert.strictEqual(comparison.destinationOnly.length, 1);
        assert.strictEqual(source.instanceUrl, 'https://source.my.salesforce.com');
        assert.strictEqual(
            destination.instanceUrl,
            'https://dest.my.salesforce.com'
        );
    });

    await runTest('stripSensitiveText redacts token-like fragments', async () => {
        const sanitized = stripSensitiveText(
            'Bearer abc.def refresh_token=secret accessToken=also-secret'
        );

        assert.ok(!sanitized.includes('abc.def'));
        assert.ok(!sanitized.includes('secret'));
        assert.ok(sanitized.includes('[REDACTED]'));
    });
}

main();
