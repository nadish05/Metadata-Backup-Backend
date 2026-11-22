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
    applyDeclarationResolutions,
    applyNestedClassResolutions,
    assertResolvableNestedClassKeys,
    assertNestedClassResolutionTargetsAreConflicts,
    assertResolvableMethodResolutionKeys,
    assertMethodResolutionTargetsAreConflicts,
    buildScopedMethodKey,
    isNestedClassComposeReady,
    validateComposedNestedStructuralExpectations,
    countDeclarationConflicts
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

function inventoryByKey(inventory, key, declaringClassQualifiedName = null) {
    if (declaringClassQualifiedName) {
        return inventory.methods.find(
            (entry) =>
                entry.methodKey === key &&
                entry.declaringClassQualifiedName === declaringClassQualifiedName
        );
    }

    return (
        inventory.methods.find(
            (entry) => entry.methodKey === key && entry.isRootCallable
        ) || inventory.methods.find((entry) => entry.methodKey === key)
    );
}

function methodByScoped(inventory, scopedMethodKey) {
    return inventory.methods.find(
        (entry) => entry.scopedMethodKey === scopedMethodKey
    );
}

function nestedByQName(result, qualifiedName) {
    return result.nestedClasses.find(
        (entry) => entry.qualifiedName === qualifiedName
    );
}

function assertNestedComposeBlocked(
    comparison,
    sourceContent,
    destinationContent = sourceContent
) {
    assert.strictEqual(comparison.nestedClassComposeReady, false);
    assert.throws(
        () =>
            composeApexMethodMerge(
                comparison,
                sourceContent,
                destinationContent
            ),
        (error) =>
            error instanceof ApexMergeError &&
            (error.code === MERGE_ERROR.METHOD_COMPOSE_FAILED ||
                error.code === MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT)
    );
}

function assertNestedComposeSuccess(
    comparison,
    sourceContent,
    destinationContent = sourceContent
) {
    comparison.nestedClassComposeReady = isNestedClassComposeReady(
        comparison.nestedClasses,
        comparison.parses?.source,
        comparison.parses?.destination,
        comparison.methods,
        comparison.maps?.source,
        comparison.maps?.destination
    );
    assert.strictEqual(comparison.nestedClassComposeReady, true);
    const composed = composeApexMethodMerge(
        comparison,
        sourceContent,
        destinationContent
    );
    assert.ok(composed.composeSuccess);
    return composed.composedSource;
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
            scopedMethodKey: buildScopedMethodKey(
                comparison.className,
                'notReal()'
            ),
            declaringClassQualifiedName: comparison.className,
            isRootCallable: true,
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
            comparison.maps.destination,
            comparison.className
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
            comparison.maps.destination,
            comparison.className
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
            comparisonTarget.maps.destination,
            comparisonTarget.className
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

    await runTest('structural guard: nested class field drift surfaces nested inventory', () => {
        const method = methodBlock('getWeather()', "System.debug('x');");
        const nestedA = '    private class Inner { Integer a = 1; }\n';
        const header = 'public with sharing class NestedLab {\n';
        const base = `${header}${nestedA}${method}\n}`;
        const source = `${header}${nestedA.replace('= 1', '= 2')}${method}\n}`;
        const destination = `${header}${nestedA.replace('= 1', '= 3')}${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });
        const nested = nestedByQName(result, 'NestedLab.Inner');

        assert.strictEqual(nested.status, METHOD_STATUS.CONFLICT);
        assert.strictEqual(result.nestedClassConflictCount, 1);
        assertNestedComposeBlocked(result, source);
    });

    await runTest('Phase 5A.2: nested class visibility-only difference surfaces nested conflict', () => {
        const mk = (visibility) => `public class ExampleService {
    ${visibility} class Helper {
        public String getValue() {
            return 'Example';
        }
    }
    public static void run() {}
}`;

        const assertNestedShellDrift = (base, source, destination) => {
            const result = compareApexMethodMerge({
                baseContent: base,
                sourceContent: source,
                destinationContent: destination
            });
            const nested = nestedByQName(result, 'ExampleService.Helper');

            assert.strictEqual(nested.status, METHOD_STATUS.AUTO_INCLUDED);
            assertNestedComposeSuccess(result, source, destination);
        };

        assertNestedShellDrift(mk('private'), mk('public'), mk('private'));
        assertNestedShellDrift(mk('public'), mk('private'), mk('public'));
        assertNestedShellDrift(
            mk('protected'),
            mk('public'),
            mk('protected')
        );
        assertNestedShellDrift(mk('public'), mk('protected'), mk('public'));
    });

    await runTest('Phase 5A.2: nested class static and abstract modifier drift fails', () => {
        const method = methodBlock('run()', "System.debug('x');");
        const header = 'public class ModifierLab {\n';
        const footer = `\n${method}\n}`;
        const base = `${header}    private static class Inner { }\n${footer}`;
        const source = `${header}    private class Inner { }\n${footer}`;
        const destination = `${header}    private static class Inner { }\n${footer}`;

        const staticResult = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(staticResult, 'ModifierLab.Inner').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assertNestedComposeSuccess(staticResult, source, destination);

        const abstractBase = `${header}    private abstract class Inner { }\n${footer}`;
        const abstractSource = `${header}    private abstract class Inner { }\n${footer}`;
        const abstractDestination = `${header}    private class Inner { }\n${footer}`;

        const abstractResult = compareApexMethodMerge({
            baseContent: abstractBase,
            sourceContent: abstractSource,
            destinationContent: abstractDestination
        });

        assert.strictEqual(
            nestedByQName(abstractResult, 'ModifierLab.Inner').status,
            METHOD_STATUS.AUTO_INCLUDED
        );

        const virtualBase = `${header}    private virtual class Inner { }\n${footer}`;
        const virtualSource = `${header}    private virtual class Inner { }\n${footer}`;
        const virtualDestination = `${header}    private class Inner { }\n${footer}`;

        const virtualResult = compareApexMethodMerge({
            baseContent: virtualBase,
            sourceContent: virtualSource,
            destinationContent: virtualDestination
        });

        assert.strictEqual(
            nestedByQName(virtualResult, 'ModifierLab.Inner').status,
            METHOD_STATUS.AUTO_INCLUDED
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

        const annResult = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(annResult, 'AnnLab.Inner').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assertNestedComposeSuccess(annResult, source, destination);
    });

    await runTest('Phase 5A.2: nested hierarchy L1 visibility-only fails', () => {
        const method = methodBlock('run()', "System.debug('x');");
        const mk = (l1Vis) => `public class Root {
    ${l1Vis} class L1 {
        public class L2 { Integer x = 1; }
    }
${method}
}`;
        const result = compareApexMethodMerge({
            baseContent: mk('private'),
            sourceContent: mk('public'),
            destinationContent: mk('protected')
        });

        assert.strictEqual(
            nestedByQName(result, 'Root.L1').status,
            METHOD_STATUS.CONFLICT
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
        const result = compareApexMethodMerge({
            baseContent: mk('public'),
            sourceContent: mk('protected'),
            destinationContent: mk('private')
        });

        assert.strictEqual(
            nestedByQName(result, 'Root.L1.L2').status,
            METHOD_STATUS.CONFLICT
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

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'WeatherService.TemperatureWrapper').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            nestedByQName(result, 'WeatherService.WeatherWrapper').status,
            METHOD_STATUS.AUTO_EXCLUDED
        );
        assertNestedComposeSuccess(result, source, destination);
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

    await runTest('Phase 5B.2: source-only nested class inventory', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const nested = '    private class OnlySource { Integer x = 1; }\n';
        const baseDest = `public class SOnly {\n${method}\n}`;
        const source = `public class SOnly {\n${method}\n${nested}\n}`;

        const result = compareApexMethodMerge({
            baseContent: baseDest,
            sourceContent: source,
            destinationContent: baseDest
        });

        assert.strictEqual(
            nestedByQName(result, 'SOnly.OnlySource').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assertNestedComposeSuccess(result, source, baseDest);
    });

    await runTest('Phase 5B.2: destination-only nested class inventory', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const nested = '    private class OnlyDest { Integer x = 2; }\n';
        const baseSource = `public class DOnly {\n${method}\n}`;
        const destination = `public class DOnly {\n${method}\n${nested}\n}`;

        const result = compareApexMethodMerge({
            baseContent: baseSource,
            sourceContent: baseSource,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'DOnly.OnlyDest').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assertNestedComposeSuccess(result, baseSource, destination);
    });

    await runTest('Phase 5B.2: identical nested additions on both sides', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const nested = '    private class SharedAdd { }\n';
        const base = `public class SameAdd {\n${method}\n}`;
        const both = `public class SameAdd {\n${method}\n${nested}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: both,
            destinationContent: both
        });

        assert.strictEqual(
            nestedByQName(result, 'SameAdd.SharedAdd').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assertNestedComposeSuccess(result, both, both);
    });

    await runTest('Phase 5B.2.1: independent nested additions A and B', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const base = `public class DiffAdd {\n${method}\n}`;
        const source = `public class DiffAdd {\n${method}\n    private class A { }\n}`;
        const destination = `public class DiffAdd {\n${method}\n    private class B { }\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'DiffAdd.A').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            nestedByQName(result, 'DiffAdd.B').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(result.nestedClassConflictCount, 0);
        assertNestedComposeSuccess(result, source, destination);
    });

    await runTest('Phase 5B.2.1: WeatherService-style independent additions', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const base = `public class WeatherService {\n${method}\n}`;
        const source = `public class WeatherService {\n    public class WeatherApiResponse { }\n${method}\n}`;
        const destination = `public class WeatherService {\n    public class TemperatureWrapper { }\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'WeatherService.WeatherApiResponse').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            nestedByQName(result, 'WeatherService.TemperatureWrapper').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(result.nestedClassConflictCount, 0);
    });

    await runTest('Phase 5B.2.1: same qualified name identical shells on both sides', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const nested = '    public class SharedNest { Integer x = 1; }\n';
        const base = `public class SameQName {\n${method}\n}`;
        const both = `public class SameQName {\n${nested}${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: both,
            destinationContent: both
        });

        assert.strictEqual(
            nestedByQName(result, 'SameQName.SharedNest').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(result.nestedClassConflictCount, 0);
    });

    await runTest('Phase 5B.2.1: same qualified name divergent shells conflict', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const base = `public class ShellQName {\n${method}\n}`;
        const source = `public class ShellQName {\n    private class SharedNest { }\n${method}\n}`;
        const destination = `public class ShellQName {\n    public static class SharedNest { }\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'ShellQName.SharedNest').status,
            METHOD_STATUS.CONFLICT
        );
        assert.strictEqual(result.nestedClassConflictCount, 1);
    });

    await runTest('Phase 5B.2.1: additions with unchanged base nested class', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const legacy = '    private class Legacy { Integer id = 1; }\n';
        const base = `public class WithLegacy {\n${legacy}${method}\n}`;
        const source = `public class WithLegacy {\n${legacy}    private class AddedA { }\n${method}\n}`;
        const destination = `public class WithLegacy {\n${legacy}    private class AddedB { }\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'WithLegacy.Legacy').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            nestedByQName(result, 'WithLegacy.AddedA').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            nestedByQName(result, 'WithLegacy.AddedB').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(result.nestedClassConflictCount, 0);
    });

    await runTest('Phase 5B.2.1: multiple independent sibling additions', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const base = `public class MultiAdd {\n${method}\n}`;
        const source = `public class MultiAdd {\n    private class SiblingS1 { }\n    private class SiblingS2 { }\n${method}\n}`;
        const destination = `public class MultiAdd {\n    private class SiblingD1 { }\n    private class SiblingD2 { }\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'MultiAdd.SiblingS1').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            nestedByQName(result, 'MultiAdd.SiblingS2').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            nestedByQName(result, 'MultiAdd.SiblingD1').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            nestedByQName(result, 'MultiAdd.SiblingD2').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(result.nestedClassConflictCount, 0);
    });

    await runTest('Phase 5B.2.1: absent base same-qualified divergent additions conflict', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const source = `public class AbsentQName {\n    private class SharedNest { Integer a = 1; }\n${method}\n}`;
        const destination = `public class AbsentQName {\n    private class SharedNest { Integer a = 2; }\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'AbsentQName.SharedNest').status,
            METHOD_STATUS.CONFLICT
        );
        assert.strictEqual(result.nestedClassConflictCount, 1);
    });

    await runTest('Phase 5B.2: nested class deleted on both sides', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const nested = '    private class Gone { }\n';
        const base = `public class BothDel {\n${nested}${method}\n}`;
        const trimmed = `public class BothDel {\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: trimmed,
            destinationContent: trimmed
        });

        assert.strictEqual(
            nestedByQName(result, 'BothDel.Gone').status,
            METHOD_STATUS.AUTO_EXCLUDED
        );
        assertNestedComposeSuccess(result, trimmed, trimmed);
    });

    await runTest('Phase 5B.2: nested delete versus unchanged destination', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const nested = '    private class DropMe { }\n';
        const base = `public class DelUnch {\n${nested}${method}\n}`;
        const source = `public class DelUnch {\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: base
        });

        assert.strictEqual(
            nestedByQName(result, 'DelUnch.DropMe').status,
            METHOD_STATUS.AUTO_EXCLUDED
        );
    });

    await runTest('Phase 5B.2: nested delete versus modification conflicts', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const nested = '    private class Mutate { Integer x = 1; }\n';
        const nestedMut = '    private static class Mutate { Integer x = 2; }\n';
        const base = `public class DelMod {\n${nested}${method}\n}`;
        const source = `public class DelMod {\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: `public class DelMod {\n${nestedMut}${method}\n}`
        });

        assert.strictEqual(
            nestedByQName(result, 'DelMod.Mutate').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('Phase 5B.2: source-only nested shell modification', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const baseDest = `public class ShellSrc {\n${method}\n    private class Inner { }\n}`;
        const source = `public class ShellSrc {\n${method}\n    private static class Inner { }\n}`;

        const result = compareApexMethodMerge({
            baseContent: baseDest,
            sourceContent: source,
            destinationContent: baseDest
        });

        assert.strictEqual(
            nestedByQName(result, 'ShellSrc.Inner').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assertNestedComposeSuccess(result, source, baseDest);
    });

    await runTest('Phase 5B.2: destination-only nested shell modification', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const baseSource = `public class ShellDst {\n    private class Inner { }\n${method}\n}`;
        const destination = `public class ShellDst {\n    private static class Inner { }\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: baseSource,
            sourceContent: baseSource,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'ShellDst.Inner').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
    });

    await runTest('Phase 5B.2: divergent nested shell modifications conflict', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const base = `public class ShellDiv {\n    private class Inner { }\n${method}\n}`;
        const source = `public class ShellDiv {\n    private static class Inner { }\n${method}\n}`;
        const destination = `public class ShellDiv {\n    public class Inner { }\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'ShellDiv.Inner').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('Phase 5B.2: matching shell with divergent nested method bodies', () => {
        const mk = (bodyLine) => `public class WeatherService {
    public class Weather {
        public Decimal toFahrenheit() {
            ${bodyLine}
        }
    }
    public static void run() {}
}`;
        const base = mk('return 1;');
        const source = mk("return 32 + 1;");
        const destination = mk('return 212;');

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'WeatherService.Weather').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(result.nestedClassConflictCount, 0);
        assertNestedComposeBlocked(result, source);
    });

    await runTest('Phase 5B.2: multiple sibling nested classes', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const source = `public class Siblings {
    private class A { }
    private class B { Integer x = 1; }
${method}
}`;
        const destination = `public class Siblings {
    private class A { }
    private class B { Integer x = 2; }
${method}
}`;

        const base = `public class Siblings {
    private class A { }
    private class B { Integer x = 0; }
${method}
}`;
        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'Siblings.A').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            nestedByQName(result, 'Siblings.B').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('Phase 5B.2: deeply nested qualified names', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const tree = `public class DeepRoot {
    private class L1 {
        public class L2 {
            public class L3 { Integer x = 1; }
        }
    }
${method}
}`;
        const changed = tree.replace('Integer x = 1', 'Integer x = 9');

        const sourceChanged = tree.replace('Integer x = 1', 'Integer x = 4');
        const result = compareApexMethodMerge({
            baseContent: tree,
            sourceContent: sourceChanged,
            destinationContent: changed
        });

        assert.strictEqual(
            nestedByQName(result, 'DeepRoot.L1.L2.L3').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('Phase 5B.2: nested class accept source resolution', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const base = `public class ResSrc {\n${method}\n    private class Inner { }\n}`;
        const source = `public class ResSrc {\n${method}\n    private static class Inner { }\n}`;
        const destination = `public class ResSrc {\n${method}\n    public class Inner { }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        applyNestedClassResolutions(comparison.nestedClasses, [
            {
                qualifiedName: 'ResSrc.Inner',
                strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
            }
        ]);

        assert.strictEqual(
            nestedByQName(comparison, 'ResSrc.Inner').status,
            METHOD_STATUS.RESOLVED
        );
        assert.strictEqual(
            comparison.nestedClasses.filter(
                (entry) => entry.status === METHOD_STATUS.CONFLICT
            ).length,
            0
        );
        assertNestedComposeSuccess(comparison, source, destination);
    });

    await runTest('Phase 5B.2: nested class accept destination resolution', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const base = `public class ResDst {\n${method}\n    private class Inner { }\n}`;
        const source = `public class ResDst {\n${method}\n    private static class Inner { }\n}`;
        const destination = `public class ResDst {\n${method}\n    public class Inner { }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        applyNestedClassResolutions(comparison.nestedClasses, [
            {
                qualifiedName: 'ResDst.Inner',
                strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
            }
        ]);

        assert.strictEqual(
            nestedByQName(comparison, 'ResDst.Inner').status,
            METHOD_STATUS.RESOLVED
        );
        assertNestedComposeSuccess(comparison, source, destination);
    });

    await runTest('Phase 5B.2: invalid nested resolution keys and strategies', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const base = `public class BadRes {\n    private class Inner { }\n${method}\n}`;
        const source = `public class BadRes {\n    private static class Inner { }\n${method}\n}`;
        const destination = `public class BadRes {\n    public class Inner { }\n${method}\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.throws(
            () =>
                assertResolvableNestedClassKeys(comparison.nestedClasses, [
                    { qualifiedName: 'BadRes.Missing', strategy: 'ACCEPT_SOURCE' }
                ]),
            (error) => error.code === MERGE_ERROR.INVALID_REQUEST
        );

        assert.throws(
            () =>
                applyNestedClassResolutions(comparison.nestedClasses, [
                    {
                        qualifiedName: 'BadRes.Inner',
                        strategy: 'PICK_BOTH'
                    }
                ]),
            (error) => error.code === MERGE_ERROR.INVALID_RESOLUTION_STRATEGY
        );

        const stable = compareApexMethodMerge({
            baseContent: base,
            sourceContent: base,
            destinationContent: base
        });

        assert.throws(
            () =>
                applyNestedClassResolutions(stable.nestedClasses, [
                    {
                        qualifiedName: 'BadRes.Inner',
                        strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                    }
                ]),
            (error) => error.code === MERGE_ERROR.INVALID_REQUEST
        );
    });

    await runTest('Phase 5B.2: root METHOD merge regression without nested drift', () => {
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
        assert.strictEqual(merged.nestedClasses.length, 0);
        assert.strictEqual(merged.nestedClassComposeReady, true);
    });

    await runTest('Phase 5B.2: absent base METHOD merge regression with nested inventory', () => {
        const method = methodBlock('run()', "System.debug('same');");
        const source = `public class AbsentBase {\n${method}\n}`;
        const destination = `public class AbsentBase {\n${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.baseClassAbsent, true);
        assert.strictEqual(result.nestedClasses.length, 0);
        assert.ok(composeApexMethodMerge(result, source).composeSuccess);
    });

    await runTest('Phase 5B.2: compose and seal remain blocked for nested drift', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const source = `public class SealBlock {\n    private class Inner { }\n${method}\n}`;
        const destination = source;

        const comparison = compareApexMethodMerge({
            baseContent: source,
            sourceContent: source,
            destinationContent: destination
        });
        const merged = executeApexMethodMerge({
            baseContent: source,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(comparison.nestedClassComposeReady, true);
        assert.ok(merged.composeSuccess);

        const driftedDest = `public class SealBlock {\n${method}\n    public class Inner { }\n}`;
        const driftedSource = `public class SealBlock {\n${method}\n    private static class Inner { }\n}`;
        const drift = compareApexMethodMerge({
            baseContent: source,
            sourceContent: driftedSource,
            destinationContent: driftedDest
        });

        assert.strictEqual(
            nestedByQName(drift, 'SealBlock.Inner').status,
            METHOD_STATUS.CONFLICT
        );
        assertNestedComposeBlocked(drift, driftedSource, driftedDest);
        assert.strictEqual(
            executeApexMethodMerge({
                baseContent: source,
                sourceContent: driftedSource,
                destinationContent: driftedDest
            }).composeSuccess,
            false
        );
    });

    await runTest('Phase 5B.3: root method behaviour unchanged', () => {
        const base = buildClass([baseWeather, sharedForecast]);
        const source = buildClass([sourceWeather, sharedForecast]);
        const destination = buildClass([destWeather, sharedForecast]);

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const rootItem = inventoryByKey(result, 'getWeather()');
        assert.strictEqual(rootItem.scopedMethodKey, 'WeatherMergeLab#getWeather()');
        assert.strictEqual(rootItem.declaringClassQualifiedName, 'WeatherMergeLab');
        assert.strictEqual(rootItem.status, METHOD_STATUS.CONFLICT);

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
    });

    await runTest('Phase 5B.3: nested source-only method', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class NLab {\n    private class Inner { }\n${root}\n}`;
        const source = `public class NLab {\n    private class Inner {
        public static void onlySource() {
            System.debug('s');
        }
    }\n${root}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: base
        });

        const item = methodByScoped(result, 'NLab.Inner#onlySource()');
        assert.strictEqual(item.status, METHOD_STATUS.AUTO_INCLUDED);
    });

    await runTest('Phase 5B.3: nested destination-only method', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class NLab {\n    private class Inner { }\n${root}\n}`;
        const destination = `public class NLab {\n    private class Inner {
        public static void onlyDest() {
            System.debug('d');
        }
    }\n${root}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: base,
            destinationContent: destination
        });

        assert.strictEqual(
            methodByScoped(result, 'NLab.Inner#onlyDest()').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
    });

    await runTest('Phase 5B.3: identical nested method additions', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const nestedMethod = `        public static void sharedAdd() {
            return;
        }`;
        const base = `public class NLab {\n    private class Inner { }\n${root}\n}`;
        const both = `public class NLab {\n    private class Inner {\n${nestedMethod}\n    }\n${root}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: both,
            destinationContent: both
        });

        assert.strictEqual(
            methodByScoped(result, 'NLab.Inner#sharedAdd()').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
    });

    await runTest('Phase 5B.3: divergent nested method additions', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class NLab {\n    private class Inner { }\n${root}\n}`;
        const source = `public class NLab {\n    private class Inner {
        public static void newOne() { System.debug('s'); }
    }\n${root}\n}`;
        const destination = `public class NLab {\n    private class Inner {
        public static void newTwo() { System.debug('d'); }
    }\n${root}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            methodByScoped(result, 'NLab.Inner#newOne()').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            methodByScoped(result, 'NLab.Inner#newTwo()').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
    });

    await runTest('Phase 5B.3: same nested method modified differently', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const nested = (body) => `public class NLab {\n    private class Inner {
        public Decimal toFahrenheit() {
            ${body}
        }
    }\n${root}\n}`;
        const result = compareApexMethodMerge({
            baseContent: nested('return 1;'),
            sourceContent: nested('return 2;'),
            destinationContent: nested('return 3;')
        });

        assert.strictEqual(
            methodByScoped(result, 'NLab.Inner#toFahrenheit()').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('Phase 5B.3: nested method deleted on both sides', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const nested = `        public static void dropMe() {
            return;
        }`;
        const base = `public class NLab {\n    private class Inner {\n${nested}\n    }\n${root}\n}`;
        const trimmed = `public class NLab {\n    private class Inner { }\n${root}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: trimmed,
            destinationContent: trimmed
        });

        assert.strictEqual(
            methodByScoped(result, 'NLab.Inner#dropMe()').status,
            METHOD_STATUS.AUTO_EXCLUDED
        );
    });

    await runTest('Phase 5B.3: nested delete versus modification conflict', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const nested = `        public static void flip() {
            return;
        }`;
        const base = `public class NLab {\n    private class Inner {\n${nested}\n    }\n${root}\n}`;
        const source = `public class NLab {\n    private class Inner { }\n${root}\n}`;
        const destination = `public class NLab {\n    private class Inner {
        public static void flip() {
            System.debug('changed');
        }
    }\n${root}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            methodByScoped(result, 'NLab.Inner#flip()').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('Phase 5B.3: same method name in root and nested class', () => {
        const nested = `    private class Inner {
        public static void getWeather() {
            System.debug('inner');
        }
    }`;
        const root = methodBlock('getWeather()', "System.debug('root');");
        const base = `public class NLab {\n${root}\n${nested}\n}`;
        const source = base.replace("System.debug('root')", "System.debug('root-s')");
        const destination = base.replace("System.debug('inner')", "System.debug('inner-d')");

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const rootMethod = methodByScoped(result, 'NLab#getWeather()');
        const nestedMethod = methodByScoped(result, 'NLab.Inner#getWeather()');

        assert.strictEqual(rootMethod.status, METHOD_STATUS.AUTO_INCLUDED);
        assert.strictEqual(nestedMethod.status, METHOD_STATUS.AUTO_INCLUDED);
    });

    await runTest('Phase 5B.3: same method name in two nested classes', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class NLab {\n    private class A { public static void work() { System.debug('a'); } }\n    private class B { public static void work() { System.debug('b'); } }\n${root}\n}`;
        const source = base.replace("System.debug('a')", "System.debug('a-s')");
        const destination = base.replace("System.debug('b')", "System.debug('b-d')");

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            methodByScoped(result, 'NLab.A#work()').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
        assert.strictEqual(
            methodByScoped(result, 'NLab.B#work()').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
    });

    await runTest('Phase 5B.3: overloaded nested methods', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class NLab {\n    private class Inner {
        public static void greet(String name) { return; }
    }\n${root}\n}`;
        const source = `public class NLab {\n    private class Inner {
        public static void greet(String name) { System.debug('s'); }
        public static void greet(Decimal value) { System.debug('s2'); }
    }\n${root}\n}`;
        const destination = `public class NLab {\n    private class Inner {
        public static void greet(String name) { System.debug('d'); }
        public static void greet(Decimal value) { System.debug('d2'); }
    }\n${root}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            methodByScoped(result, 'NLab.Inner#greet(String)').status,
            METHOD_STATUS.CONFLICT
        );
        assert.strictEqual(
            methodByScoped(result, 'NLab.Inner#greet(Decimal)').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('Phase 5B.3: nested constructors', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class NLab {\n    private class Inner { }\n${root}\n}`;
        const source = `public class NLab {\n    private class Inner {
        public Inner() { }
        public Inner(String label) { System.debug(label); }
    }\n${root}\n}`;
        const destination = `public class NLab {\n    private class Inner {
        public Inner() { }
        public Inner(String label) { System.debug('dest'); }
    }\n${root}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            methodByScoped(result, 'NLab.Inner#Inner(String)').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('Phase 5B.3: two-level nested methods', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const tree = `public class NLab {\n    private class L1 {
        public class L2 {
            public static void deep() { System.debug('base'); }
        }
    }\n${root}\n}`;
        const source = tree.replace("System.debug('base')", "System.debug('source')");
        const destination = tree.replace("System.debug('base')", "System.debug('dest')");

        const result = compareApexMethodMerge({
            baseContent: tree,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            methodByScoped(result, 'NLab.L1.L2#deep()').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('Phase 5B.3: three-level nested methods', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const tree = `public class DeepLab {\n    private class L1 {\n        public class L2 {\n            public class L3 {
                public static void deep3() { return; }
            }\n        }\n    }\n${root}\n}`;
        const source = tree.replace('return;', "System.debug('s');");
        const destination = tree.replace('return;', "System.debug('d');");

        const result = compareApexMethodMerge({
            baseContent: tree,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            methodByScoped(result, 'DeepLab.L1.L2.L3#deep3()').status,
            METHOD_STATUS.CONFLICT
        );
    });

    await runTest('Phase 5B.3: accept source for nested method', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const mk = (body) => `public class NLab {\n${root}\n    private class Inner {
        public static void pick() {
            ${body}
        }
    }\n}`;
        const comparison = compareApexMethodMerge({
            baseContent: mk('return;'),
            sourceContent: mk("System.debug('source');"),
            destinationContent: mk("System.debug('dest');")
        });

        applyMethodResolutions(
            comparison.methods,
            [
                {
                    methodKey: 'pick()',
                    declaringClassQualifiedName: 'NLab.Inner',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ],
            comparison.maps.source,
            comparison.maps.destination,
            comparison.className
        );

        assert.strictEqual(
            methodByScoped(comparison, 'NLab.Inner#pick()').status,
            METHOD_STATUS.RESOLVED
        );
        const composed = assertNestedComposeSuccess(
            comparison,
            mk("System.debug('source');"),
            mk("System.debug('dest');")
        );
        assert.ok(composed.includes("System.debug('source');"));
    });

    await runTest('Phase 5B.3: accept destination for nested method', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const mk = (body) => `public class NLab {\n${root}\n    private class Inner {
        public static void pick() {
            ${body}
        }
    }\n}`;
        const comparison = compareApexMethodMerge({
            baseContent: mk('return;'),
            sourceContent: mk("System.debug('source');"),
            destinationContent: mk("System.debug('dest');")
        });

        applyMethodResolutions(
            comparison.methods,
            [
                {
                    methodKey: 'pick()',
                    declaringClassQualifiedName: 'NLab.Inner',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                }
            ],
            comparison.maps.source,
            comparison.maps.destination,
            comparison.className
        );

        assert.strictEqual(
            methodByScoped(comparison, 'NLab.Inner#pick()').status,
            METHOD_STATUS.RESOLVED
        );
    });

    await runTest('Phase 5B.3: legacy root resolution payload', () => {
        const base = buildClass([baseWeather]);
        const source = buildClass([sourceWeather]);
        const destination = buildClass([destWeather]);
        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.doesNotThrow(() =>
            assertResolvableMethodResolutionKeys(
                comparison.methods,
                [{ methodKey: 'getWeather()', strategy: 'ACCEPT_SOURCE' }],
                comparison.className
            )
        );
    });

    await runTest('Phase 5B.3: invalid nested method resolution', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const mk = (body) => `public class NLab {\n${root}\n    private class Inner {
        public static void pick() { ${body} }
    }\n}`;
        const comparison = compareApexMethodMerge({
            baseContent: mk('return;'),
            sourceContent: mk("System.debug('source');"),
            destinationContent: mk("System.debug('dest');")
        });

        assert.throws(
            () =>
                assertResolvableMethodResolutionKeys(
                    comparison.methods,
                    [{ methodKey: 'pick()', strategy: 'ACCEPT_SOURCE' }],
                    comparison.className
                ),
            (error) => error.code === MERGE_ERROR.INVALID_REQUEST
        );

        assert.throws(
            () =>
                applyMethodResolutions(
                    comparison.methods,
                    [{ methodKey: 'missing()', declaringClassQualifiedName: 'NLab.Inner', strategy: 'ACCEPT_SOURCE' }],
                    comparison.maps.source,
                    comparison.maps.destination,
                    comparison.className
                ),
            (error) => error.code === MERGE_ERROR.UNKNOWN_METHOD_KEY
        );
    });

    await runTest('Phase 5B.3: unresolved parent class blocks nested method rows', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class ParentBlock {\n    private class Inner { public static void work() { return; } }\n${root}\n}`;
        const source = `public class ParentBlock {\n    private static class Inner { public static void work() { return; } }\n${root}\n}`;
        const destination = `public class ParentBlock {\n    public class Inner { public static void work() { return; } }\n${root}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'ParentBlock.Inner').status,
            METHOD_STATUS.CONFLICT
        );
        assert.strictEqual(
            methodByScoped(result, 'ParentBlock.Inner#work()'),
            undefined
        );
    });

    await runTest('Phase 5B.3: resolved nested method cannot bypass compose protection', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const mk = (body) => `public class ComposeBlock {\n    private class Inner {
        public static void pick() { ${body} }
    }\n${root}\n}`;
        const comparison = compareApexMethodMerge({
            baseContent: mk('return;'),
            sourceContent: mk("System.debug('source');"),
            destinationContent: mk("System.debug('dest');")
        });

        applyMethodResolutions(
            comparison.methods,
            [
                {
                    methodKey: 'pick()',
                    declaringClassQualifiedName: 'ComposeBlock.Inner',
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
                }
            ],
            comparison.maps.source,
            comparison.maps.destination,
            comparison.className
        );

        comparison.nestedClassComposeReady = isNestedClassComposeReady(
            comparison.nestedClasses,
            comparison.parses.source,
            comparison.parses.destination,
            comparison.methods
        );
        const composed = assertNestedComposeSuccess(
            comparison,
            mk("System.debug('source');"),
            mk("System.debug('dest');")
        );
        assert.ok(composed.includes("System.debug('source');"));
    });

    await runTest('Phase 5B.3: declaration conflict regression unchanged', () => {
        const method = methodBlock('getWeather()', "System.debug('shared');");
        const bodyShell = `    private static Integer cacheVersion = 1;
`;
        const base = `public with sharing class WeatherMergeLab {\n${bodyShell}${method}\n}`;
        const source = `global without sharing class WeatherMergeLab {\n${bodyShell}${method}\n}`;
        const destination = `inherited sharing class WeatherMergeLab {\n${bodyShell}${method}\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.declarationConflictCount, 2);
    });

    await runTest('Phase 5B.3: absent base regression with nested method inventory', () => {
        const root = methodBlock('run()', "System.debug('same');");
        const source = `public class AbsentNest {\n    private class Inner { public static void x() { System.debug('x'); } }\n${root}\n}`;
        const destination = source;

        const result = compareApexMethodMerge({
            baseContent: '',
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.baseClassAbsent, true);
        assert.strictEqual(
            methodByScoped(result, 'AbsentNest.Inner#x()').status,
            METHOD_STATUS.AUTO_INCLUDED
        );
    });

    await runTest('Phase 5B.4: independent nested method merges in Weather', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class WeatherSvc {\n${root}\n    public class Weather {
        public Decimal getTemperature() {
            return 20;
        }
    }\n}`;
        const source = `public class WeatherSvc {\n${root}\n    public class Weather {
        public Decimal getTemperature() {
            return 25;
        }
    }\n}`;
        const destination = `public class WeatherSvc {\n${root}\n    public class Weather {
        public Decimal getTemperature() {
            return 20;
        }
        public Decimal toFahrenheit(Decimal value) {
            return value;
        }
    }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const composed = assertNestedComposeSuccess(
            comparison,
            source,
            destination
        );

        assert.ok(composed.includes('return 25;'));
        assert.ok(composed.includes('toFahrenheit'));
    });

    await runTest('Phase 5B.4: resolved whole nested class does not merge rejected methods', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class WholeCls {\n${root}\n    private class Inner { public static void a() { return; } }\n}`;
        const source = `public class WholeCls {\n${root}\n    private static class Inner { public static void a() { System.debug('s'); } }\n}`;
        const destination = `public class WholeCls {\n${root}\n    public class Inner { public static void b() { System.debug('d'); } }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        applyNestedClassResolutions(comparison.nestedClasses, [
            {
                qualifiedName: 'WholeCls.Inner',
                strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
            }
        ]);

        const composed = assertNestedComposeSuccess(
            comparison,
            source,
            destination
        );

        assert.ok(composed.includes("System.debug('s');"));
        assert.ok(!composed.includes("System.debug('d');"));
    });

    await runTest('Phase 5B.4.1: nested calculate() deleted on Source only auto-excludes', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class Ready {\n${root}\n    private class Inner {
        public static void calculate() {
            return;
        }
    }\n}`;
        const source = `public class Ready {\n${root}\n    private class Inner {\n    }\n}`;
        const destination = base;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const calculate = comparison.methods.find(
            (m) => m.scopedMethodKey === 'Ready.Inner#calculate()'
        );

        assert.strictEqual(calculate.status, METHOD_STATUS.AUTO_EXCLUDED);
        assert.strictEqual(calculate.included, false);
        assert.strictEqual(calculate.chosenFrom, 'source');
        assert.strictEqual(comparison.nestedClassComposeReady, true);

        const composed = assertNestedComposeSuccess(
            comparison,
            source,
            destination
        );

        assert.ok(!composed.includes('calculate()'));
    });

    await runTest('Phase 5B.4.1: destination-only nested shell preserves static', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class WeatherService {\n${root}\n    public class Weather {
        public Decimal getValue() {
            return 10;
        }
    }\n}`;
        const destination = `public class WeatherService {\n${root}\n    public class Weather {
        public static Decimal getValue() {
            return 10;
        }
    }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: base,
            destinationContent: destination
        });

        const composed = assertNestedComposeSuccess(
            comparison,
            base,
            destination
        );

        assert.ok(composed.includes('static Decimal getValue()'));
    });

    await runTest('Phase 5B.4.1: source-only nested shell preserved', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class ShellSvc {\n${root}\n    public class Inner { public static void a() { } }\n}`;
        const source = `public class ShellSvc {\n${root}\n    private class Inner { public static void a() { } }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: base
        });

        const composed = assertNestedComposeSuccess(
            comparison,
            source,
            base
        );

        assert.ok(composed.includes('private class Inner'));
    });

    await runTest('Phase 5B.4.1: destination shell with independent method merge', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class MixSvc {\n${root}\n    public class Inner { public static void keep() { return; } }\n}`;
        const source = `public class MixSvc {\n${root}\n    public class Inner {
            public static void keep() {
                System.debug('source');
            }
        }\n}`;
        const destination = `public class MixSvc {\n${root}\n    public static class Inner {
            public static void keep() { return; }
            public static void added() { System.debug('dest'); }
        }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const composed = assertNestedComposeSuccess(
            comparison,
            source,
            destination
        );

        assert.ok(composed.includes("System.debug('source');"));
        assert.ok(composed.includes('static class Inner'));
        assert.ok(composed.includes('added()'));
    });

    await runTest('Phase 5B.4.1: compose readiness matrix smoke', () => {
        const method = methodBlock('run()', "System.debug('run');");
        const innerKeep = '    private class X { public static void keep() { } }\n';
        const scenarios = [
            {
                name: 'source-only nested add',
                base: `public class Ready {\n${method}\n}`,
                source: `public class Ready {\n${method}\n    private class A { }\n}`,
                dest: `public class Ready {\n${method}\n}`,
                ready: true
            },
            {
                name: 'dest-only nested add',
                base: `public class Ready {\n${method}\n}`,
                source: `public class Ready {\n${method}\n}`,
                dest: `public class Ready {\n${method}\n    private class B { }\n}`,
                ready: true
            },
            {
                name: 'independent nested adds both sides',
                base: `public class Ready {\n${method}\n}`,
                source: `public class Ready {\n${method}\n    private class A { }\n}`,
                dest: `public class Ready {\n${method}\n    private class B { }\n}`,
                ready: true
            },
            {
                name: 'source-only shell modification',
                base: `public class Ready {\n${method}\n${innerKeep}}`,
                source: `public class Ready {\n${method}\n    private static class X { public static void keep() { } }\n}`,
                dest: `public class Ready {\n${method}\n${innerKeep}}`,
                ready: true
            },
            {
                name: 'destination-only shell modification',
                base: `public class Ready {\n${method}\n${innerKeep}}`,
                source: `public class Ready {\n${method}\n${innerKeep}}`,
                dest: `public class Ready {\n${method}\n    public static class X { public static void keep() { } }\n}`,
                ready: true
            },
            {
                name: 'nested class deleted both sides',
                base: `public class Ready {\n${method}\n    private class Gone { }\n}`,
                source: `public class Ready {\n${method}\n}`,
                dest: `public class Ready {\n${method}\n}`,
                ready: true
            },
            {
                name: 'nested method addition destination',
                base: `public class Ready {\n${method}\n${innerKeep}}`,
                source: `public class Ready {\n${method}\n${innerKeep}}`,
                dest: `public class Ready {\n${method}\n    private class X { public static void keep() { } public static void extra() { } }\n}`,
                ready: true
            },
            {
                name: 'nested method deletion source',
                base: `public class Ready {\n${method}\n    private class X { public static void keep() { } public static void drop() { } }\n}`,
                source: `public class Ready {\n${method}\n    private class X { public static void keep() { } }\n}`,
                dest: `public class Ready {\n${method}\n    private class X { public static void keep() { } public static void drop() { } }\n}`,
                ready: true
            },
            {
                name: 'unresolved nested conflict',
                base: `public class Ready {\n${method}\n    private class X { }\n}`,
                source: `public class Ready {\n${method}\n    private static class X { }\n}`,
                dest: `public class Ready {\n${method}\n    public class X { }\n}`,
                ready: false
            }
        ];

        for (const scenario of scenarios) {
            const result = compareApexMethodMerge({
                baseContent: scenario.base,
                sourceContent: scenario.source,
                destinationContent: scenario.dest
            });

            assert.strictEqual(
                result.nestedClassComposeReady,
                scenario.ready,
                `readiness mismatch for ${scenario.name}`
            );
        }
    });

    await runTest('Phase 5B.4.3: destination-only nested field drift fails closed', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class FieldSvc {\n${root}\n    private class Inner { Integer x = 1; }\n}`;
        const source = base;
        const destination = `public class FieldSvc {\n${root}\n    private class Inner { Integer x = 1; Integer y = 2; }\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'FieldSvc.Inner').status,
            METHOD_STATUS.CONFLICT
        );
        assert.strictEqual(result.compositionReady, false);
        assertNestedComposeBlocked(result, source, destination);
    });

    await runTest('Phase 5B.4.3: source-only nested field drift fails closed', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class FieldSvc {\n${root}\n    private class Inner { Integer x = 1; }\n}`;
        const source = `public class FieldSvc {\n${root}\n    private class Inner { Integer x = 1; Integer added = 9; }\n}`;
        const destination = base;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'FieldSvc.Inner').status,
            METHOD_STATUS.CONFLICT
        );
        assert.strictEqual(result.resolved, false);
        assert.strictEqual(result.compositionReady, false);
    });

    await runTest('Phase 5B.4.3: nested field deletion drift fails closed', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class FieldSvc {\n${root}\n    private class Inner { Integer x = 1; Integer drop = 2; }\n}`;
        const source = `public class FieldSvc {\n${root}\n    private class Inner { Integer x = 1; }\n}`;
        const destination = base;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'FieldSvc.Inner').status,
            METHOD_STATUS.CONFLICT
        );
        assert.strictEqual(result.compositionReady, false);
    });

    await runTest('Phase 5B.4.3: nested property drift fails closed', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class PropSvc {\n${root}\n    private class Inner { Integer x { get; set; } }\n}`;
        const source = base;
        const destination = `public class PropSvc {\n${root}\n    private class Inner { Integer x { get; set; } Integer y { get; set; } }\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(
            nestedByQName(result, 'PropSvc.Inner').status,
            METHOD_STATUS.CONFLICT
        );
        assert.strictEqual(result.compositionReady, false);
    });

    await runTest('Phase 5B.4.3: header-only drift remains composable', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class HeadSvc {\n${root}\n    public class Inner { public static void work() { return; } }\n}`;
        const source = base;
        const destination = `public class HeadSvc {\n${root}\n    public static class Inner { public static void work() { return; } }\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const inner = nestedByQName(result, 'HeadSvc.Inner');
        assert.strictEqual(inner.status, METHOD_STATUS.AUTO_INCLUDED);
        assert.strictEqual(result.compositionReady, true);
        const composed = assertNestedComposeSuccess(
            result,
            source,
            destination
        );
        assert.ok(composed.includes('static class Inner'));
    });

    await runTest('Phase 5B.4.3: compositionReady false when conflicts resolved but nested uncomposable', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class ReadySvc {\n${root}\n    private class Inner { Integer x = 1; }\n}`;
        const source = base;
        const destination = `public class ReadySvc {\n${root}\n    private class Inner { Integer x = 1; Integer y = 2; }\n}`;

        const result = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.strictEqual(result.conflictCount, 0);
        assert.strictEqual(result.nestedClassConflictCount, 1);
        assert.strictEqual(result.resolved, false);
        assert.strictEqual(result.compositionReady, false);
    });

    await runTest('Phase 5B.4.5 F-01: compose blocks with nested-class-specific error', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class CmpNest {\n${root}\n    private class Inner { }\n}`;
        const source = `public class CmpNest {\n${root}\n    private static class Inner { }\n}`;
        const destination = `public class CmpNest {\n${root}\n    public class Inner { }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.throws(
            () => composeApexMethodMerge(comparison, source, destination),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT &&
                /nested class conflict/i.test(error.message)
        );
    });

    await runTest('Phase 5B.4.5 F-01: compose blocks with nested-method-specific error', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class CmpMeth {\n${root}\n    private class Inner { public void touch() { System.debug('base'); } }\n}`;
        const source = `public class CmpMeth {\n${root}\n    private class Inner { public void touch() { System.debug('source'); } }\n}`;
        const destination = `public class CmpMeth {\n${root}\n    private class Inner { public void touch() { System.debug('dest'); } }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.throws(
            () => composeApexMethodMerge(comparison, source, destination),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT &&
                /method conflict/i.test(error.message)
        );
    });

    await runTest('Phase 5B.4.5 F-01: declaration error precedes generic readiness when both apply', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const inner = '    private class Inner { Integer x = 1; }\n';
        const base = `public with sharing class DeclReady {\n${root}\n${inner}}`;
        const source = `global without sharing class DeclReady {\n${root}\n${inner}}`;
        const destination = `inherited sharing class DeclReady {\n${root}\n${inner}}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.ok(countDeclarationConflicts(comparison.declarations) >= 2);
        assert.strictEqual(comparison.nestedClassConflictCount, 0);
        assert.strictEqual(comparison.conflictCount, 0);

        applyDeclarationResolutions(
            comparison.declarations,
            [
                {
                    conflictKey: 'declaration:access',
                    side: DECLARATION_RESOLUTION_SIDE.SOURCE
                }
            ],
            comparison.declarationInventories
        );

        assert.strictEqual(countDeclarationConflicts(comparison.declarations), 1);

        comparison.methods.push({
            scopedMethodKey: buildScopedMethodKey('DeclReady', 'phantom()'),
            methodKey: 'phantom()',
            declaringClassQualifiedName: 'DeclReady',
            status: METHOD_STATUS.AUTO_INCLUDED,
            included: true,
            sourcePresent: true,
            destinationPresent: true,
            chosenFrom: 'source'
        });

        assert.throws(
            () => composeApexMethodMerge(comparison, source, destination),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.DECLARATION_UNRESOLVED_CONFLICT
        );
    });

    await runTest('Phase 5B.4.5 F-01: missing declaration inventory fails closed on resolution', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public with sharing class DeclInv {\n${root}\n}`;
        const source = `global without sharing class DeclInv {\n${root}\n}`;
        const destination = `inherited sharing class DeclInv {\n${root}\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.throws(
            () =>
                applyDeclarationResolutions(
                    comparison.declarations,
                    [
                        {
                            conflictKey: 'declaration:access',
                            side: DECLARATION_RESOLUTION_SIDE.SOURCE
                        }
                    ],
                    null
                ),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.MISSING_THREE_WAY_ARTIFACTS
        );
    });

    await runTest('Phase 5B.4.5 F-01: nested class conflict precedes declaration conflict', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public with sharing class BothDeclNest {\n${root}\n    private class Inner { }\n}`;
        const source = `public without sharing class BothDeclNest {\n${root}\n    private static class Inner { }\n}`;
        const destination = `public inherited sharing class BothDeclNest {\n${root}\n    public class Inner { }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.throws(
            () => composeApexMethodMerge(comparison, source, destination),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT &&
                /nested class conflict/i.test(error.message)
        );
    });

    await runTest('Phase 5B.4.5 F-01: method conflict precedes declaration conflict', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public with sharing class BothDeclMeth {\n${root}\n    private class Inner { public void touch() { System.debug('base'); } }\n}`;
        const source = `public without sharing class BothDeclMeth {\n${root}\n    private class Inner { public void touch() { System.debug('source'); } }\n}`;
        const destination = `public inherited sharing class BothDeclMeth {\n${root}\n    private class Inner { public void touch() { System.debug('dest'); } }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        assert.throws(
            () => composeApexMethodMerge(comparison, source, destination),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT &&
                /method conflict/i.test(error.message)
        );
    });

    await runTest('Phase 5B.4.5 F-01: generic readiness when inventory is not composable', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const shell = `public class StructReady {\n${root}\n}`;
        const comparison = compareApexMethodMerge({
            baseContent: shell,
            sourceContent: shell,
            destinationContent: shell
        });

        comparison.methods.push({
            scopedMethodKey: buildScopedMethodKey('StructReady', 'phantom()'),
            methodKey: 'phantom()',
            declaringClassQualifiedName: 'StructReady',
            status: METHOD_STATUS.AUTO_INCLUDED,
            included: true,
            sourcePresent: true,
            destinationPresent: true,
            chosenFrom: 'source'
        });

        assert.throws(
            () => composeApexMethodMerge(comparison, shell, shell),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_UNRESOLVED_CONFLICT &&
                /not ready to compose/i.test(error.message)
        );
    });

    await runTest('Phase 5B.4.5 F-01: fully resolved composition succeeds', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public with sharing class AllResolved {\n${root}\n    private class Inner { public void ok() { System.debug('base'); } }\n}`;
        const source = `public without sharing class AllResolved {\n${root}\n    private class Inner { public void ok() { System.debug('src'); } }\n}`;
        const destination = base;

        let comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        comparison = composeWithDeclarationResolutions(comparison, source, [
            {
                conflictKey: 'declaration:sharing',
                side: DECLARATION_RESOLUTION_SIDE.SOURCE
            }
        ]);

        const composed = assertNestedComposeSuccess(comparison, source, destination);
        const reparsed = parseApexClassSource(composed);
        assert.strictEqual(reparsed.primaryClassName, 'AllResolved');
        assert.ok(composed.includes("System.debug('src');"));
        assertOuterDeclaration(
            composed,
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT
        );
    });

    await runTest('Phase 5B.4.5 F-02: post-compose validator rejects corrupted nested fields', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class CorruptSvc {\n${root}\n    private class Inner { Integer x = 1; }\n}`;
        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: base,
            destinationContent: base
        });
        const composed = assertNestedComposeSuccess(comparison, base, base);
        const corrupted = composed.replace('Integer x = 1', 'Integer x = 99');
        const parsed = parseApexClassSource(corrupted);

        assert.throws(
            () =>
                validateComposedNestedStructuralExpectations({
                    parsed,
                    nestedClasses: comparison.nestedClasses,
                    sourceParsed: comparison.parses.source,
                    destinationParsed: comparison.parses.destination,
                    rootQualifiedName: comparison.className
                }),
            (error) =>
                error instanceof ApexMergeError &&
                error.code === MERGE_ERROR.METHOD_COMPOSE_FAILED
        );
    });

    await runTest('Phase 5B.4.5 F-02: destination-selected nested replacement preserves structure', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class StrDst {\n${root}\n    private class Inner { Integer x = 1; }\n}`;
        const source = `public class StrDst {\n${root}\n    private static class Inner { Integer x = 1; }\n}`;
        const destination = `public class StrDst {\n${root}\n    public class Inner { Integer x = 1; Integer y = 2; }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        applyNestedClassResolutions(comparison.nestedClasses, [
            {
                qualifiedName: 'StrDst.Inner',
                strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
            }
        ]);

        const composed = assertNestedComposeSuccess(comparison, source, destination);
        const parsed = parseApexClassSource(composed);
        const inner = parsed.classes.find(
            (entry) => entry.qualifiedName === 'StrDst.Inner'
        );

        assert.ok(inner);
        assert.strictEqual(inner.properties.length + inner.fields.length >= 2, true);
        assert.ok(composed.includes('Integer y = 2'));
    });

    await runTest('Phase 5B.4.5 F-02: header-only nested change remains valid after compose', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class HeadOut {\n${root}\n    private class Inner { Integer x = 1; }\n}`;
        const source = base;
        const destination = `public class HeadOut {\n${root}\n    private static class Inner { Integer x = 1; }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const composed = assertNestedComposeSuccess(comparison, source, destination);
        const parsed = parseApexClassSource(composed);

        assert.ok(composed.includes('static class Inner'));
        assert.ok(
            parsed.classes.some(
                (entry) => entry.qualifiedName === 'HeadOut.Inner'
            )
        );
    });

    await runTest('Phase 5B.4.5 F-03 A: three-level nested method compose output', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const tree = `public class OuterClass {\n${root}
    private class LevelOne {
        public class LevelTwo {
            public class LevelThree {
                public static Integer deepest() {
                    return 1;
                }
            }
        }
    }
}`;
        const source = tree.replace('return 1', 'return 2');
        const destination = tree;

        const comparison = compareApexMethodMerge({
            baseContent: tree,
            sourceContent: source,
            destinationContent: destination
        });

        const composed = assertNestedComposeSuccess(comparison, source, destination);
        const parsed = parseApexClassSource(composed);

        assert.ok(composed.includes('return 2;'));
        assert.ok(
            parsed.classes.some(
                (entry) =>
                    entry.qualifiedName === 'OuterClass.LevelOne.LevelTwo.LevelThree'
            )
        );
        const deepMethod = methodByScoped(
            comparison,
            'OuterClass.LevelOne.LevelTwo.LevelThree#deepest()'
        );
        assert.strictEqual(deepMethod.status, METHOD_STATUS.AUTO_INCLUDED);
    });

    await runTest('Phase 5B.4.5 F-03 B: sibling nested additions both present', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class SiblingHost {\n${root}\n}`;
        const source = `public class SiblingHost {\n${root}\n    private class HelperA { Integer a = 1; }\n}`;
        const destination = `public class SiblingHost {\n${root}\n    private class HelperB { Integer b = 2; }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const composed = assertNestedComposeSuccess(comparison, source, destination);
        const parsed = parseApexClassSource(composed);

        assert.ok(composed.includes('HelperA'));
        assert.ok(composed.includes('HelperB'));
        assert.strictEqual(
            parsed.classes.filter((entry) => !entry.isRoot).length,
            2
        );
    });

    await runTest('Phase 5B.4.5 F-03 C: append and replacement under same parent', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class AppendHost {\n${root}\n    private class Keep { Integer k = 1; }\n}`;
        const source = `public class AppendHost {\n${root}\n    private class Keep { Integer k = 2; }\n}`;
        const destination = `public class AppendHost {\n${root}\n    private class Keep { Integer k = 3; }\n    private class Added { Integer a = 9; }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const keep = nestedByQName(comparison, 'AppendHost.Keep');
        assert.strictEqual(keep.status, METHOD_STATUS.CONFLICT);

        applyNestedClassResolutions(comparison.nestedClasses, [
            {
                qualifiedName: 'AppendHost.Keep',
                strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_SOURCE
            }
        ]);

        const added = nestedByQName(comparison, 'AppendHost.Added');
        assert.strictEqual(added.status, METHOD_STATUS.AUTO_INCLUDED);

        const composed = assertNestedComposeSuccess(comparison, source, destination);
        const parsed = parseApexClassSource(composed);

        assert.ok(composed.includes('Integer k = 2'));
        assert.ok(!composed.includes('Integer k = 3'));
        assert.ok(composed.includes('class Added'));
        assert.ok(
            parsed.classes.some(
                (entry) => entry.qualifiedName === 'AppendHost.Keep'
            )
        );
        assert.ok(
            parsed.classes.some(
                (entry) => entry.qualifiedName === 'AppendHost.Added'
            )
        );
    });

    await runTest('Phase 5B.4.5 F-03 D: nested method change plus class addition', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class MixHost {\n${root}\n    private class Inner { public void work() { System.debug('b'); } }\n}`;
        const source = `public class MixHost {\n${root}\n    private class Inner { public void work() { System.debug('s'); } }\n}`;
        const destination = `public class MixHost {\n${root}\n    private class Inner { public void work() { System.debug('b'); } }\n    private class Fresh { Integer z = 3; }\n}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        const composed = assertNestedComposeSuccess(comparison, source, destination);
        assert.ok(composed.includes("System.debug('s');"));
        assert.ok(composed.includes('class Fresh'));
    });

    await runTest('Phase 5B.4.5 F-03 E: multiple nested method edits under different classes', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public class MultiNest {\n${root}
    private class A { public void a() { System.debug('ba'); } }
    private class B { public void b() { System.debug('bb'); } }
}`;
        const source = `public class MultiNest {\n${root}
    private class A { public void a() { System.debug('sa'); } }
    private class B { public void b() { System.debug('bb'); } }
}`;
        const destination = `public class MultiNest {\n${root}
    private class A { public void a() { System.debug('ba'); } }
    private class B { public void b() { System.debug('db'); } public void extra() { } }
}`;

        const comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        applyMethodResolutions(
            comparison.methods,
            [
                {
                    scopedMethodKey: buildScopedMethodKey('MultiNest.B', 'b()'),
                    strategy: METHOD_RESOLUTION_STRATEGY.ACCEPT_TARGET
                }
            ],
            comparison.maps.source,
            comparison.maps.destination,
            comparison.className
        );

        const composed = assertNestedComposeSuccess(comparison, source, destination);
        assert.ok(composed.includes("System.debug('sa');"));
        assert.ok(composed.includes("System.debug('db');"));
        assert.ok(composed.includes('extra()'));
    });

    await runTest('Phase 5B.4.5 F-03 F: declaration conflict resolution with nested composition', () => {
        const root = methodBlock('run()', "System.debug('run');");
        const base = `public with sharing class DeclNest {\n${root}\n    private class Inner { public void ok() { System.debug('b'); } }\n}`;
        const source = `public without sharing class DeclNest {\n${root}\n    private class Inner { public void ok() { System.debug('s'); } }\n}`;
        const destination = base;

        let comparison = compareApexMethodMerge({
            baseContent: base,
            sourceContent: source,
            destinationContent: destination
        });

        comparison = composeWithDeclarationResolutions(comparison, source, [
            {
                conflictKey: 'declaration:sharing',
                side: DECLARATION_RESOLUTION_SIDE.SOURCE
            }
        ]);

        const composed = assertNestedComposeSuccess(comparison, source, destination);
        assert.ok(composed.includes("System.debug('s');"));
        assertOuterDeclaration(
            composed,
            OUTER_ACCESS.PUBLIC,
            OUTER_SHARING.WITHOUT
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