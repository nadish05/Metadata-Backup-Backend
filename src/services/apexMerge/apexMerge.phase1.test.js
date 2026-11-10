'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);
const writeFile = util.promisify(fs.writeFile);
const mkdir = util.promisify(fs.mkdir);

const { normalizeApexClassSelections } = require('./apexMergePaths.util');
const { mergeApexClassFull, hasConflictMarkers } = require('./apexMergeFullClass.service');
const { buildApexMergeManifest, sha256Utf8 } = require('./apexMergeManifest.service');
const {
    createSessionRecord,
    clearAllSessions,
    sealSession,
    SESSION_STATUS
} = require('./mergeSession.store');
const mergeSessionService = require('./mergeSession.service');
const { assertNoDestinationDrift } = require('./apexMergeDrift.service');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function initFixtureRepository(fixtureRoot) {
    const clsPath = 'force-app/main/default/classes/Demo.cls';
    const metaPath = 'force-app/main/default/classes/Demo.cls-meta.xml';

    await mkdir(path.join(fixtureRoot, path.dirname(clsPath)), {
        recursive: true
    });

    const runGit = async (command) => {
        await execAsync(`cd ${JSON.stringify(fixtureRoot)} && ${command}`);
    };

    await runGit('git init');
    await runGit('git config user.email "merge@test.local"');
    await runGit('git config user.name "Merge Test"');
    await runGit('git config core.autocrlf false');
    await runGit('git config core.eol lf');

    await writeFile(
        path.join(fixtureRoot, clsPath),
        'public class Demo {\n    public String base() { return "base"; }\n}\n',
        'utf8'
    );
    await writeFile(
        path.join(fixtureRoot, metaPath),
        '<?xml version="1.0"?>\n<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\n    <apiVersion>59.0</apiVersion>\n</ApexClass>\n',
        'utf8'
    );
    await runGit('git add .');
    await runGit('git commit -m "base"');
    await runGit('git branch destination');
    await runGit('git checkout -b source');

    await writeFile(
        path.join(fixtureRoot, clsPath),
        'public class Demo {\n    public String base() { return "base"; }\n    public String fromSource() { return "s"; }\n}\n',
        'utf8'
    );
    await runGit('git add .');
    await runGit('git commit -m "source change"');

    await runGit('git checkout destination');

    await runGit('git update-ref refs/remotes/origin/source refs/heads/source');
    await runGit(
        'git update-ref refs/remotes/origin/destination refs/heads/destination'
    );

    return { clsPath, metaPath };
}

async function main() {
    await runTest('normalizeApexClassSelections collapses cls and meta rows', () => {
        const normalized = normalizeApexClassSelections([
            {
                metadataType: 'ApexClass',
                metadataName: 'Weather',
                filePath: 'force-app/main/default/classes/Weather.cls'
            },
            {
                metadataType: 'ApexClass',
                filePath: 'force-app/main/default/classes/Weather.cls-meta.xml'
            }
        ]);

        assert.strictEqual(normalized.length, 1);
        assert.strictEqual(normalized[0].metadataName, 'Weather');
    });

    await runTest('full-class merge combines non-conflicting source and destination edits', async () => {
        const fixtureRoot = path.join(os.tmpdir(), `apex-merge-fixture-${Date.now()}`);
        const { clsPath } = await initFixtureRepository(fixtureRoot);

        const result = await mergeApexClassFull({
            repoPath: fixtureRoot,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            metadataName: 'Demo',
            filePath: clsPath
        });

        assert.strictEqual(result.conflictState, 'NONE');
        assert.match(result.artifacts.cls.content, /fromSource/);
        assert.match(result.artifacts.cls.content, /base\(\)/);
        assert.ok(result.artifacts.metaXml.content.includes('<apiVersion>'));
    });

    await runTest('conflict markers are detected', () => {
        assert.strictEqual(hasConflictMarkers('<<<<<<< HEAD\n'), true);
        assert.strictEqual(hasConflictMarkers('public class X {}'), false);
    });

    await runTest('manifest hashes are server-computed at seal time', () => {
        clearAllSessions();

        const session = createSessionRecord({
            comparisonId: 'cmp-1',
            deploymentPlanId: 'plan-1',
            repoUrl: 'https://github.com/example/repo.git',
            sourceBranch: 'source',
            destinationBranch: 'destination',
            gitPins: {
                sourceHeadSha: 'abc',
                destinationHeadSha: 'def'
            },
            classes: [
                {
                    metadataName: 'Demo',
                    filePath: 'force-app/main/default/classes/Demo.cls',
                    metaXmlPath:
                        'force-app/main/default/classes/Demo.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base-sha',
                    conflictState: 'NONE',
                    artifacts: {
                        cls: {
                            content:
                                'public class Demo { public String merged() { return "ok"; } }',
                            conflict: false
                        },
                        metaXml: {
                            content:
                                '<?xml version="1.0"?><ApexClass><apiVersion>59.0</apiVersion></ApexClass>',
                            conflict: false
                        }
                    }
                }
            ]
        });

        const manifest = buildApexMergeManifest(session);
        const unit = manifest.units[0];

        assert.strictEqual(
            unit.artifacts.cls.sha256,
            sha256Utf8(session.classes[0].artifacts.cls.content)
        );
        assert.strictEqual(
            unit.artifacts.metaXml.sha256,
            sha256Utf8(session.classes[0].artifacts.metaXml.content)
        );

        sealSession(session.mergeSessionId, manifest);
    });

    await runTest('destination drift detection compares org vs git hashes', async () => {
        const gitContent = 'public class Demo { public String git() { return "g"; } }';
        const orgContent = 'public class Demo { public String org() { return "o"; } }';

        const { gitClsContentToBuffer } = require('./apexMergeDrift.service');
        const { packMemberFiles } = require('../deploymentSnapshot/destinationMemberArtifact.service');
        const { hashBytes } = require('../deploymentSnapshot/snapshotIntegrity.service');
        const { extractClsBytesFromPack } = require('./apexMergeDrift.service');

        const pack = packMemberFiles([
            {
                relativePath: 'force-app/main/default/classes/Demo.cls',
                bytes: Buffer.from(orgContent, 'utf8')
            }
        ]);

        const orgBytes = extractClsBytesFromPack(pack, 'Demo');
        const gitBytes = gitClsContentToBuffer(gitContent);
        assert.notStrictEqual(hashBytes(orgBytes), hashBytes(gitBytes));
    });

    await runTest('seal rejects unresolved conflicts', () => {
        const session = createSessionRecord({
            comparisonId: 'cmp-2',
            deploymentPlanId: 'plan-2',
            repoUrl: 'https://github.com/example/repo.git',
            sourceBranch: 'source',
            destinationBranch: 'destination',
            gitPins: {
                sourceHeadSha: 'abc',
                destinationHeadSha: 'def'
            },
            classes: [
                {
                    metadataName: 'Demo',
                    filePath: 'force-app/main/default/classes/Demo.cls',
                    metaXmlPath:
                        'force-app/main/default/classes/Demo.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base-sha',
                    conflictState: 'UNRESOLVED',
                    artifacts: {
                        cls: { content: '<<<<<<< HEAD\n', conflict: true },
                        metaXml: {
                            content:
                                '<?xml version="1.0"?><ApexClass><apiVersion>59.0</apiVersion></ApexClass>',
                            conflict: false
                        }
                    }
                }
            ]
        });

        assert.throws(
            () => buildApexMergeManifest(session),
            (error) => error.code === MERGE_ERROR.UNRESOLVED_CONFLICT
        );
    });

    await runTest('create session requires comparison and plan ids', async () => {
        clearAllSessions();

        await assert.rejects(
            () =>
                mergeSessionService.createMergeSession({
                    repoUrl: 'https://github.com/example/repo.git',
                    sourceBranch: 'source',
                    destinationBranch: 'destination',
                    classes: [{ metadataName: 'Demo' }]
                }),
            (error) => error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });
}

main();
