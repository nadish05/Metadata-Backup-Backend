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

const deploymentPermissionSetCompatibilityService = require('./deploymentPermissionSetCompatibility.service');
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
    buildBoundDeployArtifactRecord,
    verifyBoundDeployArtifactIntegrity
} = require('./deploymentBoundArtifact.service');
const {
    buildSfdxProjectDefinition
} = require('./sfdxProject.service');

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
    return patchConnectivityWithDestinationVersions(['67.0']);
}

function patchConnectivityWithDestinationVersions(versions) {
    const originalPost = axios.post;
    const originalGet = axios.get;

    axios.post = async () => ({
        data: {
            access_token: 'test-token',
            instance_url: 'https://test.example.my.salesforce.com'
        }
    });
    axios.get = async (url) => {
        const target = String(url);

        if (target.includes('/services/data/')) {
            if (!versions || versions === 'empty') {
                return { status: 200, data: [] };
            }

            return {
                status: 200,
                data: versions.map((version) => ({ version }))
            };
        }

        return { status: 200 };
    };

    return () => {
        axios.post = originalPost;
        axios.get = originalGet;
    };
}

function profileXmlContent({ viewAllFields = false } = {}) {
    const viewAllFieldsXml = viewAllFields
        ? '\n        <viewAllFields>true</viewAllFields>'
        : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <objectPermissions>
        <object>Account</object>${viewAllFieldsXml}
    </objectPermissions>
</Profile>`;
}

function installRepositoryReaderMock({
    sourceMetadataApiVersion = null,
    profileXml = null
} = {}) {
    const originalReader =
        deploymentWorkspaceService.createRepositoryFileReader;

    deploymentWorkspaceService.createRepositoryFileReader = async () =>
        async (relativePath) => {
            const normalized = String(relativePath).replace(/\\/g, '/');

            if (
                normalized.includes('.metadata-backup/retrieval-metadata.json')
            ) {
                if (!sourceMetadataApiVersion) {
                    throw new Error('Snapshot metadata unavailable.');
                }

                return JSON.stringify({
                    sourceMetadataApiVersion
                });
            }

            if (typeof profileXml === 'string' && normalized.toLowerCase().includes('profile')) {
                return profileXml;
            }

            throw new Error(`Unexpected repository read: ${relativePath}`);
        };

    return () => {
        deploymentWorkspaceService.createRepositoryFileReader = originalReader;
    };
}

function buildGeneratedProfilePackage({
    viewAllFields = false,
    profileName = 'Admin',
    includeContent = true,
    content = null
} = {}) {
    const item = {
        metadataType: 'Profile',
        metadataName: profileName
    };

    if (includeContent) {
        item.content =
            content === null
                ? profileXmlContent({ viewAllFields })
                : content;
    }

    return {
        metadata: [item],
        dependencies: [],
        profileOnlyMinimalPackage: true
    };
}

function buildTwoProfileGeneratedPackage({
    adminContent = profileXmlContent({ viewAllFields: false }),
    standardContent = profileXmlContent({ viewAllFields: false }),
    includeAdminContent = true,
    includeStandardContent = true
} = {}) {
    const metadata = [
        {
            metadataType: 'Profile',
            metadataName: 'Admin'
        },
        {
            metadataType: 'Profile',
            metadataName: 'Standard'
        }
    ];

    if (includeAdminContent) {
        metadata[0].content = adminContent;
    }

    if (includeStandardContent) {
        metadata[1].content = standardContent;
    }

    return {
        metadata,
        dependencies: [],
        profileOnlyMinimalPackage: true
    };
}

async function resolveProfileOnlyApiFresh({
    generatedDeploymentPackage,
    deploymentPackageOverrides = {},
    sourceMetadataApiVersion = '67.0',
    destinationVersions = ['67.0']
} = {}) {
    const restoreAxios =
        patchConnectivityWithDestinationVersions(destinationVersions);
    const restoreReader = installRepositoryReaderMock({
        sourceMetadataApiVersion
    });

    try {
        delete require.cache[require.resolve('./deploymentValidation.service')];
        const validationService = require('./deploymentValidation.service');
        const result =
            await validationService.resolveProfileOnlyMinimalDeploymentApiVersion(
                {
                    deploymentPackage: baseDeploymentPackage({
                        profileOnlyMinimalPackage: true,
                        ...deploymentPackageOverrides
                    }),
                    generatedDeploymentPackage,
                    refreshToken: 'rt',
                    instanceUrl: 'https://test.example.my.salesforce.com',
                    connectivityResult: connectivityPass
                }
            );

        return { result, validationService };
    } finally {
        restoreReader();
        restoreAxios();
    }
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
                        profileOnlyMinimalPackage: true,
                        selectedMetadata: [
                            {
                                metadataType: 'Profile',
                                metadataName: 'Admin',
                                content: profileXmlContent({
                                    viewAllFields: false
                                })
                            }
                        ]
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
            const restoreAxios = patchConnectivityWithDestinationVersions(['67.0']);
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
                                    metadataName: 'Admin',
                                    content: profileXmlContent({
                                        viewAllFields: false
                                    })
                                },
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Standard',
                                    content: profileXmlContent({
                                        viewAllFields: false,
                                        profileName: 'Standard'
                                    })
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
                restoreAxios();
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
                        profileOnlyMinimalPackage: true,
                        selectedMetadata: [
                            {
                                metadataType: 'Profile',
                                metadataName: 'Admin',
                                content: profileXmlContent({
                                    viewAllFields: false
                                })
                            }
                        ]
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
        'Profile-only blocks when selected Profile XML is missing',
        async () => {
            const { result } = await resolveProfileOnlyApiFresh({
                generatedDeploymentPackage: buildGeneratedProfilePackage({
                    includeContent: false
                })
            });

            assert.strictEqual(result.blocked, true);
            assert.strictEqual(
                result.deploymentApiVersionPolicy.compatible,
                false
            );
            assert.match(result.reason, /inspection failed|not successfully inspected|unavailable/i);
        }
    );

    await runTest(
        'Profile-only blocks when selected Profile XML is malformed',
        async () => {
            const { result } = await resolveProfileOnlyApiFresh({
                generatedDeploymentPackage: buildGeneratedProfilePackage({
                    content:
                        '<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><label>Broken</description></Profile>'
                })
            });

            assert.strictEqual(result.blocked, true);
            assert.strictEqual(
                result.deploymentApiVersionPolicy.compatible,
                false
            );
        }
    );

    await runTest(
        'Profile-only blocks when selected Profile has unexpected XML root',
        async () => {
            const { result } = await resolveProfileOnlyApiFresh({
                generatedDeploymentPackage: buildGeneratedProfilePackage({
                    content:
                        '<PermissionSet xmlns="http://soap.sforce.com/2006/04/metadata"><label>Wrong Root</label></PermissionSet>'
                })
            });

            assert.strictEqual(result.blocked, true);
            assert.strictEqual(
                result.deploymentApiVersionPolicy.compatible,
                false
            );
        }
    );

    await runTest(
        'Profile-only blocks when one of two Profiles is missing XML',
        async () => {
            const { result } = await resolveProfileOnlyApiFresh({
                generatedDeploymentPackage: buildTwoProfileGeneratedPackage({
                    includeStandardContent: false
                })
            });

            assert.strictEqual(result.blocked, true);
            assert.match(result.reason, /Standard|inspection failed|not successfully inspected/i);
        }
    );

    await runTest(
        'Profile-only blocks when one of two Profiles is malformed',
        async () => {
            const { result } = await resolveProfileOnlyApiFresh({
                generatedDeploymentPackage: buildTwoProfileGeneratedPackage({
                    standardContent:
                        '<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><label>x</description></Profile>'
                })
            });

            assert.strictEqual(result.blocked, true);
            assert.strictEqual(
                result.deploymentApiVersionPolicy.compatible,
                false
            );
        }
    );

    await runTest(
        'Profile-only blocks when Profile analyzer throws unexpectedly',
        async () => {
            const originalSafe =
                deploymentPermissionSetCompatibilityService.analyzeProfileMetadataCompatibilitySafe;
            deploymentPermissionSetCompatibilityService.analyzeProfileMetadataCompatibilitySafe =
                async () => ({
                    overallStatus: 'BLOCKED',
                    inspectionError: 'simulated analyzer failure',
                    structuralMinimumApiVersion: null,
                    profiles: [],
                    summary: {
                        analyzed: 0,
                        compatible: 0,
                        incompatible: 0,
                        malformed: 0,
                        failedInspection: 1,
                        requiresStructuralMinimum: false
                    }
                });

            try {
                const { result } = await resolveProfileOnlyApiFresh({
                    generatedDeploymentPackage: buildGeneratedProfilePackage({
                        viewAllFields: false
                    })
                });

                assert.strictEqual(result.blocked, true);
                assert.strictEqual(
                    result.profileMetadataCompatibility.overallStatus,
                    'BLOCKED'
                );
                assert.strictEqual(
                    result.deploymentApiVersionPolicy.compatible,
                    false
                );
            } finally {
                deploymentPermissionSetCompatibilityService.analyzeProfileMetadataCompatibilitySafe =
                    originalSafe;
            }
        }
    );

    await runTest(
        'Profile-only blocks when API policy resolution throws',
        async () => {
            const restoreAxios =
                patchConnectivityWithDestinationVersions(['67.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '67.0'
            });

            delete require.cache[
                require.resolve('./deploymentApiVersionPolicy.service')
            ];
            delete require.cache[
                require.resolve('./deploymentValidation.service')
            ];

            const policyService = require('./deploymentApiVersionPolicy.service');
            const originalPolicy =
                policyService.resolveDeploymentApiVersionPolicyAsync;
            policyService.resolveDeploymentApiVersionPolicyAsync = async () => {
                throw new Error('simulated policy failure');
            };

            try {
                const validationService = require('./deploymentValidation.service');
                const result =
                    await validationService.resolveProfileOnlyMinimalDeploymentApiVersion(
                        {
                            deploymentPackage: baseDeploymentPackage({
                                profileOnlyMinimalPackage: true
                            }),
                            generatedDeploymentPackage:
                                buildGeneratedProfilePackage({
                                    viewAllFields: false
                                }),
                            refreshToken: 'rt',
                            instanceUrl:
                                'https://test.example.my.salesforce.com',
                            connectivityResult: connectivityPass
                        }
                    );

                assert.strictEqual(result.blocked, true);
                assert.strictEqual(
                    result.deploymentApiVersionPolicy.compatible,
                    false
                );
                assert.match(result.reason, /simulated policy failure/i);
            } finally {
                policyService.resolveDeploymentApiVersionPolicyAsync =
                    originalPolicy;
                restoreReader();
                restoreAxios();
                delete require.cache[
                    require.resolve('./deploymentValidation.service')
                ];
                delete require.cache[
                    require.resolve('./deploymentApiVersionPolicy.service')
                ];
            }
        }
    );

    await runTest(
        'Case 1 regression: source 61 destination 67 viewAllFields final API 63',
        async () => {
            const restoreAxios =
                patchConnectivityWithDestinationVersions(['67.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '61.0',
                profileXml: profileXmlContent({ viewAllFields: true })
            });

            try {
                delete require.cache[
                    require.resolve('./deploymentValidation.service')
                ];
                const validationService = require('./deploymentValidation.service');
                const result =
                    await validationService.resolveProfileOnlyMinimalDeploymentApiVersion(
                        {
                            deploymentPackage: baseDeploymentPackage({
                                profileOnlyMinimalPackage: true
                            }),
                            generatedDeploymentPackage:
                                buildGeneratedProfilePackage({
                                    viewAllFields: true
                                }),
                            refreshToken: 'rt',
                            instanceUrl:
                                'https://test.example.my.salesforce.com',
                            connectivityResult: connectivityPass
                        }
                    );

                assert.strictEqual(result.blocked, false);
                assert.strictEqual(
                    result.deploymentApiVersionPolicy.deploymentApiVersion,
                    '63.0'
                );
                assert.strictEqual(
                    result.deploymentApiNegotiation.sourceApiVersion,
                    '61.0'
                );
                assert.strictEqual(
                    result.deploymentApiNegotiation.negotiatedApiVersion,
                    '61.0'
                );
                assert.strictEqual(
                    result.deploymentApiNegotiation.negotiationStatus,
                    'SUCCESS'
                );
                assert.strictEqual(result.deploymentApiVersion, '63.0');
            } finally {
                restoreReader();
                restoreAxios();
            }
        }
    );

    await runTest(
        'inspection block skips CLI and bound artifact',
        async () => {
            const restoreAxios = patchConnectivityWithDestinationVersions(['67.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '67.0'
            });
            const originalCheckOnly =
                checkOnlyDeploymentService.runCheckOnlyDeployment;
            let checkOnlyInvoked = false;

            checkOnlyDeploymentService.runCheckOnlyDeployment = async () => {
                checkOnlyInvoked = true;
                return { success: true, status: 'SUCCESS', executed: true };
            };

            try {
                const validationService = loadValidationServiceFresh();
                const result = await validationService.validateDeployment({
                    refreshToken: 'rt',
                    instanceUrl: 'https://test.example.my.salesforce.com',
                    orgId: '00DTEST',
                    validationId: 'val-inspection-block',
                    deploymentPackage: baseDeploymentPackage({
                        profileOnlyMinimalPackage: true,
                        selectedMetadata: [
                            {
                                metadataType: 'Profile',
                                metadataName: 'Admin'
                            }
                        ]
                    })
                });

                assert.strictEqual(checkOnlyInvoked, false);
                assert.strictEqual(result.checkOnlyDeployment.executed, false);
                assert.strictEqual(
                    result.profileOnlyMinimalApiVersionBlocked,
                    true
                );
                assert.ok(!result.boundDeployArtifact);
            } finally {
                checkOnlyDeploymentService.runCheckOnlyDeployment =
                    originalCheckOnly;
                restoreReader();
                restoreAxios();
            }
        }
    );

    await runTest(
        'Profile with viewAllFields resolves API 63+ when destination is 67',
        async () => {
            const restoreAxios = patchConnectivityWithDestinationVersions(['67.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '67.0',
                profileXml: profileXmlContent({ viewAllFields: true })
            });

            try {
                delete require.cache[
                    require.resolve('./deploymentValidation.service')
                ];
                const validationService = require('./deploymentValidation.service');
                const result =
                    await validationService.resolveProfileOnlyMinimalDeploymentApiVersion(
                        {
                            deploymentPackage: baseDeploymentPackage({
                                profileOnlyMinimalPackage: true
                            }),
                            generatedDeploymentPackage:
                                buildGeneratedProfilePackage({
                                    viewAllFields: true
                                }),
                            refreshToken: 'rt',
                            instanceUrl:
                                'https://test.example.my.salesforce.com',
                            connectivityResult: connectivityPass
                        }
                    );

                assert.strictEqual(result.blocked, false);
                assert.ok(
                    Number(result.deploymentApiVersion.split('.')[0]) >= 63
                );
                assert.ok(
                    Number(result.deploymentApiVersion.split('.')[0]) <= 67
                );
            } finally {
                restoreReader();
                restoreAxios();
            }
        }
    );

    await runTest(
        'Profile with viewAllFields resolves API 63 when destination is 63',
        async () => {
            const restoreAxios = patchConnectivityWithDestinationVersions(['63.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '63.0',
                profileXml: profileXmlContent({ viewAllFields: true })
            });

            try {
                delete require.cache[
                    require.resolve('./deploymentValidation.service')
                ];
                const validationService = require('./deploymentValidation.service');
                const result =
                    await validationService.resolveProfileOnlyMinimalDeploymentApiVersion(
                        {
                            deploymentPackage: baseDeploymentPackage({
                                profileOnlyMinimalPackage: true
                            }),
                            generatedDeploymentPackage:
                                buildGeneratedProfilePackage({
                                    viewAllFields: true
                                }),
                            refreshToken: 'rt',
                            instanceUrl:
                                'https://test.example.my.salesforce.com',
                            connectivityResult: connectivityPass
                        }
                    );

                assert.strictEqual(result.blocked, false);
                assert.strictEqual(result.deploymentApiVersion, '63.0');
            } finally {
                restoreReader();
                restoreAxios();
            }
        }
    );

    await runTest(
        'Profile with viewAllFields blocks before CLI when destination is 62',
        async () => {
            const restoreAxios = patchConnectivityWithDestinationVersions(['62.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '67.0',
                profileXml: profileXmlContent({ viewAllFields: true })
            });

            try {
                delete require.cache[
                    require.resolve('./deploymentValidation.service')
                ];
                const validationService = require('./deploymentValidation.service');
                const result =
                    await validationService.resolveProfileOnlyMinimalDeploymentApiVersion(
                        {
                            deploymentPackage: baseDeploymentPackage({
                                profileOnlyMinimalPackage: true
                            }),
                            generatedDeploymentPackage:
                                buildGeneratedProfilePackage({
                                    viewAllFields: true
                                }),
                            refreshToken: 'rt',
                            instanceUrl:
                                'https://test.example.my.salesforce.com',
                            connectivityResult: connectivityPass
                        }
                    );

                assert.strictEqual(result.blocked, true);
                assert.strictEqual(
                    result.deploymentApiVersionPolicy.compatible,
                    false
                );
            } finally {
                restoreReader();
                restoreAxios();
            }
        }
    );

    await runTest(
        'Profile with viewAllFields blocks when destination API is unknown',
        async () => {
            const restoreAxios = patchConnectivityWithDestinationVersions('empty');
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '67.0',
                profileXml: profileXmlContent({ viewAllFields: true })
            });

            try {
                delete require.cache[
                    require.resolve('./deploymentValidation.service')
                ];
                const validationService = require('./deploymentValidation.service');
                const result =
                    await validationService.resolveProfileOnlyMinimalDeploymentApiVersion(
                        {
                            deploymentPackage: baseDeploymentPackage({
                                profileOnlyMinimalPackage: true
                            }),
                            generatedDeploymentPackage:
                                buildGeneratedProfilePackage({
                                    viewAllFields: true
                                }),
                            refreshToken: 'rt',
                            instanceUrl:
                                'https://test.example.my.salesforce.com',
                            connectivityResult: connectivityPass
                        }
                    );

                assert.strictEqual(result.blocked, true);
            } finally {
                restoreReader();
                restoreAxios();
            }
        }
    );

    await runTest(
        'Profile without viewAllFields does not force API 63.0',
        async () => {
            const restoreAxios = patchConnectivityWithDestinationVersions(['67.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '67.0',
                profileXml: profileXmlContent({ viewAllFields: false })
            });

            try {
                delete require.cache[
                    require.resolve('./deploymentValidation.service')
                ];
                const validationService = require('./deploymentValidation.service');
                const result =
                    await validationService.resolveProfileOnlyMinimalDeploymentApiVersion(
                        {
                            deploymentPackage: baseDeploymentPackage({
                                profileOnlyMinimalPackage: true
                            }),
                            generatedDeploymentPackage:
                                buildGeneratedProfilePackage({
                                    viewAllFields: false
                                }),
                            refreshToken: 'rt',
                            instanceUrl:
                                'https://test.example.my.salesforce.com',
                            connectivityResult: connectivityPass
                        }
                    );

                assert.strictEqual(result.blocked, false);
                assert.strictEqual(
                    result.profileMetadataCompatibility
                        ?.structuralMinimumApiVersion,
                    null
                );
                assert.ok(
                    !(result.deploymentApiVersionPolicy?.embeddedApiVersions || [])
                        .length
                );
                assert.notStrictEqual(result.deploymentApiVersion, '63.0');
            } finally {
                restoreReader();
                restoreAxios();
            }
        }
    );

    await runTest(
        'source snapshot 61 with viewAllFields does not proceed at API 61.0',
        async () => {
            const restoreAxios = patchConnectivityWithDestinationVersions(['67.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '61.0',
                profileXml: profileXmlContent({ viewAllFields: true })
            });

            try {
                delete require.cache[
                    require.resolve('./deploymentValidation.service')
                ];
                const validationService = require('./deploymentValidation.service');
                const result =
                    await validationService.resolveProfileOnlyMinimalDeploymentApiVersion(
                        {
                            deploymentPackage: baseDeploymentPackage({
                                profileOnlyMinimalPackage: true
                            }),
                            generatedDeploymentPackage:
                                buildGeneratedProfilePackage({
                                    viewAllFields: true
                                }),
                            refreshToken: 'rt',
                            instanceUrl:
                                'https://test.example.my.salesforce.com',
                            connectivityResult: connectivityPass
                        }
                    );

                assert.strictEqual(result.blocked, false);
                assert.notStrictEqual(result.deploymentApiVersion, '61.0');
                assert.ok(
                    Number(result.deploymentApiVersion.split('.')[0]) >= 63
                );
            } finally {
                restoreReader();
                restoreAxios();
            }
        }
    );

    await runTest(
        'missing source snapshot still negotiates without forcing wrong org discovery',
        async () => {
            const restoreAxios = patchConnectivityWithDestinationVersions(['67.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: null,
                profileXml: profileXmlContent({ viewAllFields: false })
            });

            try {
                delete require.cache[
                    require.resolve('./deploymentValidation.service')
                ];
                const validationService = require('./deploymentValidation.service');
                const pkg = baseDeploymentPackage({
                    profileOnlyMinimalPackage: true
                });
                const result =
                    await validationService.resolveProfileOnlyMinimalDeploymentApiVersion(
                        {
                            deploymentPackage: pkg,
                            generatedDeploymentPackage:
                                buildGeneratedProfilePackage({
                                    viewAllFields: false
                                }),
                            refreshToken: 'rt',
                            instanceUrl:
                                'https://test.example.my.salesforce.com',
                            connectivityResult: connectivityPass
                        }
                    );

                assert.strictEqual(result.blocked, false);
                assert.strictEqual(pkg.sourceApiVersion, null);
            } finally {
                restoreReader();
                restoreAxios();
            }
        }
    );

    await runTest(
        'API version block skips Salesforce CLI execution',
        async () => {
            const restoreAxios = patchConnectivityWithDestinationVersions(['62.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '67.0',
                profileXml: profileXmlContent({ viewAllFields: true })
            });
            const originalCheckOnly =
                checkOnlyDeploymentService.runCheckOnlyDeployment;
            let checkOnlyInvoked = false;

            checkOnlyDeploymentService.runCheckOnlyDeployment = async () => {
                checkOnlyInvoked = true;
                return { success: true, status: 'SUCCESS', executed: true };
            };

            try {
                const validationService = loadValidationServiceFresh();
                const result = await validationService.validateDeployment({
                    refreshToken: 'rt',
                    instanceUrl: 'https://test.example.my.salesforce.com',
                    orgId: '00DTEST',
                    deploymentPackage: baseDeploymentPackage({
                        profileOnlyMinimalPackage: true,
                        selectedMetadata: [
                            {
                                metadataType: 'Profile',
                                metadataName: 'Admin',
                                content: profileXmlContent({
                                    viewAllFields: true
                                })
                            }
                        ]
                    })
                });

                assert.strictEqual(checkOnlyInvoked, false);
                assert.strictEqual(result.checkOnlyDeployment.executed, false);
                assert.strictEqual(
                    result.deploymentReadiness.canDeploy,
                    false
                );
                assert.strictEqual(
                    result.deploymentApiVersionPolicy?.compatible,
                    false
                );
                assert.strictEqual(
                    result.profileOnlyMinimalApiVersionBlocked,
                    true
                );
                assert.ok(!result.boundDeployArtifact);
            } finally {
                checkOnlyDeploymentService.runCheckOnlyDeployment =
                    originalCheckOnly;
                restoreReader();
                restoreAxios();
            }
        }
    );

    await runTest(
        'manifest and CLI API versions match resolved Profile-only deployment API',
        async () => {
            const restoreAxios = patchConnectivityWithDestinationVersions(['67.0']);
            const restoreReader = installRepositoryReaderMock({
                sourceMetadataApiVersion: '67.0',
                profileXml: profileXmlContent({ viewAllFields: true })
            });
            const originalBuild =
                deploymentWorkspaceService.buildDeploymentWorkspace;
            const originalCheckOnly =
                checkOnlyDeploymentService.runCheckOnlyDeployment;
            let capturedCheckOnlyVersion = null;
            let workspaceRootToCleanup = null;

            deploymentWorkspaceService.buildDeploymentWorkspace = async (
                args
            ) => {
                const workspaceRoot = await createBoundReadyWorkspace(
                    args.generatedManifest
                );
                workspaceRootToCleanup = workspaceRoot;
                return {
                    status: 'READY',
                    workspacePath: workspaceRoot,
                    dependenciesCopied: 0,
                    metadataCopied: 1
                };
            };
            checkOnlyDeploymentService.runCheckOnlyDeployment = async (
                args
            ) => {
                capturedCheckOnlyVersion = args.deploymentApiVersion;
                return {
                    success: true,
                    status: 'SUCCESS',
                    executed: true
                };
            };

            try {
                delete require.cache[
                    require.resolve('./deploymentValidation.service')
                ];
                const validationService = loadValidationServiceFresh();
                const result = await validationService.runProfileOnlyMinimalValidation({
                    connectivityResult: connectivityPass,
                    deploymentPackage: baseDeploymentPackage({
                        profileOnlyMinimalPackage: true,
                        selectedMetadata: [
                            {
                                metadataType: 'Profile',
                                metadataName: 'Admin',
                                content: profileXmlContent({
                                    viewAllFields: true
                                })
                            }
                        ]
                    }),
                    refreshToken: 'rt',
                    instanceUrl: 'https://test.example.my.salesforce.com',
                    orgId: '00DTEST',
                    validationId: 'val-api-version-align'
                });

                assert.strictEqual(
                    result.validationExecutionPath,
                    validationService.PROFILE_ONLY_MINIMAL_EXECUTION_PATH
                );
                assert.ok(result.generatedManifest.summary.apiVersion);
                assert.strictEqual(
                    result.generatedManifest.summary.apiVersion,
                    capturedCheckOnlyVersion
                );
                assert.ok(
                    result.generatedManifest.packageXml.includes(
                        `<version>${result.generatedManifest.summary.apiVersion}</version>`
                    )
                );
                assert.strictEqual(
                    result.deploymentApiVersionPolicy.deploymentApiVersion,
                    result.generatedManifest.summary.apiVersion
                );
                assert.ok(result.boundDeployArtifact?.artifactDigest);
                const integrity = await verifyBoundDeployArtifactIntegrity({
                    artifactRecord: result.boundDeployArtifact,
                    manifest: result.generatedManifest,
                    generatedDeploymentPackage: result.generatedDeploymentPackage
                });
                assert.strictEqual(integrity.ok, true, integrity.reason);
                assert.strictEqual(
                    buildSfdxProjectDefinition(
                        result.generatedManifest.summary.apiVersion
                    ).sourceApiVersion,
                    capturedCheckOnlyVersion
                );
            } finally {
                deploymentWorkspaceService.buildDeploymentWorkspace =
                    originalBuild;
                checkOnlyDeploymentService.runCheckOnlyDeployment =
                    originalCheckOnly;
                restoreReader();
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
