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
    selectPublishUnits,
    PUBLISH_STATE
} = require('./apexMergePublish.service');
const { showBlobAtRef, revParseOriginHead } = require('./apexMergeGit.service');
const { companionMetaPath } = require('./apexMergePaths.util');
const {
    createSessionRecord,
    clearAllSessions,
    updateSession
} = require('./mergeSession.store');
const { publishMergeSession } = require('./mergeSession.service');
const {
    buildMethodPreviewUnit,
    resolveMethodMergeUnit,
    METHOD_RESOLUTION_STRATEGY
} = require('./apexMergeMethodSession.service');

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

    await git('git config user.email "publish@test.local"');
    await git('git config user.name "Publish Test"');
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
        clsPath,
        metaPath,
        extraClsPath,
        sourceHeadSha,
        destinationHeadSha,
        sourceCls,
        destinationCls
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

function buildResolvedMethodUnit(composedCls, metadataName = 'WeatherService') {
  return {
        metadataName,
        filePath: `force-app/main/default/classes/${metadataName}.cls`,
        metaXmlPath: `force-app/main/default/classes/${metadataName}.cls-meta.xml`,
        mergeMode: 'METHOD',
        mergeBaseSha: 'base-sha',
        conflictState: 'RESOLVED',
        methodMerge: {
            methods: [
                {
                    methodKey: 'getWeather()',
                    status: 'RESOLVED',
                    included: true
                },
                {
                    methodKey: 'getHumidity()',
                    status: 'AUTO_INCLUDED',
                    included: true
                }
            ],
            conflictCount: 0,
            resolved: true,
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

function buildPublishSession(unit, inputMergePins, repoUrl = 'file://placeholder') {
    clearAllSessions();

    return createSessionRecord({
        comparisonId: 'cmp-publish',
        deploymentPlanId: 'plan-publish',
        repoUrl,
        sourceBranch: 'source',
        destinationBranch: 'destination',
        gitPins: {
            ...inputMergePins,
            recordedAt: new Date().toISOString()
        },
        inputMergePins: { ...inputMergePins },
        publish: null,
        status: 'RESOLVED',
        classes: [unit]
    });
}

async function main() {
    const composedCls = buildComposedWeatherCls();

    await runTest('successful Source branch publishing replaces .cls exactly', async () => {
        const root = path.join(os.tmpdir(), `apex-publish-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const unit = buildResolvedMethodUnit(composedCls);

        const result = await publishMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    clsContent: composedCls,
                    clsSha256: sha256Utf8(composedCls)
                }
            ]
        });

        assert.strictEqual(result.publishState, PUBLISH_STATE.PUBLISHED);
        assert.ok(result.publishedCommitSha);

        const remoteCls = await showBlobAtRef(
            fixture.clonePath,
            `origin/source`,
            fixture.clsPath
        );
        assert.strictEqual(remoteCls.content, composedCls);
    });

    await runTest('destination branch remains unchanged after publish', async () => {
        const root = path.join(os.tmpdir(), `apex-publish-dest-${Date.now()}`);
        const fixture = await initPublishRepository(root);

        await publishMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    clsContent: composedCls,
                    clsSha256: sha256Utf8(composedCls)
                }
            ]
        });

        const destCls = await showBlobAtRef(
            fixture.clonePath,
            'origin/destination',
            fixture.clsPath
        );

        assert.ok(destCls.content.includes("System.debug('destination');"));
        const destinationHead = await revParseOriginHead(
            fixture.clonePath,
            'destination'
        );
        assert.strictEqual(destinationHead, fixture.destinationHeadSha);
    });

    await runTest('source cls-meta.xml remains unchanged', async () => {
        const root = path.join(os.tmpdir(), `apex-publish-meta-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const beforeMeta = await readFile(
            path.join(fixture.clonePath, fixture.metaPath),
            'utf8'
        );

        await publishMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    clsContent: composedCls,
                    clsSha256: sha256Utf8(composedCls)
                }
            ]
        });

        const remoteMeta = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            fixture.metaPath
        );
        assert.strictEqual(remoteMeta.content, beforeMeta);
    });

    await runTest('source branch SHA mismatch rejects publishing', async () => {
        const root = path.join(os.tmpdir(), `apex-publish-stale-${Date.now()}`);
        const fixture = await initPublishRepository(root);

        await writeFile(
            path.join(fixture.clonePath, fixture.clsPath),
            `${composedCls}\n`,
            'utf8'
        );
        await runGit(fixture.clonePath, 'checkout source');
        await runGit(fixture.clonePath, 'add .');
        await runGit(fixture.clonePath, 'commit -m "advance source"');
        await runGit(fixture.clonePath, 'push origin source');
        await runGit(fixture.clonePath, 'fetch origin');

        await assert.rejects(
            publishMethodMergeInRepo({
                repoPath: fixture.clonePath,
                sourceBranch: 'source',
                destinationBranch: 'destination',
                inputMergePins: {
                    sourceHeadSha: fixture.sourceHeadSha,
                    destinationHeadSha: fixture.destinationHeadSha
                },
                publishUnits: [
                    {
                        metadataName: 'WeatherService',
                        filePath: fixture.clsPath,
                        metaXmlPath: fixture.metaPath,
                        clsContent: composedCls,
                        clsSha256: sha256Utf8(composedCls)
                    }
                ]
            }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.PUBLISH_SOURCE_BRANCH_CHANGED
        );
    });

    await runTest('publish uses no force push', async () => {
        const root = path.join(os.tmpdir(), `apex-publish-noforce-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const commands = [];

        await publishMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    clsContent: composedCls,
                    clsSha256: sha256Utf8(composedCls)
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

    await runTest('unresolved METHOD conflicts prevent publishing', () => {
        const shell = `public class WeatherService {
    private static Integer cacheVersion = 1;
`;
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base',
            clsThreeWay: {
                base: `${shell}
    public static void getWeather() { System.debug('base'); }
}`,
                source: `${shell}
    public static void getWeather() { System.debug('source'); }
}`,
                destination: `${shell}
    public static void getWeather() { System.debug('destination'); }
}`
            },
            metaMerge: { content: metaXml, conflict: false }
        });

        const session = buildPublishSession(preview, {
            sourceHeadSha: 'abc',
            destinationHeadSha: 'def'
        });

        assert.throws(
            () =>
                selectPublishUnits(session, ['WeatherService']),
            (error) =>
                error instanceof ApexMergeError &&
                (error.code === MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT ||
                    error.code === MERGE_ERROR.PUBLISH_NOT_ELIGIBLE)
        );
    });

    await runTest('invalid class selection is rejected', () => {
        const unit = buildResolvedMethodUnit(composedCls);
        const session = buildPublishSession(unit, {
            sourceHeadSha: 'abc',
            destinationHeadSha: 'def'
        });

        assert.throws(
            () => selectPublishUnits(session, ['MissingClass']),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });

    await runTest('multiple classes publish in one commit', async () => {
        const root = path.join(os.tmpdir(), `apex-publish-multi-${Date.now()}`);
        const forecastCls = `public class ForecastService {
    public static void run() { System.debug('merged-forecast'); }
}`;
        const fixture = await initPublishRepository(root, {
            extraClass: {
                filePath: 'force-app/main/default/classes/ForecastService.cls',
                sourceContent: `public class ForecastService {
    public static void run() { System.debug('source'); }
}`
            }
        });

        const result = await publishMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    clsContent: composedCls,
                    clsSha256: sha256Utf8(composedCls)
                },
                {
                    metadataName: 'ForecastService',
                    filePath: fixture.extraClsPath,
                    metaXmlPath: companionMetaPath(fixture.extraClsPath),
                    clsContent: forecastCls,
                    clsSha256: sha256Utf8(forecastCls)
                }
            ]
        });

        assert.strictEqual(result.publishedClasses.length, 2);
        const remoteForecast = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            fixture.extraClsPath
        );
        assert.strictEqual(remoteForecast.content, forecastCls);
    });

    await runTest('one invalid class prevents all publishing before Git writes', () => {
        const good = buildResolvedMethodUnit(composedCls);
        const forecastCls = `public class ForecastService { }`;
        const bad = {
            metadataName: 'ForecastService',
            filePath: 'force-app/main/default/classes/ForecastService.cls',
            mergeMode: 'FULL',
            conflictState: 'NONE',
            artifacts: {
                cls: { content: forecastCls, conflict: false },
                metaXml: { content: metaXml, conflict: false }
            }
        };

        const session = createSessionRecord({
            comparisonId: 'cmp',
            deploymentPlanId: 'plan',
            repoUrl: 'x',
            sourceBranch: 'source',
            destinationBranch: 'destination',
            gitPins: { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            inputMergePins: { sourceHeadSha: 'a', destinationHeadSha: 'b' },
            classes: [good, bad]
        });

        assert.throws(
            () =>
                selectPublishUnits(session, ['WeatherService', 'ForecastService']),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.PUBLISH_NOT_ELIGIBLE
        );
    });

    await runTest('git push rejection does not require caller to mark published', async () => {
        const root = path.join(os.tmpdir(), `apex-publish-reject-${Date.now()}`);
        const fixture = await initPublishRepository(root);

        await assert.rejects(
            publishMethodMergeInRepo({
                repoPath: fixture.clonePath,
                sourceBranch: 'source',
                destinationBranch: 'destination',
                inputMergePins: {
                    sourceHeadSha: fixture.sourceHeadSha,
                    destinationHeadSha: fixture.destinationHeadSha
                },
                publishUnits: [
                    {
                        metadataName: 'WeatherService',
                        filePath: fixture.clsPath,
                        metaXmlPath: fixture.metaPath,
                        clsContent: composedCls,
                        clsSha256: sha256Utf8(composedCls)
                    }
                ],
                deps: {
                    runGit: async (repoPath, command) => {
                        if (command.startsWith('push ')) {
                            throw new Error('push rejected');
                        }

                        return runGit(repoPath, command);
                    }
                }
            }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.PUBLISH_PUSH_REJECTED
        );
    });

    await runTest('duplicate publish does not create duplicate commits', async () => {
        const root = path.join(os.tmpdir(), `apex-publish-dup-${Date.now()}`);
        const fixture = await initPublishRepository(root);

        const publishUnits = [
            {
                metadataName: 'WeatherService',
                filePath: fixture.clsPath,
                metaXmlPath: fixture.metaPath,
                clsContent: composedCls,
                clsSha256: sha256Utf8(composedCls)
            }
        ];

        const first = await publishMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishUnits
        });

        await runGit(fixture.clonePath, 'fetch origin');

        const second = await publishMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishUnits,
            existingPublish: {
                publishState: PUBLISH_STATE.PUBLISHED,
                publishedCommitSha: first.publishedCommitSha,
                publishedAt: first.publishedAt,
                publishedClasses: first.publishedClasses
            }
        });

        assert.strictEqual(second.publishedCommitSha, first.publishedCommitSha);

        const log = (
            await execAsync(
                `cd ${JSON.stringify(fixture.clonePath)} && git rev-list --count origin/source`
            )
        ).stdout.trim();

        assert.ok(Number(log) >= 2);
    });

    await runTest('network failure after push reconciles remote state safely', async () => {
        const root = path.join(os.tmpdir(), `apex-publish-reconcile-${Date.now()}`);
        const fixture = await initPublishRepository(root);

        const result = await publishMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: {
                sourceHeadSha: fixture.sourceHeadSha,
                destinationHeadSha: fixture.destinationHeadSha
            },
            publishUnits: [
                {
                    metadataName: 'WeatherService',
                    filePath: fixture.clsPath,
                    metaXmlPath: fixture.metaPath,
                    clsContent: composedCls,
                    clsSha256: sha256Utf8(composedCls)
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

        assert.strictEqual(result.publishState, PUBLISH_STATE.PUBLISHED);
        assert.ok(result.publishedCommitSha);

        const remoteCls = await showBlobAtRef(
            fixture.clonePath,
            'origin/source',
            fixture.clsPath
        );
        assert.strictEqual(remoteCls.content, composedCls);
    });

    await runTest('session publish records state without mutating inputMergePins', async () => {
        const root = path.join(os.tmpdir(), `apex-publish-session-${Date.now()}`);
        const fixture = await initPublishRepository(root);
        const unit = buildResolvedMethodUnit(composedCls);
        const session = buildPublishSession(unit, {
            sourceHeadSha: fixture.sourceHeadSha,
            destinationHeadSha: fixture.destinationHeadSha
        });

        const originalPins = { ...session.inputMergePins };

        const direct = await publishMethodMergeInRepo({
            repoPath: fixture.clonePath,
            sourceBranch: 'source',
            destinationBranch: 'destination',
            inputMergePins: session.inputMergePins,
            publishUnits: selectPublishUnits(session, ['WeatherService']).map(
                (entry) => entry
            )
        });

        updateSession(session.mergeSessionId, {
            publish: {
                publishState: direct.publishState,
                publishedCommitSha: direct.publishedCommitSha,
                publishedAt: direct.publishedAt,
                publishedClasses: direct.publishedClasses
            }
        });

        const stored = require('./mergeSession.store').getSession(
            session.mergeSessionId
        );

        assert.deepStrictEqual(stored.inputMergePins, originalPins);
        assert.strictEqual(
            stored.publish.publishedCommitSha,
            direct.publishedCommitSha
        );
        assert.notStrictEqual(
            stored.publish.publishedCommitSha,
            originalPins.sourceHeadSha
        );
    });

    await runTest('publishMergeSession rejects sealed sessions', async () => {
        const unit = buildResolvedMethodUnit(composedCls);
        const session = buildPublishSession(unit, {
            sourceHeadSha: 'abc',
            destinationHeadSha: 'def'
        });

        const { sealSession } = require('./mergeSession.store');
        const manifest = { mergeManifestId: 'm1', units: [] };

        updateSession(session.mergeSessionId, { status: 'RESOLVED' });
        sealSession(session.mergeSessionId, manifest);

        await assert.rejects(
            publishMergeSession(session.mergeSessionId, {
                metadataNames: ['WeatherService']
            }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.SESSION_SEALED
        );
    });

    await runTest('existing FULL merge regression tests remain green', async () => {
        const phase1 = path.join(__dirname, 'apexMerge.phase1.test.js');
        const methodSession = path.join(__dirname, 'apexMergeMethodSession.test.js');

        await execAsync(`node ${JSON.stringify(phase1)}`);
        await execAsync(`node ${JSON.stringify(methodSession)}`);
    });

    if (process.exitCode) {
        throw new Error('One or more tests failed');
    }

    console.log('All Apex merge publish tests completed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});