'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    parseApexClassSource,
    buildMethodIdentityKey,
    extractSourceRange,
    OUTER_ACCESS,
    OUTER_SHARING,
    extractRootOuterDeclaration,
    reconstructOuterClassDeclaration
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

function rootBodySlice(source, parsed) {
    const outer = extractRootOuterDeclaration(parsed, source);
    return source.slice(outer.bodyRange.start);
}

function assertBodiesPreserved(originalSource, rebuiltSource, originalParsed) {
    const originalBody = rootBodySlice(originalSource, originalParsed);
    const rebuiltParsed = parseApexClassSource(rebuiltSource);
    const rebuiltBody = rootBodySlice(rebuiltSource, rebuiltParsed);

    assert.strictEqual(rebuiltBody, originalBody);
}

function assertMethodSlicesPreserved(originalSource, rebuiltSource, originalParsed) {
    const rebuiltParsed = parseApexClassSource(rebuiltSource);

    for (const method of originalParsed.methods) {
        const rebuilt = rebuiltParsed.methods.find(
            (entry) =>
                entry.identityKey === method.identityKey &&
                entry.declaringClassQualifiedName ===
                    method.declaringClassQualifiedName
        );

        assert.ok(rebuilt, `missing method ${method.identityKey}`);
        assert.strictEqual(
            rebuilt.sourceText,
            method.sourceText,
            `method sourceText changed for ${method.identityKey}`
        );
    }
}

function assertNestedClassDeclarationsPreserved(originalSource, rebuiltSource) {
    const originalParsed = parseApexClassSource(originalSource);
    const rebuiltParsed = parseApexClassSource(rebuiltSource);

    const originalNested = originalParsed.classes.filter((entry) => !entry.isRoot);
    const rebuiltNested = rebuiltParsed.classes.filter((entry) => !entry.isRoot);

    assert.strictEqual(originalNested.length, rebuiltNested.length);

    for (const originalInner of originalNested) {
        const rebuiltInner = rebuiltNested.find(
            (entry) => entry.qualifiedName === originalInner.qualifiedName
        );

        assert.ok(rebuiltInner, originalInner.qualifiedName);
        assert.strictEqual(
            rebuiltInner.classDeclaration.text,
            originalInner.classDeclaration.text
        );
    }
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

    await runTest('root typeDeclaration span is wider than classDeclaration ast span', () => {
        const source = 'public with sharing class Example {\n}';
        const parsed = parseApexClassSource(source);
        const root = parsed.classes.find((entry) => entry.isRoot);

        assert.ok(parsed.typeDeclaration.start < root.classDeclaration.start);
        assert.ok(
            parsed.typeDeclaration.text.includes('public with sharing class Example')
        );
        assert.ok(root.classDeclaration.text.includes('class Example'));
        assert.ok(
            !root.classDeclaration.text.trimStart().startsWith('public')
        );
    });

    await runTest('extractRootOuterDeclaration maps access and sharing variants', () => {
        const cases = [
            {
                source: 'public class Example {\n}',
                access: OUTER_ACCESS.PUBLIC,
                sharing: OUTER_SHARING.OMITTED
            },
            {
                source: 'global class Example {\n}',
                access: OUTER_ACCESS.GLOBAL,
                sharing: OUTER_SHARING.OMITTED
            },
            {
                source: 'public with sharing class Example {\n}',
                access: OUTER_ACCESS.PUBLIC,
                sharing: OUTER_SHARING.WITH
            },
            {
                source: 'public without sharing class Example {\n}',
                access: OUTER_ACCESS.PUBLIC,
                sharing: OUTER_SHARING.WITHOUT
            },
            {
                source: 'public inherited sharing class Example {\n}',
                access: OUTER_ACCESS.PUBLIC,
                sharing: OUTER_SHARING.INHERITED
            }
        ];

        for (const item of cases) {
            const parsed = parseApexClassSource(item.source);
            const outer = parsed.outerDeclaration;

            assert.strictEqual(outer.access, item.access, item.source);
            assert.strictEqual(outer.sharing, item.sharing, item.source);
            assert.strictEqual(outer.className, 'Example');
            assert.strictEqual(
                item.source.slice(outer.headerRange.start, outer.headerRange.end),
                outer.headerText
            );
        }
    });

    await runTest('outerDeclaration preserves annotations and inheritance in non-mergeable text', () => {
        const source = readFixture('Comprehensive.cls');
        const parsed = parseApexClassSource(source);
        const outer = parsed.outerDeclaration;

        assert.strictEqual(outer.access, OUTER_ACCESS.GLOBAL);
        assert.strictEqual(outer.sharing, OUTER_SHARING.WITH);
        assert.strictEqual(outer.className, 'Comprehensive');
        assert.ok(outer.leadingNonMergeablePrefix.includes('@RestResource'));
        assert.ok(outer.classClauseText.includes('extends BaseHandler'));
        assert.ok(outer.classClauseText.includes('implements IWorker'));
        assert.ok(outer.nonMergeableHeaderText.includes('@RestResource'));
        assert.ok(outer.classClauseText.includes('IRunnable'));
    });

    await runTest('reconstructOuterClassDeclaration changes only access and sharing', () => {
        const source = readFixture('Comprehensive.cls');
        const parsed = parseApexClassSource(source);

        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.PUBLIC,
            sharing: OUTER_SHARING.WITHOUT
        });

        const rebuiltParsed = parseApexClassSource(rebuilt);

        assert.strictEqual(rebuiltParsed.outerDeclaration.access, OUTER_ACCESS.PUBLIC);
        assert.strictEqual(
            rebuiltParsed.outerDeclaration.sharing,
            OUTER_SHARING.WITHOUT
        );
        assert.ok(rebuilt.includes('@RestResource(urlMapping=\'/demo/*\')'));
        assert.ok(rebuilt.includes('extends BaseHandler'));
        assert.ok(rebuilt.includes('implements IWorker, IRunnable'));

        assertBodiesPreserved(source, rebuilt, parsed);
        assertMethodSlicesPreserved(source, rebuilt, parsed);
        assertNestedClassDeclarationsPreserved(source, rebuilt);
    });

    await runTest('reconstructOuterClassDeclaration preserves nested visibility text', () => {
        const source = `public with sharing class Example {
    private class Helper {
        public String value;
    }
}`;
        const parsed = parseApexClassSource(source);
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.PUBLIC,
            sharing: OUTER_SHARING.OMITTED
        });

        assert.ok(rebuilt.includes('private class Helper'));
        assertBodiesPreserved(source, rebuilt, parsed);
    });

    await runTest('reconstructOuterClassDeclaration keeps method and field bytes stable', () => {
        const source = readFixture('WeatherService.cls');
        const parsed = parseApexClassSource(source);

        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.PUBLIC,
            sharing: OUTER_SHARING.WITH
        });

        assertBodiesPreserved(source, rebuilt, parsed);
        assertMethodSlicesPreserved(source, rebuilt, parsed);
    });

    await runTest('reconstructOuterClassDeclaration supports global without sharing combination', () => {
        const source = `global without sharing class Example {
    public static String getValue() {
        return 'test';
    }
}`;
        const parsed = parseApexClassSource(source);

        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.GLOBAL,
            sharing: OUTER_SHARING.WITH
        });

        const rebuiltParsed = parseApexClassSource(rebuilt);

        assert.strictEqual(rebuiltParsed.outerDeclaration.sharing, OUTER_SHARING.WITH);
        assert.ok(rebuilt.includes("return 'test';"));
        assertBodiesPreserved(source, rebuilt, parsed);
        assertMethodSlicesPreserved(source, rebuilt, parsed);
    });

    await runTest('reconstructOuterClassDeclaration preserves comments before declaration', () => {
        const source = `// file banner
public class Example {
    // inner
}`;
        const parsed = parseApexClassSource(source);
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.GLOBAL,
            sharing: OUTER_SHARING.INHERITED
        });

        assert.ok(rebuilt.startsWith('// file banner'));
        assertBodiesPreserved(source, rebuilt, parsed);
    });

    await runTest('root body opening brace uses parser classBody LBRACE position', () => {
        const source = `public with sharing class Example {
    private class Inner {
        public void run() {}
    }
}`;
        const parsed = parseApexClassSource(source);
        const outer = parsed.outerDeclaration;
        const rootOpen = source.indexOf('{');

        assert.strictEqual(outer.classBodyOpenBraceIndex, rootOpen);
        assert.notStrictEqual(
            outer.classBodyOpenBraceIndex,
            source.indexOf('Inner')
        );
        assert.ok(source[outer.classBodyOpenBraceIndex] === '{');
    });

    await runTest('reconstruction preserves comment between access and sharing', () => {
        const source = `public /* access note */ with /* share note */ sharing class Example {
    public static void run() {
        return;
    }
}`;
        const parsed = parseApexClassSource(source);
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.PUBLIC,
            sharing: OUTER_SHARING.WITHOUT
        });

        assert.ok(rebuilt.includes('/* access note */'));
        assert.ok(rebuilt.includes('/* share note */'));
        assert.ok(rebuilt.includes('without /* share note */ sharing'));
        assertBodiesPreserved(source, rebuilt, parsed);
        assertMethodSlicesPreserved(source, rebuilt, parsed);
    });

    await runTest('reconstruction preserves comment between sharing and class keyword', () => {
        const source = `public with sharing /* before class */ class Example {
}`;
        const parsed = parseApexClassSource(source);
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.GLOBAL,
            sharing: OUTER_SHARING.INHERITED
        });

        assert.ok(rebuilt.includes('/* before class */'));
        assert.ok(rebuilt.includes('inherited sharing'));
        assert.strictEqual(
            parseApexClassSource(rebuilt).outerDeclaration.access,
            OUTER_ACCESS.GLOBAL
        );
        assertBodiesPreserved(source, rebuilt, parsed);
    });

    await runTest('reconstruction preserves multiline and file banner comments', () => {
        const source = `// banner
/* block */
public
\t/* mid */ with
 sharing
 class Example {
    Integer v = 1;
}`;
        const parsed = parseApexClassSource(source);
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.PUBLIC,
            sharing: OUTER_SHARING.OMITTED
        });

        assert.ok(rebuilt.startsWith('// banner'));
        assert.ok(rebuilt.includes('/* block */'));
        assert.ok(rebuilt.includes('/* mid */'));
        assert.ok(!rebuilt.includes('with sharing'));
        assertBodiesPreserved(source, rebuilt, parsed);
    });

    await runTest('reconstruction inserts sharing without destroying interstitial comments', () => {
        const source = `public /* keep */ class Example {
}`;
        const parsed = parseApexClassSource(source);
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.PUBLIC,
            sharing: OUTER_SHARING.WITH
        });

        assert.ok(rebuilt.includes('/* keep */'));
        assert.ok(rebuilt.includes('with sharing'));
        assert.strictEqual(
            parseApexClassSource(rebuilt).outerDeclaration.sharing,
            OUTER_SHARING.WITH
        );
        assertBodiesPreserved(source, rebuilt, parsed);
    });

    await runTest('parser tokens ignore annotation argument access keywords', () => {
        const cases = [
            {
                source: "@CustomAnnotation(label='global')\npublic with sharing class Example {\n}",
                access: OUTER_ACCESS.PUBLIC,
                sharing: OUTER_SHARING.WITH
            },
            {
                source: "@CustomAnnotation(label='public')\nglobal with sharing class Example {\n}",
                access: OUTER_ACCESS.GLOBAL,
                sharing: OUTER_SHARING.WITH
            },
            {
                source:
                    '/*\n * Previously public and global.\n */\npublic without sharing class Example {\n}',
                access: OUTER_ACCESS.PUBLIC,
                sharing: OUTER_SHARING.WITHOUT
            }
        ];

        for (const item of cases) {
            const parsed = parseApexClassSource(item.source);
            assert.strictEqual(parsed.outerDeclaration.access, item.access, item.source);
            assert.strictEqual(parsed.outerDeclaration.sharing, item.sharing, item.source);
            assert.strictEqual(
                item.source.slice(
                    parsed.outerDeclaration.accessSourceRange.start,
                    parsed.outerDeclaration.accessSourceRange.end
                ),
                item.access
            );
        }
    });

    await runTest('reconstruction preserves comment inside sharing phrase', () => {
        const source = 'public with /* security note */ sharing class Example {\n}';
        const parsed = parseApexClassSource(source);
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.PUBLIC,
            sharing: OUTER_SHARING.WITHOUT
        });

        assert.ok(rebuilt.includes('/* security note */'));
        assert.ok(rebuilt.includes('without /* security note */ sharing'));
        assert.strictEqual(
            parseApexClassSource(rebuilt).outerDeclaration.sharing,
            OUTER_SHARING.WITHOUT
        );
        assertBodiesPreserved(source, rebuilt, parsed);
    });

    await runTest('reconstruction replaces only sharing qualifier with line comment between tokens', () => {
        const source = 'public without // security note\nsharing class Example {\n}';
        const parsed = parseApexClassSource(source);
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.PUBLIC,
            sharing: OUTER_SHARING.WITH
        });

        assert.ok(rebuilt.includes('// security note'));
        assert.ok(rebuilt.includes('with // security note'));
        assert.ok(rebuilt.includes('sharing class Example'));
        parseApexClassSource(rebuilt);
        assertBodiesPreserved(source, rebuilt, parsed);
    });

    function normalizeStructuralText(text) {
        return String(text || '').replace(/\r\n/g, '\n').replace(/\s+/g, ' ').trim();
    }

    await runTest('nonMergeableHeaderText excludes access and sharing token spans', () => {
        const variants = [
            'public with sharing class Example { }',
            'public without sharing class Example { }',
            'global inherited sharing class Example { }',
            'with sharing class Example { }',
            'without sharing class Example { }',
            'inherited sharing class Example { }',
            'public class Example { }',
            'class Example { }'
        ];

        const fingerprints = variants.map((source) =>
            normalizeStructuralText(parseApexClassSource(source).outerDeclaration.nonMergeableHeaderText)
        );

        for (const fingerprint of fingerprints) {
            assert.strictEqual(fingerprint, 'class Example');
        }
    });

    await runTest('nonMergeableHeaderText keeps annotations and inheritance clauses', () => {
        const base = `@IsTest
public with sharing class Example extends BaseHandler implements IWorker {
}`;
        const sharingOnly = `@IsTest
without sharing class Example extends BaseHandler implements IWorker {
}`;
        const accessOnly = `@IsTest
global class Example extends BaseHandler implements IWorker {
}`;

        const baseOuter = parseApexClassSource(base).outerDeclaration;
        const sharingOuter = parseApexClassSource(sharingOnly).outerDeclaration;
        const accessOuter = parseApexClassSource(accessOnly).outerDeclaration;

        assert.ok(baseOuter.nonMergeableHeaderText.includes('@IsTest'));
        assert.ok(baseOuter.nonMergeableHeaderText.includes('extends BaseHandler'));
        assert.ok(baseOuter.nonMergeableHeaderText.includes('implements IWorker'));
        assert.ok(!/\bwith\b/.test(baseOuter.nonMergeableHeaderText));
        assert.ok(!/\bpublic\b/.test(baseOuter.nonMergeableHeaderText));

        assert.strictEqual(
            normalizeStructuralText(sharingOuter.nonMergeableHeaderText),
            normalizeStructuralText(baseOuter.nonMergeableHeaderText)
        );
        assert.strictEqual(
            normalizeStructuralText(accessOuter.nonMergeableHeaderText),
            normalizeStructuralText(baseOuter.nonMergeableHeaderText)
        );
    });

    await runTest('nonMergeableHeaderText preserves comments between mergeable modifiers', () => {
        const source =
            'public with /* keep */ sharing class Example {\n}';
        const outer = parseApexClassSource(source).outerDeclaration;

        assert.ok(outer.nonMergeableHeaderText.includes('/* keep */'));
        assert.ok(!outer.nonMergeableHeaderText.includes('with'));
        assert.ok(!outer.nonMergeableHeaderText.includes('public'));
    });

    await runTest('nonMergeableHeaderText differs when extends clause changes', () => {
        const left = 'public class Example extends One { }';
        const right = 'public class Example extends Two { }';

        const leftFingerprint = normalizeStructuralText(
            parseApexClassSource(left).outerDeclaration.nonMergeableHeaderText
        );
        const rightFingerprint = normalizeStructuralText(
            parseApexClassSource(right).outerDeclaration.nonMergeableHeaderText
        );

        assert.notStrictEqual(leftFingerprint, rightFingerprint);
    });

    const SHARING_BY_KEY = Object.freeze({
        omitted: OUTER_SHARING.OMITTED,
        with: OUTER_SHARING.WITH,
        without: OUTER_SHARING.WITHOUT,
        inherited: OUTER_SHARING.INHERITED
    });

    const ACCESS_BY_KEY = Object.freeze({
        unspecified: OUTER_ACCESS.UNSPECIFIED,
        public: OUTER_ACCESS.PUBLIC,
        global: OUTER_ACCESS.GLOBAL
    });

    const SHARING_PREFIX = Object.freeze({
        omitted: '',
        with: 'with sharing ',
        without: 'without sharing ',
        inherited: 'inherited sharing '
    });

    function classShellWithAccessAndSharing(accessKey, sharingKey) {
        const accessValue = ACCESS_BY_KEY[accessKey];
        const sharingPrefix = SHARING_PREFIX[sharingKey];
        const accessPrefix =
            accessValue === OUTER_ACCESS.UNSPECIFIED ? '' : `${accessValue} `;

        return `${accessPrefix}${sharingPrefix}class Example {
    public static void run() {}
    private class Helper {
        public Integer value;
    }
}`;
    }

    function assertAccessSharingReconstruction(source, selection, expectedAccess, expectedSharing) {
        const parsed = parseApexClassSource(source);
        const rebuilt = reconstructOuterClassDeclaration(source, selection);
        const rebuiltParsed = parseApexClassSource(rebuilt);

        assert.strictEqual(rebuiltParsed.outerDeclaration.access, expectedAccess);
        assert.strictEqual(rebuiltParsed.outerDeclaration.sharing, expectedSharing);
        assertBodiesPreserved(source, rebuilt, parsed);
        assertNestedClassDeclarationsPreserved(source, rebuilt);
    }

    await runTest('reconstructOuterClassDeclaration supports all mergeable access transitions', () => {
        const sharingKeys = ['omitted', 'with', 'without', 'inherited'];
        const accessKeys = ['unspecified', 'public', 'global'];

        for (const sharingKey of sharingKeys) {
            const sharingValue = SHARING_BY_KEY[sharingKey];

            for (const fromKey of accessKeys) {
                for (const toKey of accessKeys) {
                    const source = classShellWithAccessAndSharing(fromKey, sharingKey);
                    const selection = {
                        access: ACCESS_BY_KEY[toKey],
                        sharing: sharingValue
                    };

                    assertAccessSharingReconstruction(
                        source,
                        selection,
                        ACCESS_BY_KEY[toKey],
                        sharingValue
                    );
                }
            }
        }
    });

    await runTest('reconstructOuterClassDeclaration preserves sharing across access transitions', () => {
        const cases = [
            {
                source: '@IsTest\nwith sharing class Example {\n}',
                access: OUTER_ACCESS.PUBLIC,
                sharing: OUTER_SHARING.WITH
            },
            {
                source: '@IsTest\nclass Example {\n}',
                access: OUTER_ACCESS.GLOBAL,
                sharing: OUTER_SHARING.OMITTED
            },
            {
                source: '/** banner */\npublic /* trailing */ class Example {\n}',
                access: OUTER_ACCESS.UNSPECIFIED,
                sharing: OUTER_SHARING.OMITTED
            }
        ];

        for (const item of cases) {
            const parsed = parseApexClassSource(item.source);
            const rebuilt = reconstructOuterClassDeclaration(item.source, {
                access: item.access,
                sharing: item.sharing
            });

            assert.ok(rebuilt.includes('@IsTest') || rebuilt.includes('/** banner */'));
            assert.strictEqual(
                parseApexClassSource(rebuilt).outerDeclaration.access,
                item.access
            );
            assert.strictEqual(
                parseApexClassSource(rebuilt).outerDeclaration.sharing,
                item.sharing
            );
            assertBodiesPreserved(item.source, rebuilt, parsed);
        }
    });

    await runTest('reconstructOuterClassDeclaration adds sharing without changing access token span', () => {
        const source = 'public class Example {\n}';
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.PUBLIC,
            sharing: OUTER_SHARING.WITHOUT
        });

        assert.ok(rebuilt.startsWith('public without sharing class Example'));
        assert.strictEqual(
            parseApexClassSource(rebuilt).outerDeclaration.sharing,
            OUTER_SHARING.WITHOUT
        );
    });

    await runTest('reconstructOuterClassDeclaration adds access and sharing together when both omitted', () => {
        const source = 'class Example {\n}';
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.PUBLIC,
            sharing: OUTER_SHARING.INHERITED
        });

        assert.ok(rebuilt.startsWith('public inherited sharing class Example'));
        assert.strictEqual(
            parseApexClassSource(rebuilt).outerDeclaration.access,
            OUTER_ACCESS.PUBLIC
        );
        assert.strictEqual(
            parseApexClassSource(rebuilt).outerDeclaration.sharing,
            OUTER_SHARING.INHERITED
        );
    });

    await runTest('annotated RestResource class preserves annotation on reconstruction', () => {
        const source = `@RestResource(urlMapping='/example/*')
global with sharing class Example {
    @HttpGet
    global static String run() {
        return 'ok';
    }
}`;
        const parsed = parseApexClassSource(source);
        const rebuilt = reconstructOuterClassDeclaration(source, {
            access: OUTER_ACCESS.GLOBAL,
            sharing: OUTER_SHARING.WITHOUT
        });

        assert.ok(rebuilt.includes("@RestResource(urlMapping='/example/*')"));
        assert.ok(rebuilt.includes('@HttpGet'));
        assertBodiesPreserved(source, rebuilt, parsed);
        assertMethodSlicesPreserved(source, rebuilt, parsed);
    });

    console.log('All apexClassParser tests passed.');
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});