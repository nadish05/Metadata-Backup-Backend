'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const deploymentWorkspaceService = require('./deploymentWorkspace.service');
const profileWorkspaceService = require('./profileWorkspaceCanonicalContent.service');

const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const mkdir = util.promisify(fs.mkdir);
const rm = util.promisify(fs.rm);

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

function profileXml({ marker = 'repo' } = {}) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">
    <description>${marker}</description>
</Profile>`;
}

function installRepositoryMocks({
    profilePaths = ['force-app/main/default/profiles/Admin.profile-meta.xml'],
    contentByPath = {}
} = {}) {
    const originalReader =
        deploymentWorkspaceService.createRepositoryFileReader;
    const originalList =
        deploymentWorkspaceService.listDeploymentRepositoryRelativeFiles;

    deploymentWorkspaceService.listDeploymentRepositoryRelativeFiles = async () =>
        profilePaths;
    deploymentWorkspaceService.createRepositoryFileReader = async () =>
        async (relativePath) => {
            const normalized = String(relativePath).replace(/\\/g, '/');

            if (Object.prototype.hasOwnProperty.call(contentByPath, normalized)) {
                return contentByPath[normalized];
            }

            throw new Error(`Unexpected repository read: ${relativePath}`);
        };

    return () => {
        deploymentWorkspaceService.createRepositoryFileReader = originalReader;
        deploymentWorkspaceService.listDeploymentRepositoryRelativeFiles =
            originalList;
    };
}

async function createWorkspaceRoot() {
    return fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'profile-canonical-ws-')
    );
}

async function main() {
    await runTest('inline content differs from repository and wins', async () => {
        const workspacePath = await createWorkspaceRoot();
        const inline = profileXml({ marker: 'inline-canonical' });
        const repo = profileXml({ marker: 'repo-copy' });
        const restore = installRepositoryMocks({
            contentByPath: {
                'force-app/main/default/profiles/Admin.profile-meta.xml': repo
            }
        });

        try {
            const result =
                await profileWorkspaceService.materializeProfileOnlyWorkspaceCanonicalContent(
                    {
                        workspacePath,
                        deploymentPackage: {
                            selectedMetadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin',
                                    content: inline
                                }
                            ]
                        },
                        generatedDeploymentPackage: {
                            metadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin'
                                }
                            ]
                        },
                        repoUrl: 'https://example.com/repo.git',
                        sourceBranch: 'main'
                    }
                );

            assert.strictEqual(result.status, 'VERIFIED');
            assert.strictEqual(result.profiles[0].source, 'INLINE_SELECTED_CONTENT');
            const written = await readFile(
                path.join(
                    workspacePath,
                    'force-app/main/default/profiles/Admin.profile-meta.xml'
                ),
                'utf8'
            );
            assert.match(written, /inline-canonical/);
            assert.doesNotMatch(written, /repo-copy/);
        } finally {
            restore();
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('repository content used when inline missing', async () => {
        const workspacePath = await createWorkspaceRoot();
        const repo = profileXml({ marker: 'from-git' });
        const restore = installRepositoryMocks({
            contentByPath: {
                'force-app/main/default/profiles/Admin.profile-meta.xml': repo
            }
        });

        try {
            const result =
                await profileWorkspaceService.materializeProfileOnlyWorkspaceCanonicalContent(
                    {
                        workspacePath,
                        deploymentPackage: {
                            selectedMetadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin'
                                }
                            ]
                        },
                        generatedDeploymentPackage: {
                            metadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin'
                                }
                            ]
                        },
                        repoUrl: 'https://example.com/repo.git',
                        sourceBranch: 'main'
                    }
                );

            assert.strictEqual(result.status, 'VERIFIED');
            assert.strictEqual(result.profiles[0].source, 'GIT_REPOSITORY');
        } finally {
            restore();
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('missing inline and repository blocks materialization', async () => {
        const workspacePath = await createWorkspaceRoot();
        const restore = installRepositoryMocks({
            profilePaths: [],
            contentByPath: {}
        });

        try {
            const result =
                await profileWorkspaceService.materializeProfileOnlyWorkspaceCanonicalContent(
                    {
                        workspacePath,
                        deploymentPackage: {
                            selectedMetadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin'
                                }
                            ]
                        },
                        generatedDeploymentPackage: {
                            metadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin'
                                }
                            ]
                        },
                        repoUrl: 'https://example.com/repo.git',
                        sourceBranch: 'main'
                    }
                );

            assert.strictEqual(result.status, 'BLOCKED');
            assert.match(result.errors.join(' '), /not found/i);
        } finally {
            restore();
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('ambiguous repository profile paths block', async () => {
        const resolution =
            profileWorkspaceService.resolveDeterministicRepositoryProfilePath(
                'Admin',
                [
                    'apps/app-a/profiles/Admin.profile-meta.xml',
                    'apps/app-b/profiles/Admin.profile-meta.xml'
                ]
            );

        assert.strictEqual(resolution.ok, false);
        assert.strictEqual(resolution.ambiguous, true);
    });

    await runTest('two profiles resolve to distinct workspace destinations', async () => {
        const adminPath =
            profileWorkspaceService.resolveProfileWorkspaceRelativePath('Admin');
        const standardPath =
            profileWorkspaceService.resolveProfileWorkspaceRelativePath(
                'Standard'
            );

        assert.notStrictEqual(adminPath, standardPath);
    });

    await runTest('duplicate workspace destinations block', async () => {
        const destinations = new Map();
        const first = profileWorkspaceService.registerProfileWorkspaceDestination(
            destinations,
            'Admin'
        );
        const second = profileWorkspaceService.registerProfileWorkspaceDestination(
            destinations,
            'Admin'
        );

        assert.strictEqual(first.ok, true);
        assert.strictEqual(second.ok, false);
        assert.match(second.reason, /Duplicate workspace destination/i);
    });

    await runTest('canonical sha matches workspace read-back sha', async () => {
        const workspacePath = await createWorkspaceRoot();
        const xml = profileXml({ marker: 'hash-test' });
        const restore = installRepositoryMocks({
            contentByPath: {
                'force-app/main/default/profiles/Admin.profile-meta.xml': xml
            }
        });

        try {
            const result =
                await profileWorkspaceService.materializeProfileOnlyWorkspaceCanonicalContent(
                    {
                        workspacePath,
                        deploymentPackage: { selectedMetadata: [] },
                        generatedDeploymentPackage: {
                            metadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin'
                                }
                            ]
                        },
                        repoUrl: 'https://example.com/repo.git',
                        sourceBranch: 'main'
                    }
                );

            assert.strictEqual(result.status, 'VERIFIED');
            assert.strictEqual(
                result.profiles[0].canonicalSha256,
                result.profiles[0].workspaceSha256
            );
            assert.strictEqual(
                result.profiles[0].canonicalSha256,
                profileWorkspaceService.sha256Utf8(xml)
            );
        } finally {
            restore();
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('malformed canonical xml blocks materialization', async () => {
        const workspacePath = await createWorkspaceRoot();
        const restore = installRepositoryMocks({
            contentByPath: {
                'force-app/main/default/profiles/Admin.profile-meta.xml':
                    '<Profile><label>x</description></Profile>'
            }
        });

        try {
            const result =
                await profileWorkspaceService.materializeProfileOnlyWorkspaceCanonicalContent(
                    {
                        workspacePath,
                        deploymentPackage: { selectedMetadata: [] },
                        generatedDeploymentPackage: {
                            metadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin'
                                }
                            ]
                        },
                        repoUrl: 'https://example.com/repo.git',
                        sourceBranch: 'main'
                    }
                );

            assert.strictEqual(result.status, 'BLOCKED');
            assert.match(result.errors.join(' '), /Malformed/i);
        } finally {
            restore();
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('workspace content change before inspection is detected', async () => {
        const workspacePath = await createWorkspaceRoot();
        const xml = profileXml({ marker: 'stable' });
        const restore = installRepositoryMocks({
            contentByPath: {
                'force-app/main/default/profiles/Admin.profile-meta.xml': xml
            }
        });

        try {
            const materialized =
                await profileWorkspaceService.materializeProfileOnlyWorkspaceCanonicalContent(
                    {
                        workspacePath,
                        deploymentPackage: { selectedMetadata: [] },
                        generatedDeploymentPackage: {
                            metadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin'
                                }
                            ]
                        },
                        repoUrl: 'https://example.com/repo.git',
                        sourceBranch: 'main'
                    }
                );

            await writeFile(
                path.join(
                    workspacePath,
                    materialized.profiles[0].workspaceRelativePath
                ),
                profileXml({ marker: 'mutated' }),
                'utf8'
            );

            const integrity =
                await profileWorkspaceService.verifyProfileWorkspaceContentUnchanged(
                    workspacePath,
                    materialized.profiles
                );

            assert.strictEqual(integrity.ok, false);
        } finally {
            restore();
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('inspection package reads verified workspace paths without inline content', async () => {
        const workspacePath = await createWorkspaceRoot();
        const xml = profileXml({ marker: 'workspace-inspect' });
        const restore = installRepositoryMocks({
            contentByPath: {
                'force-app/main/default/profiles/Admin.profile-meta.xml': xml
            }
        });

        try {
            const materialized =
                await profileWorkspaceService.materializeProfileOnlyWorkspaceCanonicalContent(
                    {
                        workspacePath,
                        deploymentPackage: { selectedMetadata: [] },
                        generatedDeploymentPackage: {
                            metadata: [
                                {
                                    metadataType: 'Profile',
                                    metadataName: 'Admin'
                                }
                            ]
                        },
                        repoUrl: 'https://example.com/repo.git',
                        sourceBranch: 'main'
                    }
                );

            const inspectionPackage =
                profileWorkspaceService.buildPackageForWorkspaceProfileInspection(
                    {
                        metadata: [
                            {
                                metadataType: 'Profile',
                                metadataName: 'Admin',
                                content: profileXml({ marker: 'ignored-inline' })
                            }
                        ]
                    }
                );
            const readFileFromWorkspace =
                profileWorkspaceService.createWorkspaceFileReader(workspacePath);
            const readBack = await readFileFromWorkspace(
                inspectionPackage.metadata[0].filePath
            );

            assert.match(readBack, /workspace-inspect/);
            assert.strictEqual(
                inspectionPackage.metadata[0].content,
                undefined
            );
            assert.strictEqual(materialized.status, 'VERIFIED');
        } finally {
            restore();
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest(
        'removeStaleSelectedProfileWorkspaceCopies deletes only selected stale copies',
        async () => {
            const workspacePath = await createWorkspaceRoot();
            const canonicalPath =
                profileWorkspaceService.resolveProfileWorkspaceRelativePath(
                    'Admin'
                );
            const canonicalXml = profileXml({ marker: 'canonical-admin' });
            await mkdir(
                path.join(workspacePath, path.dirname(canonicalPath)),
                { recursive: true }
            );
            await writeFile(
                path.join(workspacePath, ...canonicalPath.split('/')),
                canonicalXml,
                'utf8'
            );
            await mkdir(path.join(workspacePath, 'profiles'), { recursive: true });
            await writeFile(
                path.join(workspacePath, 'profiles', 'Admin.profile-meta.xml'),
                profileXml({ marker: 'stale-admin' }),
                'utf8'
            );
            await writeFile(
                path.join(workspacePath, 'profiles', 'Unrelated.profile-meta.xml'),
                profileXml({ marker: 'keep-unrelated' }),
                'utf8'
            );

            const verifiedProfiles = [
                {
                    profileName: 'Admin',
                    workspaceRelativePath: canonicalPath,
                    verified: true,
                    canonicalSha256:
                        profileWorkspaceService.sha256Utf8(canonicalXml),
                    workspaceSha256:
                        profileWorkspaceService.sha256Utf8(canonicalXml)
                }
            ];

            const removal =
                await profileWorkspaceService.removeStaleSelectedProfileWorkspaceCopies(
                    workspacePath,
                    verifiedProfiles
                );

            assert.strictEqual(removal.ok, true);
            assert.deepStrictEqual(removal.removedPaths, [
                'profiles/Admin.profile-meta.xml'
            ]);
            assert.ok(
                fs.existsSync(
                    path.join(workspacePath, ...canonicalPath.split('/'))
                )
            );
            assert.ok(
                fs.existsSync(
                    path.join(
                        workspacePath,
                        'profiles',
                        'Unrelated.profile-meta.xml'
                    )
                )
            );

            await rm(workspacePath, { recursive: true, force: true });
        }
    );
}

main();
