'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const axios = require('axios');

const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const rm = util.promisify(fs.rm);

const relationshipDiscoveryService = require('./dependencyResolution/relationshipDiscovery.service');
const referenceDiscoveryService = require('./dependencyResolution/referenceDiscovery.service');
const graphExpansionService = require('./dependencyResolution/graphExpansion/graphExpansion.service');
const dependencyResolutionService = require('./dependencyResolution/dependencyResolution.service');
const dependencyValidationService = require('./dependencyValidation.service');
const metadataValidationService = require('./metadataValidation.service');
const checkOnlyDeploymentService = require('./checkOnlyDeployment.service');
const deploymentWorkspaceService = require('./deploymentWorkspace.service');
const statusStore = require('./deploymentValidationStatus.store');
const boundDeployService = require('./deploymentBoundDeploy.service');
const {
    buildBoundDeployArtifactRecord
} = require('./deploymentBoundArtifact.service');

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

const connectivityPass = {
    success: true,
    deploymentValidation: {
        destinationConnected: true,
        status: 'PASS',
        message: 'Successfully authenticated with destination org.'
    }
};

function patchConnectivity() {
    const originalPost = axios.post;
    const originalGet = axios.get;

    axios.post = async () => ({
        data: {
            access_token: 'test-token',
            instance_url: 'https://test.example.my.salesforce.com'
        }
    });
    axios.get = async () => ({ status: 200 });

    return () => {
        axios.post = originalPost;
        axios.get = originalGet;
    };
}

function installDiscoverySpies() {
    const calls = {
        discoverRelationships: 0,
        discoverReferences: 0,
        expandMetadataGraph: 0,
        resolveDependencies: 0,
        validateDependencies: 0
    };

    const originals = {
        discoverRelationships:
            relationshipDiscoveryService.discoverRelationships,
        discoverReferences: referenceDiscoveryService.discoverReferences,
        expandMetadataGraph: graphExpansionService.expandMetadataGraph,
        resolveDependencies: dependencyResolutionService.resolveDependencies,
        validateDependencies: dependencyValidationService.validateDependencies
    };

    relationshipDiscoveryService.discoverRelationships = async () => {
        calls.discoverRelationships += 1;
        return {
            enrichedDependencies: [],
            summary: {
                metadataScanned: 0,
                filesScanned: 0,
                relationshipsDiscovered: 0,
                lookupRelationships: 0,
                masterDetailRelationships: 0,
                warnings: []
            },
            discoveredRelationships: []
        };
    };
    referenceDiscoveryService.discoverReferences = async () => {
        calls.discoverReferences += 1;
        return {
            enrichedDependencies: [],
            summary: {
                referencesDiscovered: 0,
                byType: {},
                blockingReferences: 0,
                deployableReferences: 0,
                warnings: []
            },
            discoveredReferences: []
        };
    };
    graphExpansionService.expandMetadataGraph = async () => {
        calls.expandMetadataGraph += 1;
        return {
            enrichedDependencies: [],
            summary: {
                iterations: 0,
                graphDepth: 0,
                metadataNodes: 0,
                relationships: 0,
                newDependencies: 0,
                warnings: []
            },
            discoveredEdges: []
        };
    };
    dependencyResolutionService.resolveDependencies = async () => {
        calls.resolveDependencies += 1;
        return {
            resolvedDependencies: [],
            summary: {
                analyzed: 0,
                deploy: 0,
                reference: 0,
                skip: 0,
                block: 0,
                warnings: []
            }
        };
    };
    dependencyValidationService.validateDependencies = async () => {
        calls.validateDependencies += 1;
        return {
            overallStatus: 'PASS',
            results: []
        };
    };

    return {
        calls,
        restore() {
            relationshipDiscoveryService.discoverRelationships =
                originals.discoverRelationships;
            referenceDiscoveryService.discoverReferences =
                originals.discoverReferences;
            graphExpansionService.expandMetadataGraph =
                originals.expandMetadataGraph;
            dependencyResolutionService.resolveDependencies =
                originals.resolveDependencies;
            dependencyValidationService.validateDependencies =
                originals.validateDependencies;
        }
    };
}

function loadValidationServiceFresh() {
    const modulePath = require.resolve('./deploymentValidation.service');
    delete require.cache[modulePath];
    return require('./deploymentValidation.service');
}

async function createProfileWorkspaceRoot() {
    const root = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'profile-only-val-')
    );
    await createProfileWorkspaceRootAt(root);
    return root;
}

async function createProfileWorkspaceRootAt(root) {
    const profilesDir = path.join(root, 'profiles');
    await mkdir(profilesDir, { recursive: true });
    await writeFile(
        path.join(profilesDir, 'Admin.profile-meta.xml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"/>\n',
        'utf8'
    );
    await writeFile(
        path.join(profilesDir, 'Standard.profile-meta.xml'),
        '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata"/>\n',
        'utf8'
    );
    return root;
}

async function createBoundReadyWorkspace(generatedManifest) {
    const root = await createProfileWorkspaceRoot();
    await writeFile(
        path.join(root, 'package.xml'),
        generatedManifest?.packageXml ||
            '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>Admin</members>\n    <name>Profile</name>\n  </types>\n  <version>61.0</version>\n</Package>\n',
        'utf8'
    );
    return root;
}

function baseDeploymentPackage(overrides = {}) {
    return {
        repoUrl: 'https://example.com/org/repo.git',
        sourceBranch: 'main',
        selectedMetadata: [
            {
                metadataType: 'Profile',
                metadataName: 'Admin'
            }
        ],
        requiredDependencies: [
            {
                type: 'CustomField',
                name: 'Account.Industry',
                action: 'DEPLOY',
                selected: true,
                required: true
            }
        ],
        ...overrides
    };
}

async function main() {
    await runTest(
        'checkbox OFF reaches relationship discovery in legacy pipeline',
        async () => {
            const restoreAxios = patchConnectivity();
            const spies = installDiscoverySpies();
            const originalMetadataValidation =
                metadataValidationService.validateMetadataPackage;
            const originalBuildWorkspace =
                deploymentWorkspaceService.buildDeploymentWorkspace;
            const originalCheckOnly =
                checkOnlyDeploymentService.runCheckOnlyDeployment;

            metadataValidationService.validateMetadataPackage = async () => ({
                overallStatus: 'PASS',
                results: []
            });
            deploymentWorkspaceService.buildDeploymentWorkspace = async () => ({
                status: 'READY',
                workspacePath: await createProfileWorkspaceRoot(),
                dependenciesCopied: 1,
                metadataCopied: 1
            });
            checkOnlyDeploymentService.runCheckOnlyDeployment = async () => ({
                success: true,
                status: 'SUCCESS'
            });

            try {
                const validationService = loadValidationServiceFresh();
                const result = await validationService.validateDeployment({
                    refreshToken: 'rt',
                    instanceUrl: 'https://test.example.my.salesforce.com',
                    orgId: '00DTEST',
                    deploymentPackage: baseDeploymentPackage({
                        profileOnlyMinimalPackage: false
                    })
                });

                assert.strictEqual(
                    spies.calls.discoverRelationships,
                    1,
                    'legacy path must invoke relationship discovery'
                );
                assert.strictEqual(result.validationExecutionPath, undefined);
            } finally {
                metadataValidationService.validateMetadataPackage =
                    originalMetadataValidation;
                deploymentWorkspaceService.buildDeploymentWorkspace =
                    originalBuildWorkspace;
                checkOnlyDeploymentService.runCheckOnlyDeployment =
                    originalCheckOnly;
                spies.restore();
                restoreAxios();
            }
        }
    );

    await runTest(
        'checkbox ON skips entire dependency discovery pipeline',
        async () => {
            const restoreAxios = patchConnectivity();
            const spies = installDiscoverySpies();
            const originalBuild =
                deploymentWorkspaceService.buildDeploymentWorkspace;
            const originalCheckOnly =
                checkOnlyDeploymentService.runCheckOnlyDeployment;
            let workspaceRootToCleanup = null;

            deploymentWorkspaceService.buildDeploymentWorkspace = async (
                args
            ) => {
                assert.strictEqual(args.skipDependencyCopy, true);
                assert.deepStrictEqual(
                    args.generatedDeploymentPackage.dependencies,
                    []
                );
                const workspaceRoot = await createBoundReadyWorkspace(
                    args.generatedManifest
                );
                workspaceRootToCleanup = workspaceRoot;
                return {
                    status: 'READY',
                    workspacePath: workspaceRoot,
                    workspaceCreated: true,
                    metadataCopied:
                        args.generatedDeploymentPackage.metadata.length,
                    dependenciesCopied: 0,
                    copiedFiles: 2,
                    missingFiles: []
                };
            };
            checkOnlyDeploymentService.runCheckOnlyDeployment = async () => ({
                success: true,
                status: 'SUCCESS',
                executed: true,
                deploymentId: '0AfCHECK'
            });

            try {
                const validationService = loadValidationServiceFresh();
                const result = await validationService.validateDeployment({
                    refreshToken: 'rt',
                    instanceUrl: 'https://test.example.my.salesforce.com',
                    orgId: '00DTEST',
                    validationId: 'val-profile-only-1',
                    deploymentPackage: baseDeploymentPackage({
                        profileOnlyMinimalPackage: true
                    })
                });

                assert.strictEqual(
                    result.validationExecutionPath,
                    validationService.PROFILE_ONLY_MINIMAL_EXECUTION_PATH
                );
                assert.strictEqual(spies.calls.discoverRelationships, 0);
                assert.strictEqual(spies.calls.discoverReferences, 0);
                assert.strictEqual(spies.calls.expandMetadataGraph, 0);
                assert.strictEqual(spies.calls.resolveDependencies, 0);
                assert.strictEqual(spies.calls.validateDependencies, 0);
                assert.strictEqual(result.generatedDeploymentPackage.metadata.length, 1);
                assert.strictEqual(
                    result.generatedDeploymentPackage.metadata[0].metadataName,
                    'Admin'
                );
                assert.deepStrictEqual(
                    result.generatedDeploymentPackage.dependencies,
                    []
                );
                assert.ok(result.generatedManifest.packageXml.includes('<name>Profile</name>'));
                assert.ok(!result.generatedManifest.packageXml.includes('CustomField'));
                assert.strictEqual(result.generatedWorkspace.dependenciesCopied, 0);
                assert.strictEqual(result.deploymentReadiness.canDeploy, true);
                assert.ok(result.boundDeployArtifact?.artifactDigest);
            } finally {
                deploymentWorkspaceService.buildDeploymentWorkspace =
                    originalBuild;
                checkOnlyDeploymentService.runCheckOnlyDeployment =
                    originalCheckOnly;
                spies.restore();
                restoreAxios();
                if (workspaceRootToCleanup) {
                    await rm(workspaceRootToCleanup, {
                        recursive: true,
                        force: true
                    });
                }
            }
        }
    );

    await runTest(
        'checkbox ON with multiple Profiles generates exactly those Profiles',
        async () => {
            const validationService = loadValidationServiceFresh();
            const workspaceRoot = await createProfileWorkspaceRoot();
            const originalBuild =
                deploymentWorkspaceService.buildDeploymentWorkspace;
            const originalCheckOnly =
                checkOnlyDeploymentService.runCheckOnlyDeployment;

            deploymentWorkspaceService.buildDeploymentWorkspace = async () => ({
                status: 'READY',
                workspacePath: workspaceRoot,
                dependenciesCopied: 0,
                metadataCopied: 2
            });
            checkOnlyDeploymentService.runCheckOnlyDeployment = async () => ({
                success: true,
                status: 'SUCCESS',
                executed: true
            });

            try {
                const result =
                    await validationService.runProfileOnlyMinimalValidation({
                        connectivityResult: connectivityPass,
                        deploymentPackage: baseDeploymentPackage({
                            profileOnlyMinimalPackage: true,
                            selectedMetadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin'
                                },
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Standard'
                                }
                            ]
                        }),
                        refreshToken: 'rt',
                        instanceUrl: 'https://test.example.my.salesforce.com',
                        orgId: '00DTEST'
                    });

                assert.strictEqual(
                    result.generatedDeploymentPackage.metadata.length,
                    2
                );
                const names = result.generatedDeploymentPackage.metadata
                    .map((item) => item.metadataName)
                    .sort();
                assert.deepStrictEqual(names, ['Admin', 'Standard']);
            } finally {
                deploymentWorkspaceService.buildDeploymentWorkspace =
                    originalBuild;
                checkOnlyDeploymentService.runCheckOnlyDeployment =
                    originalCheckOnly;
                await rm(workspaceRoot, { recursive: true, force: true });
            }
        }
    );

    await runTest('empty Profile selection is rejected', async () => {
        const validationService = loadValidationServiceFresh();
        const result = await validationService.validateDeployment({
            refreshToken: 'rt',
            instanceUrl: 'https://test.example.my.salesforce.com',
            orgId: '00DTEST',
            deploymentPackage: baseDeploymentPackage({
                profileOnlyMinimalPackage: true,
                selectedMetadata: []
            })
        });

        assert.strictEqual(result.profileOnlyMinimalPackageBlocked, true);
        assert.strictEqual(
            result.profileOnlyMinimalPackageIneligibilityReason,
            'empty_selection'
        );
        assert.strictEqual(result.deploymentReadiness.canDeploy, false);
    });

    await runTest('non-Profile explicit selection is rejected', async () => {
        const validationService = loadValidationServiceFresh();
        const result = await validationService.validateDeployment({
            refreshToken: 'rt',
            instanceUrl: 'https://test.example.my.salesforce.com',
            orgId: '00DTEST',
            deploymentPackage: baseDeploymentPackage({
                profileOnlyMinimalPackage: true,
                selectedMetadata: [
                    { metadataType: 'ApexClass', metadataName: 'Foo' }
                ]
            })
        });

        assert.strictEqual(result.profileOnlyMinimalPackageBlocked, true);
        assert.strictEqual(
            result.profileOnlyMinimalPackageIneligibilityReason,
            'mixed_or_non_profile_selection'
        );
    });

    await runTest('check-only failures are returned without auto dependency fixes', async () => {
        const validationService = loadValidationServiceFresh();
        const workspaceRoot = await createProfileWorkspaceRoot();
        const originalBuild =
            deploymentWorkspaceService.buildDeploymentWorkspace;
        const originalCheckOnly =
            checkOnlyDeploymentService.runCheckOnlyDeployment;

        deploymentWorkspaceService.buildDeploymentWorkspace = async () => ({
            status: 'READY',
            workspacePath: workspaceRoot,
            dependenciesCopied: 0,
            metadataCopied: 1
        });
        checkOnlyDeploymentService.runCheckOnlyDeployment = async () => ({
            success: false,
            status: 'FAILURE',
            executed: true,
            message: 'Profile Admin: unknown user permission'
        });

        try {
            const result =
                await validationService.runProfileOnlyMinimalValidation({
                    connectivityResult: connectivityPass,
                    deploymentPackage: baseDeploymentPackage({
                        profileOnlyMinimalPackage: true
                    }),
                    refreshToken: 'rt',
                    instanceUrl: 'https://test.example.my.salesforce.com',
                    orgId: '00DTEST',
                    validationId: 'val-checkonly-fail'
                });

            assert.strictEqual(result.checkOnlyDeployment.success, false);
            assert.strictEqual(result.deploymentReadiness.canDeploy, false);
            assert.strictEqual(result.boundDeployArtifact, undefined);
            assert.strictEqual(
                result.dependencyValidation.overallStatus,
                'SKIPPED'
            );
        } finally {
            deploymentWorkspaceService.buildDeploymentWorkspace = originalBuild;
            checkOnlyDeploymentService.runCheckOnlyDeployment =
                originalCheckOnly;
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    await runTest(
        'bound deployment consumes the exact validated artifact',
        async () => {
            statusStore.clearAllJobs();
            statusStore.resetTtlForTests();

            const workspacePath = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'profile-bound-ws-')
            );
            const packageXml =
                '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>Admin</members>\n    <name>Profile</name>\n  </types>\n  <version>62.0</version>\n</Package>\n';
            await writeFile(
                path.join(workspacePath, 'package.xml'),
                packageXml,
                'utf8'
            );
            await createProfileWorkspaceRootAt(workspacePath);

            const validationId = statusStore.createJob();
            const orgId = '00DBOUNDORG';
            const finalResponse = {
                deploymentReadiness: { canDeploy: true },
                checkOnlyDeployment: {
                    executed: true,
                    success: true,
                    status: 'SUCCESS'
                },
                generatedWorkspace: {
                    status: 'READY',
                    workspacePath
                },
                generatedManifest: {
                    packageXml,
                    summary: { apiVersion: '62.0' }
                },
                generatedDeploymentPackage: {
                    profileOnlyMinimalPackage: true,
                    metadata: [
                        { metadataType: 'Profile', metadataName: 'Admin' }
                    ],
                    dependencies: []
                }
            };

            const artifact = await buildBoundDeployArtifactRecord({
                validationId,
                orgId,
                deploymentPackage: {
                    profileOnlyMinimalPackage: true,
                    autoExcludeShapeFormulaConflicts: false
                },
                finalResponse
            });

            finalResponse.boundDeployArtifact = artifact;
            statusStore.completeJob(validationId, finalResponse);

            boundDeployService.setResolveVerifiedDestinationOrgIdForTests(
                async () => orgId
            );
            let capturedWorkspacePath = null;
            boundDeployService.setRunDeploymentExecutionForTests(async ({
                generatedWorkspace
            }) => {
                capturedWorkspacePath = generatedWorkspace?.workspacePath;
                return {
                    success: true,
                    status: 'SUCCESS',
                    deploymentId: '0AfBOUND'
                };
            });
            boundDeployService.setRunDeployAfterOptionalSnapshotForTests(
                async ({ runDeploymentExecution }) => ({
                    deploymentExecution: await runDeploymentExecution(),
                    snapshot: null,
                    snapshotBlocked: false
                })
            );

            try {
                const deployResult =
                    await boundDeployService.deployBoundValidationArtifact({
                        boundValidationId: validationId,
                        refreshToken: 'rt',
                        instanceUrl: 'https://test.example.my.salesforce.com',
                        orgId
                    });

                assert.strictEqual(deployResult.success, true);
                assert.strictEqual(capturedWorkspacePath, workspacePath);
            } finally {
                boundDeployService.resetRunDeploymentExecutionForTests();
                boundDeployService.resetRunDeployAfterOptionalSnapshotForTests();
                boundDeployService.resetResolveVerifiedDestinationOrgIdForTests();
                statusStore.clearAllJobs();
                await rm(workspacePath, { recursive: true, force: true });
            }
        }
    );
}

main().then(() => {
    if (process.exitCode) {
        process.exit(process.exitCode);
    }
});
