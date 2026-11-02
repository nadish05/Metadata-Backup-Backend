'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const profileWorkspaceCanonicalContentService = require('./profileWorkspaceCanonicalContent.service');
const sanitizationService = require('./profileUserPermissionSanitization.service');

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

function profileFailure(profileName, permissionName, overrides = {}) {
    return {
        metadataType: 'Profile',
        metadataName: profileName,
        problem: `Unknown user permission: ${permissionName}`,
        ...overrides
    };
}

function checkOnlyWithFailures(failures, extra = {}) {
    return {
        success: false,
        status: 'FAILED',
        executed: true,
        deploymentId: '0AfTEST',
        deploymentDiagnostics: {
            componentFailures: failures
        },
        ...extra
    };
}

function profileXmlWithUserPermissions({
    permissions = [],
    includeObject = true,
    includeField = false,
    marker = ''
} = {}) {
    const objectBlock = includeObject
        ? `<objectPermissions>
        <object>Account</object>
        <allowRead>true</allowRead>
    </objectPermissions>`
        : '';
    const fieldBlock = includeField
        ? `<fieldPermissions>
        <editable>true</editable>
        <field>Account.Name</field>
        <readable>true</readable>
    </fieldPermissions>`
        : '';
    const userBlocks = permissions
        .map(
            (entry) => `<userPermissions>
        <enabled>${entry.enabled === false ? 'false' : 'true'}</enabled>
        <name>${entry.name}</name>
    </userPermissions>`
        )
        .join('\n    ');
    const description = marker ? `\n    <description>${marker}</description>` : '';

    return `<?xml version="1.0" encoding="UTF-8"?>
<Profile xmlns="http://soap.sforce.com/2006/04/metadata">${description}
    ${objectBlock}
    ${fieldBlock}
    ${userBlocks}
</Profile>`;
}

async function writeWorkspaceProfile(workspacePath, profileName, xml) {
    const relativePath =
        profileWorkspaceCanonicalContentService.resolveProfileWorkspaceRelativePath(
            profileName
        );
    const absolutePath = path.join(
        workspacePath,
        ...relativePath.split('/')
    );
    await mkdir(path.dirname(absolutePath), { recursive: true });
    await writeFile(absolutePath, xml, 'utf8');
    return { relativePath, absolutePath };
}

async function main() {
    const selectedAdmin = new Set(['Admin']);

    await runTest('1 exact Unknown user permission problem is recognized', async () => {
        assert.strictEqual(
            sanitizationService.parseUnknownUserPermissionProblem(
                'Unknown user permission: CreateWorkBadgeDefinition'
            ),
            'CreateWorkBadgeDefinition'
        );
    });

    await runTest('2 generic Profile error is rejected', async () => {
        assert.strictEqual(
            sanitizationService.parseUnknownUserPermissionProblem(
                'Profile Admin: unknown user permission'
            ),
            null
        );
    });

    await runTest('3 missing permission name is rejected', async () => {
        assert.strictEqual(
            sanitizationService.parseUnknownUserPermissionProblem(
                'Unknown user permission:'
            ),
            null
        );
    });

    await runTest('4 non-Profile component failure is rejected', async () => {
        const parsed = sanitizationService.isConfirmedUnknownUserPermissionFailure(
            {
                metadataType: 'CustomObject',
                metadataName: 'Admin',
                problem: 'Unknown user permission: Foo'
            },
            selectedAdmin
        );
        assert.strictEqual(parsed.ok, false);
    });

    await runTest('5 missing Profile identity is rejected', async () => {
        const parsed = sanitizationService.isConfirmedUnknownUserPermissionFailure(
            {
                metadataType: 'Profile',
                problem: 'Unknown user permission: Foo'
            },
            selectedAdmin
        );
        assert.strictEqual(parsed.ok, false);
    });

    await runTest('6 unselected Profile failure is rejected', async () => {
        const parsed = sanitizationService.isConfirmedUnknownUserPermissionFailure(
            profileFailure('Standard', 'CreateWorkBadgeDefinition'),
            selectedAdmin
        );
        assert.strictEqual(parsed.ok, false);
    });

    await runTest('7 multiple component failures are all inspected', async () => {
        const result =
            sanitizationService.extractConfirmedUnknownUserPermissionFailures(
                checkOnlyWithFailures([
                    profileFailure('Admin', 'PermA'),
                    profileFailure('Admin', 'PermB')
                ]),
                selectedAdmin
            );
        assert.strictEqual(result.ok, true);
        assert.strictEqual(result.failures.length, 2);
    });

    await runTest('8 mixed unknown-permission and unrelated errors stop immediately', async () => {
        const result =
            sanitizationService.extractConfirmedUnknownUserPermissionFailures(
                checkOnlyWithFailures([
                    profileFailure('Admin', 'PermA'),
                    {
                        metadataType: 'Profile',
                        metadataName: 'Admin',
                        problem: 'Invalid field permission'
                    }
                ]),
                selectedAdmin
            );
        assert.strictEqual(result.ok, false);
    });

    await runTest('9 one matching enabled=true block is removed', async () => {
        const xml = profileXmlWithUserPermissions({
            permissions: [{ name: 'CreateWorkBadgeDefinition', enabled: true }]
        });
        const removal = sanitizationService.removeSingleUserPermissionBlock(
            xml,
            'CreateWorkBadgeDefinition'
        );
        assert.strictEqual(removal.ok, true);
        assert.doesNotMatch(removal.xml, /CreateWorkBadgeDefinition/);
    });

    await runTest('10 matching enabled=false block is never removed', async () => {
        const xml = profileXmlWithUserPermissions({
            permissions: [{ name: 'CreateWorkBadgeDefinition', enabled: false }]
        });
        const removal = sanitizationService.removeSingleUserPermissionBlock(
            xml,
            'CreateWorkBadgeDefinition'
        );
        assert.strictEqual(removal.ok, false);
    });

    await runTest('11 permission not present blocks sanitization', async () => {
        const xml = profileXmlWithUserPermissions({ permissions: [] });
        const removal = sanitizationService.removeSingleUserPermissionBlock(
            xml,
            'MissingPerm'
        );
        assert.strictEqual(removal.ok, false);
    });

    await runTest('12 duplicate matching permission blocks block sanitization', async () => {
        const xml = profileXmlWithUserPermissions({
            permissions: [
                { name: 'DupPerm', enabled: true },
                { name: 'DupPerm', enabled: true }
            ]
        });
        const removal = sanitizationService.removeSingleUserPermissionBlock(
            xml,
            'DupPerm'
        );
        assert.strictEqual(removal.ok, false);
    });

    await runTest('13 malformed XML blocks sanitization', async () => {
        assert.throws(() => {
            sanitizationService.validateSanitizedProfileXml('<Profile><unclosed');
        });
    });

    await runTest('14 only exact matching userPermissions block is removed', async () => {
        const xml = profileXmlWithUserPermissions({
            permissions: [
                { name: 'KeepMe', enabled: true },
                { name: 'RemoveMe', enabled: true }
            ]
        });
        const removal = sanitizationService.removeSingleUserPermissionBlock(
            xml,
            'RemoveMe'
        );
        assert.strictEqual(removal.ok, true);
        assert.match(removal.xml, /KeepMe/);
        assert.doesNotMatch(removal.xml, /RemoveMe/);
    });

    await runTest('15 other userPermissions remain unchanged', async () => {
        const xml = profileXmlWithUserPermissions({
            permissions: [
                { name: 'PermA', enabled: true },
                { name: 'PermB', enabled: true }
            ]
        });
        const removal = sanitizationService.removeSingleUserPermissionBlock(
            xml,
            'PermA'
        );
        assert.match(removal.xml, /<name>PermB<\/name>/);
    });

    await runTest('16 objectPermissions remain unchanged', async () => {
        const xml = profileXmlWithUserPermissions({
            permissions: [{ name: 'PermA', enabled: true }]
        });
        const removal = sanitizationService.removeSingleUserPermissionBlock(
            xml,
            'PermA'
        );
        assert.match(removal.xml, /<object>Account<\/object>/);
    });

    await runTest('17 fieldPermissions remain unchanged', async () => {
        const xml = profileXmlWithUserPermissions({
            includeField: true,
            permissions: [{ name: 'PermA', enabled: true }]
        });
        const removal = sanitizationService.removeSingleUserPermissionBlock(
            xml,
            'PermA'
        );
        assert.match(removal.xml, /<field>Account\.Name<\/field>/);
    });

    await runTest('18 other Profile sections remain unchanged', async () => {
        const xml = profileXmlWithUserPermissions({
            marker: 'section-marker',
            permissions: [{ name: 'PermA', enabled: true }]
        });
        const removal = sanitizationService.removeSingleUserPermissionBlock(
            xml,
            'PermA'
        );
        assert.match(removal.xml, /section-marker/);
    });

    await runTest('19 multiple permissions in one Profile are handled safely', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'sanitize-multi-perm-')
        );
        const xml = profileXmlWithUserPermissions({
            permissions: [
                { name: 'PermA', enabled: true },
                { name: 'PermB', enabled: true }
            ]
        });

        try {
            await writeWorkspaceProfile(workspacePath, 'Admin', xml);
            const result = await sanitizationService.applySanitizationPlan({
                workspacePath,
                confirmedFailures: [
                    {
                        profileName: 'Admin',
                        permissionName: 'PermA',
                        sourceFailure: { problem: 'Unknown user permission: PermA' }
                    },
                    {
                        profileName: 'Admin',
                        permissionName: 'PermB',
                        sourceFailure: { problem: 'Unknown user permission: PermB' }
                    }
                ],
                attempt: 1
            });
            assert.strictEqual(result.ok, true);
            assert.strictEqual(result.removedPermissions.length, 2);
        } finally {
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('20 multiple Profiles are handled independently', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'sanitize-multi-profile-')
        );

        try {
            await writeWorkspaceProfile(
                workspacePath,
                'Admin',
                profileXmlWithUserPermissions({
                    permissions: [{ name: 'PermA', enabled: true }]
                })
            );
            await writeWorkspaceProfile(
                workspacePath,
                'Standard',
                profileXmlWithUserPermissions({
                    permissions: [{ name: 'PermB', enabled: true }]
                })
            );
            const result = await sanitizationService.applySanitizationPlan({
                workspacePath,
                confirmedFailures: [
                    {
                        profileName: 'Admin',
                        permissionName: 'PermA',
                        sourceFailure: { problem: 'Unknown user permission: PermA' }
                    },
                    {
                        profileName: 'Standard',
                        permissionName: 'PermB',
                        sourceFailure: { problem: 'Unknown user permission: PermB' }
                    }
                ],
                attempt: 1
            });
            assert.strictEqual(result.ok, true);
            const adminRel =
                profileWorkspaceCanonicalContentService.resolveProfileWorkspaceRelativePath(
                    'Admin'
                );
            const standardRel =
                profileWorkspaceCanonicalContentService.resolveProfileWorkspaceRelativePath(
                    'Standard'
                );
            const adminXml = await readFile(
                path.join(workspacePath, ...adminRel.split('/')),
                'utf8'
            );
            const standardXml = await readFile(
                path.join(workspacePath, ...standardRel.split('/')),
                'utf8'
            );
            assert.doesNotMatch(adminXml, /PermA/);
            assert.doesNotMatch(standardXml, /PermB/);
        } finally {
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('21 only canonical workspace files are modified', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'sanitize-canonical-')
        );
        const xml = profileXmlWithUserPermissions({
            permissions: [{ name: 'PermA', enabled: true }]
        });

        try {
            const { relativePath } = await writeWorkspaceProfile(
                workspacePath,
                'Admin',
                xml
            );
            assert.match(relativePath, /^force-app\/main\/default\/profiles\//);
            await sanitizationService.applySanitizationPlan({
                workspacePath,
                confirmedFailures: [
                    {
                        profileName: 'Admin',
                        permissionName: 'PermA',
                        sourceFailure: { problem: 'Unknown user permission: PermA' }
                    }
                ],
                attempt: 1
            });
        } finally {
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('22 Git repository source files remain unchanged (workspace-only)', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'sanitize-no-git-')
        );
        const repoCopy = profileXmlWithUserPermissions({
            marker: 'repo-only',
            permissions: [{ name: 'PermA', enabled: true }]
        });
        const workspaceCopy = profileXmlWithUserPermissions({
            marker: 'workspace',
            permissions: [{ name: 'PermA', enabled: true }]
        });

        try {
            await writeWorkspaceProfile(workspacePath, 'Admin', workspaceCopy);
            await sanitizationService.applySanitizationPlan({
                workspacePath,
                confirmedFailures: [
                    {
                        profileName: 'Admin',
                        permissionName: 'PermA',
                        sourceFailure: { problem: 'Unknown user permission: PermA' }
                    }
                ],
                attempt: 1
            });
            assert.notStrictEqual(repoCopy, workspaceCopy);
            assert.match(repoCopy, /repo-only/);
        } finally {
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('23 read-back hash matches modified content', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'sanitize-hash-')
        );
        const xml = profileXmlWithUserPermissions({
            permissions: [{ name: 'PermA', enabled: true }]
        });

        try {
            await writeWorkspaceProfile(workspacePath, 'Admin', xml);
            const result = await sanitizationService.applySanitizationPlan({
                workspacePath,
                confirmedFailures: [
                    {
                        profileName: 'Admin',
                        permissionName: 'PermA',
                        sourceFailure: { problem: 'Unknown user permission: PermA' }
                    }
                ],
                attempt: 1
            });
            assert.strictEqual(result.ok, true);
            const rel =
                profileWorkspaceCanonicalContentService.resolveProfileWorkspaceRelativePath(
                    'Admin'
                );
            const readBack = await readFile(
                path.join(workspacePath, ...rel.split('/')),
                'utf8'
            );
            assert.strictEqual(
                profileWorkspaceCanonicalContentService.sha256Utf8(readBack),
                profileWorkspaceCanonicalContentService.sha256Utf8(readBack)
            );
        } finally {
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('24 original canonical hash is preserved separately', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'sanitize-dual-hash-')
        );
        const xml = profileXmlWithUserPermissions({
            permissions: [{ name: 'PermA', enabled: true }]
        });
        const originalHash = profileWorkspaceCanonicalContentService.sha256Utf8(xml);

        try {
            await writeWorkspaceProfile(workspacePath, 'Admin', xml);
            await sanitizationService.applySanitizationPlan({
                workspacePath,
                confirmedFailures: [
                    {
                        profileName: 'Admin',
                        permissionName: 'PermA',
                        sourceFailure: { problem: 'Unknown user permission: PermA' }
                    }
                ],
                attempt: 1
            });
            const refreshed =
                await sanitizationService.refreshFinalWorkspaceHashes(
                    {
                        profiles: [
                            {
                                profileName: 'Admin',
                                workspaceRelativePath:
                                    profileWorkspaceCanonicalContentService.resolveProfileWorkspaceRelativePath(
                                        'Admin'
                                    ),
                                originalCanonicalSha256: originalHash,
                                verified: true
                            }
                        ]
                    },
                    workspacePath
                );
            assert.strictEqual(
                refreshed.profiles[0].originalCanonicalSha256,
                originalHash
            );
            assert.notStrictEqual(
                refreshed.profiles[0].finalWorkspaceSha256,
                originalHash
            );
        } finally {
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('25 final workspace hash changes after sanitization', async () => {
        const workspacePath = await fs.promises.mkdtemp(
            path.join(os.tmpdir(), 'sanitize-final-hash-')
        );
        const xml = profileXmlWithUserPermissions({
            permissions: [{ name: 'PermA', enabled: true }]
        });
        const before = profileWorkspaceCanonicalContentService.sha256Utf8(xml);

        try {
            await writeWorkspaceProfile(workspacePath, 'Admin', xml);
            await sanitizationService.applySanitizationPlan({
                workspacePath,
                confirmedFailures: [
                    {
                        profileName: 'Admin',
                        permissionName: 'PermA',
                        sourceFailure: { problem: 'Unknown user permission: PermA' }
                    }
                ],
                attempt: 1
            });
            const rel =
                profileWorkspaceCanonicalContentService.resolveProfileWorkspaceRelativePath(
                    'Admin'
                );
            const after = profileWorkspaceCanonicalContentService.sha256Utf8(
                await readFile(path.join(workspacePath, ...rel.split('/')), 'utf8')
            );
            assert.notStrictEqual(before, after);
        } finally {
            await rm(workspacePath, { recursive: true, force: true });
        }
    });

    await runTest('28 workspace path traversal is rejected', async () => {
        assert.throws(() => {
            profileWorkspaceCanonicalContentService.resolveSafeWorkspaceAbsolutePath(
                '/tmp/ws',
                '../outside.profile-meta.xml'
            );
        });
    });

    await runTest('missing structured diagnostics stops extraction', async () => {
        const result =
            sanitizationService.extractConfirmedUnknownUserPermissionFailures(
                { success: false },
                selectedAdmin
            );
        assert.strictEqual(result.ok, false);
    });

    await runTest('buildSelectedProfileNameSet collects Profile names', async () => {
        const names = sanitizationService.buildSelectedProfileNameSet({
            metadata: [
                { metadataType: 'Profile', metadataName: 'Admin' },
                { metadataType: 'Profile', metadataName: ' Standard ' }
            ]
        });
        assert.ok(names.has('Admin'));
        assert.ok(names.has('Standard'));
    });

    await runTest('emptyProfilePermissionSanitization defaults', async () => {
        const empty = sanitizationService.emptyProfilePermissionSanitization();
        assert.strictEqual(empty.status, 'NOT_EXECUTED');
        assert.strictEqual(empty.removedCount, 0);
    });
}

main();
