'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    collectExpectedAfterArtifact
} = require('./expectedAfterArtifact.service');
const { packMemberFiles } = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

(async () => {
    await runTest('hashes ApexClass workspace files including companion meta.xml', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r51-after-cls-'));
        const clsRel = 'force-app/main/default/classes/AccountService.cls';
        const metaRel = `${clsRel}-meta.xml`;
        const clsBytes = Buffer.from('public class AccountService {\r\n}\n');
        const metaBytes = Buffer.from('<ApexClass/>\n');

        await fs.promises.mkdir(path.dirname(path.join(root, clsRel)), {
            recursive: true
        });
        await fs.promises.writeFile(path.join(root, clsRel), clsBytes);
        await fs.promises.writeFile(path.join(root, metaRel), metaBytes);

        const result = await collectExpectedAfterArtifact({
            workspacePath: root,
            member: {
                metadataType: 'ApexClass',
                metadataName: 'AccountService',
                filePath: clsRel
            }
        });

        const expected = packMemberFiles([
            { relativePath: clsRel, bytes: clsBytes },
            { relativePath: metaRel, bytes: metaBytes }
        ]);

        assert.ok(result.artifactBytes.equals(expected));
        assert.strictEqual(result.expectedAfterHash, hashBytes(expected));
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('LWC expected-after uses SNAPMEM1 of all bundle files', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r51-after-lwc-'));
        const bundle = 'force-app/main/default/lwc/weatherApp';
        const html = Buffer.from('<template></template>');
        const js = Buffer.from('export default class WeatherApp {}');
        const xml = Buffer.from('<LightningComponentBundle/>');

        await fs.promises.mkdir(path.join(root, bundle), { recursive: true });
        await fs.promises.writeFile(
            path.join(root, bundle, 'weatherApp.js'),
            js
        );
        await fs.promises.writeFile(
            path.join(root, bundle, 'weatherApp.html'),
            html
        );
        await fs.promises.writeFile(
            path.join(root, bundle, 'weatherApp.js-meta.xml'),
            xml
        );

        const reversedLayout = packMemberFiles([
            { relativePath: `${bundle}/weatherApp.js`, bytes: js },
            { relativePath: `${bundle}/weatherApp.js-meta.xml`, bytes: xml },
            { relativePath: `${bundle}/weatherApp.html`, bytes: html }
        ]);

        const result = await collectExpectedAfterArtifact({
            workspacePath: root,
            member: {
                metadataType: 'LightningComponentBundle',
                metadataName: 'weatherApp',
                filePath: bundle
            }
        });

        assert.ok(result.artifactBytes.equals(reversedLayout));
        await fs.promises.rm(root, { recursive: true, force: true });
    });

    await runTest('preserves CRLF in expected-after workspace bytes', async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p0r51-after-crlf-'));
        const rel = 'force-app/main/default/classes/AccountService.cls';
        const crlf = Buffer.from('line1\r\nline2\r\n');

        await fs.promises.mkdir(path.dirname(path.join(root, rel)), {
            recursive: true
        });
        await fs.promises.writeFile(path.join(root, rel), crlf);

        const result = await collectExpectedAfterArtifact({
            workspacePath: root,
            member: {
                metadataType: 'ApexClass',
                metadataName: 'AccountService',
                filePath: rel
            }
        });

        assert.ok(result.files[0].bytes.equals(crlf));
        await fs.promises.rm(root, { recursive: true, force: true });
    });
})();
