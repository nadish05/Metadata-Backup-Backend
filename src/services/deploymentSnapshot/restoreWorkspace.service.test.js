'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const {
    CHANGE_CLASS,
    MEMBER_CAPTURE_STATUS
} = require('./snapshot.types');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');
const {
    createSnapshotCaptureService
} = require('./snapshotCapture.service');
const {
    createMemorySnapshotMetadataStore
} = require('./stores/memorySnapshotMetadataStore');
const {
    createMemorySnapshotBlobStore
} = require('./stores/memorySnapshotBlobStore');
const {
    buildRestoreWorkspace,
    assertSafeRelativePath
} = require('./restoreWorkspace.service');
const { ROLLBACK_CODE } = require('./snapshotRestore.errors');

const readFile = util.promisify(fs.readFile);
const stat = util.promisify(fs.stat);

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

function createCapture() {
    return createSnapshotCaptureService({
        metadataStore: createMemorySnapshotMetadataStore(),
        blobStore: createMemorySnapshotBlobStore()
    });
}

async function sealMember(service, member) {
    const ready = await service.captureSnapshot({
        deploymentContext: { destinationOrgId: '00D000000000001' },
        members: [member]
    });
    const sealed = await service.sealSnapshot(ready.snapshotId);
    const members = await service.getMembers(sealed.snapshotId);

    return { service, sealed, members };
}

function modified(type, name, files, filePath) {
    const bytes = packMemberFiles(files);
    const after = packMemberFiles(
        files.map((file) => ({
            ...file,
            bytes: Buffer.concat([file.bytes, Buffer.from('after')])
        }))
    );

    return {
        metadataType: type,
        metadataName: name,
        filePath: filePath || files[0].relativePath,
        changeClass: CHANGE_CLASS.MODIFIED,
        destinationBeforeBytes: bytes,
        expectedAfterHash: hashBytes(after)
    };
}

(async () => {
    await runTest('writes ApexClass exact bytes including CRLF', async () => {
        const crlf = Buffer.from('public class AccountService {\r\n}\r\n', 'utf8');
        const capture = createCapture();
        const { sealed, members } = await sealMember(
            capture,
            modified('ApexClass', 'AccountService', [
                {
                    relativePath: 'force-app/main/default/classes/AccountService.cls',
                    bytes: crlf
                },
                {
                    relativePath:
                        'force-app/main/default/classes/AccountService.cls-meta.xml',
                    bytes: Buffer.from('<ApexClass/>\r\n', 'utf8')
                }
            ])
        );

        const workspace = await buildRestoreWorkspace({
            snapshot: sealed,
            members,
            getArtifact: (id, artifactId) => capture.getArtifact(id, artifactId),
            tmpdir: os.tmpdir
        });

        assert.strictEqual(workspace.status, 'READY');
        assert.strictEqual(workspace.workspaceCreated, true);
        assert.strictEqual(workspace.packageXmlWritten, true);
        const written = await readFile(
            path.join(
                workspace.workspacePath,
                'force-app/main/default/classes/AccountService.cls'
            )
        );
        assert.deepStrictEqual(written, crlf);
        const xml = await readFile(
            path.join(workspace.workspacePath, 'package.xml'),
            'utf8'
        );
        assert.ok(xml.includes('<name>ApexClass</name>'));
        assert.ok(xml.includes('<members>AccountService</members>'));
        assert.ok(!xml.toLowerCase().includes('destructive'));
        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('writes ApexTrigger, CustomObject, CustomField, CustomMetadata, LWC', async () => {
        const capture = createCapture();
        const membersInput = [
            modified('ApexTrigger', 'AccountTrigger', [
                {
                    relativePath:
                        'force-app/main/default/triggers/AccountTrigger.trigger',
                    bytes: Buffer.from('trigger AccountTrigger on Account (before insert) {}', 'utf8')
                }
            ]),
            modified('CustomObject', 'Weather_Config__mdt', [
                {
                    relativePath:
                        'force-app/main/default/objects/Weather_Config__mdt/Weather_Config__mdt.object-meta.xml',
                    bytes: Buffer.from('<CustomObject/>', 'utf8')
                }
            ]),
            modified('CustomField', 'Weather_Config__mdt.api_key__c', [
                {
                    relativePath:
                        'force-app/main/default/objects/Weather_Config__mdt/fields/api_key__c.field-meta.xml',
                    bytes: Buffer.from('<CustomField/>', 'utf8')
                }
            ]),
            modified('CustomMetadata', 'Weather_Config.Default', [
                {
                    relativePath:
                        'force-app/main/default/customMetadata/Weather_Config.Default.md',
                    bytes: Buffer.from('<CustomMetadata/>', 'utf8')
                }
            ]),
            modified('LightningComponentBundle', 'weatherApp', [
                {
                    relativePath: 'force-app/main/default/lwc/weatherApp/weatherApp.js',
                    bytes: Buffer.from('export default class WeatherApp {}', 'utf8')
                },
                {
                    relativePath: 'force-app/main/default/lwc/weatherApp/weatherApp.html',
                    bytes: Buffer.from('<template></template>', 'utf8')
                },
                {
                    relativePath:
                        'force-app/main/default/lwc/weatherApp/weatherApp.js-meta.xml',
                    bytes: Buffer.from('<LightningComponentBundle/>', 'utf8')
                }
            ])
        ];

        const ready = await capture.captureSnapshot({
            deploymentContext: { destinationOrgId: '00D000000000001' },
            members: membersInput
        });
        const sealed = await capture.sealSnapshot(ready.snapshotId);
        const members = await capture.getMembers(sealed.snapshotId);
        const workspace = await buildRestoreWorkspace({
            snapshot: sealed,
            members,
            getArtifact: (id, artifactId) => capture.getArtifact(id, artifactId)
        });
        const xml = await readFile(
            path.join(workspace.workspacePath, 'package.xml'),
            'utf8'
        );

        assert.ok(xml.includes('ApexTrigger'));
        assert.ok(xml.includes('CustomObject'));
        assert.ok(xml.includes('CustomField'));
        assert.ok(xml.includes('CustomMetadata'));
        assert.ok(xml.includes('LightningComponentBundle'));
        assert.ok(xml.includes('Weather_Config.Default'));
        assert.ok(xml.includes('Weather_Config__mdt.api_key__c'));
        assert.ok(!fs.existsSync(path.join(workspace.workspacePath, 'destructiveChanges.xml')));
        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('preserves LF and binary bytes', async () => {
        const lf = Buffer.from('line1\nline2\n', 'utf8');
        const binary = Buffer.from([0, 1, 2, 255, 10, 13]);
        const capture = createCapture();
        const ready = await capture.captureSnapshot({
            deploymentContext: { destinationOrgId: '00D000000000001' },
            members: [
                modified('ApexClass', 'LfClass', [
                    {
                        relativePath: 'force-app/main/default/classes/LfClass.cls',
                        bytes: lf
                    }
                ]),
                modified('ApexClass', 'BinClass', [
                    {
                        relativePath: 'force-app/main/default/classes/BinClass.cls',
                        bytes: binary
                    }
                ])
            ]
        });
        const sealed = await capture.sealSnapshot(ready.snapshotId);
        const members = await capture.getMembers(sealed.snapshotId);
        const workspace = await buildRestoreWorkspace({
            snapshot: sealed,
            members,
            getArtifact: (id, artifactId) => capture.getArtifact(id, artifactId)
        });

        assert.deepStrictEqual(
            await readFile(
                path.join(
                    workspace.workspacePath,
                    'force-app/main/default/classes/LfClass.cls'
                )
            ),
            lf
        );
        assert.deepStrictEqual(
            await readFile(
                path.join(
                    workspace.workspacePath,
                    'force-app/main/default/classes/BinClass.cls'
                )
            ),
            binary
        );
        await fs.promises.rm(workspace.workspacePath, {
            recursive: true,
            force: true
        });
    });

    await runTest('rejects path traversal', async () => {
        assert.throws(() => assertSafeRelativePath('../etc/passwd'), (error) => {
            return error.code === ROLLBACK_CODE.WORKSPACE_FAILED;
        });
        assert.throws(() => assertSafeRelativePath('/tmp/x'), (error) => {
            return error.code === ROLLBACK_CODE.WORKSPACE_FAILED;
        });
    });

    await runTest('rejects duplicate conflicting paths', async () => {
        const capture = createCapture();
        const shared = packMemberFiles([
            {
                relativePath: 'force-app/main/default/classes/Shared.cls',
                bytes: Buffer.from('one', 'utf8')
            }
        ]);
        const ready = await capture.captureSnapshot({
            deploymentContext: { destinationOrgId: '00D000000000001' },
            members: [
                {
                    metadataType: 'ApexClass',
                    metadataName: 'One',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: shared,
                    expectedAfterHash: hashBytes(
                        packMemberFiles([
                            {
                                relativePath:
                                    'force-app/main/default/classes/Shared.cls',
                                bytes: Buffer.from('two', 'utf8')
                            }
                        ])
                    )
                },
                {
                    metadataType: 'ApexClass',
                    metadataName: 'Two',
                    changeClass: CHANGE_CLASS.MODIFIED,
                    destinationBeforeBytes: shared,
                    expectedAfterHash: hashBytes(
                        packMemberFiles([
                            {
                                relativePath:
                                    'force-app/main/default/classes/Shared.cls',
                                bytes: Buffer.from('three', 'utf8')
                            }
                        ])
                    )
                }
            ]
        });
        const sealed = await capture.sealSnapshot(ready.snapshotId);
        const members = await capture.getMembers(sealed.snapshotId);

        await assert.rejects(
            () =>
                buildRestoreWorkspace({
                    snapshot: sealed,
                    members,
                    getArtifact: (id, artifactId) =>
                        capture.getArtifact(id, artifactId)
                }),
            (error) => error.code === ROLLBACK_CODE.WORKSPACE_FAILED
        );
    });
})();
