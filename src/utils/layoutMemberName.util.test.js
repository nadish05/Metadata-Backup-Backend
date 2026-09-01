const assert = require('assert');

const { parseLayoutMemberName } = require('./layoutMemberName.util');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function main() {
    await runTest('returns null for empty input', async () => {
        assert.strictEqual(parseLayoutMemberName(''), null);
        assert.strictEqual(parseLayoutMemberName(null), null);
    });

    await runTest('returns null when hyphen is missing', async () => {
        assert.strictEqual(parseLayoutMemberName('AccountLayout'), null);
    });

    await runTest('returns null when object name is empty', async () => {
        assert.strictEqual(parseLayoutMemberName('-Layout'), null);
    });
}

main();
