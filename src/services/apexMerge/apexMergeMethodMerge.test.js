'use strict';

const assert = require('assert');
const { execSync } = require('child_process');
const path = require('path');

const { parseApexClassSource } = require('./apexClassParser.service');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    METHOD_STATUS,
    METHOD_RESOLUTION_STRATEGY,
    compareApexMethodMerge,
    executeApexMethodMerge,
    composeApexMethodMerge,
    applyMethodResolutions
} = require('./apexMergeMethodMerge.service');

const SHELL_HEADER = `/**
 * Method merge fixture shell.
 */
public class WeatherMergeLab {
    private static Integer cacheVersion = 1;
`;

const SHELL_FOOTER = `
}
`;

function buildClass(methodBlocks) {
    return `${SHELL_HEADER}${methodBlocks.map((block) => `\n${block}`).join('\n')}${SHELL_FOOTER}`;
}

function methodBlock(signature, bodyLine) {
    return `    public static void ${signature} {
        ${bodyLine}
    }`;
}

function inventoryByKey(inventory, key) {
    return inventory.methods.find((entry) => entry.methodKey === key);
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

async function main() {
    const baseWeather = methodBlock('getWeather()', "System.debug('base');");
    const sourceWeather = methodBlock('getWeather()', "System.debug('source');");
    const destWeather = methodBlock('getWeather()', "System.debug('destination');");
    const sharedForecast = methodBlock('getForecast()', "System.debug('forecast');");
    const sourceTemperature = methodBlock(
        'getTemperature()',
        "System.debug('temperature');"
    );
    const destHumidity = methodBlock('getHumidity()', "System.debug('humidity');");
    const overloadAString = `    public static String greet(String name) {
        return name;
    }`;
    const overloadADecimalSource = `    public static String greet(Decimal value) {
        return String.valueOf(value);
    }`;
    const overloadADecimalDest = `    public static String greet(Decimal value) {
        return 'dest-' + String.valueOf(value);
    }`;

    await runTest('source-only method is AUTO_INCLUDED', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sourceWeather, sharedForecast, sourceTemperature]);
        const destination = buildClass([baseWeather, sharedForecast]);

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const item = inventoryByKey(result, 'getTemperature()');
        assert.ok(item);
        assert.strictEqual(item.status, METHOD_STATUS.AUTO_INCLUDED);
        assert.strictEqual(item.sourcePresent, true);
        assert.strictEqual(item.destinationPresent, false);
    });

    await runTest('destination-only method is AUTO_INCLUDED', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sourceWeather, sharedForecast]);
        const destination = buildClass([baseWeather, sharedForecast, destHumidity]);

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const item = inventoryByKey(result, 'getHumidity()');
        assert.ok(item);
        assert.strictEqual(item.status, METHOD_STATUS.AUTO_INCLUDED);
        assert.strictEqual(item.destinationPresent, true);
        assert.strictEqual(item.sourcePresent, false);
    });

    await runTest('identical implementations remain AUTO_INCLUDED', () => {
        const body = buildClass([sharedForecast]);

        const result = compareApexMethodMerge({
            baseContent: body,
            sourceContent: body,
            destinationContent: body
        });

        const item = inventoryByKey(result, 'getForecast()');
        assert.strictEqual(item.status, METHOD_STATUS.AUTO_INCLUDED);
    });

    await runTest('source-only modification is AUTO_INCLUDED from Source', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sourceWeather, sharedForecast]);
        const destination = buildClass([baseWeather, sharedForecast]);

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.ok(merged.composedSource.includes("System.debug('source');"));
    });

    await runTest('destination-only modification is AUTO_INCLUDED from Destination', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([baseWeather, sharedForecast]);
        const destination = buildClass([destWeather, sharedForecast]);

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.ok(
            merged.composedSource.includes("System.debug('destination');")
        );
    });

    await runTest('conflicting implementations are reported as CONFLICT', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sourceWeather, sharedForecast]);
        const destination = buildClass([destWeather, sharedForecast]);

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.conflictCount, 1);
        assert.strictEqual(result.resolved, false);
        assert.strictEqual(
            inventoryByKey(result, 'getWeather()').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('ACCEPT_SOURCE resolution selects Source implementation', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sourceWeather, sharedForecast]);
        const destination = buildClass([destWeather, sharedForecast]);

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination,
            resolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        assert.strictEqual(merged.composeSuccess, true);
        assert.ok(merged.composedSource.includes("System.debug('source');"));
        assert.ok(
            !merged.composedSource.includes("System.debug('destination');")
        );
    });

    await runTest('ACCEPT_TARGET resolution selects Destination implementation', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sourceWeather, sharedForecast]);
        const destination = buildClass([destWeather, sharedForecast]);

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination,
            resolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                }
            ]
        });

        assert.ok(
            merged.composedSource.includes("System.debug('destination');")
        );
    });

    await runTest('multiple independent conflicts require multiple resolutions', () => {
        const sourceForecast = methodBlock(
            'getForecast()',
            "System.debug('source-forecast');"
        );
        const destForecast = methodBlock(
            'getForecast()',
            "System.debug('dest-forecast');"
        );
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sourceWeather, sourceForecast]);
        const destination = buildClass([destWeather, destForecast]);

        const partial = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination,
            resolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ]
        });

        assert.strictEqual(partial.composeSuccess, false);
        assert.strictEqual(partial.conflictCount, 1);

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination,
            resolutions: [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                },
                {
                    methodKey: 'getForecast()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                }
            ]
        });

        assert.strictEqual(merged.composeSuccess, true);
        assert.ok(merged.composedSource.includes("System.debug('source');"));
        assert.ok(
            merged.composedSource.includes("System.debug('dest-forecast');")
        );
    });

    await runTest('overloaded methods are compared independently by identity key', () => {
        const base = buildClass([overloadAString]);
        const source = buildClass([overloadAString, overloadADecimalSource]);
        const destination = buildClass([overloadAString, overloadADecimalDest]);

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            inventoryByKey(result, 'greet(String)').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            inventoryByKey(result, 'greet(Decimal)').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('deletion versus modification is reported as CONFLICT', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sharedForecast]);
        const destination = buildClass([destWeather, sharedForecast]);

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            inventoryByKey(result, 'getWeather()').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('duplicate method identities are prevented in composed output', () => {
        const base = buildClass([baseWeather]);
        const source = buildClass([sourceWeather]);
        const destination = buildClass([
            sourceWeather,
            methodBlock('getHumidity()', "System.debug('humidity');")
        ]);

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const parsed = parseApexClassSource(merged.composedSource);
        const keys = parsed.methods
            .filter((m) => m.declaringClassQualifiedName === parsed.primaryClassName)
            .map((m) => m.identityKey);

        assert.strictEqual(new Set(keys).size, keys.length);
    });

    await runTest('comments and annotations on Source methods are preserved', () => {
        const annotatedSource = `${SHELL_HEADER}
    // line comment
    @SuppressWarnings('PMD')
    public static void getWeather() {
        /* inside */
        System.debug('source');
    }
${SHELL_FOOTER}`;
        const base = buildClass([baseWeather]);
        const destination = buildClass([baseWeather]);

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: annotatedSource,
            destinationContent: destination
        });

        assert.ok(merged.composedSource.includes('@SuppressWarnings'));
        assert.ok(merged.composedSource.includes('// line comment'));
        assert.ok(merged.composedSource.includes('/* inside */'));
    });

    await runTest('Source class declaration and fields are preserved in composed class', () => {
        const base = buildClass([baseWeather]);
        const source = buildClass([sourceWeather]);
        const destination = buildClass([baseWeather, destHumidity]);

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.ok(merged.composedSource.includes('private static Integer cacheVersion = 1'));
        assert.ok(merged.composedSource.includes('public class WeatherMergeLab'));
    });

    await runTest('unsupported class-level structural conflict fails closed', () => {
        const base = buildClass([baseWeather]);
        const source = buildClass([sourceWeather]);
        const destinationShell = SHELL_HEADER.replace(
            'cacheVersion = 1',
            'cacheVersion = 2'
        ) + sourceWeather + SHELL_FOOTER;

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: base,
                    sourceContent: source,
                    destinationContent: destinationShell
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT
        );
    });

    await runTest('invalid composed Apex fails METHOD_COMPOSE_FAILED validation', () => {
        const base = buildClass([baseWeather]);
        const source = buildClass([sourceWeather]);
        const destination = buildClass([sourceWeather]);

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        comparison.methods.push({
            methodKey: 'notReal()',
            status: METHOD_STATUS.AUTO_INCLUDED,
            included: true,
            chosenImplementation: 'public static void notReal() { broken',
            sourcePresent: false,
            destinationPresent: true,
            basePresent: false
        });

        assert.throws(
            () => composeApexMethodMerge(comparison, source),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_COMPOSE_FAILED
        );
    });

    await runTest('unresolved conflicts prevent successful composition', () => {
        const base = buildClass([baseWeather]);
        const source = buildClass([sourceWeather]);
        const destination = buildClass([destWeather]);

        const result = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.composeSuccess, false);
        assert.strictEqual(result.composedSource, null);

        assert.throws(
            () => composeApexMethodMerge(result, source),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT
        );
    });

    await runTest('composed class includes destination-only method after merge', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sourceWeather, sharedForecast]);
        const destination = buildClass([
            baseWeather,
            sharedForecast,
            destHumidity
        ]);

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const parsed = parseApexClassSource(merged.composedSource);
        assert.ok(
            parsed.methods.some((method) => method.identityKey === 'getHumidity()')
        );
    });

    await runTest('method deleted in both branches is AUTO_EXCLUDED', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sharedForecast]);
        const destination = buildClass([sharedForecast]);

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const item = inventoryByKey(result, 'getWeather()');
        assert.strictEqual(item.status, METHOD_STATUS.AUTO_EXCLUDED);
        assert.strictEqual(item.included, false);
    });

    await runTest('deletion conflict resolves with ACCEPT_TARGET to keep Destination', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sharedForecast]);
        const destination = buildClass([destWeather, sharedForecast]);

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        applyMethodResolutions(
            comparison.methods,
            [
                {
                    methodKey: 'getWeather()',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                }
            ],
            comparison.maps.source,
            comparison.maps.destination
        );

        composeApexMethodMerge(comparison, source);
        assert.ok(
            comparison.composedSource.includes("System.debug('destination');")
        );
    });

    await runTest('existing FULL merge regression tests continue passing', () => {
        const phase1TestPath = path.join(__dirname, 'apexMerge.phase1.test.js');
        execSync(`node ${JSON.stringify(phase1TestPath)}`, {
            stdio: 'inherit',
            env: process.env
        });
    });

    if (process.exitCode) {
        throw new Error('One or more tests failed');
    }

    console.log('All METHOD merge tests completed.');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});