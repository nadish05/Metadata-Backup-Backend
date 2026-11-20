'use strict';

const assert = require('assert');
const { execSync } = require('child_process');
const path = require('path');

const {
    parseApexClassSource,
    reconstructOuterClassDeclaration,
    OUTER_ACCESS,
    OUTER_SHARING
} = require('./apexClassParser.service');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');
const {
    METHOD_STATUS,
    METHOD_RESOLUTION_STRATEGY,
    DECLARATION_STATUS,
    DECLARATION_RESOLUTION_SIDE,
    compareApexMethodMerge,
    executeApexMethodMerge,
    composeApexMethodMerge,
    applyMethodResolutions,
    applyDeclarationResolutions
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

function sharingPhrase(sharing) {
    if (sharing === OUTER_SHARING.WITH) {
        return 'with sharing ';
    }

    if (sharing === OUTER_SHARING.WITHOUT) {
        return 'without sharing ';
    }

    if (sharing === OUTER_SHARING.INHERITED) {
        return 'inherited sharing ';
    }

    return '';
}

function buildClassWithOuterDeclaration(access, sharing, methodBlocks) {
    const header = `/**
 * Method merge fixture shell.
 */
${access} ${sharingPhrase(sharing)}class WeatherMergeLab {
    private static Integer cacheVersion = 1;
`;

    return `${header}${methodBlocks.map((block) => `\n${block}`).join('\n')}${SHELL_FOOTER}`;
}

function buildMinimalClass(access, sharing, bodyLines = []) {
    const header = `${access} ${sharingPhrase(sharing)}class ShellMismatch {\n`;
    const body = bodyLines.map((line) => `    ${line}\n`).join('');
    return `${header}${body}}`;
}

function methodBlock(signature, bodyLine) {
    return `    public static void ${signature} {
        ${bodyLine}
    }`;
}

function inventoryByKey(inventory, key) {
    return inventory.methods.find((entry) => entry.methodKey === key);
}

function assertOuterDeclaration(classSource, access, sharing) {
    const parsed = parseApexClassSource(classSource);

    assert.strictEqual(parsed.outerDeclaration.access, access);
    assert.strictEqual(parsed.outerDeclaration.sharing, sharing);
}

function composeWithDeclarationResolutions(comparison, sourceContent, declarationResolutions) {
    if (declarationResolutions?.length) {
        applyDeclarationResolutions(
            comparison.declarations,
            declarationResolutions,
            comparison.declarationInventories
        );
    }

    return composeApexMethodMerge(comparison, sourceContent);
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

    await runTest('declaration three-way: divergent sharing conflicts while access auto-resolves', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.INHERITED,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.declarationConflictCount, 1);
        assert.strictEqual(
            result.declarations.access.status,
            DECLARATION_STATUS.AUTO_RESOLVED
        );
        assert.strictEqual(result.declarations.access.selectedValue, OUTER_ACCESS.PUBLIC);
        assert.strictEqual(
            result.declarations.sharing.status,
            DECLARATION_STATUS.CONFLICT
        );
        assert.strictEqual(result.declarations.sharing.selectedValue, null);
        assert.strictEqual(
            inventoryByKey(result, 'getWeather()').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
    });

    await runTest('declaration three-way access: source-only change auto-selects source', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.WITH,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            result.declarations.access.status,
            DECLARATION_STATUS.AUTO_RESOLVED
        );
        assert.strictEqual(result.declarations.access.selectedValue, OUTER_ACCESS.GLOBAL);
        assert.strictEqual(result.declarationConflictCount, 0);
    });

    await runTest('declaration three-way access: destination-only change auto-selects destination', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.WITH,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.declarations.access.selectedValue, OUTER_ACCESS.GLOBAL);
        assert.strictEqual(result.declarationConflictCount, 0);
    });

    await runTest('declaration three-way access: identical side changes auto-resolve', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const side = buildClassWithOuterDeclaration(
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.WITH,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: side,
            destinationContent: side
        });

        assert.strictEqual(result.declarations.access.selectedValue, OUTER_ACCESS.GLOBAL);
        assert.strictEqual(result.declarationConflictCount, 0);
    });

    await runTest('declaration three-way access: divergent changes conflict', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.WITH,
            [method]
        );
        const destination = `/**
 * Method merge fixture shell.
 */
class WeatherMergeLab {
    private static Integer cacheVersion = 1;
${method}
}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            result.declarations.access.status,
            DECLARATION_STATUS.CONFLICT
        );
        assert.strictEqual(result.declarationConflictCount, 1);
    });

    await runTest('declaration three-way sharing: source-only change auto-selects source', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            result.declarations.sharing.selectedValue,
            OUTER_SHARING.WITHOUT
        );
        assert.strictEqual(result.declarationConflictCount, 0);
    });

    await runTest('declaration three-way sharing: destination-only change auto-selects destination', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.INHERITED,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            result.declarations.sharing.selectedValue,
            OUTER_SHARING.INHERITED
        );
        assert.strictEqual(result.declarationConflictCount, 0);
    });

    await runTest('declaration three-way sharing: identical side changes auto-resolve', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const side = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: side,
            destinationContent: side
        });

        assert.strictEqual(
            result.declarations.sharing.selectedValue,
            OUTER_SHARING.WITHOUT
        );
        assert.strictEqual(result.declarationConflictCount, 0);
    });

    await runTest('declaration three-way sharing: omitted to with transition on one side', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const omittedHeader = `/**
 * Method merge fixture shell.
 */
public class WeatherMergeLab {
    private static Integer cacheVersion = 1;
`;
        const base = `${omittedHeader}${method}${SHELL_FOOTER}`;
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const destination = `${omittedHeader}${method}${SHELL_FOOTER}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            result.declarations.sharing.selectedValue,
            OUTER_SHARING.WITH
        );
        assert.strictEqual(result.declarationConflictCount, 0);
    });

    await runTest('declaration: access conflicts while sharing auto-resolves', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.WITH,
            [method]
        );
        const destination = `/**
 * Method merge fixture shell.
 */
class WeatherMergeLab {
    private static Integer cacheVersion = 1;
${method}
}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.declarationConflictCount, 1);
        assert.strictEqual(
            result.declarations.access.status,
            DECLARATION_STATUS.CONFLICT
        );
        assert.strictEqual(
            result.declarations.sharing.status,
            DECLARATION_STATUS.AUTO_RESOLVED
        );
    });

    await runTest('absent base declaration: identical access and sharing auto-resolve', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.baseClassAbsent, true);
        assert.strictEqual(result.declarationConflictCount, 0);
        assert.strictEqual(
            result.declarations.access.selectedValue,
            OUTER_ACCESS.PUBLIC
        );
        assert.strictEqual(
            result.declarations.sharing.selectedValue,
            OUTER_SHARING.WITHOUT
        );
    });

    await runTest('absent base declaration: different access only conflicts', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.WITH,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.declarationConflictCount, 1);
        assert.strictEqual(
            result.declarations.access.status,
            DECLARATION_STATUS.CONFLICT
        );
        assert.strictEqual(
            result.declarations.sharing.status,
            DECLARATION_STATUS.AUTO_RESOLVED
        );
    });

    await runTest('absent base declaration: different sharing only conflicts', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.INHERITED,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.declarationConflictCount, 1);
        assert.strictEqual(
            result.declarations.sharing.status,
            DECLARATION_STATUS.CONFLICT
        );
    });

    await runTest('absent base declaration: both access and sharing conflict', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.WITHOUT,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.INHERITED,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.declarationConflictCount, 2);
    });

    await runTest('structural guard: different root fields still fail closed', () => {
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

    await runTest('structural guard: different extends clause fails closed', () => {
        const method = methodBlock('getWeather()', "System.debug('x');");
        const make = (extendsClause) =>
            `public class ExtendsLab ${extendsClause} {\n${method}\n}`;
        const base = make('extends BaseOne');
        const source = make('extends BaseOne');
        const destination = make('extends BaseTwo');

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: base,
                    sourceContent: source,
                    destinationContent: destination
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT
        );
    });

    await runTest('structural guard: different implements clause fails closed', () => {
        const method = methodBlock('getWeather()', "System.debug('x');");
        const make = (implementsClause) =>
            `public class ImplementsLab ${implementsClause} {\n${method}\n}`;
        const base = make('implements IOne');
        const source = make('implements IOne');
        const destination = make('implements IOne, ITwo');

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: base,
                    sourceContent: source,
                    destinationContent: destination
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT
        );
    });

    await runTest('structural guard: class annotation difference fails closed', () => {
        const method = methodBlock('getWeather()', "System.debug('x');");
        const base = `@IsTest\npublic class AnnotatedLab {\n${method}\n}`;
        const source = `@IsTest\npublic class AnnotatedLab {\n${method}\n}`;
        const destination = `@SuppressWarnings('PMD')\npublic class AnnotatedLab {\n${method}\n}`;

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: base,
                    sourceContent: source,
                    destinationContent: destination
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT
        );
    });

    await runTest('structural guard: nested class body difference fails closed', () => {
        const method = methodBlock('getWeather()', "System.debug('x');");
        const nestedA = '    private class Inner { Integer a = 1; }\n';
        const nestedB = '    private class Inner { Integer a = 2; }\n';
        const header = 'public with sharing class NestedLab {\n';
        const base = `${header}${nestedA}${method}\n}`;
        const source = `${header}${nestedA}${method}\n}`;
        const destination = `${header}${nestedB}${method}\n}`;

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: base,
                    sourceContent: source,
                    destinationContent: destination
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT
        );
    });

    await runTest('Phase 5A.2: nested class visibility-only difference fails structural guard', () => {
        const mk = (visibility) => `public class ExampleService {
    ${visibility} class Helper {
        public String getValue() {
            return 'Example';
        }
    }
    public static void run() {}
}`;

        const assertInnerClassConflict = (base, source, destination) => {
            assert.throws(
                () =>
                    compareApexMethodMerge({
                        baseContent: base,
                        sourceContent: source,
                        destinationContent: destination
                    }),
                (error) =>
                    error instanceof ApexMergeError &&
                    error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT &&
                    error.details.mismatches.includes('innerClasses')
            );
        };

        assertInnerClassConflict(mk('private'), mk('public'), mk('private'));
        assertInnerClassConflict(mk('public'), mk('private'), mk('public'));
        assertInnerClassConflict(mk('protected'), mk('public'), mk('protected'));
        assertInnerClassConflict(mk('public'), mk('protected'), mk('public'));
    });

    await runTest('Phase 5A.2: nested class static and abstract modifier drift fails', () => {
        const method = methodBlock('run()', "System.debug('x');");
        const header = 'public class ModifierLab {\n';
        const footer = `\n${method}\n}`;
        const base = `${header}    private static class Inner { }\n${footer}`;
        const source = `${header}    private class Inner { }\n${footer}`;
        const destination = `${header}    private static class Inner { }\n${footer}`;

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: base,
                    sourceContent: source,
                    destinationContent: destination
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT &&
                error.details.mismatches.includes('innerClasses')
        );

        const abstractBase = `${header}    private abstract class Inner { }\n${footer}`;
        const abstractSource = `${header}    private abstract class Inner { }\n${footer}`;
        const abstractDestination = `${header}    private class Inner { }\n${footer}`;

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: abstractBase,
                    sourceContent: abstractSource,
                    destinationContent: abstractDestination
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT &&
                error.details.mismatches.includes('innerClasses')
        );

        const virtualBase = `${header}    private virtual class Inner { }\n${footer}`;
        const virtualSource = `${header}    private virtual class Inner { }\n${footer}`;
        const virtualDestination = `${header}    private class Inner { }\n${footer}`;

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: virtualBase,
                    sourceContent: virtualSource,
                    destinationContent: virtualDestination
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT &&
                error.details.mismatches.includes('innerClasses')
        );
    });

    await runTest('Phase 5A.2: identical nested annotations pass structural guard', () => {
        const ann = '    @TestVisible\n';
        const method = methodBlock('run()', "System.debug('x');");
        const nested = (body) =>
            `public class AnnLab {\n${ann}    private class Inner { ${body} }\n${method}\n}`;
        const base = nested('Integer a = 1;');
        const source = nested('Integer a = 1;');
        const destination = nested('Integer a = 1;');

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.declarationConflictCount, 0);
    });

    await runTest('Phase 5A.2: nested class annotation drift fails structural guard', () => {
        const method = methodBlock('run()', "System.debug('x');");
        const make = (ann, body) =>
            `public class AnnLab {\n${ann}    private class Inner { ${body} }\n${method}\n}`;
        const base = make('    @TestVisible\n', 'Integer a = 1;');
        const source = make('    @TestVisible\n', 'Integer a = 1;');
        const destination = make('', 'Integer a = 1;');

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: base,
                    sourceContent: source,
                    destinationContent: destination
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT &&
                error.details.mismatches.includes('innerClasses')
        );
    });

    await runTest('Phase 5A.2: nested hierarchy L1 visibility-only fails', () => {
        const method = methodBlock('run()', "System.debug('x');");
        const mk = (l1Vis) => `public class Root {
    ${l1Vis} class L1 {
        public class L2 { Integer x = 1; }
    }
${method}
}`;
        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: mk('private'),
                    sourceContent: mk('public'),
                    destinationContent: mk('private')
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT &&
                error.details.mismatches.includes('innerClasses')
        );
    });

    await runTest('Phase 5A.2: nested hierarchy L2 visibility-only fails', () => {
        const method = methodBlock('run()', "System.debug('x');");
        const mk = (l2Vis) => `public class Root {
    private class L1 {
        ${l2Vis} class L2 { Integer x = 1; }
    }
${method}
}`;
        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: mk('public'),
                    sourceContent: mk('private'),
                    destinationContent: mk('public')
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT &&
                error.details.mismatches.includes('innerClasses')
        );
    });

    await runTest('Phase 5A.2: nested class whitespace and order normalization preserved', () => {
        const method = methodBlock('run()', "System.debug('x');");
        const one = `public class OrderLab {\n    private class A { }\n    private class B { }\n${method}\n}`;
        const two = `public class OrderLab {\n    private   class   B   {   }\n    private class A { }\n${method}\n}`;
        const result = compareApexMethodMerge({
            baseContent: one,
            sourceContent: one,
            destinationContent: two
        });

        assert.ok(result.methods);
    });

    await runTest('Phase 5A.2: WeatherService divergent nested-class sets still fail', () => {
        const base = `public with sharing class WeatherService {
    public static void getWeather() {}
    public class WeatherWrapper {
        @AuraEnabled public String temperature;
    }
}`;
        const source = `public class WeatherService {
    public static void getResortWeather(Datetime dateToCheck) {}
    private class WeatherApiResponse { public List<TemperatureWrapper> weather; }
    private class TemperatureWrapper { public Decimal temperature; }
    public class Weather { public Decimal minTemperatureC; }
}`;
        const destination = `public class WeatherService {
    public static void getResortWeather(Datetime dateToCheck) {}
    public class Weather { public Decimal minTemperatureC; }
}`;

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: base,
                    sourceContent: source,
                    destinationContent: destination
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT &&
                error.details.mismatches.includes('innerClasses')
        );
    });

    await runTest('omitted access: sharing-only drift reaches declaration comparison', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const bodyShell = `    private static Integer cacheVersion = 1;
`;
        const make = (sharingPhrase) =>
            `/**
 * Method merge fixture shell.
 */
${sharingPhrase}class WeatherMergeLab {
${bodyShell}${method}
}`;
        const base = make('with sharing ');
        const source = make('without sharing ');
        const destination = make('inherited sharing ');

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            result.declarations.access.status,
            DECLARATION_STATUS.AUTO_RESOLVED
        );
        assert.strictEqual(
            result.declarations.access.selectedValue,
            OUTER_ACCESS.UNSPECIFIED
        );
        assert.strictEqual(
            result.declarations.sharing.status,
            DECLARATION_STATUS.CONFLICT
        );
        assert.strictEqual(result.declarationConflictCount, 1);
    });

    await runTest('declaration: both attributes conflict with omitted access', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const bodyShell = `    private static Integer cacheVersion = 1;
`;
        const base = `/**
 * Method merge fixture shell.
 */
public with sharing class WeatherMergeLab {
${bodyShell}${method}
}`;
        const source = `/**
 * Method merge fixture shell.
 */
global without sharing class WeatherMergeLab {
${bodyShell}${method}
}`;
        const destination = `/**
 * Method merge fixture shell.
 */
inherited sharing class WeatherMergeLab {
${bodyShell}${method}
}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.declarationConflictCount, 2);
        assert.strictEqual(
            result.declarations.access.status,
            DECLARATION_STATUS.CONFLICT
        );
        assert.strictEqual(
            result.declarations.sharing.status,
            DECLARATION_STATUS.CONFLICT
        );
    });

    await runTest('non-mergeable header still fails structural when extends differs', () => {
        const method = methodBlock('getWeather()', "System.debug('x');");
        const base = `public with sharing class ExtLab extends BaseOne {\n${method}\n}`;
        const source = `public without sharing class ExtLab extends BaseOne {\n${method}\n}`;
        const destination = `public inherited sharing class ExtLab extends BaseTwo {\n${method}\n}`;

        assert.throws(
            () =>
                compareApexMethodMerge({
                    baseContent: base,
                    sourceContent: source,
                    destinationContent: destination
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_STRUCTURAL_CONFLICT
        );
    });

    await runTest('outer sharing drift alone no longer fails structural guard', () => {
        const method = methodBlock('getWeather()', "System.debug('x');");
        const nested = '    private class Inner { }\n';
        const base = `public with sharing class NestedLab {\n${nested}${method}\n}`;
        const source = `public without sharing class NestedLab {\n${nested}${method}\n}`;
        const destination = `public inherited sharing class NestedLab {\n${nested}${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            result.declarations.sharing.status,
            DECLARATION_STATUS.CONFLICT
        );
        assert.strictEqual(
            result.declarations.access.status,
            DECLARATION_STATUS.AUTO_RESOLVED
        );
    });

    await runTest('declaration inventory feeds reconstruct helper without composing merge output', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: result.declarations.access.selectedValue,
            sharing: result.declarations.sharing.selectedValue
        });

        assert.ok(rebuilt.includes('without sharing'));
        parseApexClassSource(rebuilt);
    });

    await runTest('method conflict count unchanged when only declaration attributes differ', () => {
        const method = methodBlock('getWeather()', "System.debug('same');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.conflictCount, 0);
        assert.strictEqual(
            inventoryByKey(result, 'getWeather()').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(result.declarationConflictCount, 0);
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

    await runTest('Phase 3: automatic sharing selection appears in composed cls', () => {
        const method = methodBlock('getWeather()', "System.debug('same');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.ok(merged.composeSuccess);
        assertOuterDeclaration(
            merged.composedSource,
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT
        );
        assert.ok(merged.composedSource.includes('without sharing'));
    });

    await runTest('Phase 3: automatic access selection appears in composed cls', () => {
        const method = methodBlock('getWeather()', "System.debug('same');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.WITH,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );

        const merged = executeApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.ok(merged.composeSuccess);
        assertOuterDeclaration(
            merged.composedSource,
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.WITH
        );
    });

    await runTest('Phase 3: WeatherService combined sharing conflict resolved to SOURCE', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const shell = `    private static Integer cacheVersion = 1;
`;
        const base = `public with sharing class WeatherService {
${shell}${method}
}`;
        const source = `global without sharing class WeatherService {
${shell}${method}
}`;
        const destination = `public inherited sharing class WeatherService {
${shell}${method}
}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            comparison.declarations.access.selectedValue,
            OUTER_ACCESS.GLOBAL
        );
        assert.strictEqual(
            comparison.declarations.sharing.status,
            DECLARATION_STATUS.CONFLICT
        );

        const merged = composeWithDeclarationResolutions(comparison, source, [
            {
                conflictKey: 'declaration:sharing',
                side: DECLARATION_RESOLUTION_SIDE.SOURCE
            }
        ]);

        assert.ok(merged.composeSuccess);
        assert.ok(merged.composedSource.includes('global without sharing class WeatherService'));
        assertOuterDeclaration(
            merged.composedSource,
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.WITHOUT
        );
    });

    await runTest('Phase 3: sharing conflict resolved to DESTINATION in composed cls', () => {
        const method = methodBlock('getWeather()', "System.debug('same');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.INHERITED,
            [method]
        );

        let comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        comparison = composeWithDeclarationResolutions(comparison, source, [
            {
                conflictKey: 'declaration:sharing',
                side: DECLARATION_RESOLUTION_SIDE.DESTINATION
            }
        ]);

        assertOuterDeclaration(
            comparison.composedSource,
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.INHERITED
        );
        assert.ok(comparison.composedSource.includes('inherited sharing'));
    });

    await runTest('Phase 3: independent access and sharing conflict resolutions in composed cls', () => {
        const method = methodBlock('getWeather()', "System.debug('same');");
        const shell = `    private static Integer cacheVersion = 1;
`;
        const base = `public with sharing class WeatherMergeLab {
${shell}${method}
    private class Helper {
        public Integer value;
    }
}`;
        const source = `global without sharing class WeatherMergeLab {
${shell}${method}
    private class Helper {
        public Integer value;
    }
}`;
        const destination = `inherited sharing class WeatherMergeLab {
${shell}${method}
    private class Helper {
        public Integer value;
    }
}`;

        let comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        comparison = composeWithDeclarationResolutions(comparison, source, [
            {
                conflictKey: 'declaration:access',
                side: DECLARATION_RESOLUTION_SIDE.SOURCE
            },
            {
                conflictKey: 'declaration:sharing',
                side: DECLARATION_RESOLUTION_SIDE.DESTINATION
            }
        ]);

        assertOuterDeclaration(
            comparison.composedSource,
            OUTER_ACCESS.GLOBAL,
            OUTER_SHARING.INHERITED
        );
        assert.ok(comparison.composedSource.includes('private class Helper'));
    });

    await runTest('Phase 3: absent base identical declarations compose with selected values', () => {
        const method = methodBlock('getWeather()', "System.debug('same');");
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );

        const merged = executeApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.ok(merged.composeSuccess);
        assertOuterDeclaration(
            merged.composedSource,
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT
        );
    });

    await runTest('Phase 3: unresolved declaration conflict blocks composition', () => {
        const method = methodBlock('getWeather()', "System.debug('same');");
        const base = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITH,
            [method]
        );
        const source = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT,
            [method]
        );
        const destination = buildClassWithOuterDeclaration(
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.INHERITED,
            [method]
        );

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.throws(
            () => composeApexMethodMerge(comparison, source),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.DECLARATION_UNRESOLVED_CONFLICT
        );
    });

    await runTest('Phase 3: unsupported selected access fails composition closed', () => {
        const method = methodBlock('getWeather()', "System.debug('same');");
        const source = `private class PrivateOnly {
${method}
}`;
        const destination = `private class PrivateOnly {
${method}
}`;

        const comparison = compareApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.throws(
            () => composeApexMethodMerge(comparison, source),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_COMPOSE_FAILED
        );
    });

    await runTest('Phase 3: merged methods preserved with declaration reconstruction', () => {
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

        assert.ok(merged.composeSuccess);
        assert.ok(merged.composedSource.includes("System.debug('destination');"));
        assertOuterDeclaration(
            merged.composedSource,
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.OMITTED
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