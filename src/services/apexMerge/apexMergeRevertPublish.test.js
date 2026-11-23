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
const readFile = util.promisify(fs.readFile);

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    publishMethodMergeInRepo,
    runGit,
    sha256Utf8,
    PUBLISH_STATE
} = require('./apexMergePublish.service');
const {
    revertMethodMergeInRepo,
    revertMethodMergeSession,
    assertPublishNotAlreadyCompleted,
    REVERT_STATE
} = require('./apexMergeRevertPublish.service');
const { showBlobAtRef, revParseOriginHead } = require('./apexMergeGit.service');
const { companionMetaPath } = require('./apexMergePaths.util');
const {
    createSessionRecord,
    clearAllSessions,
    updateSession,
    getSession,
    SESSION_STATUS
} = require('./mergeSession.store');
const {
    publishMergeSession,
    revertPublishedMerge,
    sealMergeSession
} = require('./mergeSession.service');

const metaXml =
    '<?xml version="1.0"?><ApexClass xmlns="http://soap.sforce.com/2006/04/metadata"><apiVersion>59.0</apiVersion></ApexClass>';

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

async function initPublishRepository(fixtureRoot, options = {}) {
    const barePath = path.join(fixtureRoot, 'remote.git');
    const clonePath = path.join(fixtureRoot, 'clone');
    const clsPath = 'force-app/main/default/classes/WeatherService.cls';
    const metaPath = companionMetaPath(clsPath);
    const extraClsPath =
        options.extraClass?.filePath ||
        'force-app/main/default/classes/ForecastService.cls';

    await execAsync(`git init --bare ${JSON.stringify(barePath)}`);
    await execAsync(`git clone ${JSON.stringify(barePath)} ${JSON.stringify(clonePath)}`);

    const git = async (command) => {
        await execAsync(`cd ${JSON.stringify(clonePath)} && ${command}`);
    };

    await git('git config user.email "revert@test.local"');
    await git('git config user.name "Revert Test"');
    await git('git config core.autocrlf false');
    await git('git config core.eol lf');

    await mkdir(path.dirname(path.join(clonePath, clsPath)), {
        recursive: true
    });

    const baseCls = `public class WeatherService {
    public static void getWeather() {
        System.debug('base');
    }
}`;
    const sourceCls = `public class WeatherService {
    public static void getWeather() {
        System.debug('source');
    }
}`;
    const destinationCls = `public class WeatherService {
    public static void getWeather() {
        System.debug('destination');
    }
}`;

    await writeFile(path.join(clonePath, clsPath), baseCls, 'utf8');
    await writeFile(path.join(clonePath, metaPath), metaXml, 'utf8');

    if (options.extraClass) {
        await mkdir(path.dirname(path.join(clonePath, extraClsPath)), {
            recursive: true
        });
        await writeFile(
            path.join(clonePath, extraClsPath),
            options.extraClass.sourceContent,
            'utf8'
        );
        await writeFile(
            path.join(clonePath, companionMetaPath(extraClsPath)),
            metaXml,
            'utf8'
        );
    }

    await git('git add .');
    await git('git commit -m "base"');
    await git('git branch destination');
    await git('git branch source');
    await git('git checkout source');
    await writeFile(path.join(clonePath, clsPath), sourceCls, 'utf8');
    await git('git add .');
    await git('git commit -m "source"');

    await git('git checkout destination');
    await writeFile(path.join(clonePath, clsPath), destinationCls, 'utf8');
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
        clsPath,
        metaPath,
        extraClsPath,
        sourceHeadSha,
        destinationHeadSha,
        sourceCls,
        prePublishCls: sourceCls
    };
}

function buildComposedWeatherCls() {
    return `public class WeatherService {
    private static Integer cacheVersion = 1;
    public static void getWeather() {
        System.debug('merged-source');
    }
    public static void getHumidity() {
        System.debug('merged-dest-only');
    }
}`;
}

function buildResolvedMethodUnit(composedCls, metadataName = 'WeatherService', filePath) {
    return {
        metadataName,
        filePath: filePath || `force-app/main/default/classes/${metadataName}.cls`,
        metaXmlPath:
            companionMetaPath(
                filePath || `force-app/main/default/classes/${metadataName}.cls`
            ),
        mergeMode: 'METHOD',
        mergeBaseSha: 'base-sha',
        conflictState: 'RESOLVED',
        methodMerge: {
            methods: [],
            nestedClasses: [],
            conflictCount: 0,
            nestedClassConflictCount: 0,
            nestedClassComposeReady: true,
            declarationConflictCount: 0,
            declarationsResolved: true,
            resolved: true,
            compositionReady: true,
            composeSuccess: true,
            methodResolutions: []
        },
        artifacts: {
            cls: {
                content: composedCls,
                sha256: sha256Utf8(composedCls),
                conflict: false
            },
            metaXml: {
                content: metaXml,
                conflict: false
            }
        }
    };
}

function buildSession(units, pins, repoUrl, publish = null) {
    clearAllSessions();
    return createSessionRecord({
        comparisonId: 'cmp-revert',
        deploymentPlanId: 'plan-revert',
        repoUrl,
        sourceBranch: 'source',
        destinationBranch: 'destination',
        gitPins: { ...pins, recordedAt: new Date().toISOString() },
        inputMergePins: { ...pins },
        publish,
        status: 'RESOLVED',
        classes: units
    });
}

async function publishFixture(fixture, composedCls, extra = null) {
    const publishUnits = [
        {
            metadataName: 'WeatherService',
            filePath: fixture.clsPath,
            metaXmlPath: fixture.metaPath,
            clsContent: composedCls,
            clsSha256: sha256Utf8(composedCls)
        }
    ];

    if (extra) {
        publishUnits.push(extra);
    }

    return publishMethodMergeInRepo({
        repoPath: fixture.clonePath,
        sourceBranch: 'source',
        destinationBranch: 'destination',
        inputMergePins: {
            sourceHeadSha: fixture.sourceHeadSha,
            destinationHeadSha: fixture.destinationHeadSha
        },
        publishUnits
    });
}

async function main() {
    const composedCls = buildComposedWeatherCls();

    await runTest('successful single-class revert restores pre-publish content', async () => {
        const root = path.join(os.tmpdir(), `apex-revert-single-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const publish = await publishFixture(fixture, composedCls);
        const session = buildSession(
            [buildResolvedMethodUnit(composedCls, 'WeatherService', fixture.clsPath)],
            {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            fixture.repoUrl,
            publish
        );

        const revert = await revertMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: session.inputMergePins,
            publishedCommitSha: publish.publishedCommitSha,
            revertUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    publishedClsSha256: sha256Utf8(composedCls),
                    clsContent: composedCls
                }
            ]
        });

        assert.strictEqual(revert.revertState, REVERT_STATE.REVERTED);
        const remoteCls = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            fixture.clsPath
        );
        assert.strictEqual(remoteCls.content, fixture.prePublishCls);
        assert.notStrictEqual(revert.revertCommitSha, fixture.sourceHeadSha);
    });

    await runTest('revert uses no force push', async () => {
        const root = path.join(os.tmpdir(), `apex-revert-noforce-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const publish = await publishFixture(fixture, composedCls);
        const commands = [];

        await revertMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishedCommitSha: publish.publishedCommitSha,
            revertUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    publishedClsSha256: sha256Utf8(composedCls),
                    clsContent: composedCls
                }
            ],
            deps: {
                runGit: async (repoPath, command) => {
                    commands.push(command);
                    return runGit(repoPath, command);
                }
            }
        });

        const pushCommands = commands.filter((command) =>
            command.startsWith('push ')
        );
        assert.strictEqual(pushCommands.length, 1);
        assert.ok(!/--force\b|-f\b/.test(pushCommands[0]));
    });

    await runTest('successful multi-class revert in one commit', async () => {
        const forecastCls = `public class ForecastService {
    public static void run() { System.debug('merged-forecast'); }
}`;
        const root = path.join(os.tmpdir(), `apex-revert-multi-${Date.now()}`);
        const fixture = await initPublishRepository(root, {
            extraClass: {
                filePath: 'force-app/main/default/classes/ForecastService.cls',
                sourceContent: `public class ForecastService {
    public static void run() { System.debug('source'); }
}`
            }
        });
        const extra = {
            metadataName: 'ForecastService',
            filePath: fixture.extraClsPath,
            metaXmlPath: companionMetaPath(fixture.extraClsPath),
            clsContent: forecastCls,
            clsSha256: sha256Utf8(forecastCls)
        };
        const publish = await publishFixture(fixture, composedCls, extra);

        await revertMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishedCommitSha: publish.publishedCommitSha,
            revertUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    publishedClsSha256: sha256Utf8(composedCls),
                    clsContent: composedCls
                },
                {
                    metadataName: 'ForecastService',
                    filePath: fixture.extraClsPath,
                    metaXmlPath: companionMetaPath(fixture.extraClsPath),
                    publishedClsSha256: sha256Utf8(forecastCls),
                    clsContent: forecastCls
                }
            ]
        });

        const weather = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            fixture.clsPath
        );
        assert.strictEqual(weather.content, fixture.prePublishCls);
        const forecast = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            fixture.extraClsPath
        );
        assert.ok(forecast.content.includes("System.debug('source');"));
    });

    await runTest('destination branch and cls-meta.xml remain unchanged', async () => {
        const root = path.join(os.tmpdir(), `apex-revert-meta-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const beforeMeta = await readFile(
            path.join(fixture.clonePath, fixture.metaPath),
            'utf8'
        );
        const publish = await publishFixture(fixture, composedCls);

        await revertMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishedCommitSha: publish.publishedCommitSha,
            revertUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    publishedClsSha256: sha256Utf8(composedCls),
                    clsContent: composedCls
                }
            ]
        });

        const destHead = await revParseOriginHead(fixture.clonePath, 'destination');
        assert.strictEqual(destHead, fixture.destinationHeadSha);
        const remoteMeta = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            fixture.metaPath
        );
        assert.strictEqual(remoteMeta.content, beforeMeta);
    });

    await runTest('unrelated file commit is preserved after revert', async () => {
        const root = path.join(os.tmpdir(), `apex-revert-unrelated-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const publish = await publishFixture(fixture, composedCls);
        await writeFile(
            path.join(fixture.clonePath, 'notes.txt'),
            'unrelated',
            'utf8'
        );
        await runGit(fixture.clonePath, 'checkout source');
        await runGit(fixture.clonePath, 'add notes.txt');
        await runGit(fixture.clonePath, 'commit -m "unrelated"');
        await runGit(fixture.clonePath, 'push origin source');
        await runGit(fixture.clonePath, 'fetch origin');

        await revertMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishedCommitSha: publish.publishedCommitSha,
            revertUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    publishedClsSha256: sha256Utf8(composedCls),
                    clsContent: composedCls
                }
            ]
        });

        const notes = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            'notes.txt'
        );
        assert.strictEqual(notes.content, 'unrelated');
    });

    await runTest('revert refused after Apex file drift', async () => {
        const root = path.join(os.tmpdir(), `apex-revert-drift-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const publish = await publishFixture(fixture, composedCls);
        await writeFile(
            path.join(fixture.clonePath, fixture.clsPath),
            `${composedCls}\n// drift`,
            'utf8'
        );
        await runGit(fixture.clonePath, 'checkout source');
        await runGit(fixture.clonePath, 'add .');
        await runGit(fixture.clonePath, 'commit -m "drift"');
        await runGit(fixture.clonePath, 'push origin source');
        await runGit(fixture.clonePath, 'fetch origin');

        await assert.rejects(
            revertMethodMergeInRepo({
                repoPath: fixture.clonePath,
                sourceBranch: 'source',
                destinationBranch: 'destination',
                inputMergePins: {
                    sourceHeadSha: fixture.sourceHeadSha,
                    destinationHeadSha: fixture.destinationHeadSha
                },
                publishedCommitSha: publish.publishedCommitSha,
                revertUnits: [
                    {
                        metadataName: 'WeatherService',
                        filePath: fixture.clsPath,
                        metaXmlPath: fixture.metaPath,
                        publishedClsSha256: sha256Utf8(composedCls),
                        clsContent: composedCls
                    }
                ]
            }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.REVERT_SOURCE_FILE_DRIFT
        );
    });

    await runTest('revert refused when published commit is not ancestor', async () => {
        const root = path.join(os.tmpdir(), `apex-revert-diverge-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const publish = await publishFixture(fixture, composedCls);
        await runGit(fixture.clonePath, 'checkout source');
        await runGit(fixture.clonePath, 'reset --hard HEAD~1');
        await runGit(fixture.clonePath, 'push --force origin source');
        await runGit(fixture.clonePath, 'fetch origin');

        await assert.rejects(
            revertMethodMergeInRepo({
                repoPath: fixture.clonePath,
                sourceBranch: 'source',
                destinationBranch: 'destination',
                inputMergePins: {
                    sourceHeadSha: fixture.sourceHeadSha,
                    destinationHeadSha: fixture.destinationHeadSha
                },
                publishedCommitSha: publish.publishedCommitSha,
                revertUnits: [
                    {
                        metadataName: 'WeatherService',
                        filePath: fixture.clsPath,
                        metaXmlPath: fixture.metaPath,
                        publishedClsSha256: sha256Utf8(composedCls),
                        clsContent: composedCls
                    }
                ]
            }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.REVERT_HISTORY_DIVERGED
        );
    });

    await runTest('ambiguous push outcome reconciles on revert', async () => {
        const root = path.join(os.tmpdir(), `apex-revert-reconcile-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const publish = await publishFixture(fixture, composedCls);

        const result = await revertMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishedCommitSha: publish.publishedCommitSha,
            revertUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    publishedClsSha256: sha256Utf8(composedCls),
                    clsContent: composedCls
                }
            ],
            deps: {
                runGit: async (repoPath, command) => {
                    if (command.startsWith('push ')) {
                        await runGit(repoPath, command);
                        throw new Error('simulated transport error after push');
                    }

                    return runGit(repoPath, command);
                }
            }
        });

        assert.strictEqual(result.revertState, REVERT_STATE.REVERTED);
        const remoteCls = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            fixture.clsPath
        );
        assert.strictEqual(remoteCls.content, fixture.prePublishCls);
    });

    await runTest('repeated revert is idempotent at session layer', async () => {
        const root = path.join(os.tmpdir(), `apex-revert-dup-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const publish = await publishFixture(fixture, composedCls);
        const session = buildSession(
            [buildResolvedMethodUnit(composedCls, 'WeatherService', fixture.clsPath)],
            {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            fixture.repoUrl,
            publish
        );

        const first = await revertPublishedMerge(session.mergeSessionId, {
            comparisonId: 'cmp-revert',
            deploymentPlanId: 'plan-revert'
        });
        const second = await revertPublishedMerge(session.mergeSessionId, {
            comparisonId: 'cmp-revert',
            deploymentPlanId: 'plan-revert'
        });

        assert.strictEqual(first.revertState, REVERT_STATE.REVERTED);
        assert.strictEqual(second.revertState, REVERT_STATE.REVERTED);
        assert.strictEqual(
            getSession(session.mergeSessionId).status,
            SESSION_STATUS.REVERTED
        );
    });

    await runTest('revert refused for unpublished session', async () => {
        const session = buildSession(
            [buildResolvedMethodUnit(composedCls)],
            { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            'file://placeholder'
        );

        await assert.rejects(
            revertPublishedMerge(session.mergeSessionId),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.REVERT_NOT_ELIGIBLE
        );
    });

    await runTest('revert refused for sealed session', async () => {
        const session = buildSession(
            [buildResolvedMethodUnit(composedCls)],
            { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            'file://placeholder',
            {
                publishState: PUBLISH_STATE.PUBLISHED,
                publishedCommitSha: 'abc',
                publishedClasses: [
                    { metadataName: 'WeatherService', filePath: 'x.cls' }
                ]
            }
        );

        const { sealSession } = require('./mergeSession.store');
        sealSession(session.mergeSessionId, { mergeManifestId: 'm1', units: [] });

        await assert.rejects(
            revertPublishedMerge(session.mergeSessionId),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.SESSION_SEALED
        );
    });

    await runTest('reverted session cannot publish or seal', async () => {
        const session = buildSession(
            [buildResolvedMethodUnit(composedCls)],
            { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            'file://placeholder',
            {
                publishState: PUBLISH_STATE.PUBLISHED,
                publishedCommitSha: 'abc',
                publishedAt: new Date().toISOString(),
                publishedClasses: [
                    {
                        metadataName: 'WeatherService',
                        filePath:
                            'force-app/main/default/classes/WeatherService.cls'
                    }
                ]
            }
        );

        updateSession(session.mergeSessionId, {
            status: SESSION_STATUS.REVERTED,
            revert: {
                revertState: REVERT_STATE.REVERTED,
                revertCommitSha: 'def',
                revertedAt: new Date().toISOString(),
                revertedClasses: []
            }
        });

        await assert.rejects(
            publishMergeSession(session.mergeSessionId, {
                metadataNames: ['WeatherService']
            }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.SESSION_REVERTED
        );

        assert.throws(
            () => sealMergeSession(session.mergeSessionId),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.SESSION_REVERTED
        );
    });

    await runTest('one-publish-per-session rejects different second publish', () => {
        const session = buildSession(
            [buildResolvedMethodUnit(composedCls)],
            { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            'file://placeholder',
            {
                publishState: PUBLISH_STATE.PUBLISHED,
                publishedCommitSha: 'abc',
                publishedAt: new Date().toISOString(),
                publishedClasses: [
                    {
                        metadataName: 'WeatherService',
                        filePath:
                            'force-app/main/default/classes/WeatherService.cls'
                    }
                ]
            }
        );

        assert.throws(
            () =>
                assertPublishNotAlreadyCompleted(session, ['ForecastService']),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.PUBLISH_ALREADY_COMPLETED
        );

        assert.doesNotThrow(() =>
            assertPublishNotAlreadyCompleted(session, ['WeatherService'])
        );
    });

    await runTest('revert via session service with remote clone', async () => {
        const root = path.join(os.tmpdir(), `apex-revert-session-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const publish = await publishFixture(fixture, composedCls);
        const session = buildSession(
            [buildResolvedMethodUnit(composedCls, 'WeatherService', fixture.clsPath)],
            {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            fixture.repoUrl,
            publish
        );

        const prePublishSha = fixture.sourceHeadSha;
        const publishedCommitSha = publish.publishedCommitSha;

        assert.strictEqual(session.sourceBranch, 'source');
        assert.strictEqual(session.destinationBranch, 'destination');
        assert.strictEqual(session.inputMergePins.sourceHeadSha, prePublishSha);
        assert.ok(publishedCommitSha);
        assert.notStrictEqual(publishedCommitSha, prePublishSha);

        await runGit(fixture.clonePath, 'fetch origin');

        const remoteHeadBeforeRevert = await revParseOriginHead(
            fixture.clonePath,
            'source'
        );
        assert.strictEqual(remoteHeadBeforeRevert, publishedCommitSha);

        const publishedBlob = await showBlobAtRef(
            fixture.clonePath,
            remoteHeadBeforeRevert,
            fixture.clsPath
        );
        assert.strictEqual(publishedBlob.content, composedCls);
        assert.notStrictEqual(
            sha256Utf8(publishedBlob.content),
            sha256Utf8(fixture.prePublishCls)
        );

        const prePublishBlob = await showBlobAtRef(
            fixture.clonePath,
            prePublishSha,
            fixture.clsPath
        );
        assert.strictEqual(prePublishBlob.content, fixture.prePublishCls);
        assert.strictEqual(
            sha256Utf8(prePublishBlob.content),
            sha256Utf8(fixture.prePublishCls)
        );

        const destinationHeadBefore = await revParseOriginHead(
            fixture.clonePath,
            'destination'
        );
        assert.strictEqual(destinationHeadBefore, fixture.destinationHeadSha);

        const revert = await revertPublishedMerge(session.mergeSessionId, {
            comparisonId: 'cmp-revert',
            deploymentPlanId: 'plan-revert'
        });

        assert.strictEqual(revert.revertState, REVERT_STATE.REVERTED);
        assert.ok(revert.revertCommitSha);
        assert.notStrictEqual(revert.revertCommitSha, publishedCommitSha);

        const stored = getSession(session.mergeSessionId);
        assert.strictEqual(stored.status, SESSION_STATUS.REVERTED);
        assert.strictEqual(stored.revert.revertState, REVERT_STATE.REVERTED);

        await runGit(fixture.clonePath, 'fetch origin');

        const remoteHeadAfterRevert = await revParseOriginHead(
            fixture.clonePath,
            'source'
        );
        assert.strictEqual(remoteHeadAfterRevert, revert.revertCommitSha);
        assert.notStrictEqual(remoteHeadAfterRevert, publishedCommitSha);

        const remoteCls = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            fixture.clsPath
        );
        assert.strictEqual(remoteCls.content, fixture.prePublishCls);
        assert.strictEqual(
            sha256Utf8(remoteCls.content),
            sha256Utf8(prePublishBlob.content)
        );

        const destinationHeadAfter = await revParseOriginHead(
            fixture.clonePath,
            'destination'
        );
        assert.strictEqual(destinationHeadAfter, fixture.destinationHeadSha);

        const remoteMeta = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            fixture.metaPath
        );
        assert.strictEqual(remoteMeta.content, metaXml);
    });

    await runTest('existing publish regression tests remain green', async () => {
        const publishTest = path.join(__dirname, 'apexMergePublish.test.js');
        await execAsync(`node ${JSON.stringify(publishTest)}`);
    });

    if (process.exitCode) {
        throw new Error('One or more tests failed');
    }

    console.log('All Apex merge revert publish tests completed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});