'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    parseApexClassSource,
    buildMethodIdentityKey,
    extractSourceRange
} = require('./apexClassParser.service');
const { MERGE_ERROR, ApexMergeError } = require('./apexMerge.errors');

const FIXTURES_ROOT = path.join(__dirname, 'fixtures', 'parser');

function readFixture(name) {
    return fs.readFileSync(path.join(FIXTURES_ROOT, name), 'utf8');
}

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            throw error;
        });
}

function methodByName(methods, name) {
    return methods.filter((method) => method.name === name);
}

async function main() {
    await runTest('extracts WeatherService methods and identity keys', () => {
        const source = readFixture('WeatherService.cls');
        const parsed = parseApexClassSource(source);

        assert.strictEqual(parsed.className, 'WeatherService');
        assert.ok(parsed.classDeclaration.text.includes('public class WeatherService'));
        assert.strictEqual(parsed.methods.length, 5);

        const weather = parsed.methods.find((m) => m.name === 'getWeather');
        assert.ok(weather);
        assert.strictEqual(weather.identityKey, 'getWeather()');
        assert.strictEqual(weather.isStatic, true);
        assert.strictEqual(weather.accessModifier, 'public');
        assert.strictEqual(weather.returnType, 'void');

        const greets = methodByName(parsed.methods, 'greet');
        assert.strictEqual(greets.length, 2);
        assert.notStrictEqual(greets[0].identityKey, greets[1].identityKey);
        assert.strictEqual(greets[0].identityKey, 'greet(String,Integer)');
        assert.strictEqual(greets[1].identityKey, 'greet(Decimal)');

        const forecast = parsed.methods.find((m) => m.name === 'getForecast');
        assert.ok(forecast.sourceText.includes('block comment inside'));
        assert.ok(
            source.slice(forecast.sourceRange.start, forecast.sourceRange.end).includes(
                'public static void getForecast'
            )
        );
    });

    await runTest('source slices preserve comments and annotations', () => {
        const source = readFixture('Comprehensive.cls');
        const parsed = parseApexClassSource(source);

        const load = parsed.methods.find(
            (method) => method.name === 'load' && method.declaringClassQualifiedName === 'Comprehensive'
        );
        assert.ok(load);
        assert.ok(load.sourceText.includes('@AuraEnabled'));
        assert.ok(load.sourceText.includes('Map<String, Integer>'));
        assert.strictEqual(load.identityKey, 'load(Map<String,Integer>,Set<Id>)');

        const helper = parsed.methods.find((method) => method.name === 'helper');
        assert.ok(helper);
        assert.ok(helper.sourceText.includes('// inline comment'));
        assert.ok(helper.annotations.length >= 1);
        assert.match(helper.annotations[0], /@TestVisible/);
    });

    await runTest('detects constructors, fields, properties, and inner classes', () => {
        const source = readFixture('Comprehensive.cls');
        const parsed = parseApexClassSource(source);

        assert.strictEqual(parsed.constructors.length, 2);
        assert.notStrictEqual(
            parsed.constructors[0].identityKey,
            parsed.constructors[1].identityKey
        );
        assert.strictEqual(parsed.constructors[1].identityKey, 'Comprehensive(String)');

        const root = parsed.classes.find((c) => c.isRoot);
        assert.ok(root.fields.length >= 1);
        assert.ok(root.fields[0].sourceText.includes('counter'));
        assert.ok(root.properties.length >= 1);
        assert.ok(root.properties[0].sourceText.includes('get { return LABEL; }'));

        const inner = parsed.classes.find(
            (c) => c.qualifiedName === 'Comprehensive.InnerWorker'
        );
        assert.ok(inner);
        assert.strictEqual(inner.methods.length, 2);
        assert.strictEqual(inner.methods[0].identityKey, 'run()');
        assert.strictEqual(inner.methods[1].identityKey, 'run(String)');
        assert.ok(root.innerClasses.some((c) => c.className === 'InnerWorker'));
    });

    await runTest('extractSourceRange matches full method text in source', () => {
        const source = readFixture('WeatherService.cls');
        const parsed = parseApexClassSource(source);
        const temperature = parsed.methods.find((m) => m.name === 'getTemperature');

        const sliced = source.slice(
            temperature.sourceRange.start,
            temperature.sourceRange.end
        );

        assert.strictEqual(sliced, temperature.sourceText);
        assert.ok(temperature.sourceText.includes('getTemperature'));
        assert.strictEqual(temperature.isStatic, false);
    });

    await runTest('buildMethodIdentityKey only uses name and parameter types', () => {
        assert.strictEqual(
            buildMethodIdentityKey('foo', ['String', 'Integer']),
            'foo(String,Integer)'
        );
        assert.strictEqual(
            buildMethodIdentityKey('foo', ['Integer']),
            'foo(Integer)'
        );
    });

    await runTest('invalid Apex fails with PARSE_FAILED', () => {
        const source = readFixture('InvalidSyntax.cls');

        assert.throws(
            () => parseApexClassSource(source),
            (error) => {
                assert.ok(error instanceof ApexMergeError);
                assert.strictEqual(error.code, MERGE_ERROR.PARSE_FAILED);
                return true;
            }
        );
    });

    await runTest('empty source fails clearly', () => {
        assert.throws(
            () => parseApexClassSource('   '),
            (error) => error.code === MERGE_ERROR.PARSE_FAILED
        );
    });

    console.log('All apexClassParser tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});