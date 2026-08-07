const assert = require('assert');

const {
    classifyDeploymentFailures
} = require('./deploymentFailureClassification.service');
const {
    buildResolutionReport,
    RESOLUTION_TYPES
} = require('./deploymentResolution.service');
const {
    applyAutoFixes,
    FIX_TYPES
} = require('./deploymentAutoFix.service');
const deploymentPackageService = require('../deploymentPackage.service');
const packageXmlService = require('../packageXml.service');

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

function packageContains(pkg, metadataType, metadataName) {
    const key = `${metadataType}:${metadataName}`.toLowerCase();
    const items = [...(pkg.metadata || []), ...(pkg.dependencies || [])];
    return items.some((item) => {
        const type = item.metadataType || item.type;
        const name = item.metadataName || item.name;
        return type && name && `${type}:${name}`.toLowerCase() === key;
    });
}

async function assertMissingDependencyAutoFix({
    metadataType,
    metadataName,
    problem
}) {
    const failureClassification = classifyDeploymentFailures({
        dependencyValidation: {
            overallStatus: 'BLOCKED',
            results: [
                {
                    name: metadataName,
                    type: metadataType,
                    status: 'BLOCKED',
                    message:
                        problem ||
                        `${metadataType} ${metadataName} not found in destination and not included in the package.`
                }
            ]
        }
    });

    const generatedDeploymentPackage = {
        metadata: [
            {
                metadataType: 'PermissionSet',
                metadataName: 'Gym_Trainer'
            }
        ],
        dependencies: [],
        testClasses: [],
        summary: {
            metadataCount: 1,
            dependencyCount: 0,
            testClassCount: 0,
            totalComponents: 1
        }
    };

    const resolutionReport = buildResolutionReport({
        failureClassification,
        deploymentPackage: generatedDeploymentPackage
    });

    assert.ok(
        resolutionReport.resolutions.some(
            (resolution) =>
                resolution.metadataType === metadataType &&
                resolution.metadataName === metadataName &&
                (resolution.resolutionType === RESOLUTION_TYPES.DEPENDENCY ||
                    resolution.resolutionType === RESOLUTION_TYPES.PACKAGE)
        ),
        `Expected DEPENDENCY/PACKAGE resolution for ${metadataType}:${metadataName}`
    );

    const resolvedDependencies = [
        {
            type: metadataType,
            name: metadataName,
            action: 'SKIP',
            selected: false,
            required: true,
            sourceExists: true,
            artifactResolved: true,
            filePath: `force-app/main/default/${metadataType}/${metadataName}`
        }
    ];

    let workspaceCalls = 0;

    const result = await applyAutoFixes(
        {
            failureClassification,
            resolutionReport,
            resolvedDependencies,
            deploymentPackage: {
                selectedMetadata: [
                    {
                        metadataType: 'PermissionSet',
                        metadataName: 'Gym_Trainer'
                    }
                ],
                requiredDependencies: resolvedDependencies,
                repoUrl: 'https://example.com/repo.git',
                sourceBranch: 'main'
            },
            generatedDeploymentPackage,
            generatedWorkspace: {
                workspaceCreated: true,
                status: 'READY'
            },
            selectedMetadata: [
                {
                    metadataType: 'PermissionSet',
                    metadataName: 'Gym_Trainer'
                }
            ],
            repoUrl: 'https://example.com/repo.git',
            sourceBranch: 'main',
            deploymentApiVersion: '62.0'
        },
        {
            generateDeploymentPackage:
                deploymentPackageService.generateDeploymentPackage,
            generateManifest: packageXmlService.generateManifest,
            buildDeploymentWorkspace: async () => {
                workspaceCalls += 1;
                return {
                    workspaceCreated: true,
                    status: 'READY',
                    packageXmlWritten: true
                };
            }
        }
    );

    assert.strictEqual(result.autoFixAvailable, true);
    assert.strictEqual(result.autoFixApplied, true);
    assert.ok(
        packageContains(
            result.generatedDeploymentPackage,
            metadataType,
            metadataName
        ),
        `Expected regenerated package to include ${metadataType}:${metadataName}`
    );

    const includeFix = result.fixes.find(
        (fix) =>
            fix.fixType === FIX_TYPES.INCLUDE_DISCOVERED_DEPENDENCY &&
            fix.metadataType === metadataType &&
            fix.metadataName === metadataName
    );
    assert.ok(includeFix, 'Expected INCLUDE_DISCOVERED_DEPENDENCY fix');
    assert.strictEqual(includeFix.executed, true);
    assert.strictEqual(includeFix.successful, true);

    const regenerateFix = result.fixes.find(
        (fix) => fix.fixType === FIX_TYPES.REGENERATE_PACKAGE
    );
    assert.ok(regenerateFix, 'Expected REGENERATE_PACKAGE fix');
    assert.strictEqual(regenerateFix.executed, true);
    assert.strictEqual(regenerateFix.successful, true);

    const rebuildFix = result.fixes.find(
        (fix) => fix.fixType === FIX_TYPES.REBUILD_WORKSPACE
    );
    assert.ok(rebuildFix, 'Expected REBUILD_WORKSPACE fix');
    assert.strictEqual(rebuildFix.executed, true);
    assert.strictEqual(rebuildFix.successful, true);
    assert.strictEqual(workspaceCalls, 1);
}

async function main() {
    await runTest('Missing ApexClass auto-fix includes dependency', () =>
        assertMissingDependencyAutoFix({
            metadataType: 'ApexClass',
            metadataName: 'TrainerService'
        })
    );

    await runTest('Missing Flow auto-fix includes dependency', () =>
        assertMissingDependencyAutoFix({
            metadataType: 'Flow',
            metadataName: 'Trainer_Onboarding'
        })
    );

    await runTest('Missing CustomObject auto-fix includes dependency', () =>
        assertMissingDependencyAutoFix({
            metadataType: 'CustomObject',
            metadataName: 'Gym_Trainer__c'
        })
    );

    await runTest(
        'Missing ExternalCredential auto-fix includes dependency',
        () =>
            assertMissingDependencyAutoFix({
                metadataType: 'ExternalCredential',
                metadataName: 'Weather'
            })
    );

    await runTest('Missing CustomTab auto-fix includes dependency', () =>
        assertMissingDependencyAutoFix({
            metadataType: 'CustomTab',
            metadataName: 'Gym_Trainer'
        })
    );

    await runTest(
        'Missing CustomPermission auto-fix includes dependency',
        () =>
            assertMissingDependencyAutoFix({
                metadataType: 'CustomPermission',
                metadataName: 'Manage_Trainers'
            })
    );

    await runTest(
        'Missing ExternalDataSource auto-fix includes dependency',
        () =>
            assertMissingDependencyAutoFix({
                metadataType: 'ExternalDataSource',
                metadataName: 'Weather_API'
            })
    );

    await runTest(
        'Missing CustomApplication auto-fix includes dependency',
        () =>
            assertMissingDependencyAutoFix({
                metadataType: 'CustomApplication',
                metadataName: 'Gym_Console'
            })
    );

    await runTest(
        'No auto-fix when resolved dependency has no artifact',
        async () => {
            const failureClassification = classifyDeploymentFailures({
                dependencyValidation: {
                    overallStatus: 'BLOCKED',
                    results: [
                        {
                            name: 'MissingClass',
                            type: 'ApexClass',
                            status: 'BLOCKED',
                            message: 'ApexClass not found in destination.'
                        }
                    ]
                }
            });
            const generatedDeploymentPackage = {
                metadata: [],
                dependencies: []
            };
            const resolutionReport = buildResolutionReport({
                failureClassification,
                deploymentPackage: generatedDeploymentPackage
            });

            const result = await applyAutoFixes({
                resolutionReport,
                resolvedDependencies: [
                    {
                        type: 'ApexClass',
                        name: 'MissingClass',
                        action: 'BLOCK',
                        selected: false,
                        sourceExists: false,
                        artifactResolved: false
                    }
                ],
                generatedDeploymentPackage,
                selectedMetadata: []
            });

            assert.strictEqual(result.autoFixAvailable, false);
            assert.strictEqual(result.autoFixApplied, false);
            assert.strictEqual(result.fixes.length, 0);
        }
    );

    await runTest(
        'PersonAccount / ENABLE_FEATURE is not auto-fixed',
        async () => {
            const failureClassification = classifyDeploymentFailures({
                deployOutcome: {
                    success: false,
                    failureDetails: [
                        {
                            componentName: 'PersonAccount.PersonAccount',
                            metadataType: 'RecordType',
                            problem:
                                'no RecordType named PersonAccount.PersonAccount found'
                        }
                    ]
                }
            });
            const resolutionReport = buildResolutionReport({
                failureClassification
            });

            const result = await applyAutoFixes({
                failureClassification,
                resolutionReport,
                resolvedDependencies: [],
                generatedDeploymentPackage: { metadata: [], dependencies: [] },
                selectedMetadata: []
            });

            assert.strictEqual(result.autoFixAvailable, false);
            assert.strictEqual(result.autoFixApplied, false);
            assert.ok(
                !result.fixes.some(
                    (fix) =>
                        fix.fixType === FIX_TYPES.INCLUDE_DISCOVERED_DEPENDENCY
                )
            );
        }
    );
}

main();
