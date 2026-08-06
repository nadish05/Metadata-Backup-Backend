const assert = require('assert');

const {
    NEGOTIATION_STATUS,
    negotiateDeploymentApiVersions,
    negotiateDeploymentApiVersionsSafe,
    emptyNegotiation
} = require('./deploymentApiNegotiation.service');
const {
    analyzeDeploymentCompatibilityPlan,
    CATEGORIES
} = require('./deploymentCompatibility.service');
const {
    shouldSkipDeploymentForCompatibility
} = require('./deploymentCompatibilityGate.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function main() {
    await runTest('Source > Destination → negotiated = destination', () => {
        const result = negotiateDeploymentApiVersions({
            sourceApiVersion: '66.0',
            destinationApiVersion: '64.0',
            currentDeploymentApiVersion: '61.0'
        });

        assert.strictEqual(result.sourceApiVersion, '66.0');
        assert.strictEqual(result.destinationApiVersion, '64.0');
        assert.strictEqual(result.currentDeploymentApiVersion, '61.0');
        assert.strictEqual(result.negotiatedApiVersion, '64.0');
        assert.strictEqual(result.effectiveCompatibilityApiVersion, '64.0');
        assert.strictEqual(
            result.negotiationStatus,
            NEGOTIATION_STATUS.READY_FOR_UPGRADE
        );
        assert.strictEqual(result.upgradeAvailable, true);
    });

    await runTest('Destination > Source → negotiated = source', () => {
        const result = negotiateDeploymentApiVersions({
            sourceApiVersion: '64.0',
            destinationApiVersion: '66.0',
            currentDeploymentApiVersion: '61.0'
        });

        assert.strictEqual(result.negotiatedApiVersion, '64.0');
        assert.strictEqual(
            result.negotiationStatus,
            NEGOTIATION_STATUS.READY_FOR_UPGRADE
        );
    });

    await runTest('Equal versions → negotiated = 64', () => {
        const result = negotiateDeploymentApiVersions({
            sourceApiVersion: '64.0',
            destinationApiVersion: '64.0',
            currentDeploymentApiVersion: '64.0'
        });

        assert.strictEqual(result.negotiatedApiVersion, '64.0');
        assert.strictEqual(
            result.negotiationStatus,
            NEGOTIATION_STATUS.SUCCESS
        );
        assert.strictEqual(result.upgradeAvailable, false);
        assert.strictEqual(result.effectiveCompatibilityApiVersion, '64.0');
    });

    await runTest('Unknown source', () => {
        const result = negotiateDeploymentApiVersions({
            sourceApiVersion: null,
            destinationApiVersion: '64.0',
            currentDeploymentApiVersion: '61.0'
        });

        assert.strictEqual(result.negotiationStatus, NEGOTIATION_STATUS.UNKNOWN);
        assert.strictEqual(result.negotiatedApiVersion, null);
        assert.strictEqual(result.effectiveCompatibilityApiVersion, '61.0');
    });

    await runTest('Unknown destination', () => {
        const result = negotiateDeploymentApiVersions({
            sourceApiVersion: '66.0',
            destinationApiVersion: null,
            currentDeploymentApiVersion: '61.0'
        });

        assert.strictEqual(result.negotiationStatus, NEGOTIATION_STATUS.UNKNOWN);
        assert.strictEqual(result.negotiatedApiVersion, null);
        assert.strictEqual(result.effectiveCompatibilityApiVersion, '61.0');
    });

    await runTest('Unknown both', () => {
        const result = negotiateDeploymentApiVersions({
            currentDeploymentApiVersion: '61.0'
        });

        assert.strictEqual(result.negotiationStatus, NEGOTIATION_STATUS.UNKNOWN);
        assert.strictEqual(result.sourceApiVersion, null);
        assert.strictEqual(result.destinationApiVersion, null);
        assert.strictEqual(result.effectiveCompatibilityApiVersion, '61.0');
    });

    await runTest('Existing compatibility planner unchanged', async () => {
        const plan = await analyzeDeploymentCompatibilityPlan({
            generatedDeploymentPackage: {
                metadata: [
                    {
                        metadataType: 'Flow',
                        metadataName: 'Booking_Flow',
                        content:
                            '<Flow><areMetricsLoggedToDataCloud>true</areMetricsLoggedToDataCloud></Flow>'
                    }
                ],
                dependencies: []
            },
            deploymentApiVersionPolicy: { deploymentApiVersion: '61.0' }
        });

        assert.ok(
            plan.compatibilityWarnings.some(
                (warning) => warning.category === CATEGORIES.FLOW_API_VERSION
            )
        );
        assert.strictEqual(
            plan.compatibilityWarnings.some(
                (warning) =>
                    warning.category === CATEGORIES.PERMISSION_SET_API_VERSION
            ),
            false
        );
    });

    await runTest('Existing deployment gate unchanged', () => {
        assert.strictEqual(
            shouldSkipDeploymentForCompatibility({
                readyForDeployment: true
            }),
            false
        );
        assert.strictEqual(
            shouldSkipDeploymentForCompatibility({
                readyForDeployment: false
            }),
            true
        );
    });

    await runTest('Existing workspace generation unchanged', () => {
        const workspace = require('./deploymentWorkspace.service');

        assert.strictEqual(typeof workspace.buildDeploymentWorkspace, 'function');
        assert.strictEqual(
            typeof workspace.createRepositoryFileReader,
            'function'
        );
    });

    await runTest('Fail-safe never throws', () => {
        const result = negotiateDeploymentApiVersionsSafe({
            sourceApiVersion: { bad: true },
            destinationApiVersion: '64.0',
            currentDeploymentApiVersion: '61.0'
        });

        assert.ok(result);
        assert.ok(
            Object.values(NEGOTIATION_STATUS).includes(result.negotiationStatus)
        );
        assert.deepStrictEqual(
            emptyNegotiation('61.0').currentDeploymentApiVersion,
            '61.0'
        );
    });
}

main();
