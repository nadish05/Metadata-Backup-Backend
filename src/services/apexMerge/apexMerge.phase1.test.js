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

const {
    normalizeApexClassSelections,
    coalesceClassSelectionInput
} = require('./apexMergePaths.util');
const {
    mergeApexClassFull,
    hasConflictMarkers,
    resolveUnitArtifacts,
    RESOLUTION_STRATEGIES
} = require('./apexMergeFullClass.service');
const { buildApexMergeManifest, sha256Utf8 } = require('./apexMergeManifest.service');
const {
    createSessionRecord,
    clearAllSessions,
    sealSession,
    setTtlForTests,
    resetTtlForTests,
    SESSION_STATUS
} = require('./mergeSession.store');
const mergeSessionService = require('./mergeSession.service');
const {
    retrieveSealedMergeArtifact,
    authorizeArtifactHandoff,
    buildGrantExpiryIso,
    setResolveDestinationOrgIdentityForTests,
    resetResolveDestinationOrgIdentityForTests,
    setArtifactHandoffGrantWindowForTests,
    resetArtifactHandoffGrantWindowForTests
} = require('./apexMergeArtifactHandoff.service');
const { OrgLockIdentityError } = require('../deploymentOrgLock/deploymentOrgLock.errors');
const {
    computeSessionExpiryMs,
    patchSessionRaw
} = require('./mergeSession.store');
const { getSession } = require('./mergeSession.store');
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
    await runTest('coalesceClassSelectionInput prefers classes over eligibleClasses', () => {
        const fromClasses = coalesceClassSelectionInput({
            classes: [{ metadataName: 'A' }],
            eligibleClasses: [{ metadataName: 'B' }]
        });
        assert.strictEqual(fromClasses.length, 1);
        assert.strictEqual(fromClasses[0].metadataName, 'A');

        const fromEligible = coalesceClassSelectionInput({
            eligibleClasses: [{ metadataName: 'Eligible' }]
        });
        assert.strictEqual(fromEligible[0].metadataName, 'Eligible');
    });

    await runTest('normalizeApexClassSelections maps classFilePath to filePath', () => {
        const customPath =
            'force-app/main/default/classes/custom/pkg/Weather.cls';
        const normalized = normalizeApexClassSelections([
            {
                metadataType: 'ApexClass',
                metadataName: 'Weather',
                classFilePath: customPath
            }
        ]);

        assert.strictEqual(normalized.length, 1);
        assert.strictEqual(normalized[0].filePath, customPath);
    });

    await runTest('normalizeApexClassSelections rejects duplicate paths for same name', () => {
        assert.throws(
            () =>
                normalizeApexClassSelections([
                    {
                        metadataName: 'Dup',
                        filePath: 'force-app/main/default/classes/Dup.cls'
                    },
                    {
                        metadataName: 'Dup',
                        classFilePath: 'force-app/main/default/classes/other/Dup.cls'
                    }
                ]),
            (error) => error.code === MERGE_ERROR.DUPLICATE_CLASS_IDENTITY
        );
    });

    await runTest('ACCEPT_SOURCE and ACCEPT_TARGET resolve from stored threeWay artifacts', () => {
        const unit = {
            metadataName: 'Demo',
            conflictState: 'UNRESOLVED',
            threeWay: {
                cls: {
                    base: 'base',
                    source: 'source-cls',
                    destination: 'dest-cls'
                },
                metaXml: {
                    base: 'meta-base',
                    source: 'source-meta',
                    destination: 'dest-meta'
                }
            },
            artifacts: {
                cls: { content: '<<<<<<<' },
                metaXml: { content: '' }
            }
        };

        const fromSource = resolveUnitArtifacts(unit, {
            resolutionStrategy: RESOLUTION_STRATEGIES.ACCEPT_SOURCE
        });
        assert.strictEqual(fromSource.artifacts.cls.content, 'source-cls');
        assert.strictEqual(fromSource.artifacts.metaXml.content, 'source-meta');
        assert.strictEqual(fromSource.conflictState, 'RESOLVED');
        assert.ok(fromSource.artifacts.cls.sha256);

        const fromTarget = resolveUnitArtifacts(
            {
                ...unit,
                artifacts: { cls: { content: 'conflict' }, metaXml: { content: '' } }
            },
            { resolutionStrategy: RESOLUTION_STRATEGIES.ACCEPT_TARGET }
        );
        assert.strictEqual(fromTarget.artifacts.cls.content, 'dest-cls');
        assert.strictEqual(fromTarget.artifacts.metaXml.content, 'dest-meta');
    });

    await runTest('mapClassPreviewResponse exposes per-class mergedContent and hasConflicts', () => {
        const { mapClassPreviewResponse } = require('./mergeSession.service');
        const mapped = mapClassPreviewResponse({
            metadataName: 'X',
            filePath: 'force-app/main/default/classes/X.cls',
            metaXmlPath: 'force-app/main/default/classes/X.cls-meta.xml',
            mergeBaseSha: 'abc',
            conflictState: 'UNRESOLVED',
            drift: { status: 'MATCH' },
            artifacts: {
                cls: { content: '<<<<<<<\n', conflict: true },
                metaXml: { content: '<xml/>', conflict: false }
            }
        });

        assert.strictEqual(mapped.mergedContent, '<<<<<<<\n');
        assert.strictEqual(mapped.hasConflicts, true);
        assert.strictEqual(mapped.conflicts.length, 1);
        assert.strictEqual(mapped.preview.cls, mapped.mergedContent);
    });

    await runTest('buildApexMergeManifest uses units as canonical collection', () => {
        const session = createSessionRecord({
            comparisonId: 'cmp-units',
            deploymentPlanId: 'plan-units',
            repoUrl: 'https://github.com/example/repo.git',
            sourceBranch: 'source',
            destinationBranch: 'destination',
            gitPins: { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            classes: [
                {
                    metadataName: 'A',
                    filePath: 'force-app/main/default/classes/A.cls',
                    metaXmlPath: 'force-app/main/default/classes/A.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base',
                    conflictState: 'NONE',
                    artifacts: {
                        cls: { content: 'class A', conflict: false },
                        metaXml: { content: '<A/>', conflict: false }
                    }
                },
                {
                    metadataName: 'B',
                    filePath: 'force-app/main/default/classes/B.cls',
                    metaXmlPath: 'force-app/main/default/classes/B.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base',
                    conflictState: 'RESOLVED',
                    artifacts: {
                        cls: { content: 'class B', conflict: false },
                        metaXml: { content: '<B/>', conflict: false }
                    }
                }
            ]
        });

        const manifest = buildApexMergeManifest(session);
        assert.ok(Array.isArray(manifest.units));
        assert.strictEqual(manifest.units.length, 2);
        assert.strictEqual(manifest.units[0].artifacts.cls.sha256, sha256Utf8('class A'));
        assert.ok(!Object.prototype.hasOwnProperty.call(manifest, 'classes'));
    });

    await runTest('expired sealed session is purged from store', () => {
        clearAllSessions();
        setTtlForTests(1, 60 * 60 * 1000);

        const session = createSessionRecord({
            comparisonId: 'cmp-exp',
            deploymentPlanId: 'plan-exp',
            repoUrl: 'https://github.com/example/repo.git',
            sourceBranch: 'source',
            destinationBranch: 'destination',
            gitPins: { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            classes: []
        });

        sealSession(session.mergeSessionId, { mergeManifestId: 'manifest_test' });
        require('./mergeSession.store').patchSessionRaw(session.mergeSessionId, {
            sealedAt: new Date(Date.now() - 10).toISOString()
        });

        return new Promise((resolve) => {
            setTimeout(() => {
                const { getSession } = require('./mergeSession.store');
                assert.strictEqual(getSession(session.mergeSessionId), null);
                resetTtlForTests();
                resolve();
            }, 5);
        });
    });

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

    function buildSealedHandoffFixture(overrides = {}) {
        if (overrides.clearSessions !== false) {
            clearAllSessions();
        }

        const clsContent =
            overrides.clsContent ||
            'public class Demo { public String merged() { return "ok"; } }';
        const metaContent =
            overrides.metaContent ||
            '<?xml version="1.0"?><ApexClass><apiVersion>59.0</apiVersion></ApexClass>';

        const session = createSessionRecord({
            comparisonId: overrides.comparisonId || 'cmp-handoff',
            deploymentPlanId: overrides.deploymentPlanId || 'plan-handoff',
            repoUrl: 'https://github.com/example/repo.git',
            sourceBranch: 'source',
            destinationBranch: 'destination',
            gitPins: {
                sourceHeadSha: 'abc',
                destinationHeadSha: 'def'
            },
            classes: overrides.classes || [
                {
                    metadataName: 'Demo',
                    filePath: 'force-app/main/default/classes/Demo.cls',
                    metaXmlPath:
                        'force-app/main/default/classes/Demo.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base-sha',
                    conflictState: 'NONE',
                    artifacts: {
                        cls: { content: clsContent, conflict: false },
                        metaXml: { content: metaContent, conflict: false }
                    }
                }
            ]
        });

        const manifest = buildApexMergeManifest(session);
        sealSession(session.mergeSessionId, manifest);

        return {
            mergeSessionId: session.mergeSessionId,
            manifest,
            clsContent,
            metaContent,
            query: {
                comparisonId: manifest.comparisonId,
                deploymentPlanId: manifest.deploymentPlanId,
                mergeManifestId: manifest.mergeManifestId
            }
        };
    }

    const DEFAULT_HANDOFF_ORG = '00D000000000001AAA';

    function mockDestinationOAuth({
        verifiedOrgId = DEFAULT_HANDOFF_ORG,
        failWith = null
    } = {}) {
        if (failWith) {
            setResolveDestinationOrgIdentityForTests(async () => {
                throw failWith;
            });
            return;
        }

        setResolveDestinationOrgIdentityForTests(async ({ requestedOrgId }) => {
            return verifiedOrgId || requestedOrgId;
        });
    }

    function buildAuthorizeBody(fixture, overrides = {}) {
        return {
            refreshToken: 'refresh-token-mock',
            instanceUrl: 'https://destination.example.my.salesforce.com',
            orgId: DEFAULT_HANDOFF_ORG,
            comparisonId: fixture.query.comparisonId,
            deploymentPlanId: fixture.query.deploymentPlanId,
            mergeManifestId: fixture.query.mergeManifestId,
            ...overrides
        };
    }

    async function authorizeHandoffFixture(fixture, overrides = {}) {
        mockDestinationOAuth(overrides.oauth || {});
        const body = buildAuthorizeBody(fixture, overrides.body);
        const result = await authorizeArtifactHandoff(fixture.mergeSessionId, body);

        if (overrides.expectReject) {
            throw new Error('Expected authorizeArtifactHandoff to reject');
        }

        return result;
    }

    function teardownHandoffOAuthMocks() {
        resetResolveDestinationOrgIdentityForTests();
        resetArtifactHandoffGrantWindowForTests();
    }

    await runTest('sealed manifest includes stable artifact IDs for cls and metaXml', () => {
        const { manifest } = buildSealedHandoffFixture();
        const unit = manifest.units[0];

        assert.ok(unit.artifacts.cls.artifactId);
        assert.ok(unit.artifacts.metaXml.artifactId);
        assert.notStrictEqual(
            unit.artifacts.cls.artifactId,
            unit.artifacts.metaXml.artifactId
        );
        assert.match(unit.artifacts.cls.artifactId, /_Demo_cls$/);
        assert.match(unit.artifacts.metaXml.artifactId, /_Demo_metaXml$/);
    });

    await runTest('handoff returns exact UTF-8 bytes with matching hash and length', async () => {
        const fixture = buildSealedHandoffFixture();
        const { mergeSessionId, manifest, clsContent, metaContent, query } =
            fixture;
        await authorizeHandoffFixture(fixture);
        const clsId = manifest.units[0].artifacts.cls.artifactId;
        const metaId = manifest.units[0].artifacts.metaXml.artifactId;

        const clsBytes = retrieveSealedMergeArtifact({
            mergeSessionId,
            artifactId: clsId,
            ...query
        });
        const metaBytes = retrieveSealedMergeArtifact({
            mergeSessionId,
            artifactId: metaId,
            ...query
        });

        assert.strictEqual(clsBytes.toString('utf8'), clsContent);
        assert.strictEqual(metaBytes.toString('utf8'), metaContent);
        assert.strictEqual(
            manifest.units[0].artifacts.cls.sha256,
            sha256Utf8(clsContent)
        );
        assert.strictEqual(
            clsBytes.length,
            manifest.units[0].artifacts.cls.byteLength
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff rejects unknown artifact ID', async () => {
        const fixture = buildSealedHandoffFixture();
        const { mergeSessionId, manifest, query } = fixture;
        await authorizeHandoffFixture(fixture);

        assert.throws(
            () =>
                retrieveSealedMergeArtifact({
                    mergeSessionId,
                    artifactId: `${manifest.mergeManifestId}_Missing_cls`,
                    ...query
                }),
            (error) => error.code === MERGE_ERROR.ARTIFACT_NOT_FOUND
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff rejects unknown session', async () => {
        const fixture = buildSealedHandoffFixture();
        const { manifest, query } = fixture;
        await authorizeHandoffFixture(fixture);

        assert.throws(
            () =>
                retrieveSealedMergeArtifact({
                    mergeSessionId: 'merge_does_not_exist',
                    artifactId: manifest.units[0].artifacts.cls.artifactId,
                    ...query
                }),
            (error) => error.code === MERGE_ERROR.SESSION_NOT_FOUND
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff rejects expired sealed session', async () => {
        const fixture = buildSealedHandoffFixture();
        const { mergeSessionId, manifest, query } = fixture;
        await authorizeHandoffFixture(fixture);
        setTtlForTests(1, 60 * 60 * 1000);

        require('./mergeSession.store').patchSessionRaw(mergeSessionId, {
            sealedAt: new Date(Date.now() - 10).toISOString()
        });

        assert.throws(
            () =>
                retrieveSealedMergeArtifact({
                    mergeSessionId,
                    artifactId: manifest.units[0].artifacts.cls.artifactId,
                    ...query
                }),
            (error) => error.code === MERGE_ERROR.SESSION_EXPIRED
        );

        resetTtlForTests();
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff rejects unsealed session', () => {
        clearAllSessions();
        const session = createSessionRecord({
            comparisonId: 'cmp-open',
            deploymentPlanId: 'plan-open',
            repoUrl: 'https://github.com/example/repo.git',
            sourceBranch: 'source',
            destinationBranch: 'destination',
            gitPins: { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            classes: [
                {
                    metadataName: 'Open',
                    filePath: 'force-app/main/default/classes/Open.cls',
                    metaXmlPath: 'force-app/main/default/classes/Open.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base',
                    conflictState: 'NONE',
                    artifacts: {
                        cls: { content: 'public class Open {}', conflict: false },
                        metaXml: { content: '<xml/>', conflict: false }
                    }
                }
            ]
        });

        const manifest = buildApexMergeManifest(session);

        assert.throws(
            () =>
                retrieveSealedMergeArtifact({
                    mergeSessionId: session.mergeSessionId,
                    artifactId: manifest.units[0].artifacts.cls.artifactId,
                    comparisonId: manifest.comparisonId,
                    deploymentPlanId: manifest.deploymentPlanId,
                    mergeManifestId: manifest.mergeManifestId
                }),
            (error) => error.code === MERGE_ERROR.SESSION_NOT_SEALED
        );
    });

    await runTest('handoff rejects correlation mismatches', async () => {
        const fixture = buildSealedHandoffFixture();
        const { mergeSessionId, manifest, query } = fixture;
        await authorizeHandoffFixture(fixture);
        const artifactId = manifest.units[0].artifacts.cls.artifactId;

        const cases = [
            { ...query, comparisonId: 'wrong-cmp' },
            { ...query, deploymentPlanId: 'wrong-plan' },
            {
                ...query,
                mergeManifestId: 'manifest_00000000-0000-4000-8000-000000000099'
            }
        ];

        for (const badQuery of cases) {
            assert.throws(
                () =>
                    retrieveSealedMergeArtifact({
                        mergeSessionId,
                        artifactId,
                        ...badQuery
                    }),
                (error) => error.code === MERGE_ERROR.CORRELATION_MISMATCH
            );
        }
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff rejects tampered in-memory artifact bytes', async () => {
        const fixture = buildSealedHandoffFixture();
        const { mergeSessionId, manifest, query } = fixture;
        await authorizeHandoffFixture(fixture);
        const artifactId = manifest.units[0].artifacts.cls.artifactId;

        const live = getSession(mergeSessionId);
        live.classes[0].artifacts.cls.content =
            'public class Demo { public String tampered() { return "x"; } }';
        require('./mergeSession.store').updateSession(mergeSessionId, live);

        assert.throws(
            () =>
                retrieveSealedMergeArtifact({
                    mergeSessionId,
                    artifactId,
                    ...query
                }),
            (error) => error.code === MERGE_ERROR.HASH_MISMATCH
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff cannot read artifacts from another sealed session', async () => {
        const first = buildSealedHandoffFixture({
            comparisonId: 'cmp-a',
            deploymentPlanId: 'plan-a'
        });
        const second = buildSealedHandoffFixture({
            clearSessions: false,
            comparisonId: 'cmp-b',
            deploymentPlanId: 'plan-b',
            classes: [
                {
                    metadataName: 'Other',
                    filePath: 'force-app/main/default/classes/Other.cls',
                    metaXmlPath:
                        'force-app/main/default/classes/Other.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base-sha',
                    conflictState: 'NONE',
                    artifacts: {
                        cls: { content: 'public class Other {}', conflict: false },
                        metaXml: { content: '<other/>', conflict: false }
                    }
                }
            ]
        });

        await authorizeHandoffFixture(first);
        await authorizeHandoffFixture(second);

        assert.throws(
            () =>
                retrieveSealedMergeArtifact({
                    mergeSessionId: second.mergeSessionId,
                    artifactId: first.manifest.units[0].artifacts.cls.artifactId,
                    comparisonId: second.manifest.comparisonId,
                    deploymentPlanId: second.manifest.deploymentPlanId,
                    mergeManifestId: second.manifest.mergeManifestId
                }),
            (error) => error.code === MERGE_ERROR.ARTIFACT_NOT_FOUND
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('artifact handoff authorize succeeds with valid OAuth and matching org', async () => {
        const fixture = buildSealedHandoffFixture();

        const result = await authorizeHandoffFixture(fixture);

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.authorized, true);
        assert.strictEqual(result.mergeSessionId, fixture.mergeSessionId);
        assert.strictEqual(result.mergeManifestId, fixture.manifest.mergeManifestId);
        assert.strictEqual(result.verifiedOrgId, DEFAULT_HANDOFF_ORG);
        assert.ok(result.expiresAt);

        const session = getSession(fixture.mergeSessionId);
        assert.strictEqual(session.artifactHandoff.authorized, true);
        assert.strictEqual(session.artifactHandoff.verifiedOrgId, DEFAULT_HANDOFF_ORG);
        teardownHandoffOAuthMocks();
    });

    await runTest('artifact handoff authorize rejects invalid refresh token', async () => {
        const fixture = buildSealedHandoffFixture();
        mockDestinationOAuth({
            failWith: new OrgLockIdentityError(
                'Destination org identity verification failed: unable to authenticate.'
            )
        });

        await assert.rejects(
            () => authorizeArtifactHandoff(fixture.mergeSessionId, buildAuthorizeBody(fixture)),
            (error) => error.code === MERGE_ERROR.DESTINATION_AUTH_FAILED
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('artifact handoff authorize rejects revoked refresh token', async () => {
        const fixture = buildSealedHandoffFixture();
        mockDestinationOAuth({
            failWith: new OrgLockIdentityError(
                'Destination org identity verification failed: unable to authenticate.'
            )
        });

        await assert.rejects(
            () =>
                authorizeArtifactHandoff(fixture.mergeSessionId, {
                    ...buildAuthorizeBody(fixture),
                    refreshToken: 'revoked-token'
                }),
            (error) => error.code === MERGE_ERROR.DESTINATION_AUTH_FAILED
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('artifact handoff authorize rejects userinfo failure', async () => {
        const fixture = buildSealedHandoffFixture();
        mockDestinationOAuth({
            failWith: new OrgLockIdentityError(
                'Destination org identity verification failed: identity lookup failed.'
            )
        });

        await assert.rejects(
            () => authorizeArtifactHandoff(fixture.mergeSessionId, buildAuthorizeBody(fixture)),
            (error) => error.code === MERGE_ERROR.DESTINATION_AUTH_FAILED
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('artifact handoff authorize rejects org identity mismatch', async () => {
        const fixture = buildSealedHandoffFixture();
        mockDestinationOAuth({
            failWith: new OrgLockIdentityError(
                'Destination org identity verification failed: request orgId does not match authenticated org.'
            )
        });

        await assert.rejects(
            () => authorizeArtifactHandoff(fixture.mergeSessionId, buildAuthorizeBody(fixture)),
            (error) => error.code === MERGE_ERROR.ORG_IDENTITY_MISMATCH
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('artifact handoff authorize rejects missing refresh token', async () => {
        const fixture = buildSealedHandoffFixture();

        await assert.rejects(
            () =>
                authorizeArtifactHandoff(fixture.mergeSessionId, {
                    ...buildAuthorizeBody(fixture),
                    refreshToken: ''
                }),
            (error) => error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });

    await runTest('artifact handoff authorize rejects missing instance URL', async () => {
        const fixture = buildSealedHandoffFixture();

        await assert.rejects(
            () =>
                authorizeArtifactHandoff(fixture.mergeSessionId, {
                    ...buildAuthorizeBody(fixture),
                    instanceUrl: ''
                }),
            (error) => error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });

    await runTest('artifact handoff authorize rejects missing org ID', async () => {
        const fixture = buildSealedHandoffFixture();

        await assert.rejects(
            () =>
                authorizeArtifactHandoff(fixture.mergeSessionId, {
                    ...buildAuthorizeBody(fixture),
                    orgId: ''
                }),
            (error) => error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });

    await runTest('artifact handoff authorize rejects wrong correlation IDs', async () => {
        const fixture = buildSealedHandoffFixture();
        mockDestinationOAuth();

        const cases = [
            { comparisonId: 'wrong-cmp' },
            { deploymentPlanId: 'wrong-plan' },
            {
                mergeManifestId:
                    'manifest_00000000-0000-4000-8000-000000000099'
            }
        ];

        for (const patch of cases) {
            await assert.rejects(
                () =>
                    authorizeArtifactHandoff(
                        fixture.mergeSessionId,
                        buildAuthorizeBody(fixture, patch)
                    ),
                (error) => error.code === MERGE_ERROR.CORRELATION_MISMATCH
            );
        }
        teardownHandoffOAuthMocks();
    });

    await runTest('artifact handoff authorize rejects unsealed session', async () => {
        clearAllSessions();
        const session = createSessionRecord({
            comparisonId: 'cmp-open-auth',
            deploymentPlanId: 'plan-open-auth',
            repoUrl: 'https://github.com/example/repo.git',
            sourceBranch: 'source',
            destinationBranch: 'destination',
            gitPins: { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            classes: [
                {
                    metadataName: 'Open',
                    filePath: 'force-app/main/default/classes/Open.cls',
                    metaXmlPath: 'force-app/main/default/classes/Open.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base',
                    conflictState: 'NONE',
                    artifacts: {
                        cls: { content: 'public class Open {}', conflict: false },
                        metaXml: { content: '<xml/>', conflict: false }
                    }
                }
            ]
        });

        const manifest = buildApexMergeManifest(session);
        mockDestinationOAuth();

        await assert.rejects(
            () =>
                authorizeArtifactHandoff(session.mergeSessionId, {
                    refreshToken: 'rt',
                    instanceUrl: 'https://x.salesforce.com',
                    orgId: DEFAULT_HANDOFF_ORG,
                    comparisonId: manifest.comparisonId,
                    deploymentPlanId: manifest.deploymentPlanId,
                    mergeManifestId: manifest.mergeManifestId
                }),
            (error) => error.code === MERGE_ERROR.SESSION_NOT_SEALED
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff GET rejects missing authorization grant', () => {
        const { mergeSessionId, manifest, query } = buildSealedHandoffFixture();

        assert.throws(
            () =>
                retrieveSealedMergeArtifact({
                    mergeSessionId,
                    artifactId: manifest.units[0].artifacts.cls.artifactId,
                    ...query
                }),
            (error) => error.code === MERGE_ERROR.ARTIFACT_HANDOFF_NOT_AUTHORIZED
        );
    });

    await runTest('handoff GET rejects expired authorization grant', async () => {
        const fixture = buildSealedHandoffFixture();
        await authorizeHandoffFixture(fixture);

        patchSessionRaw(fixture.mergeSessionId, {
            artifactHandoff: {
                ...getSession(fixture.mergeSessionId).artifactHandoff,
                expiresAt: new Date(Date.now() - 1000).toISOString()
            }
        });

        assert.throws(
            () =>
                retrieveSealedMergeArtifact({
                    mergeSessionId: fixture.mergeSessionId,
                    artifactId: fixture.manifest.units[0].artifacts.cls.artifactId,
                    ...fixture.query
                }),
            (error) => error.code === MERGE_ERROR.ARTIFACT_HANDOFF_NOT_AUTHORIZED
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff GET succeeds with valid grant', async () => {
        const fixture = buildSealedHandoffFixture();
        await authorizeHandoffFixture(fixture);

        const bytes = retrieveSealedMergeArtifact({
            mergeSessionId: fixture.mergeSessionId,
            artifactId: fixture.manifest.units[0].artifacts.cls.artifactId,
            ...fixture.query
        });

        assert.strictEqual(bytes.toString('utf8'), fixture.clsContent);
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff grant on one session cannot authorize GET on another', async () => {
        const first = buildSealedHandoffFixture({ comparisonId: 'cmp-x' });
        const second = buildSealedHandoffFixture({
            clearSessions: false,
            comparisonId: 'cmp-y'
        });

        await authorizeHandoffFixture(first);

        assert.throws(
            () =>
                retrieveSealedMergeArtifact({
                    mergeSessionId: second.mergeSessionId,
                    artifactId: first.manifest.units[0].artifacts.cls.artifactId,
                    ...second.query
                }),
            (error) => error.code === MERGE_ERROR.ARTIFACT_HANDOFF_NOT_AUTHORIZED
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff GET with different manifest rejects grant correlation', async () => {
        const fixture = buildSealedHandoffFixture();
        await authorizeHandoffFixture(fixture);

        assert.throws(
            () =>
                retrieveSealedMergeArtifact({
                    mergeSessionId: fixture.mergeSessionId,
                    artifactId: fixture.manifest.units[0].artifacts.cls.artifactId,
                    ...fixture.query,
                    mergeManifestId:
                        'manifest_00000000-0000-4000-8000-000000000099'
                }),
            (error) => error.code === MERGE_ERROR.CORRELATION_MISMATCH
        );
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff GET with different comparison or plan rejects grant', async () => {
        const fixture = buildSealedHandoffFixture();
        await authorizeHandoffFixture(fixture);
        const artifactId = fixture.manifest.units[0].artifacts.cls.artifactId;

        for (const patch of [
            { comparisonId: 'other-cmp' },
            { deploymentPlanId: 'other-plan' }
        ]) {
            assert.throws(
                () =>
                    retrieveSealedMergeArtifact({
                        mergeSessionId: fixture.mergeSessionId,
                        artifactId,
                        ...fixture.query,
                        ...patch
                    }),
                (error) => error.code === MERGE_ERROR.CORRELATION_MISMATCH
            );
        }
        teardownHandoffOAuthMocks();
    });

    await runTest('handoff grant expiry does not exceed merge session expiry', () => {
        const fixture = buildSealedHandoffFixture();
        const session = getSession(fixture.mergeSessionId);
        setArtifactHandoffGrantWindowForTests(60 * 60 * 1000);

        const grantExpiry = buildGrantExpiryIso(session);
        const sessionExpiryMs = computeSessionExpiryMs(session);

        assert.ok(new Date(grantExpiry).getTime() <= sessionExpiryMs);
        teardownHandoffOAuthMocks();
    });

    await runTest('repeated authorize replaces grant for new verified org', async () => {
        const fixture = buildSealedHandoffFixture();
        const otherOrg = '00D000000000002AAA';

        mockDestinationOAuth({ verifiedOrgId: DEFAULT_HANDOFF_ORG });
        await authorizeArtifactHandoff(fixture.mergeSessionId, buildAuthorizeBody(fixture));

        mockDestinationOAuth({ verifiedOrgId: otherOrg });
        await authorizeArtifactHandoff(fixture.mergeSessionId, {
            ...buildAuthorizeBody(fixture),
            orgId: otherOrg
        });

        assert.strictEqual(
            getSession(fixture.mergeSessionId).artifactHandoff.verifiedOrgId,
            otherOrg
        );

        const bytes = retrieveSealedMergeArtifact({
            mergeSessionId: fixture.mergeSessionId,
            artifactId: fixture.manifest.units[0].artifacts.cls.artifactId,
            ...fixture.query
        });
        assert.ok(bytes.length > 0);
        teardownHandoffOAuthMocks();
    });

    await runTest('multiple classes expose distinct artifact IDs', () => {
        const { manifest } = buildSealedHandoffFixture({
            classes: [
                {
                    metadataName: 'Alpha',
                    filePath: 'force-app/main/default/classes/Alpha.cls',
                    metaXmlPath:
                        'force-app/main/default/classes/Alpha.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base',
                    conflictState: 'NONE',
                    artifacts: {
                        cls: { content: 'public class Alpha {}', conflict: false },
                        metaXml: { content: '<a/>', conflict: false }
                    }
                },
                {
                    metadataName: 'Beta',
                    filePath: 'force-app/main/default/classes/Beta.cls',
                    metaXmlPath:
                        'force-app/main/default/classes/Beta.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base',
                    conflictState: 'NONE',
                    artifacts: {
                        cls: { content: 'public class Beta {}', conflict: false },
                        metaXml: { content: '<b/>', conflict: false }
                    }
                }
            ]
        });

        const ids = new Set();

        for (const unit of manifest.units) {
            ids.add(unit.artifacts.cls.artifactId);
            ids.add(unit.artifacts.metaXml.artifactId);
        }

        assert.strictEqual(ids.size, 4);
    });
}

main();
