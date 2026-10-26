'use strict';

const assert = require('assert');

const { compareOrgUserLicenses } = require('./orgLicense.controller');

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

function mockRes() {
    const res = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(payload) {
            this.body = payload;
            return this;
        }
    };

    return res;
}

async function main() {
    await runTest('controller returns 400 for invalid payload', async () => {
        const res = mockRes();

        await compareOrgUserLicenses({ body: { source: {} } }, res);

        assert.strictEqual(res.statusCode, 400);
        assert.strictEqual(res.body.success, false);
        assert.ok(res.body.error);
        assert.strictEqual(res.body.refreshToken, undefined);
    });
}

main();
