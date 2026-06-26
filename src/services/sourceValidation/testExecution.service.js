const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

function parseCliJson(output) {
    const start = output.indexOf('{');

    if (start === -1) {
        throw new Error('No JSON output from Salesforce CLI');
    }

    return JSON.parse(output.slice(start));
}

function mapTestOutcome(outcome) {
    if (!outcome) {
        return 'Unknown';
    }

    if (outcome.toLowerCase() === 'passed') {
        return 'Passed';
    }

    if (outcome.toLowerCase() === 'failed') {
        return 'Failed';
    }

    return outcome;
}

async function executeSelectedTests(testClassNames, alias) {
    if (!testClassNames.length) {
        return {
            executed: false,
            status: null,
            testRunId: null
        };
    }

    const testsArg = testClassNames.join(',');

    const command =
        `sf apex run test ` +
        `--tests "${testsArg}" ` +
        `--result-format json ` +
        `--target-org ${alias} ` +
        `--wait 10 ` +
        `--json`;

    let testResult;

    try {
        const result = await execAsync(command, {
            maxBuffer: 50 * 1024 * 1024
        });

        testResult = parseCliJson(result.stdout);
    } catch (error) {
        if (error.stdout) {
            testResult = parseCliJson(error.stdout);
        } else {
            throw error;
        }
    }

    const summary = testResult?.result?.summary || {};

    return {
        executed: true,
        status: mapTestOutcome(summary.outcome),
        testRunId: summary.testRunId || null
    };
}

module.exports = {
    executeSelectedTests
};
