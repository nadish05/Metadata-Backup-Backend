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

    const METHOD_MERGE_NO_CONFLICT_SOURCE = `public with sharing class MethodMergeNoConflictDemo {

    public static String getGreeting() {
        return 'Hello from Source Org';
    }

    public static Decimal calculateDiscount(Decimal amount) {
        return amount * 0.10;
    }

    public static String getStatus() {
        return 'INITIAL';
    }

    public static String getSourceMessage() {
        return 'This method was added in Source Org';
    }
}
`;

    const METHOD_MERGE_NO_CONFLICT_DESTINATION = `public with sharing class MethodMergeNoConflictDemo {

    public static String getGreeting() {
        return 'Hello';
    }

    public static Decimal calculateDiscount(Decimal amount) {
        return amount * 0.15;
    }

    public static String getStatus() {
        return 'INITIAL';
    }

    public static String getDestinationMessage() {
        return 'This method was added in Destination Org';
    }
}
`;

    const METHOD_MERGE_CONFLICT_SOURCE = `public with sharing class MethodMergeConflictDemo {

    public static String getGreeting() {
        return 'Hello';
    }

    public static String getStatus() {
        return 'SOURCE_STATUS';
    }

    public static String getSourceOnly() {
        return 'source';
    }
}
`;

    const METHOD_MERGE_CONFLICT_DESTINATION = `public with sharing class MethodMergeConflictDemo {

    public static String getGreeting() {
        return 'Hello';
    }

    public static String getStatus() {
        return 'DESTINATION_STATUS';
    }

    public static String getDestinationOnly() {
        return 'destination';
    }
}
`;

    await runTest('absent base class: compareApexMethodMerge does not parse empty base', () => {
        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: METHOD_MERGE_NO_CONFLICT_SOURCE,
            destinationContent: METHOD_MERGE_NO_CONFLICT_DESTINATION
        });

        assert.strictEqual(result.baseClassAbsent, true);
        assert.strictEqual(result.parses.base, null);
        assert.strictEqual(result.maps.base.size, 0);
        assert.ok(result.methods.length > 0);
    });

    await runTest('absent base: branch-specific methods are AUTO_INCLUDED', () => {
        const result = compareApexMethodMerge({
            baseContent: '   ',
            sourceContent: METHOD_MERGE_NO_CONFLICT_SOURCE,
            destinationContent: METHOD_MERGE_NO_CONFLICT_DESTINATION
        });

        const sourceOnly = inventoryByKey(result, 'getSourceMessage()');
        const destOnly = inventoryByKey(result, 'getDestinationMessage()');

        assert.strictEqual(sourceOnly.status, METHOD_STATUS.AUTO_INCLUDED);
        assert.strictEqual(sourceOnly.basePresent, false);
        assert.strictEqual(destOnly.status, METHOD_STATUS.AUTO_INCLUDED);
        assert.strictEqual(destOnly.basePresent, false);
    });

    await runTest('absent base: identical method in source and destination is AUTO_INCLUDED', () => {
        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: METHOD_MERGE_NO_CONFLICT_SOURCE,
            destinationContent: METHOD_MERGE_NO_CONFLICT_DESTINATION
        });

        const statusMethod = inventoryByKey(result, 'getStatus()');
        assert.strictEqual(statusMethod.status, METHOD_STATUS.AUTO_INCLUDED);
        assert.strictEqual(statusMethod.basePresent, false);
    });

    await runTest('absent base: same method with different bodies is CONFLICT', () => {
        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: METHOD_MERGE_NO_CONFLICT_SOURCE,
            destinationContent: METHOD_MERGE_NO_CONFLICT_DESTINATION
        });

        const greeting = inventoryByKey(result, 'getGreeting()');
        const discount = inventoryByKey(result, 'calculateDiscount(Decimal)');

        assert.strictEqual(greeting.status, METHOD_STATUS.CONFLICT);
        assert.strictEqual(discount.status, METHOD_STATUS.CONFLICT);
    });

    await runTest('absent base: independently added methods with identical bodies merge cleanly', () => {
        const sharedHeader = 'public class SharedAbsentBaseDemo {\n';
        const sharedFooter = '\n}';
        const sharedMethod = `    public static String sharedOnly() {
        return 'same';
    }`;
        const source = `${sharedHeader}${sharedMethod}${sharedFooter}`;
        const destination = `${sharedHeader}${sharedMethod}${sharedFooter}`;

        const merged = executeApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(merged.conflictCount, 0);
        assert.strictEqual(merged.composeSuccess, true);
        assert.ok(merged.composedSource.includes('sharedOnly'));
    });

    await runTest('absent base conflict demo: getStatus is CONFLICT with basePresent false', () => {
        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: METHOD_MERGE_CONFLICT_SOURCE,
            destinationContent: METHOD_MERGE_CONFLICT_DESTINATION
        });

        const status = inventoryByKey(result, 'getStatus()');
        const greeting = inventoryByKey(result, 'getGreeting()');

        assert.strictEqual(status.status, METHOD_STATUS.CONFLICT);
        assert.strictEqual(status.basePresent, false);
        assert.strictEqual(greeting.status, METHOD_STATUS.AUTO_INCLUDED);
    });

    await runTest('absent base conflict resolution ACCEPT_SOURCE and ACCEPT_TARGET', () => {
        const comparison = compareApexMethodMerge({
            baseContent: '',
            sourceContent: METHOD_MERGE_CONFLICT_SOURCE,
            destinationContent: METHOD_MERGE_CONFLICT_DESTINATION
        });

        applyMethodResolutions(
            comparison.methods,
            [{ methodKey: 'getStatus()', strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE }],
            comparison.maps.source,
            comparison.maps.destination
        );

        const resolvedSource = composeApexMethodMerge(
            comparison,
            METHOD_MERGE_CONFLICT_SOURCE
        );
        assert.ok(resolvedSource.composedSource.includes('SOURCE_STATUS'));

        const comparisonTarget = compareApexMethodMerge({
            baseContent: '',
            sourceContent: METHOD_MERGE_CONFLICT_SOURCE,
            destinationContent: METHOD_MERGE_CONFLICT_DESTINATION
        });

        applyMethodResolutions(
            comparisonTarget.methods,
            [{ methodKey: 'getStatus()', strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET }],
            comparisonTarget.maps.source,
            comparisonTarget.maps.destination
        );

        const resolvedTarget = composeApexMethodMerge(
            comparisonTarget,
            METHOD_MERGE_CONFLICT_SOURCE
        );
        assert.ok(resolvedTarget.composedSource.includes('DESTINATION_STATUS'));
    });

    await runTest('absent base: structural mismatch between source and destination fails closed', () => {
        const source = `public class ShellMismatch {\n    private Integer v = 1;\n}`;
        const dest = `public class ShellMismatch {\n    private Integer v = 2;\n}`;

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: '',
                    sourceContent: source,
                    destinationContent: dest
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT
        );
    });

    await runTest('absent base: method missing from non-empty base class keeps basePresent false semantics', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([baseWeather, sharedForecast, sourceTemperature]);
        const destination = buildClass([baseWeather, sharedForecast]);

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const item = inventoryByKey(result, 'getTemperature()');
        assert.strictEqual(item.basePresent, false);
        assert.strictEqual(item.status, METHOD_STATUS.AUTO_INCLUDED);
    });

    await runTest('non-empty base METHOD merge remains unchanged', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sourceWeather, sharedForecast]);
        const destination = buildClass([destWeather, sharedForecast]);

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.baseClassAbsent, false);
        assert.ok(result.parses.base);
        assert.strictEqual(
            inventoryByKey(result, 'getWeather()').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('absent base no-conflict scenario composes valid Apex when shared methods match', () => {
        const header = 'public with sharing class MethodMergeComposeDemo {\n\n';
        const footer = '\n}';
        const shared = `    public static String getStatus() {
        return 'INITIAL';
    }`;
        const sourceOnly = `    public static String getSourceMessage() {
        return 'source';
    }`;
        const destOnly = `    public static String getDestinationMessage() {
        return 'destination';
    }`;
        const source = `${header}${shared}\n${sourceOnly}${footer}`;
        const destination = `${header}${shared}\n${destOnly}${footer}`;

        const merged = executeApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(merged.conflictCount, 0);
        assert.strictEqual(merged.composeSuccess, true);
        parseApexClassSource(merged.composedSource);
        assert.ok(merged.composedSource.includes('getSourceMessage'));
        assert.ok(merged.composedSource.includes('getDestinationMessage'));
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