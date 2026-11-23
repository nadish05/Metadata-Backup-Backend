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

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    buildMethodPreviewUnit,
    METHOD_RESOLUTION_STRATEGY,
    DECLARATION_RESOLUTION_SIDE
} = require('./apexMergeMethodSession.service');
const { METHOD_STATUS } = require('./apexMergeMethodMerge.service');
const { showBlobAtRef } = require('./apexMergeGit.service');
const {
    clearAllSessions,
    createSessionRecord,
    getSession,
    updateSession,
    SESSION_STATUS
} = require('./mergeSession.store');
const {
    createMergeSession,
    previewMergeSession,
    resolveMergeSession,
    sealMergeSession
} = require('./mergeSession.service');
const { RESOLUTION_STRATEGIES } = require('./apexMergeFullClass.service');

const CLASS_A = 'MethodMergeNoConflictDemo';
const CLASS_B = 'DeclarationMergeTest';
const PATH_A = `force-app/main/default/classes/${CLASS_A}.cls`;
const PATH_B = `force-app/main/default/classes/${CLASS_B}.cls`;
const metaXml =
    '<?xml version="1.0"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion></ApexClass>';

const BASE_A = `public with sharing class ${CLASS_A} {
    public static Decimal calculateDiscount(Decimal amount) {
        return amount * 0.05;
    }
}`;

const SOURCE_A = `public with sharing class ${CLASS_A} {
    public static Decimal calculateDiscount(Decimal amount) {
        return amount * 0.10;
    }
}`;

const DEST_A = `public with sharing class ${CLASS_A} {
    public static Decimal calculateDiscount(Decimal amount) {
        return amount * 0.15;
    }
}`;

const SOURCE_B = `public without sharing class ${CLASS_B} {
    public static void run() {
        System.debug('source');
    }
}`;

const DEST_B = `public inherited sharing class ${CLASS_B} {
    public static void run() {
        System.debug('destination');
    }
}`;

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

function fileRepoUrl(barePath) {
    const normalized = barePath.replace(/\\/g, '/');
    return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

function unitFingerprint(unit) {
    return JSON.stringify({
        metadataName: unit.metadataName,
        mergeMode: unit.mergeMode,
        conflictState: unit.conflictState,
        methodResolutions: unit.methodMerge?.methodResolutions ?? null,
        declarationResolutions: unit.methodMerge?.declarationResolutions ?? null,
        clsSha256: unit.artifacts?.cls?.sha256 ?? null,
        clsLength: unit.artifacts?.cls?.content?.length ?? null
    });
}

function buildMethodUnit(metadataName, filePath, source, destination) {
    const preview = buildMethodPreviewUnit({
        metadataName,
        filePath,
        metaXmlPath: `${filePath}-meta.xml`,
        mergeBaseSha: 'base-sha',
        clsThreeWay: { base: '', source, destination },
        metaMerge: { content: metaXml, conflict: false }
    });
    preview.artifacts.metaXml = { content: metaXml, conflict: false };
    return preview;
}

function createTwoClassSession(unitA, unitB, overrides = {}) {
    clearAllSessions();
    return createSessionRecord({
        comparisonId: 'cmp-multi',
        deploymentPlanId: 'plan-multi',
        repoUrl: overrides.repoUrl || 'https://github.com/example/repo.git',
        sourceBranch: 'source',
        destinationBranch: 'destination',
        gitPins: overrides.gitPins || {
            sourceHeadSha: 'abc',
            destinationHeadSha: 'def'
        },
        status: SESSION_STATUS.PREVIEWED,
        classes: [unitA, unitB]
    });
}

function installDriftStub(repoPath, destinationRef, pathsByName) {
    const drift = require('./apexMergeDrift.service');
    const { packMemberFiles } = require('../deploymentSnapshot/destinationMemberArtifact.service');
    const {
        buildExpectedMemberSourcePaths
    } = require('../deploymentSnapshot/destinationMetadataRetriever.service');
    const original = drift.assertNoDestinationDrift;

    drift.assertNoDestinationDrift = async (options = {}) => {
        const retrieveMember = async ({ metadataName }) => {
            const repoRelativePath =
                pathsByName[metadataName] ||
                buildExpectedMemberSourcePaths('ApexClass', metadataName).cls.replace(
                    /\\/g,
                    '/'
                );
            const blob = await showBlobAtRef(
                repoPath,
                destinationRef,
                repoRelativePath
            );

            return {
                artifactBytes: packMemberFiles([
                    {
                        relativePath: repoRelativePath,
                        bytes: Buffer.from(blob.content || '', 'utf8')
                    }
                ])
            };
        };

        return original({ ...options, retrieveMember });
    };

    return () => {
        drift.assertNoDestinationDrift = original;
    };
}

async function initTwoClassGitRepository(root) {
    const barePath = path.join(root, 'remote.git');
    const clonePath = path.join(root, 'clone');

    await execAsync(`git init --bare ${JSON.stringify(barePath)}`);
    await execAsync(`git clone ${JSON.stringify(barePath)} ${JSON.stringify(clonePath)}`);

    const git = async (command) => {
        await execAsync(`cd ${JSON.stringify(clonePath)} && ${command}`);
    };

    await git('git config user.email "multi@test.local"');
    await git('git config user.name "Multi Class Test"');
    await git('git config core.autocrlf false');

    await mkdir(path.dirname(path.join(clonePath, PATH_A)), { recursive: true });
    await writeFile(path.join(clonePath, PATH_A), BASE_A, 'utf8');
    await writeFile(path.join(clonePath, `${PATH_A}-meta.xml`), metaXml, 'utf8');
    await writeFile(path.join(clonePath, PATH_B), DEST_B, 'utf8');
    await writeFile(path.join(clonePath, `${PATH_B}-meta.xml`), metaXml, 'utf8');

    await git('git add .');
    await git('git commit -m "base"');
    await git('git branch destination');
    await git('git branch source');

    await git('git checkout source');
    await writeFile(path.join(clonePath, PATH_A), SOURCE_A, 'utf8');
    await writeFile(path.join(clonePath, PATH_B), SOURCE_B, 'utf8');
    await git('git add .');
    await git('git commit -m "source"');

    await git('git checkout destination');
    await writeFile(path.join(clonePath, PATH_A), DEST_A, 'utf8');
    await writeFile(path.join(clonePath, PATH_B), DEST_B, 'utf8');
    await git('git add .');
    await git('git commit -m "destination"');

    await git('git checkout source');
    await git('git push -u origin source');
    await git('git push origin destination');

    const sourceHeadSha = (
        await execAsync(
            `cd ${JSON.stringify(clonePath)} && git rev-parse origin/source`
        )
    ).stdout.trim();
    const destinationHeadSha = (
        await execAsync(
            `cd ${JSON.stringify(clonePath)} && git rev-parse origin/destination`
        )
    ).stdout.trim();

    return {
        barePath,
        clonePath,
        repoUrl: fileRepoUrl(barePath),
        sourceHeadSha,
        destinationHeadSha,
        pathsByName: {
            [CLASS_A]: PATH_A,
            [CLASS_B]: PATH_B
        }
    };
}

async function main() {
    await runTest('Test 1: focused METHOD preview isolates non-focused class', async () => {
        const root = path.join(os.tmpdir(), `apex-multi-preview-${Date.now()}`);
        const fixture = await initTwoClassGitRepository(root);
        const restoreDrift = installDriftStub(
            fixture.clonePath,
            `origin/destination`,
            fixture.pathsByName
        );

        try {
            const created = await createMergeSession({
                comparisonId: 'cmp-multi',
                deploymentPlanId: 'plan-multi',
                repoUrl: fixture.repoUrl,
                sourceBranch: 'source',
                destinationBranch: 'destination',
                classes: [
                    { metadataName: CLASS_A, filePath: PATH_A },
                    { metadataName: CLASS_B, filePath: PATH_B }
                ]
            });

            const beforeB = getSession(created.mergeSessionId).classes.find(
                (unit) => unit.metadataName === CLASS_B
            );
            const bBefore = unitFingerprint(beforeB);

            await previewMergeSession(created.mergeSessionId, {
                comparisonId: 'cmp-multi',
                deploymentPlanId: 'plan-multi',
                metadataName: CLASS_A,
                mode: 'METHOD',
                refreshToken: 'rt',
                instanceUrl: 'https://example.test'
            });

            const after = getSession(created.mergeSessionId).classes;
            const unitA = after.find((unit) => unit.metadataName === CLASS_A);
            const unitB = after.find((unit) => unit.metadataName === CLASS_B);

            assert.strictEqual(unitA.mergeMode, 'METHOD');
            assert.strictEqual(unitB.mergeMode, 'FULL');
            assert.strictEqual(unitFingerprint(unitB), bBefore);
        } finally {
            restoreDrift();
        }
    });

    await runTest('Test 2–3: resolve B while A stays UNRESOLVED', () => {
        const unitA = buildMethodUnit(CLASS_A, PATH_A, SOURCE_A, DEST_A);
        const unitB = buildMethodUnit(CLASS_B, PATH_B, SOURCE_B, DEST_B);
        const session = createTwoClassSession(unitA, unitB);
        const aBefore = unitFingerprint(unitA);

        const response = resolveMergeSession(session.mergeSessionId, {
            metadataName: CLASS_B,
            declarationResolutions: [
                {
                    conflictKey: 'declaration:sharing',
                    side: DECLARATION_RESOLUTION_SIDE.SOURCE
                }
            ]
        });

        const stored = getSession(session.mergeSessionId);
        const afterA = stored.classes.find((unit) => unit.metadataName === CLASS_A);
        const afterB = stored.classes.find((unit) => unit.metadataName === CLASS_B);

        assert.strictEqual(
            unitFingerprint(afterA),
            aBefore,
            'class A must remain unchanged'
        );
        assert.strictEqual(afterB.mergeMode, 'METHOD');
        assert.strictEqual(response.metadataName, CLASS_B);
    });

    await runTest('Test 2: resolutions survive when only B is touched via resolve', () => {
        let unitA = buildMethodUnit(CLASS_A, PATH_A, SOURCE_A, DEST_A);
        const unitB = buildMethodUnit(CLASS_B, PATH_B, SOURCE_B, DEST_B);
        const session = createTwoClassSession(unitA, unitB);

        unitA = resolveMergeSession(session.mergeSessionId, {
            metadataName: CLASS_A,
            methodResolutions: [
                {
                    scopedMethodKey: `${CLASS_A}#calculateDiscount(Decimal)`,
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        const storedAfterA = getSession(session.mergeSessionId);
        const aResolved = storedAfterA.classes.find(
            (unit) => unit.metadataName === CLASS_A
        );
        const aFingerprint = unitFingerprint(aResolved);
        assert.ok(aResolved.methodMerge?.methodResolutions?.length > 0);

        resolveMergeSession(session.mergeSessionId, {
            metadataName: CLASS_B,
            declarationResolutions: [
                {
                    conflictKey: 'declaration:sharing',
                    side: DECLARATION_RESOLUTION_SIDE.SOURCE
                }
            ]
        });

        const stored = getSession(session.mergeSessionId);
        const afterA = stored.classes.find((unit) => unit.metadataName === CLASS_A);
        assert.strictEqual(unitFingerprint(afterA), aFingerprint);
    });

    await runTest('Test 4: resolve another conflict in A leaves B unchanged', () => {
        const unitA = buildMethodUnit(CLASS_A, PATH_A, SOURCE_A, DEST_A);
        let unitB = buildMethodUnit(CLASS_B, PATH_B, SOURCE_B, DEST_B);
        const session = createTwoClassSession(unitA, unitB);

        resolveMergeSession(session.mergeSessionId, {
            metadataName: CLASS_B,
            declarationResolutions: [
                {
                    conflictKey: 'declaration:sharing',
                    side: DECLARATION_RESOLUTION_SIDE.SOURCE
                }
            ]
        });

        const bFingerprint = unitFingerprint(
            getSession(session.mergeSessionId).classes.find(
                (unit) => unit.metadataName === CLASS_B
            )
        );

        resolveMergeSession(session.mergeSessionId, {
            metadataName: CLASS_A,
            methodResolutions: [
                {
                    scopedMethodKey: `${CLASS_A}#calculateDiscount(Decimal)`,
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        const afterB = getSession(session.mergeSessionId).classes.find(
            (unit) => unit.metadataName === CLASS_B
        );
        assert.strictEqual(unitFingerprint(afterB), bFingerprint);
    });

    await runTest('Test 5: focused re-preview resets only class A resolutions', async () => {
        const root = path.join(os.tmpdir(), `apex-multi-repreview-${Date.now()}`);
        const fixture = await initTwoClassGitRepository(root);
        const restoreDrift = installDriftStub(
            fixture.clonePath,
            'origin/destination',
            fixture.pathsByName
        );

        try {
            const created = await createMergeSession({
                comparisonId: 'cmp-multi',
                deploymentPlanId: 'plan-multi',
                repoUrl: fixture.repoUrl,
                sourceBranch: 'source',
                destinationBranch: 'destination',
                classes: [
                    { metadataName: CLASS_A, filePath: PATH_A },
                    { metadataName: CLASS_B, filePath: PATH_B }
                ]
            });

            await previewMergeSession(created.mergeSessionId, {
                comparisonId: 'cmp-multi',
                deploymentPlanId: 'plan-multi',
                metadataName: CLASS_A,
                mode: 'METHOD',
                refreshToken: 'rt',
                instanceUrl: 'https://example.test'
            });

            const discountKey = `${CLASS_A}#calculateDiscount(Decimal)`;
            let unitAAfterPreview = getSession(created.mergeSessionId).classes.find(
                (unit) => unit.metadataName === CLASS_A
            );
            const discountAfterPreview = unitAAfterPreview.methodMerge.methods.find(
                (entry) => entry.scopedMethodKey === discountKey
            );
            assert.strictEqual(
                discountAfterPreview.status,
                METHOD_STATUS.CONFLICT,
                'Git fixture must expose a true method conflict on calculateDiscount'
            );

            resolveMergeSession(created.mergeSessionId, {
                metadataName: CLASS_A,
                methodResolutions: [
                    {
                        scopedMethodKey: discountKey,
                        strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                    }
                ]
            });

            await previewMergeSession(created.mergeSessionId, {
                comparisonId: 'cmp-multi',
                deploymentPlanId: 'plan-multi',
                metadataName: CLASS_B,
                mode: 'METHOD',
                refreshToken: 'rt',
                instanceUrl: 'https://example.test'
            });

            const bBeforeRepreviewA = unitFingerprint(
                getSession(created.mergeSessionId).classes.find(
                    (unit) => unit.metadataName === CLASS_B
                )
            );

            await previewMergeSession(created.mergeSessionId, {
                comparisonId: 'cmp-multi',
                deploymentPlanId: 'plan-multi',
                metadataName: CLASS_A,
                mode: 'METHOD',
                refreshToken: 'rt',
                instanceUrl: 'https://example.test'
            });

            const stored = getSession(created.mergeSessionId);
            const unitA = stored.classes.find((unit) => unit.metadataName === CLASS_A);
            const unitB = stored.classes.find((unit) => unit.metadataName === CLASS_B);

            assert.deepStrictEqual(unitA.methodMerge?.methodResolutions, []);
            const discountAfterRepreview = unitA.methodMerge.methods.find(
                (entry) => entry.scopedMethodKey === discountKey
            );
            assert.strictEqual(
                discountAfterRepreview.status,
                METHOD_STATUS.CONFLICT,
                're-preview must rebuild the Git conflict inventory for calculateDiscount'
            );
            assert.strictEqual(unitFingerprint(unitB), bBeforeRepreviewA);
        } finally {
            restoreDrift();
        }
    });

    await runTest('Test 6: targeted validation remains strict', () => {
        const unitA = buildMethodUnit(CLASS_A, PATH_A, SOURCE_A, DEST_A);
        const unitB = buildMethodUnit(CLASS_B, PATH_B, SOURCE_B, DEST_B);
        const session = createTwoClassSession(unitA, unitB);

        assert.throws(
            () =>
                resolveMergeSession(session.mergeSessionId, {
                    metadataName: 'MissingClass',
                    methodResolutions: []
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.INVALID_REQUEST
        );

        assert.throws(
            () =>
                resolveMergeSession(session.mergeSessionId, {
                    metadataName: CLASS_A,
                    methodResolutions: [
                        {
                            scopedMethodKey: `${CLASS_A}#unknown()`,
                            strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                        }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.UNKNOWN_METHOD_KEY
        );

        assert.throws(
            () =>
                resolveMergeSession(session.mergeSessionId, {
                    metadataName: CLASS_B,
                    declarationResolutions: [
                        {
                            conflictKey: 'declaration:missing',
                            side: DECLARATION_RESOLUTION_SIDE.SOURCE
                        }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.UNKNOWN_DECLARATION_CONFLICT_KEY
        );
    });

    await runTest('Test 7: seal remains session-wide strict', () => {
        const unitA = buildMethodUnit(CLASS_A, PATH_A, SOURCE_A, DEST_A);
        const unitB = buildMethodUnit(CLASS_B, PATH_B, SOURCE_B, DEST_B);
        const session = createTwoClassSession(unitA, unitB);

        resolveMergeSession(session.mergeSessionId, {
            metadataName: CLASS_A,
            methodResolutions: [
                {
                    scopedMethodKey: `${CLASS_A}#calculateDiscount(Decimal)`,
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        assert.throws(
            () => sealMergeSession(session.mergeSessionId),
            (error) =>
                error instanceof ApexMergeError &&
                (error.code === MERGE_ERROR.DECLARATION_UNRESOLVED_CONFLICT ||
                    error.code === MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT ||
                    error.code === MERGE_ERROR.METHOD_COMPOSE_FAILED ||
                    error.code === MERGE_ERROR.UNRESOLVED_CONFLICT)
        );
    });

    await runTest('Test 8: batch FULL resolve still processes explicit targets', () => {
        clearAllSessions();
        const session = createSessionRecord({
            comparisonId: 'cmp-full',
            deploymentPlanId: 'plan-full',
            repoUrl: 'https://github.com/example/repo.git',
            sourceBranch: 'source',
            destinationBranch: 'destination',
            gitPins: { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            status: SESSION_STATUS.PREVIEWED,
            classes: [
                {
                    metadataName: 'FullA',
                    filePath: 'force-app/main/default/classes/FullA.cls',
                    metaXmlPath: 'force-app/main/default/classes/FullA.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base',
                    conflictState: 'UNRESOLVED',
                    threeWay: {
                        cls: {
                            base: 'a',
                            source: 'source-a',
                            destination: 'dest-a'
                        },
                        metaXml: {
                            base: '',
                            source: '<xml/>',
                            destination: '<xml/>'
                        }
                    },
                    artifacts: {
                        cls: { content: '<<<<<<<', conflict: true },
                        metaXml: { content: '<xml/>', conflict: false }
                    }
                },
                {
                    metadataName: 'FullB',
                    filePath: 'force-app/main/default/classes/FullB.cls',
                    metaXmlPath: 'force-app/main/default/classes/FullB.cls-meta.xml',
                    mergeMode: 'FULL',
                    mergeBaseSha: 'base',
                    conflictState: 'UNRESOLVED',
                    threeWay: {
                        cls: {
                            base: 'b',
                            source: 'source-b',
                            destination: 'dest-b'
                        },
                        metaXml: {
                            base: '',
                            source: '<xml/>',
                            destination: '<xml/>'
                        }
                    },
                    artifacts: {
                        cls: { content: '<<<<<<<', conflict: true },
                        metaXml: { content: '<xml/>', conflict: false }
                    }
                }
            ]
        });

        resolveMergeSession(session.mergeSessionId, {
            resolutions: [
                {
                    metadataName: 'FullA',
                    resolutionStrategy: RESOLUTION_STRATEGIES.ACCEPT_SOURCE
                },
                {
                    metadataName: 'FullB',
                    resolutionStrategy: RESOLUTION_STRATEGIES.ACCEPT_TARGET
                }
            ]
        });

        const stored = getSession(session.mergeSessionId).classes;
        assert.strictEqual(stored[0].conflictState, 'RESOLVED');
        assert.strictEqual(stored[0].artifacts.cls.content, 'source-a');
        assert.strictEqual(stored[1].conflictState, 'RESOLVED');
        assert.strictEqual(stored[1].artifacts.cls.content, 'dest-b');
    });

    await runTest('Test 9: publish and revert regression tests remain green', async () => {
        const publishTest = path.join(__dirname, 'apexMergePublish.test.js');
        const revertTest = path.join(__dirname, 'apexMergeRevertPublish.test.js');
        await execAsync(`node ${JSON.stringify(publishTest)}`);
        await execAsync(`node ${JSON.stringify(revertTest)}`);
    });

    if (process.exitCode) {
        throw new Error('One or more multi-class session tests failed');
    }

    console.log('All multi-class Apex merge session tests completed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});