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

function normalizeExecutionTime(rawTime) {
    if (rawTime == null || rawTime === '') {
        return null;
    }

    return String(rawTime).replace(/\s+/g, '');
}

function getTestClassName(fullName) {
    if (!fullName) {
        return null;
    }

    const separatorIndex = fullName.lastIndexOf('.');

    if (separatorIndex === -1) {
        return fullName;
    }

    return fullName.slice(0, separatorIndex);
}

function getMethodName(fullName) {
    if (!fullName) {
        return null;
    }

    const separatorIndex = fullName.lastIndexOf('.');

    if (separatorIndex === -1) {
        return fullName;
    }

    return fullName.slice(separatorIndex + 1);
}

function isPassedOutcome(outcome) {
    return outcome && outcome.toLowerCase() === 'pass';
}

async function runApexTests(testClassNames, alias) {
    const testsArg = testClassNames.join(',');

    const command =
        `sf apex run test ` +
        `--tests "${testsArg}" ` +
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

function buildClassResult(testClass, classTests) {
    if (!classTests.length) {
        return {
            testClass,
            status: 'FAIL',
            methodsRun: 0,
            methodsPassed: 0,
            methodsFailed: 0,
            failedMethods: [],
            message: 'Test class did not run'
        };
    }

    const methodsRun = classTests.length;
    const passedTests = classTests.filter((test) =>
        isPassedOutcome(test.Outcome)
    );
    const failedTests = classTests.filter(
        (test) => !isPassedOutcome(test.Outcome)
    );
    const methodsPassed = passedTests.length;
    const methodsFailed = failedTests.length;
    const failedMethods = failedTests
        .map((test) => getMethodName(test.FullName))
        .filter(Boolean);

    if (methodsFailed > 0) {
        const firstFailure = failedTests[0];

        return {
            testClass,
            status: 'FAIL',
            methodsRun,
            methodsPassed,
            methodsFailed,
            failedMethods,
            message:
                firstFailure.Message ||
                firstFailure.StackTrace ||
                'Test execution failed'
        };
    }

    return {
        testClass,
        status: 'PASS',
        methodsRun,
        methodsPassed,
        methodsFailed: 0,
        failedMethods: []
    };
}

function buildClassResults(testClassNames, testResult) {
    const tests = testResult?.result?.tests || [];

    return testClassNames.map((testClass) => {
        const classTests = tests.filter(
            (test) => getTestClassName(test.FullName) === testClass
        );

        return buildClassResult(testClass, classTests);
    });
}

function extractRunSummary(testResult) {
    const summary = testResult?.result?.summary || {};

    return {
        testRunId: summary.testRunId || null,
        executionTime: normalizeExecutionTime(summary.testExecutionTime)
    };
}

async function executeTestsWithResults(testClassNames, alias) {
    if (!testClassNames.length) {
        return {
            results: [],
            overallStatus: 'PASS',
            testRunId: null,
            executionTime: null
        };
    }

    const testResult = await runApexTests(testClassNames, alias);
    const results = buildClassResults(testClassNames, testResult);
    const { testRunId, executionTime } = extractRunSummary(testResult);
    const overallStatus = results.every(
        (result) => result.status === 'PASS'
    )
        ? 'PASS'
        : 'FAIL';

    return {
        results,
        overallStatus,
        testRunId,
        executionTime
    };
}

module.exports = {
    executeTestsWithResults
};
