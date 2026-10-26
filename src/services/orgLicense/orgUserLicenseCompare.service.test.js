'use strict';

const assert = require('assert');

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
    await runTest('successful comparison with matching keys', async () => {
        const result = compareUserLicenses(
            [
                {
                    Id: 's1',
                    Name: 'Salesforce',
                    LicenseDefinitionKey: 'SFDC',
                    Status: 'Active',
                    TotalLicenses: 10,
                    UsedLicenses: 5
                }
            ],
            [
                {
                    Id: 'd1',
                    Name: 'Salesforce Platform',
                    LicenseDefinitionKey: 'SFDC',
                    Status: 'Active',
                    TotalLicenses: 20,
                    UsedLicenses: 8
                }
            ]
        );

        assert.strictEqual(result.both.length, 1);
        assert.strictEqual(result.both[0].licenseDefinitionKey, 'SFDC');
        assert.strictEqual(result.both[0].source.name, 'Salesforce');
        assert.strictEqual(
            result.both[0].destination.name,
            'Salesforce Platform'
        );
        assert.strictEqual(result.sourceOnly.length, 0);
        assert.strictEqual(result.destinationOnly.length, 0);
    });

    await runTest('source-only and destination-only licences', async () => {
        const result = compareUserLicenses(
            [
                {
                    Id: 's1',
                    Name: 'A',
                    LicenseDefinitionKey: 'KEY_A',
                    Status: 'Active'
                }
            ],
            [
                {
                    Id: 'd1',
                    Name: 'B',
                    LicenseDefinitionKey: 'KEY_B',
                    Status: 'Active'
                }
            ]
        );

        assert.strictEqual(result.both.length, 0);
        assert.strictEqual(result.sourceOnly.length, 1);
        assert.strictEqual(result.sourceOnly[0].licenseDefinitionKey, 'KEY_A');
        assert.strictEqual(result.destinationOnly.length, 1);
        assert.strictEqual(
            result.destinationOnly[0].licenseDefinitionKey,
            'KEY_B'
        );
    });

    await runTest('missing comparison keys are unmatched, not merged by name', async () => {
        const result = compareUserLicenses(
            [
                {
                    Id: 's1',
                    Name: 'Same Label',
                    LicenseDefinitionKey: null,
                    Status: 'Active'
                }
            ],
            [
                {
                    Id: 'd1',
                    Name: 'Same Label',
                    LicenseDefinitionKey: null,
                    Status: 'Active'
                }
            ]
        );

        assert.strictEqual(result.both.length, 0);
        assert.strictEqual(result.unmatched.source.length, 1);
        assert.strictEqual(result.unmatched.destination.length, 1);
        assert.ok(result.warnings.length >= 2);
    });

    await runTest('counts are preserved but not used as keys', async () => {
        const result = compareUserLicenses(
            [
                {
                    Id: 's1',
                    Name: 'X',
                    LicenseDefinitionKey: 'K1',
                    TotalLicenses: 1,
                    UsedLicenses: 1
                }
            ],
            [
                {
                    Id: 'd1',
                    Name: 'Y',
                    LicenseDefinitionKey: 'K1',
                    TotalLicenses: 99,
                    UsedLicenses: 0
                }
            ]
        );

        assert.strictEqual(result.both.length, 1);
        assert.strictEqual(result.both[0].source.totalLicenses, 1);
        assert.strictEqual(result.both[0].destination.totalLicenses, 99);
    });
}

main();
