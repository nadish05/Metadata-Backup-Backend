'use strict';

const assert = require('assert');
const { execSync } = require('child_process');
const path = require('path');

const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    buildMethodPreviewUnit,
    resolveMethodMergeUnit,
    validateMethodUnitForSeal,
    METHOD_RESOLUTION_STRATEGY,
    DECLARATION_RESOLUTION_SIDE
} = require('./apexMergeMethodSession.service');
const {
    METHOD_STATUS,
    DECLARATION_STATUS,
    indexRootCallableMembers,
    buildScopedMethodKey
} = require('./apexMergeMethodMerge.service');
const { parseApexClassSource, OUTER_SHARING } = require('./apexClassParser.service');
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

function inventoryByKey(
    methodMerge,
    key,
    declaringClassQualifiedName = 'WeatherService'
) {
    return methodMerge.methods.find(
        (entry) =>
            entry.methodKey === key &&
            entry.declaringClassQualifiedName === declaringClassQualifiedName
    );
}

function rootMethodSlice(classSource, methodKey) {
    const parsed = parseApexClassSource(classSource);
    const members = indexRootCallableMembers(parsed);
    const scopedMethodKey = buildScopedMethodKey(
        parsed.primaryClassName,
        methodKey
    );

    return members.get(scopedMethodKey)?.sourceText ?? null;
}

function buildSharingDeclarationConflictThreeWay() {
    const method = methodBody('getWeather()', 'same');
    const shell = `    private static Integer cacheVersion = 1;\n`;
    const base = `public with sharing class WeatherService {\n${shell}${method}\n}`;
    const source = `public without sharing class WeatherService {\n${shell}${method}\n}`;
    const destination = `public inherited sharing class WeatherService {\n${shell}${method}\n}`;

    return { base, source, destination };
}

function buildDualDeclarationConflictThreeWay() {
    const method = methodBody('getWeather()', 'same');
    const shell = `    private static Integer cacheVersion = 1;\n`;
    const base = `public with sharing class WeatherService {\n${shell}${method}\n}`;
    const source = `global without sharing class WeatherService {\n${shell}${method}\n}`;
    const destination = `inherited sharing class WeatherService {\n${shell}${method}\n}`;

    return { base, source, destination };
}

function buildNestedClassShellConflictThreeWay() {
    const method = methodBody('run()', 'run');
    const base = `public class WeatherService {\n${method}\n    private class Inner { }\n}`;
    const source = `public class WeatherService {\n${method}\n    private static class Inner { }\n}`;
    const destination = `public class WeatherService {\n${method}\n    public class Inner { }\n}`;

    return { base, source, destination };
}

function buildHeaderOnlyNestedAutoIncludedThreeWay() {
    const method = methodBody('run()', 'run');
    const base = `public class WeatherService {\n${method}\n    private class Inner { Integer x = 1; }\n}`;
    const source = base;
    const destination = `public class WeatherService {\n${method}\n    private static class Inner { Integer x = 1; }\n}`;

    return { base, source, destination };
}

function nestedClassByQName(methodMerge, qualifiedName) {
    return (methodMerge?.nestedClasses || []).find(
        (entry) => entry.qualifiedName === qualifiedName
    );
}

function createPreviewSession(clsThreeWay, metaXmlContent) {
    const preview = buildMethodPreviewUnit({
        metadataName: 'WeatherService',
        filePath: 'force-app/main/default/classes/WeatherService.cls',
        metaXmlPath:
            'force-app/main/default/classes/WeatherService.cls-meta.xml',
        mergeBaseSha: 'base-sha',
        clsThreeWay,
        metaMerge: { content: metaXmlContent, conflict: false }
    });
    preview.artifacts.metaXml = { content: metaXmlContent, conflict: false };

    const session = createMethodSessionUnit(preview);
    updateSessionForTests(session.mergeSessionId, {
        status: SESSION_STATUS.PREVIEWED,
        classes: [preview]
    });

    return { preview, session };
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

    await runTest(
        'Phase 6.0 partial resolution keeps implementation fields on remaining conflicts',
        () => {
            const base = clsWithMethods([
                methodBody('methodA()', 'base-a'),
                methodBody('methodB()', 'base-b')
            ]);
            const source = clsWithMethods([
                methodBody('methodA()', 'source-a'),
                methodBody('methodB()', 'source-b')
            ]);
            const destination = clsWithMethods([
                methodBody('methodA()', 'destination-a'),
                methodBody('methodB()', 'destination-b')
            ]);

            let unit = buildMethodPreviewUnit({
                metadataName: 'WeatherService',
                filePath: 'force-app/main/default/classes/WeatherService.cls',
                metaXmlPath:
                    'force-app/main/default/classes/WeatherService.cls-meta.xml',
                mergeBaseSha: 'base-sha',
                clsThreeWay: { base, source, destination },
                metaMerge: { content: metaXml, conflict: false }
            });
            unit.artifacts.metaXml = { content: metaXml, conflict: false };

            const methodAKey = 'methodA()';
            const methodBKey = 'methodB()';

            let methodA = inventoryByKey(unit.methodMerge, methodAKey);
            let methodB = inventoryByKey(unit.methodMerge, methodBKey);

            assert.strictEqual(methodA.status, METHOD_STATUS.CONFLICT);
            assert.strictEqual(methodB.status, METHOD_STATUS.CONFLICT);
            assert.strictEqual(
                methodA.baseImplementation,
                rootMethodSlice(base, methodAKey)
            );
            assert.strictEqual(
                methodA.sourceImplementation,
                rootMethodSlice(source, methodAKey)
            );
            assert.strictEqual(
                methodA.destinationImplementation,
                rootMethodSlice(destination, methodAKey)
            );
            assert.strictEqual(
                methodB.baseImplementation,
                rootMethodSlice(base, methodBKey)
            );
            assert.strictEqual(
                methodB.sourceImplementation,
                rootMethodSlice(source, methodBKey)
            );
            assert.strictEqual(
                methodB.destinationImplementation,
                rootMethodSlice(destination, methodBKey)
            );

            unit = resolveMethodMergeUnit(unit, {
                methodResolutions: [
                    {
                        methodKey: methodAKey,
                        strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                    }
                ]
            });

            methodA = inventoryByKey(unit.methodMerge, methodAKey);
            methodB = inventoryByKey(unit.methodMerge, methodBKey);

            assert.strictEqual(methodA.status, METHOD_STATUS.RESOLVED);
            assert.strictEqual(methodA.sourceImplementation, undefined);
            assert.strictEqual(methodA.destinationImplementation, undefined);
            assert.strictEqual(methodA.baseImplementation, undefined);

            assert.strictEqual(methodB.status, METHOD_STATUS.CONFLICT);
            assert.strictEqual(
                methodB.baseImplementation,
                rootMethodSlice(base, methodBKey)
            );
            assert.strictEqual(
                methodB.sourceImplementation,
                rootMethodSlice(source, methodBKey)
            );
            assert.strictEqual(
                methodB.destinationImplementation,
                rootMethodSlice(destination, methodBKey)
            );

            assert.strictEqual(unit.conflictState, 'UNRESOLVED');
            assert.strictEqual(unit.methodMerge.conflictCount, 1);
            assert.strictEqual(unit.methodMerge.resolved, false);
        }
    );

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

    await runTest('declaration preview auto-resolved attributes need no resolution', () => {
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

        assert.strictEqual(preview.methodMerge.declarationConflictCount, 0);
        assert.strictEqual(
            preview.methodMerge.declarations.sharing.status,
            DECLARATION_STATUS.AUTO_RESOLVED
        );
        const mapped = mapClassPreviewResponse(preview);
        assert.strictEqual(mapped.declarationConflictCount, 0);
        assert.ok(
            mapped.conflicts.every((entry) => entry.artifact === 'method')
        );
    });

    await runTest('sharing declaration conflict resolves to SOURCE', () => {
        const { base, source, destination } = buildSharingDeclarationConflictThreeWay();
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

        assert.strictEqual(preview.methodMerge.declarationConflictCount, 1);

        const resolved = resolveMethodMergeUnit(preview, {
            declarationResolutions: [
                {
                    conflictKey: 'declaration:sharing',
                    side: DECLARATION_RESOLUTION_SIDE.SOURCE
                }
            ]
        });

        assert.strictEqual(
            resolved.methodMerge.declarations.sharing.status,
            DECLARATION_STATUS.RESOLVED
        );
        assert.strictEqual(
            resolved.methodMerge.declarations.sharing.selectedValue,
            OUTER_SHARING.WITHOUT
        );
        assert.strictEqual(resolved.methodMerge.declarationConflictCount, 0);
        assert.strictEqual(resolved.conflictState, 'RESOLVED');
        assert.ok(resolved.methodMerge.composeSuccess);
        assert.ok(
            resolved.artifacts.cls.content.includes('public without sharing class WeatherService')
        );
        assert.strictEqual(
            parseApexClassSource(resolved.artifacts.cls.content).outerDeclaration.sharing,
            OUTER_SHARING.WITHOUT
        );
    });

    await runTest('sharing declaration conflict resolves to DESTINATION', () => {
        const { base, source, destination } = buildSharingDeclarationConflictThreeWay();
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
            declarationResolutions: [
                {
                    conflictKey: 'declaration:sharing',
                    side: DECLARATION_RESOLUTION_SIDE.DESTINATION
                }
            ]
        });

        assert.strictEqual(
            preview.methodMerge.declarations.sharing.selectedValue,
            OUTER_SHARING.INHERITED
        );
    });

    await runTest('access and sharing declaration conflicts resolve independently', () => {
        const { base, source, destination } = buildDualDeclarationConflictThreeWay();
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

        assert.strictEqual(preview.methodMerge.declarationConflictCount, 2);

        preview = resolveMethodMergeUnit(preview, {
            declarationResolutions: [
                {
                    conflictKey: 'declaration:access',
                    side: DECLARATION_RESOLUTION_SIDE.SOURCE
                }
            ]
        });

        assert.strictEqual(preview.methodMerge.declarationConflictCount, 1);
        assert.strictEqual(
            preview.methodMerge.declarations.access.status,
            DECLARATION_STATUS.RESOLVED
        );
        assert.strictEqual(
            preview.methodMerge.declarations.sharing.status,
            DECLARATION_STATUS.CONFLICT
        );

        preview = resolveMethodMergeUnit(preview, {
            declarationResolutions: [
                {
                    conflictKey: 'declaration:sharing',
                    side: DECLARATION_RESOLUTION_SIDE.DESTINATION
                }
            ]
        });

        assert.strictEqual(preview.methodMerge.declarationConflictCount, 0);
        assert.strictEqual(preview.conflictState, 'RESOLVED');
    });

    await runTest('invalid declaration conflict keys are rejected', () => {
        const { base, source, destination } = buildSharingDeclarationConflictThreeWay();
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
                    declarationResolutions: [
                        {
                            conflictKey: 'declaration:extends',
                            side: DECLARATION_RESOLUTION_SIDE.SOURCE
                        }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.UNKNOWN_DECLARATION_CONFLICT_KEY
        );
    });

    await runTest('invalid declaration resolution sides are rejected', () => {
        const { base, source, destination } = buildSharingDeclarationConflictThreeWay();
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
                    declarationResolutions: [
                        { conflictKey: 'declaration:sharing', side: 'ACCEPT_SOURCE' }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.INVALID_RESOLUTION_STRATEGY
        );
    });

    await runTest('resolution for auto-resolved declaration attribute is rejected', () => {
        const { base, source, destination } = buildSharingDeclarationConflictThreeWay();
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
                    declarationResolutions: [
                        {
                            conflictKey: 'declaration:access',
                            side: DECLARATION_RESOLUTION_SIDE.SOURCE
                        }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });

    await runTest('re-preview clears declaration resolutions and stale keys are rejected', () => {
        const sharingConflict = buildSharingDeclarationConflictThreeWay();
        const methodOnly = buildWeatherThreeWay();
        let unit = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: sharingConflict,
            metaMerge: { content: metaXml, conflict: false }
        });

        unit = resolveMethodMergeUnit(unit, {
            declarationResolutions: [
                {
                    conflictKey: 'declaration:sharing',
                    side: DECLARATION_RESOLUTION_SIDE.SOURCE
                }
            ]
        });

        unit = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: methodOnly,
            metaMerge: { content: metaXml, conflict: false }
        });

        assert.deepStrictEqual(unit.methodMerge.declarationResolutions, []);
        assert.strictEqual(unit.methodMerge.declarationConflictCount, 0);

        assert.throws(
            () =>
                resolveMethodMergeUnit(unit, {
                    declarationResolutions: [
                        {
                            conflictKey: 'declaration:sharing',
                            side: DECLARATION_RESOLUTION_SIDE.SOURCE
                        }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });

    await runTest('unresolved declaration conflicts block sealing', () => {
        const { base, source, destination } = buildSharingDeclarationConflictThreeWay();
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
                error.code === MERGE_ERROR.DECLARATION_UNRESOLVED_CONFLICT
        );
    });

    await runTest('unresolved declaration conflicts block composition', () => {
        const { base, source, destination } = buildSharingDeclarationConflictThreeWay();
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });

        assert.strictEqual(preview.methodMerge.conflictCount, 0);
        assert.strictEqual(preview.methodMerge.declarationConflictCount, 1);
        assert.strictEqual(preview.methodMerge.composeSuccess, false);
        assert.strictEqual(preview.artifacts.cls.content, null);
    });

    await runTest('mapClassPreviewResponse exposes declaration conflicts distinctly', () => {
        const { base, source, destination } = buildSharingDeclarationConflictThreeWay();
        const preview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: { base, source, destination },
            metaMerge: { content: metaXml, conflict: false }
        });

        const mapped = mapClassPreviewResponse(preview);
        assert.strictEqual(mapped.declarationConflictCount, 1);
        assert.strictEqual(mapped.declarations.sharing.status, DECLARATION_STATUS.CONFLICT);
        const declarationConflict = mapped.conflicts.find(
            (entry) => entry.artifact === 'declaration'
        );
        assert.ok(declarationConflict);
        assert.strictEqual(declarationConflict.conflictKey, 'declaration:sharing');
    });

    await runTest('Phase 5B.5.1 A: resolve session forwards nested ACCEPT_SOURCE', () => {
        const clsThreeWay = buildNestedClassShellConflictThreeWay();
        const { session } = createPreviewSession(clsThreeWay, metaXml);

        const response = resolveMergeSession(session.mergeSessionId, {
            metadataName: 'WeatherService',
            nestedClassResolutions: [
                {
                    qualifiedName: 'WeatherService.Inner',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        const inner = nestedClassByQName(
            { nestedClasses: response.nestedClasses },
            'WeatherService.Inner'
        );
        assert.strictEqual(inner.status, METHOD_STATUS.RESOLVED);
        assert.strictEqual(inner.resolution, METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE);
        assert.strictEqual(response.nestedClassConflictCount, 0);
        assert.strictEqual(response.compositionReady, true);
        assert.ok(response.mergedContent.includes('static class Inner'));
    });

    await runTest('Phase 5B.5.1 B: resolve session forwards nested ACCEPT_TARGET', () => {
        const clsThreeWay = buildNestedClassShellConflictThreeWay();
        const { session } = createPreviewSession(clsThreeWay, metaXml);

        const response = resolveMergeSession(session.mergeSessionId, {
            metadataName: 'WeatherService',
            nestedClassResolutions: [
                {
                    qualifiedName: 'WeatherService.Inner',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                }
            ]
        });

        const inner = nestedClassByQName(
            { nestedClasses: response.nestedClasses },
            'WeatherService.Inner'
        );
        assert.strictEqual(inner.status, METHOD_STATUS.RESOLVED);
        assert.strictEqual(inner.resolution, METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET);
        assert.ok(response.mergedContent.includes('public class Inner'));
        assert.ok(!response.mergedContent.includes('static class Inner'));
    });

    await runTest('Phase 5B.5.1 C: reject resolution for AUTO_INCLUDED nested class', () => {
        const clsThreeWay = buildHeaderOnlyNestedAutoIncludedThreeWay();
        const { session } = createPreviewSession(clsThreeWay, metaXml);
        const inner = nestedClassByQName(
            getSession(session.mergeSessionId).classes[0].methodMerge,
            'WeatherService.Inner'
        );
        assert.strictEqual(inner.status, METHOD_STATUS.AUTO_INCLUDED);

        assert.throws(
            () =>
                resolveMergeSession(session.mergeSessionId, {
                    metadataName: 'WeatherService',
                    nestedClassResolutions: [
                        {
                            qualifiedName: 'WeatherService.Inner',
                            strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                        }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });

    await runTest('Phase 5B.5.1 D: reject unknown nested qualified name via session resolve', () => {
        const clsThreeWay = buildNestedClassShellConflictThreeWay();
        const { session } = createPreviewSession(clsThreeWay, metaXml);

        assert.throws(
            () =>
                resolveMergeSession(session.mergeSessionId, {
                    metadataName: 'WeatherService',
                    nestedClassResolutions: [
                        {
                            qualifiedName: 'WeatherService.Missing',
                            strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                        }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });

    await runTest('Phase 5B.5.1 E: method, declaration, and nested resolutions coexist', () => {
        const forecast = methodBody('getForecast()', 'forecast');
        const base = `public with sharing class WeatherService {\n${methodBody('getWeather()', 'base')}\n${forecast}\n    private class Inner { }\n}`;
        const source = `public without sharing class WeatherService {\n${methodBody('getWeather()', 'source')}\n${forecast}\n    private static class Inner { }\n}`;
        const destination = `public inherited sharing class WeatherService {\n${methodBody('getWeather()', 'destination')}\n${forecast}\n    public class Inner { }\n}`;
        const { session } = createPreviewSession(
            {
                base,
                source,
                destination
            },
            metaXml
        );

        const response = resolveMergeSession(session.mergeSessionId, {
            metadataName: 'WeatherService',
            methodResolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ],
            declarationResolutions: [
                {
                    conflictKey: 'declaration:sharing',
                    side: DECLARATION_RESOLUTION_SIDE.SOURCE
                }
            ],
            nestedClassResolutions: [
                {
                    qualifiedName: 'WeatherService.Inner',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                }
            ]
        });

        assert.strictEqual(response.conflictCount, 0);
        assert.strictEqual(response.declarationConflictCount, 0);
        assert.strictEqual(response.nestedClassConflictCount, 0);
        assert.strictEqual(response.compositionReady, true);
        assert.ok(response.mergedContent.includes('public class Inner'));
    });

    await runTest('Phase 5B.5.1 F: re-preview stale nested resolution is rejected', () => {
        const nestedConflict = buildNestedClassShellConflictThreeWay();
        let { session } = createPreviewSession(nestedConflict, metaXml);

        resolveMergeSession(session.mergeSessionId, {
            metadataName: 'WeatherService',
            nestedClassResolutions: [
                {
                    qualifiedName: 'WeatherService.Inner',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        const methodOnly = buildWeatherThreeWay();
        const replPreview = buildMethodPreviewUnit({
            metadataName: 'WeatherService',
            filePath: 'force-app/main/default/classes/WeatherService.cls',
            metaXmlPath:
                'force-app/main/default/classes/WeatherService.cls-meta.xml',
            mergeBaseSha: 'base-sha',
            clsThreeWay: methodOnly,
            metaMerge: { content: metaXml, conflict: false }
        });
        replPreview.artifacts.metaXml = { content: metaXml, conflict: false };

        updateSessionForTests(session.mergeSessionId, {
            status: SESSION_STATUS.PREVIEWED,
            classes: [replPreview]
        });

        assert.deepStrictEqual(
            getSession(session.mergeSessionId).classes[0].methodMerge
                .nestedClassResolutions,
            []
        );

        assert.throws(
            () =>
                resolveMergeSession(session.mergeSessionId, {
                    metadataName: 'WeatherService',
                    nestedClassResolutions: [
                        {
                            qualifiedName: 'WeatherService.Inner',
                            strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                        }
                    ]
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });

    await runTest('Phase 5B.5.1: resolve response exposes nested readiness fields', () => {
        const clsThreeWay = buildNestedClassShellConflictThreeWay();
        const { session } = createPreviewSession(clsThreeWay, metaXml);

        const response = resolveMergeSession(session.mergeSessionId, {
            metadataName: 'WeatherService',
            nestedClassResolutions: [
                {
                    qualifiedName: 'WeatherService.Inner',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        assert.strictEqual(response.nestedClassComposeReady, true);
        assert.ok(Array.isArray(response.nestedClasses));
        assert.strictEqual(typeof response.compositionReady, 'boolean');
    });

    await runTest('Phase 5B.5.1: HTTP error mapping for declaration conflicts', () => {
        const { mapMergeError } = require('../../controllers/merge.controller');

        const declarationUnresolved = mapMergeError(
            new ApexMergeError(
                MERGE_ERROR.DECLARATION_UNRESOLVED_CONFLICT,
                'declaration unresolved'
            )
        );
        assert.strictEqual(declarationUnresolved.httpStatus, 422);

        const unknownDeclarationKey = mapMergeError(
            new ApexMergeError(
                MERGE_ERROR.UNKNOWN_DECLARATION_CONFLICT_KEY,
                'unknown declaration key'
            )
        );
        assert.strictEqual(unknownDeclarationKey.httpStatus, 400);

        const nestedConflict = mapMergeError(
            new ApexMergeError(
                MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT,
                'nested conflict'
            )
        );
        assert.strictEqual(nestedConflict.httpStatus, 422);
    });

    await runTest('Phase 5B.4.3: methodMerge exposes compositionReady distinct from resolved', () => {
        const {
            compareApexMethodMerge,
            deriveMethodMergeReadinessFields
        } = require('./apexMergeMethodMerge.service');

        const root = `    public static void run() { System.debug('run'); }`;
        const base = `public class SessReady {\n${root}\n    private class Inner { Integer x = 1; }\n}`;
        const destination = `public class SessReady {\n${root}\n    private class Inner { Integer x = 1; Integer y = 2; }\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: base,
            destinationContent: destination
        });

        const readiness = deriveMethodMergeReadinessFields({
            conflictCount: result.conflictCount,
            nestedClassConflictCount: result.nestedClassConflictCount,
            declarationConflictCount: result.declarationConflictCount,
            nestedClassComposeReady: result.nestedClassComposeReady
        });

        assert.strictEqual(result.conflictCount, 0);
        assert.strictEqual(readiness.conflictsResolved, false);
        assert.strictEqual(result.compositionReady, false);
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