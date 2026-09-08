'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
} = require('./snapshot.types');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const { DEFAULT_API_VERSION } = require('../../config/salesforce');
const { ROLLBACK_CODE } = require('./snapshotRestore.errors');
const {
    buildMixedRollbackWorkspace,
    DESTRUCTIVE_MANIFEST_FILE
} = require('./mixedRollbackWorkspace.service');

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

const SNAPSHOT_ID = 'snapshot_mixed_p0r9';

function modifiedArtifactBytes(label = 'before') {
    return packMemberFiles([
        {
            relativePath:
                'force-app/main/default/classes/DemoModifiedClass.cls',
            bytes: Buffer.from(
                `public class DemoModifiedClass {\n    // ${label}\n}\n`,
                'utf8'
            )
        },
        {
            relativePath:
                'force-app/main/default/classes/DemoModifiedClass.cls-meta.xml',
            bytes: Buffer.from(
                '<?xml version="1.0" encoding="UTF-8"?>\n',
                'utf8'
            )
        }
    ]);
}

function modifiedMember(overrides = {}) {
    const artifactBytes = overrides.artifactBytes || modifiedArtifactBytes();

    return {
        metadataType: 'ApexClass',
        metadataName: 'DemoModifiedClass',
        filePath: 'force-app/main/default/classes/DemoModifiedClass.cls',
        changeClass: CHANGE_CLASS.MODIFIED,
        captureStatus: MEMBER_CAPTURE_STATUS.COMPLETE,
        destinationBeforeHash: hashBytes(artifactBytes),
        expectedAfterHash: hashBytes(modifiedArtifactBytes('after')),
        artifactId: `artifact-modified-${overrides.name || 'default'}`,
        artifactBytes,
        ...overrides
    };
}

function deleteMember(overrides = {}) {
    return {
        metadataType: 'ApexClass',
        metadataName: 'DemoDeletedClass',
        filePath: 'force-app/main/default/classes/DemoDeletedClass.cls',
        changeClass: CHANGE_CLASS.NEW,
        captureStatus: MEMBER_CAPTURE_STATUS.ABSENT_PROVEN,
        existedBefore: false,
        destinationBeforeHash: null,
        artifactId: null,
        expectedAfterHash: hashBytes(Buffer.from('deployed-delete\n', 'utf8')),
        ...overrides
    };
}

function createArtifactStore(members) {
    const artifacts = new Map();

    for (const member of members) {
        if (member.artifactBytes) {
            artifacts.set(member.artifactId, member.artifactBytes);
        }
    }

    return async (snapshotId, artifactId) => {
        assert.strictEqual(snapshotId, SNAPSHOT_ID);
        return artifacts.get(artifactId) || null;
    };
}

function readWorkspaceFile(workspacePath, relativePath) {
    return fs.readFileSync(path.join(workspacePath, relativePath), 'utf8');
}

(async () => {
    await runTest('H1. MODIFIED-only member produces restore files and package.xml', async () => {
        const member = modifiedMember();
        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: SNAPSHOT_ID },
            members: [member],
            getArtifact: createArtifactStore([member])
        });

        assert.ok(fs.existsSync(workspace.packageXmlPath));
        assert.match(
            readWorkspaceFile(workspace.workspacePath, 'package.xml'),
            /<members>DemoModifiedClass<\/members>/
        );
        assert.ok(
            fs.existsSync(
                path.join(
                    workspace.workspacePath,
                    'force-app/main/default/classes/DemoModifiedClass.cls'
                )
            )
        );
        assert.strictEqual(workspace.destructiveChangesPath, null);
        assert.strictEqual(workspace.preDestructiveChangesPath, null);
    });

    await runTest('H2. DELETE-only member produces destructiveChanges.xml', async () => {
        const member = deleteMember();
        const workspace = await buildMixedRollbackWorkspace({
            members: [member]
        });

        assert.ok(fs.existsSync(workspace.destructiveChangesPath));
        assert.match(
            readWorkspaceFile(workspace.workspacePath, DESTRUCTIVE_MANIFEST_FILE),
            /<members>DemoDeletedClass<\/members>/
        );
        assert.doesNotMatch(
            readWorkspaceFile(workspace.workspacePath, 'package.xml'),
            /<members>DemoDeletedClass<\/members>/
        );
        assert.strictEqual(workspace.restoreMembers.length, 0);
        assert.strictEqual(workspace.deleteMembers.length, 1);
    });

    await runTest('H3. mixed input splits package.xml and destructiveChanges.xml', async () => {
        const restore = modifiedMember();
        const deleted = deleteMember();
        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: SNAPSHOT_ID },
            members: [restore, deleted],
            getArtifact: createArtifactStore([restore])
        });
        const packageXml = readWorkspaceFile(workspace.workspacePath, 'package.xml');
        const destructiveXml = readWorkspaceFile(
            workspace.workspacePath,
            DESTRUCTIVE_MANIFEST_FILE
        );

        assert.match(packageXml, /<members>DemoModifiedClass<\/members>/);
        assert.doesNotMatch(packageXml, /<members>DemoDeletedClass<\/members>/);
        assert.match(destructiveXml, /<members>DemoDeletedClass<\/members>/);
        assert.doesNotMatch(destructiveXml, /<members>DemoModifiedClass<\/members>/);
    });

    await runTest('H4. mixed workspace contains MODIFIED restored artifact files', async () => {
        const restore = modifiedMember();
        const deleted = deleteMember();
        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: SNAPSHOT_ID },
            members: [restore, deleted],
            getArtifact: createArtifactStore([restore])
        });

        assert.ok(
            fs.existsSync(
                path.join(
                    workspace.workspacePath,
                    'force-app/main/default/classes/DemoModifiedClass.cls'
                )
            )
        );
        assert.ok(
            fs.existsSync(
                path.join(
                    workspace.workspacePath,
                    'force-app/main/default/classes/DemoModifiedClass.cls-meta.xml'
                )
            )
        );
    });

    await runTest('H5. DELETE member has no restore artifact written', async () => {
        const restore = modifiedMember();
        const deleted = deleteMember();
        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: SNAPSHOT_ID },
            members: [restore, deleted],
            getArtifact: createArtifactStore([restore])
        });

        assert.ok(
            !fs.existsSync(
                path.join(
                    workspace.workspacePath,
                    'force-app/main/default/classes/DemoDeletedClass.cls'
                )
            )
        );
    });

    await runTest('H6. both manifests share the same valid API version', async () => {
        const restore = modifiedMember();
        const deleted = deleteMember();
        const workspace = await buildMixedRollbackWorkspace({
            snapshot: { snapshotId: SNAPSHOT_ID },
            members: [restore, deleted],
            getArtifact: createArtifactStore([restore]),
            apiVersion: '61.0'
        });
        const packageXml = readWorkspaceFile(workspace.workspacePath, 'package.xml');
        const destructiveXml = readWorkspaceFile(
            workspace.workspacePath,
            DESTRUCTIVE_MANIFEST_FILE
        );

        assert.match(packageXml, /<version>61\.0<\/version>/);
        assert.match(destructiveXml, /<version>61\.0<\/version>/);
        assert.strictEqual(
            workspace.generatedManifest.summary.apiVersion,
            '61.0'
        );
    });

    await runTest(
        'H7. apiVersion null resolves through default policy without null version',
        async () => {
            const restore = modifiedMember();
            const deleted = deleteMember();
            const workspace = await buildMixedRollbackWorkspace({
                snapshot: { snapshotId: SNAPSHOT_ID },
                members: [restore, deleted],
                getArtifact: createArtifactStore([restore]),
                apiVersion: null
            });
            const packageXml = readWorkspaceFile(workspace.workspacePath, 'package.xml');
            const destructiveXml = readWorkspaceFile(
                workspace.workspacePath,
                DESTRUCTIVE_MANIFEST_FILE
            );

            assert.strictEqual(
                workspace.generatedManifest.summary.apiVersion,
                DEFAULT_API_VERSION
            );
            assert.match(
                packageXml,
                new RegExp(`<version>${DEFAULT_API_VERSION}</version>`)
            );
            assert.match(
                destructiveXml,
                new RegExp(`<version>${DEFAULT_API_VERSION}</version>`)
            );
            assert.doesNotMatch(packageXml, /<version>null<\/version>/);
            assert.doesNotMatch(destructiveXml, /<version>null<\/version>/);
        }
    );

    await runTest('H8. explicit apiVersion 61.0 is respected', async () => {
        const deleted = deleteMember();
        const workspace = await buildMixedRollbackWorkspace({
            members: [deleted],
            apiVersion: '61.0'
        });

        assert.strictEqual(
            workspace.generatedManifest.summary.apiVersion,
            '61.0'
        );
    });

    await runTest('H9. missing MODIFIED artifact is rejected', async () => {
        const member = modifiedMember();

        await assert.rejects(
            () =>
                buildMixedRollbackWorkspace({
                    snapshot: { snapshotId: SNAPSHOT_ID },
                    members: [member],
                    getArtifact: async () => null
                }),
            (error) =>
                error.code === ROLLBACK_CODE.ARTIFACT_MISSING &&
                error.message.includes('DemoModifiedClass')
        );
    });

    await runTest('H10. DELETE member missing expectedAfterHash is rejected', async () => {
        await assert.rejects(
            () =>
                buildMixedRollbackWorkspace({
                    members: [deleteMember({ expectedAfterHash: null })]
                }),
            (error) =>
                error.code === ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE &&
                error.message.includes('DemoDeletedClass')
        );
    });

    await runTest('H11. DELETE member not ABSENT_PROVEN is rejected', async () => {
        await assert.rejects(
            () =>
                buildMixedRollbackWorkspace({
                    members: [
                        deleteMember({
                            captureStatus: MEMBER_CAPTURE_STATUS.UNKNOWN
                        })
                    ]
                }),
            (error) =>
                error.code === ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE &&
                error.message.includes('DemoDeletedClass')
        );
    });

    await runTest('H12. unsupported member is rejected', async () => {
        await assert.rejects(
            () =>
                buildMixedRollbackWorkspace({
                    members: [
                        {
                            metadataType: 'ApexClass',
                            metadataName: 'UnsupportedClass',
                            changeClass: CHANGE_CLASS.UNKNOWN,
                            captureStatus: MEMBER_CAPTURE_STATUS.UNKNOWN
                        }
                    ]
                }),
            (error) => error.code === ROLLBACK_CODE.SNAPSHOT_NOT_ELIGIBLE
        );
    });

    await runTest(
        'H13. mixed builder returns package and destructive manifest paths',
        async () => {
            const restore = modifiedMember();
            const deleted = deleteMember();
            const workspace = await buildMixedRollbackWorkspace({
                snapshot: { snapshotId: SNAPSHOT_ID },
                members: [restore, deleted],
                getArtifact: createArtifactStore([restore])
            });

            assert.strictEqual(
                workspace.packageXmlPath,
                path.join(workspace.workspacePath, 'package.xml')
            );
            assert.strictEqual(
                workspace.destructiveChangesPath,
                path.join(workspace.workspacePath, DESTRUCTIVE_MANIFEST_FILE)
            );
            assert.strictEqual(
                workspace.destructiveChangesXmlPath,
                workspace.destructiveChangesPath
            );
            assert.strictEqual(
                workspace.preDestructiveChangesPath,
                DESTRUCTIVE_MANIFEST_FILE
            );
        }
    );

    await runTest('H14. workspace builder does not execute Salesforce CLI', async () => {
        const source = fs.readFileSync(
            path.join(__dirname, 'mixedRollbackWorkspace.service.js'),
            'utf8'
        );

        assert.doesNotMatch(source, /\bsf project deploy\b/);
        assert.doesNotMatch(source, /child_process/);
        assert.doesNotMatch(source, /execAsync/);
    });
})();
