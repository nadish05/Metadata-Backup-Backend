const assert = require('assert');

const flexiPageReferenceDiscoverer = require('./flexiPageReference.discoverer');

function runTest(name, fn) {
    return Promise.resolve()
        .then(() => fn())
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

const FLEXIPAGE_PATH =
    'force-app/main/default/flexipages/Session_Record_Page.flexipage-meta.xml';

function buildFlexiPageXml(componentName) {
    return `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <flexiPageRegions>
        <itemInstances>
            <componentInstance>
                <componentName>${componentName}</componentName>
            </componentInstance>
        </itemInstances>
        <name>main</name>
        <type>Region</type>
    </flexiPageRegions>
    <masterLabel>Session Record Page</masterLabel>
    <type>RecordPage</type>
</FlexiPage>`;
}

async function main() {
    await runTest(
        'lst:dynamicRelatedList is managed platform — not LightningComponentBundle',
        async () => {
            const result = await flexiPageReferenceDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Session_Record_Page',
                        filePath: FLEXIPAGE_PATH
                    }
                ],
                repoFiles: [FLEXIPAGE_PATH],
                readRepoFile: async () =>
                    buildFlexiPageXml('lst:dynamicRelatedList'),
                depth: 1
            });

            const lwcRefs = (result.references || []).filter(
                (ref) =>
                    ref.metadataType === 'LightningComponentBundle' &&
                    ref.name === 'dynamicRelatedList'
            );

            assert.strictEqual(
                lwcRefs.length,
                0,
                'lst:dynamicRelatedList must not become deployable LightningComponentBundle'
            );
        }
    );

    await runTest(
        'c:myComponent remains deployable LightningComponentBundle',
        async () => {
            const result = await flexiPageReferenceDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Session_Record_Page',
                        filePath: FLEXIPAGE_PATH
                    }
                ],
                repoFiles: [FLEXIPAGE_PATH],
                readRepoFile: async () => buildFlexiPageXml('c:myComponent'),
                depth: 1
            });

            const lwcRefs = (result.references || []).filter(
                (ref) =>
                    ref.metadataType === 'LightningComponentBundle' &&
                    ref.name === 'myComponent' &&
                    ref.deployable === true
            );

            assert.strictEqual(
                lwcRefs.length,
                1,
                'c:myComponent must remain a deployable LightningComponentBundle'
            );
        }
    );

    await runTest(
        'lightning: standard components remain skipped (unchanged)',
        async () => {
            const result = await flexiPageReferenceDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Session_Record_Page',
                        filePath: FLEXIPAGE_PATH
                    }
                ],
                repoFiles: [FLEXIPAGE_PATH],
                readRepoFile: async () =>
                    buildFlexiPageXml('lightning:button'),
                depth: 1
            });

            const lwcRefs = (result.references || []).filter(
                (ref) => ref.metadataType === 'LightningComponentBundle'
            );

            assert.strictEqual(lwcRefs.length, 0);
        }
    );

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

main();
