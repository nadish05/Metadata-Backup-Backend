const assert = require('assert');

const flexiPageReferenceDiscoverer = require('./flexiPageReference.discoverer');

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

const MEMBER_RECORD_PAGE_PATH =
    'force-app/main/default/flexipages/Member_Record_Page.flexipage-meta.xml';
const SUBSCRIPTION_MEMBER_FIELD_PATH =
    'force-app/main/default/objects/Subscription__c/fields/Member__c.field-meta.xml';

const MEMBER_RECORD_PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Member__c</sobjectType>
    <masterLabel>Member Record Page</masterLabel>
    <type>RecordPage</type>
    <flexiPageRegions>
        <itemInstances>
            <componentInstance>
                <componentInstanceProperties>
                    <name>relatedListApiName</name>
                    <value>Subscriptions__r</value>
                </componentInstanceProperties>
                <componentName>lst:dynamicRelatedList</componentName>
            </componentInstance>
        </itemInstances>
    </flexiPageRegions>
</FlexiPage>`;

const SUBSCRIPTION_MEMBER_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Member__c</fullName>
    <type>Lookup</type>
    <referenceTo>Member__c</referenceTo>
    <relationshipName>Subscriptions</relationshipName>
</CustomField>`;

async function main() {
    await runTest(
        'primary FlexiPage discovers FlexiPageDynamicRelatedList with parent and defining field',
        async () => {
            const repoFiles = [
                MEMBER_RECORD_PAGE_PATH,
                SUBSCRIPTION_MEMBER_FIELD_PATH
            ];
            const fileContents = new Map([
                [MEMBER_RECORD_PAGE_PATH, MEMBER_RECORD_PAGE_XML],
                [SUBSCRIPTION_MEMBER_FIELD_PATH, SUBSCRIPTION_MEMBER_FIELD_XML]
            ]);

            const result = await flexiPageReferenceDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Member_Record_Page',
                        filePath: MEMBER_RECORD_PAGE_PATH
                    }
                ],
                repoFiles,
                readRepoFile: async (targetPath) => fileContents.get(targetPath),
                depth: 1
            });

            const dynamicRefs = (result.references || []).filter(
                (ref) => ref.referenceType === 'FlexiPageDynamicRelatedList'
            );

            assert.strictEqual(dynamicRefs.length, 1);
            assert.strictEqual(dynamicRefs[0].name, 'Subscriptions__r');
            assert.strictEqual(dynamicRefs[0].sobjectType, 'Member__c');
            assert.strictEqual(
                dynamicRefs[0].relationshipDefiningFieldQualifiedName,
                'Subscription__c.Member__c'
            );
            assert.strictEqual(dynamicRefs[0].deployable, false);
            assert.strictEqual(dynamicRefs[0].blocking, false);
        }
    );

    await runTest(
        'lst:dynamicRelatedList is not duplicated as legacy RelatedList reference',
        async () => {
            const result = await flexiPageReferenceDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Member_Record_Page',
                        filePath: MEMBER_RECORD_PAGE_PATH
                    }
                ],
                repoFiles: [MEMBER_RECORD_PAGE_PATH],
                readRepoFile: async () => MEMBER_RECORD_PAGE_XML,
                depth: 1
            });

            const legacyRelatedListRefs = (result.references || []).filter(
                (ref) =>
                    ref.metadataType === 'RelatedList' &&
                    ref.referenceType === 'RelatedList'
            );

            assert.strictEqual(legacyRelatedListRefs.length, 0);
        }
    );

    if (process.exitCode) {
        process.exit(process.exitCode);
    }
}

main();
