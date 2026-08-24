'use strict';

const assert = require('assert');

const {
    packMemberFiles,
    unpackMemberFiles
} = require('./destinationMemberArtifact.service');

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

runTest('preserves exact CRLF and LF bytes', () => {
    const crlf = Buffer.from('line1\r\nline2\r\n', 'utf8');
    const lf = Buffer.from('line1\nline2\n', 'utf8');

    const packedCrlf = packMemberFiles([
        { relativePath: 'classes/AccountService.cls', bytes: crlf }
    ]);
    const packedLf = packMemberFiles([
        { relativePath: 'classes/AccountService.cls', bytes: lf }
    ]);

    assert.ok(!packedCrlf.equals(packedLf));
    assert.deepStrictEqual(unpackMemberFiles(packedCrlf)[0].bytes, crlf);
    assert.deepStrictEqual(unpackMemberFiles(packedLf)[0].bytes, lf);
});

runTest('packs LightningComponentBundle files in deterministic order', () => {
    const js = Buffer.from('export default class WeatherApp {}', 'utf8');
    const html = Buffer.from('<template></template>', 'utf8');
    const xml = Buffer.from('<LightningComponentBundle/>', 'utf8');

    const reversed = packMemberFiles([
        { relativePath: 'lwc/weatherApp/weatherApp.js', bytes: js },
        { relativePath: 'lwc/weatherApp/weatherApp.js-meta.xml', bytes: xml },
        { relativePath: 'lwc/weatherApp/weatherApp.html', bytes: html }
    ]);
    const sorted = packMemberFiles([
        { relativePath: 'lwc/weatherApp/weatherApp.html', bytes: html },
        { relativePath: 'lwc/weatherApp/weatherApp.js', bytes: js },
        { relativePath: 'lwc/weatherApp/weatherApp.js-meta.xml', bytes: xml }
    ]);

    assert.ok(reversed.equals(sorted));

    const unpacked = unpackMemberFiles(reversed).map((file) => file.relativePath);

    assert.deepStrictEqual(unpacked, [
        'lwc/weatherApp/weatherApp.html',
        'lwc/weatherApp/weatherApp.js',
        'lwc/weatherApp/weatherApp.js-meta.xml'
    ]);
    assert.deepStrictEqual(unpackMemberFiles(reversed)[1].bytes, js);
});

runTest('does not rewrite XML or trim whitespace', () => {
    const xml = Buffer.from(
        '<ApexClass xmlns="http://soap.sforce.com/2006/04/metadata">\r\n  <apiVersion>62.0</apiVersion>\r\n</ApexClass>  ',
        'utf8'
    );
    const packed = packMemberFiles([
        { relativePath: 'classes/AccountService.cls-meta.xml', bytes: xml }
    ]);

    assert.deepStrictEqual(unpackMemberFiles(packed)[0].bytes, xml);
});
