const assert = require('assert');

const {
    METADATA_KINDS,
    getMetadataTypeRule
} = require('../../config/metadataTypes');
const {
    getArtifactResolver
} = require('./artifactResolverRegistry');
const {
    enrichNode
} = require('./artifactResolution.service');

const CUSTOM_TAB_PATH =
    'force-app/main/default/tabs/Gym_Trainer__c.tab-meta.xml';

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

function assertResolved(metadataType, name, expectedPath, repoFiles) {
    const enriched = enrichNode(
        {
            metadataType,
            name
        },
        repoFiles
    );

    assert.strictEqual(enriched.artifactResolved, true, metadataType);
    assert.strictEqual(enriched.sourceExists, true, metadataType);
    assert.strictEqual(enriched.filePath, expectedPath, metadataType);
}

async function main() {
    await runTest('CustomTab metadata rule uses tabs source format', () => {
        const rule = getMetadataTypeRule('CustomTab');

        assert.ok(rule);
        assert.strictEqual(rule.kind, METADATA_KINDS.FILE);
        assert.strictEqual(rule.folder, 'tabs');
        assert.strictEqual(rule.extension, '.tab-meta.xml');
        assert.strictEqual(rule.requiresMetaXml, false);
        assert.strictEqual(
            getArtifactResolver('CustomTab').id,
            'GenericFileArtifactResolver'
        );
    });

    await runTest('CustomTab resolves its source file from the tabs folder', () => {
        const wrongFolderPath =
            'force-app/main/default/other/Gym_Trainer__c.tab-meta.xml';
        const enriched = enrichNode(
            {
                metadataType: 'CustomTab',
                name: 'Gym_Trainer__c'
            },
            [wrongFolderPath, CUSTOM_TAB_PATH]
        );

        assert.strictEqual(enriched.artifactResolved, true);
        assert.strictEqual(enriched.sourceExists, true);
        assert.strictEqual(enriched.filePath, CUSTOM_TAB_PATH);
    });

    await runTest('missing CustomTab remains unresolved', () => {
        const enriched = enrichNode(
            {
                metadataType: 'CustomTab',
                name: 'Missing_Tab'
            },
            [CUSTOM_TAB_PATH]
        );

        assert.strictEqual(enriched.artifactResolved, false);
        assert.strictEqual(enriched.sourceExists, false);
        assert.strictEqual(enriched.filePath, null);
    });

    await runTest('malformed CustomTab name is ignored', () => {
        const enriched = enrichNode(
            {
                metadataType: 'CustomTab',
                name: 'Bad Tab'
            },
            ['force-app/main/default/tabs/Bad Tab.tab-meta.xml']
        );

        assert.strictEqual(enriched.artifactResolved, false);
        assert.strictEqual(enriched.sourceExists, false);
        assert.strictEqual(enriched.filePath, null);
    });

    await runTest(
        'existing CustomObject, CustomField, PermissionSet, Flow and FlexiPage resolution is unchanged',
        () => {
            const paths = {
                CustomObject:
                    'force-app/main/default/objects/Gym_Trainer__c/Gym_Trainer__c.object-meta.xml',
                CustomField:
                    'force-app/main/default/objects/Gym_Trainer__c/fields/Name__c.field-meta.xml',
                PermissionSet:
                    'force-app/main/default/permissionsets/Subscription_Access.permissionset-meta.xml',
                Flow:
                    'force-app/main/default/flows/Approval_Required.flow-meta.xml',
                FlexiPage:
                    'force-app/main/default/flexipages/Trainer_Record_Page.flexipage-meta.xml'
            };
            const repoFiles = Object.values(paths);

            assertResolved(
                'CustomObject',
                'Gym_Trainer__c',
                paths.CustomObject,
                repoFiles
            );
            assertResolved(
                'CustomField',
                'Gym_Trainer__c.Name__c',
                paths.CustomField,
                repoFiles
            );
            assertResolved(
                'PermissionSet',
                'Subscription_Access',
                paths.PermissionSet,
                repoFiles
            );
            assertResolved(
                'Flow',
                'Approval_Required',
                paths.Flow,
                repoFiles
            );
            assertResolved(
                'FlexiPage',
                'Trainer_Record_Page',
                paths.FlexiPage,
                repoFiles
            );
        }
    );
}

main();
