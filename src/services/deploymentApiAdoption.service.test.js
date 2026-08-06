const assert = require('assert');

const {
    NEGOTIATION_STATUS,
    resolveDeploymentApiVersion
} = require('./deploymentApiNegotiation.service');
const { generateManifest } = require('./packageXml.service');
const {
    buildProjectDeployCommand
} = require('./checkOnlyDeployment.service');
const {
    analyzePermissionSetCompatibility
} = require('./deploymentPermissionSetCompatibility.service');
const {
    analyzeDeploymentCompatibilityPlan,
    CATEGORIES
} = require('./deploymentCompatibility.service');
const { buildDeploymentPreview } = require('./deploymentPreview.service');

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

function packageWith(metadata = []) {
    return {
        metadata,
        dependencies: [],
        testClasses: []
    };
}

async function main() {
    await runTest('Negotiated version is adopted only when ready', () => {
        assert.strictEqual(
            resolveDeploymentApiVersion({
                deploymentApiNegotiation: {
                    negotiationStatus: NEGOTIATION_STATUS.READY_FOR_UPGRADE,
                    negotiatedApiVersion: '64.0',
                    currentDeploymentApiVersion: '61.0'
                }
            }),
            '64.0'
        );
    });

    await runTest('Unknown negotiation falls back to current version', () => {
        assert.strictEqual(
            resolveDeploymentApiVersion({
                deploymentApiNegotiation: {
                    negotiationStatus: NEGOTIATION_STATUS.UNKNOWN,
                    negotiatedApiVersion: null,
                    currentDeploymentApiVersion: '61.0'
                }
            }),
            '61.0'
        );
    });

    await runTest('Failed negotiation falls back to current version', () => {
        assert.strictEqual(
            resolveDeploymentApiVersion({
                deploymentApiNegotiation: {
                    negotiationStatus: 'FAILED',
                    negotiatedApiVersion: '64.0',
                    currentDeploymentApiVersion: '61.0'
                }
            }),
            '61.0'
        );
    });

    await runTest('Invalid negotiated version falls back safely', () => {
        assert.strictEqual(
            resolveDeploymentApiVersion({
                deploymentApiNegotiation: {
                    negotiationStatus: NEGOTIATION_STATUS.READY_FOR_UPGRADE,
                    negotiatedApiVersion: 'invalid',
                    currentDeploymentApiVersion: '61.0'
                }
            }),
            '61.0'
        );
    });

    await runTest('Package.xml uses adopted deployment API version', () => {
        const manifest = generateManifest(packageWith(), {
            deploymentApiVersion: '64.0',
            deploymentApiVersionPolicy: {
                deploymentApiVersion: '64.0'
            }
        });

        assert.match(manifest.packageXml, /<version>64\.0<\/version>/);
        assert.strictEqual(manifest.summary.apiVersion, '64.0');
    });

    await runTest('Package.xml preserves fallback deployment API version', () => {
        const manifest = generateManifest(packageWith(), {
            deploymentApiVersion: '61.0',
            deploymentApiVersionPolicy: {
                deploymentApiVersion: '61.0'
            }
        });

        assert.match(manifest.packageXml, /<version>61\.0<\/version>/);
        assert.strictEqual(manifest.summary.apiVersion, '61.0');
    });

    await runTest('Salesforce CLI receives adopted API version', () => {
        const command = buildProjectDeployCommand({
            workspacePath: '/tmp/deployment',
            alias: 'destination',
            deploymentApiVersion: '64.0',
            deploymentValidationFlag: '--dry-run'
        });

        assert.match(command, /--api-version "64\.0"/);
        assert.match(command, /--dry-run/);
        assert.match(command, /--manifest package\.xml/);
    });

    await runTest(
        'PermissionSet is compatible when effective API satisfies requirement',
        async () => {
            const metadata = [
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Subscription_Access',
                    content:
                        '<PermissionSet><objectPermissions><object>Account</object><viewAllFields>true</viewAllFields></objectPermissions></PermissionSet>'
                }
            ];
            const permissionSetCompatibility =
                await analyzePermissionSetCompatibility({
                    generatedDeploymentPackage: packageWith(metadata),
                    deploymentApiVersionPolicy: {
                        deploymentApiVersion: '64.0'
                    }
                });
            const plan = await analyzeDeploymentCompatibilityPlan({
                generatedDeploymentPackage: packageWith(metadata),
                permissionSetCompatibility,
                deploymentApiVersionPolicy: {
                    deploymentApiVersion: '64.0'
                }
            });

            assert.strictEqual(
                permissionSetCompatibility.summary.incompatible,
                0
            );
            assert.strictEqual(
                plan.compatibilityWarnings.some(
                    (warning) =>
                        warning.category ===
                        CATEGORIES.PERMISSION_SET_API_VERSION
                ),
                false
            );
            assert.deepStrictEqual(plan.blockingComponents, []);
        }
    );

    await runTest('Formula compatibility remains unchanged', async () => {
        const plan = await analyzeDeploymentCompatibilityPlan({
            generatedDeploymentPackage: packageWith(),
            formulaCompatibility: {
                warnings: [
                    {
                        metadataName: 'Booking__c.Total__c',
                        metadataType: 'CustomField',
                        category: 'MISSING_FIELD',
                        severity: 'WARNING',
                        message: 'Formula references a missing field.'
                    }
                ]
            },
            deploymentApiVersionPolicy: {
                deploymentApiVersion: '64.0'
            }
        });

        assert.ok(
            plan.compatibilityWarnings.some(
                (warning) =>
                    warning.category === CATEGORIES.FORMULA_COMPILATION
            )
        );
    });

    await runTest('Preview reports adopted deployment API version', () => {
        const preview = buildDeploymentPreview({
            generatedDeploymentPackage: packageWith(),
            deploymentApiNegotiation: {
                currentDeploymentApiVersion: '64.0',
                sourceApiVersion: '66.0',
                destinationApiVersion: '64.0',
                negotiatedApiVersion: '64.0',
                negotiationStatus: NEGOTIATION_STATUS.READY_FOR_UPGRADE
            }
        });

        assert.strictEqual(preview.metadataApi.currentDeploymentApi, '64.0');
        assert.strictEqual(preview.metadataApi.negotiatedApi, '64.0');
    });

    await runTest('Workspace generation contract is unchanged', () => {
        const workspace = require('./deploymentWorkspace.service');

        assert.strictEqual(
            typeof workspace.buildDeploymentWorkspace,
            'function'
        );
        assert.strictEqual(
            typeof workspace.createRepositoryFileReader,
            'function'
        );
    });
}

main();
