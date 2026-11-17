'use strict';

const assert = require('assert');
const { execSync } = require('child_process');
const path = require('path');

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    buildMethodPreviewUnit,
    resolveMethodMergeUnit,
    validateMethodUnitForSeal,
    METHOD_RESOLUTION_STRATEGY
} = require('./apexMergeMethodSession.service');
const {
    METHOD_STATUS,
    indexRootCallableMembers
} = require('./apexMergeMethodMerge.service');
const { parseApexClassSource } = require('./apexClassParser.service');
const {
    resolveUnitArtifacts,
    RESOLUTION_STRATEGIES
} = require('./apexMergeFullClass.service');
const {
    createSessionRecord,
    clearAllSessions,
    getSession,
    SESSION_STATUS
} = require('./mergeSession.store');
const {
    resolveMergeSession,
    sealMergeSession,
    mapClassPreviewResponse
} = require('./mergeSession.service');
const { buildApexMergeManifest } = require('./apexMergeManifest.service');

const SHELL = `public class WeatherService {
    private static Integer cacheVersion = 1;
`;

const SHELL_END = `}
`;

function clsWithMethods(methods) {
    return `${SHELL}${methods.map((m) => `\n${m}`).join('\n')}\n${SHELL_END}`;
}

function methodBody(name, debugValue) {
    return `    public static void ${name} {
        System.debug('${debugValue}');
    }`;
}

function inventoryByKey(methodMerge, key) {
    return methodMerge.methods.find((entry) => entry.methodKey === key);
}

function rootMethodSlice(classSource, methodKey) {
    const parsed = parseApexClassSource(classSource);
    const members = indexRootCallableMembers(parsed);
    return members.get(methodKey)?.sourceText ?? null;
}

function buildWeatherThreeWay() {
    const base = clsWithMethods([
        methodBody('getWeather()', 'base'),
        methodBody('getForecast()', 'base-forecast')
    ]);
    const source = clsWithMethods([
        methodBody('getWeather()', 'source'),
        methodBody('getForecast()', 'base-forecast'),
        methodBody('getTemperature()', 'source-temp')
    ]);
    const destination = clsWithMethods([
        methodBody('getWeather()', 'destination'),
        methodBody('getForecast()', 'base-forecast'),
        methodBody('getHumidity()', 'dest-humidity')
    ]);

    return { base, source, destination };
}

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

function createMethodSessionUnit(previewUnit) {
    clearAllSessions();

    const session = createSessionRecord({
        comparisonId: 'cmp-method',
        deploymentPlanId: 'plan-method',
        repoUrl: 'https://github.com/example/repo.git',
        sourceBranch: 'source',
        destinationBranch: 'destination',
        gitPins: { sourceHeadSha: 'abc', destinationHeadSha: 'def' },
        classes: [
            {
                ...previewUnit,
                drift: { status: 'MATCH' },
                metaXmlPath:
                    previewUnit.metaXmlPath ||
                    'force-app/main/default/classes/WeatherService.cls-meta.xml',
                filePath:
                    previewUnit.filePath ||
                    'force-app/main/default/classes/WeatherService.cls'
            }
        ]
    });

    return session;
}

async function main() {
    const { base, source, destination } = buildWeatherThreeWay();
    const metaXml =
        '<?xml version="1.0"?><ApexClass><apiVersion>59.0</apiVersion></ApexClass>';

    await runTest('FULL ACCEPT_SOURCE resolution remains unchanged', () => {
        const unit = {
            metadataName: 'Demo',
            mergeMode: 'FULL',
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

        const resolved = resolveUnitArtifacts(unit, {
            resolutionStrategy: RESOLUTION_STRATEGIES.ACCEPT_SOURCE
        });
        assert.strictEqual(resolved.artifacts.cls.content, 'source-cls');
        assert.strictEqual(resolved.conflictState, 'RESOLVED');
    });

    await runTest('FULL mapClassPreviewResponse remains unchanged for FULL units', () => {
        const mapped = mapClassPreviewResponse({
            metadataName: 'X',
            mergeMode: 'FULL',
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

        assert.strictEqual(mapped.mergeMode, 'FULL');
        assert.strictEqual(mapped.mergedContent, '<<<<<<<\n');
        assert.strictEqual(mapped.hasConflicts, true);
        assert.strictEqual(mapped.methods, undefined);
    });

    await runTest('METHOD preview returns inventory and conflict count', () => {
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false, threeWay: {} }
        });

        assert.strictEqual(preview.mergeMode, 'METHOD');
        assert.strictEqual(preview.conflictState, 'UNRESOLVED');
        assert.ok(preview.methodMerge.methods.length >= 3);
        assert.strictEqual(preview.methodMerge.conflictCount, 1);
        assert.strictEqual(preview.artifacts.cls.content, null);

        const mapped = mapClassPreviewResponse({ ...preview, drift: { status: 'MATCH' } });
        assert.strictEqual(mapped.mergeMode, 'METHOD');
        assert.strictEqual(mapped.conflictCount, 1);
        assert.strictEqual(mapped.resolved, false);
        assert.strictEqual(mapped.mergedContent, null);
    });

    await runTest('METHOD preview auto-includes non-conflicting methods when fully resolved', () => {
        const alignedSource = clsWithMethods([
            methodBody('getWeather()', 'source'),
            methodBody('getForecast()', 'source-forecast')
        ]);
        const alignedDestination = clsWithMethods([
            methodBody('getWeather()', 'source'),
            methodBody('getForecast()', 'dest-forecast')
        ]);

        const preview = buildMethodPreviewUnit({
            metadataName: 'Aligned',
            filePath: 'force-app/main/default/classes/Aligned.cls',
            metaXmlPath: 'force-app/main/default/classes/Aligned.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: {
                base: alignedSource,
                source: alignedSource,
                destination: alignedDestination
            },
            metaMerge: { content: metaXml, conflict: false }
        });

        assert.strictEqual(preview.conflictState, 'NONE');
        assert.strictEqual(preview.methodMerge.conflictCount, 0);
        assert.ok(preview.artifacts.cls.content.includes('dest-forecast'));
        assert.ok(preview.artifacts.cls.content.includes("System.debug('source');"));
    });

    await runTest('ACCEPT_SOURCE resolves only specified method', () => {
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: {
                content: metaXml,
                conflict: false,
                threeWay: { source: metaXml }
            }
        });
        preview.artifacts.metaXml = { content: metaXml, conflict: false };

        const resolved = resolveMethodMergeUnit(preview, {
            methodResolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        assert.strictEqual(resolved.conflictState, 'RESOLVED');
        assert.ok(resolved.artifacts.cls.content.includes("System.debug('source');"));
        assert.ok(
            resolved.artifacts.cls.content.includes("System.debug('dest-humidity');")
        );
        assert.ok(
            !resolved.artifacts.cls.content.includes("System.debug('destination');")
        );
    });

    await runTest('ACCEPT_TARGET resolves only specified method', () => {
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });
        preview.artifacts.metaXml = { content: metaXml, conflict: false };

        const resolved = resolveMethodMergeUnit(preview, {
            methodResolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                }
            ]
        });

        assert.ok(
            resolved.artifacts.cls.content.includes("System.debug('destination');")
        );
    });

    await runTest('multiple method conflicts resolve independently', () => {
        const sourceForecast = methodBody('getForecast()', 'source-forecast');
        const destForecast = methodBody('getForecast()', 'dest-forecast');
        const conflictSource = clsWithMethods([
            methodBody('getWeather()', 'source'),
            sourceForecast,
            methodBody('getTemperature()', 'source-temp')
        ]);
        const conflictDestination = clsWithMethods([
            methodBody('getWeather()', 'destination'),
            destForecast,
            methodBody('getHumidity()', 'dest-humidity')
        ]);

        let unit = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: {
                base,
                source: conflictSource,
                destination: conflictDestination
            },
            metaMerge: { content: metaXml, conflict: false }
        });
        unit.artifacts.metaXml = { content: metaXml, conflict: false };

        assert.strictEqual(unit.methodMerge.conflictCount, 2);

        unit = resolveMethodMergeUnit(unit, {
            methodResolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });
        assert.strictEqual(unit.conflictState, 'UNRESOLVED');
        assert.strictEqual(unit.methodMerge.conflictCount, 1);
        assert.strictEqual(unit.artifacts.cls.content, null);

        unit = resolveMethodMergeUnit(unit, {
            methodResolutions: [
                {
                    methodKey: 'getForecast()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                }
            ]
        });
        assert.strictEqual(unit.conflictState, 'RESOLVED');
        assert.ok(unit.artifacts.cls.content.includes('source-forecast') === false);
        assert.ok(unit.artifacts.cls.content.includes('dest-forecast'));
    });

    await runTest('unknown method key is rejected', () => {
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });

        assert.throws(
            () =>
                resolveMethodMergeUnit(preview, {
                    methodResolutions: [
                        {
                            methodKey: 'missingMethod()',
                            strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                        }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.UNKNOWN_METHOD_KEY
        );
    });

    await runTest('invalid resolution strategy is rejected', () => {
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });

        assert.throws(
            () =>
                resolveMethodMergeUnit(preview, {
                    methodResolutions: [
                        {
                            methodKey: 'getWeather()',
                            strategy: 'KEEP_BOTH'
                        }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.INVALID_RESOLUTION_STRATEGY
        );
    });

    await runTest('unresolved METHOD conflicts prevent sealing', () => {
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });
        preview.artifacts.metaXml = { content: metaXml, conflict: false };

        const session = createMethodSessionUnit(preview);

        assert.throws(
            () => sealMergeSession(session.mergeSessionId),
            (error) =>
                error instanceof ApexMergeError &&
                (error.code === MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT ||
                    error.code === MERGE_ERROR.UNRESOLVED_CONFLICT)
        );
    });

    await runTest('fully resolved METHOD merge can be sealed with METHOD mode in manifest', () => {
        let preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });
        preview.artifacts.metaXml = { content: metaXml, conflict: false };
        preview = resolveMethodMergeUnit(preview, {
            methodResolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        const session = createMethodSessionUnit(preview);
        updateSessionForTests(session.mergeSessionId, {
            status: SESSION_STATUS.RESOLVED,
            classes: [preview]
        });

        const sealed = sealMergeSession(session.mergeSessionId);
        assert.strictEqual(sealed.status, SESSION_STATUS.SEALED);
        assert.strictEqual(sealed.apexMergeManifest.units[0].mergeMode, 'METHOD');

        const stored = getSession(session.mergeSessionId);
        assert.ok(stored.manifest);
        assert.strictEqual(
            stored.classes[0].artifacts.cls.content,
            preview.artifacts.cls.content
        );
    });

    await runTest('session resolve endpoint updates METHOD inventory and mergedContent', () => {
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });
        preview.artifacts.metaXml = { content: metaXml, conflict: false };

        const session = createMethodSessionUnit(preview);
        updateSessionForTests(session.mergeSessionId, {
            status: SESSION_STATUS.PREVIEWED,
            classes: [preview]
        });

        const response = resolveMergeSession(session.mergeSessionId, {
            metadataName: 'WeatherService',
            methodResolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                }
            ]
        });

        assert.strictEqual(response.mergeMode, 'METHOD');
        assert.strictEqual(response.resolved, true);
        assert.ok(response.mergedContent.includes("System.debug('destination');"));
    });

    await runTest('Phase 6.0 conflicting method exposes branch implementations', () => {
        const { base, source, destination } = buildWeatherThreeWay();
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });

        const conflict = inventoryByKey(preview.methodMerge, 'getWeather()');
        assert.strictEqual(conflict.status, METHOD_STATUS.CONFLICT);
        assert.strictEqual(
            conflict.baseImplementation,
            rootMethodSlice(base, 'getWeather()')
        );
        assert.strictEqual(
            conflict.sourceImplementation,
            rootMethodSlice(source, 'getWeather()')
        );
        assert.strictEqual(
            conflict.destinationImplementation,
            rootMethodSlice(destination, 'getWeather()')
        );
        assert.ok(conflict.sourceImplementation.includes("System.debug('source');"));
    });

    await runTest('Phase 6.0 non-conflicting methods omit implementation fields', () => {
        const { base, source, destination } = buildWeatherThreeWay();
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });

        const forecast = inventoryByKey(preview.methodMerge, 'getForecast()');
        assert.strictEqual(forecast.status, METHOD_STATUS.AUTO_INCLUDED);
        assert.strictEqual(forecast.sourceImplementation, undefined);
        assert.strictEqual(forecast.destinationImplementation, undefined);
        assert.strictEqual(forecast.baseImplementation, undefined);
    });

    await runTest('Phase 6.0 baseImplementation is null when method absent from Base', () => {
        const base = clsWithMethods([]);
        const source = clsWithMethods([methodBody('getWeather()', 'source-new')]);
        const destination = clsWithMethods([
            methodBody('getWeather()', 'destination-new')
        ]);

        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });

        const conflict = inventoryByKey(preview.methodMerge, 'getWeather()');
        assert.strictEqual(conflict.status, METHOD_STATUS.CONFLICT);
        assert.strictEqual(conflict.basePresent, false);
        assert.strictEqual(conflict.baseImplementation, null);
        assert.ok(conflict.sourceImplementation.includes('source-new'));
        assert.ok(conflict.destinationImplementation.includes('destination-new'));
    });

    await runTest('Phase 6.0 missing branch implementation is null on deletion conflict', () => {
        const { base, source, destination } = buildWeatherThreeWay();
        const sourceDeleted = clsWithMethods([
            methodBody('getForecast()', 'base-forecast'),
            methodBody('getTemperature()', 'source-temp')
        ]);
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source: sourceDeleted, destination },
            metaMerge: { content: metaXml, conflict: false }
        });

        const conflict = inventoryByKey(preview.methodMerge, 'getWeather()');
        assert.strictEqual(conflict.status, METHOD_STATUS.CONFLICT);
        assert.strictEqual(conflict.sourcePresent, false);
        assert.strictEqual(conflict.sourceImplementation, null);
        assert.ok(
            conflict.destinationImplementation.includes("System.debug('destination');")
        );
    });

    await runTest('Phase 6.0 multiple conflicts each expose correct implementations', () => {
        const sourceForecast = methodBody('getForecast()', 'source-forecast');
        const destForecast = methodBody('getForecast()', 'dest-forecast');
        const { base, source, destination } = buildWeatherThreeWay();
        const conflictSource = clsWithMethods([
            methodBody('getWeather()', 'source'),
            sourceForecast,
            methodBody('getTemperature()', 'source-temp')
        ]);
        const conflictDestination = clsWithMethods([
            methodBody('getWeather()', 'destination'),
            destForecast,
            methodBody('getHumidity()', 'dest-humidity')
        ]);

        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: {
                base,
                source: conflictSource,
                destination: conflictDestination
            },
            metaMerge: { content: metaXml, conflict: false }
        });

        const weather = inventoryByKey(preview.methodMerge, 'getWeather()');
        const forecast = inventoryByKey(preview.methodMerge, 'getForecast()');
        assert.strictEqual(weather.status, METHOD_STATUS.CONFLICT);
        assert.strictEqual(forecast.status, METHOD_STATUS.CONFLICT);
        assert.ok(weather.sourceImplementation.includes("System.debug('source');"));
        assert.ok(
            forecast.destinationImplementation.includes('dest-forecast')
        );
    });

    await runTest('Phase 6.0 resolved methods drop implementation exposure fields', () => {
        const { base, source, destination } = buildWeatherThreeWay();
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });
        preview.artifacts.metaXml = { content: metaXml, conflict: false };

        const resolved = resolveMethodMergeUnit(preview, {
            methodResolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        const weather = inventoryByKey(resolved.methodMerge, 'getWeather()');
        assert.strictEqual(weather.status, METHOD_STATUS.RESOLVED);
        assert.strictEqual(weather.sourceImplementation, undefined);
        assert.strictEqual(resolved.conflictState, 'RESOLVED');
    });

    await runTest('existing FULL and METHOD regression tests pass', () => {
        execSync(`node ${JSON.stringify(path.join(__dirname, 'apexMerge.phase1.test.js'))}`, {
            stdio: 'inherit'
        });
        execSync(
            `node ${JSON.stringify(path.join(__dirname, 'apexMergeMethodMerge.test.js'))}`,
            { stdio: 'inherit' }
        );
    });

    if (process.exitCode) {
        throw new Error('One or more tests failed');
    }

    console.log('All METHOD session integration tests completed.');
}

function updateSessionForTests(mergeSessionId, patch) {
    const { updateSession } = require('./mergeSession.store');
    return updateSession(mergeSessionId, patch);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});