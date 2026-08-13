const assert = require('assert');

const recordTypeCompactLayoutDiscoverer = require('./recordTypeCompactLayout.discoverer');
const {
    classifyDependency
} = require('../dependencyClassification.service');
const {
    createDefaultDecision,
    ACTIONS
} = require('../dependencyResolution.service');
const {
    generateDeploymentPackage
} = require('../../deploymentPackage.service');
const { generateManifest } = require('../../packageXml.service');
const {
    enrichNode
} = require('../../repositoryArtifacts/artifactResolution.service');
const {
    CLASSIFICATIONS
} = require('../dependencyClassification.model');
const {
    getRegisteredDiscoverers
} = require('../relationshipRegistry');

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

const NEW_BUSINESS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>New_Business</fullName>
    <active>true</active>
    <compactLayout>Opportunity_Highlights</compactLayout>
    <label>New Business</label>
</RecordType>`;

const RENEWAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Renewal</fullName>
    <active>true</active>
    <compactLayout>Opportunity_Highlights</compactLayout>
    <label>Renewal</label>
</RecordType>`;

const ACCOUNT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Business</fullName>
    <active>true</active>
    <compactLayout>Account_Highlights</compactLayout>
    <label>Business</label>
</RecordType>`;

const INVOICE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Standard</fullName>
    <active>true</active>
    <compactLayout>Invoice_Compact</compactLayout>
    <label>Standard</label>
</RecordType>`;

const NO_LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Standard</fullName>
    <active>true</active>
    <label>Standard</label>
</RecordType>`;

const EMPTY_LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Empty</fullName>
    <active>true</active>
    <compactLayout></compactLayout>
    <label>Empty</label>
</RecordType>`;

const WHITESPACE_LAYOUT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Spaced</fullName>
    <active>true</active>
    <compactLayout>  Opportunity_Highlights  </compactLayout>
    <label>Spaced</label>
</RecordType>`;

const REPO_FILES = [
    'force-app/main/default/objects/Opportunity/recordTypes/New_Business.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/recordTypes/Renewal.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/recordTypes/Standard.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/recordTypes/Empty.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/recordTypes/Spaced.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/compactLayouts/Opportunity_Highlights.compactLayout-meta.xml',
    'force-app/main/default/objects/Account/recordTypes/Business.recordType-meta.xml',
    'force-app/main/default/objects/Account/compactLayouts/Account_Highlights.compactLayout-meta.xml',
    'force-app/main/default/objects/Invoice__c/recordTypes/Standard.recordType-meta.xml',
    'force-app/main/default/objects/Invoice__c/compactLayouts/Invoice_Compact.compactLayout-meta.xml'
];

const XML_BY_PATH = {
    'force-app/main/default/objects/Opportunity/recordTypes/New_Business.recordType-meta.xml':
        NEW_BUSINESS_XML,
    'force-app/main/default/objects/Opportunity/recordTypes/Renewal.recordType-meta.xml':
        RENEWAL_XML,
    'force-app/main/default/objects/Opportunity/recordTypes/Standard.recordType-meta.xml':
        NO_LAYOUT_XML,
    'force-app/main/default/objects/Opportunity/recordTypes/Empty.recordType-meta.xml':
        EMPTY_LAYOUT_XML,
    'force-app/main/default/objects/Opportunity/recordTypes/Spaced.recordType-meta.xml':
        WHITESPACE_LAYOUT_XML,
    'force-app/main/default/objects/Account/recordTypes/Business.recordType-meta.xml':
        ACCOUNT_XML,
    'force-app/main/default/objects/Invoice__c/recordTypes/Standard.recordType-meta.xml':
        INVOICE_XML
};

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');
    const xml = XML_BY_PATH[normalized];

    if (!xml) {
        throw new Error(`Unexpected file read: ${filePath}`);
    }

    return xml;
}

function packageHasMember(pkg, type, name) {
    return (pkg.metadata || []).some(
        (item) =>
            item.metadataType === type && item.metadataName === name
    );
}

async function discoverRecordType(metadataName) {
    return recordTypeCompactLayoutDiscoverer.discover({
        selectedMetadata: [
            {
                metadataType: 'RecordType',
                metadataName
            }
        ],
        repoFiles: REPO_FILES,
        readRepoFile
    });
}

async function main() {
    await runTest(
        'TEST 1: Opportunity.New_Business compactLayout → CompactLayout:Opportunity.Opportunity_Highlights',
        async () => {
            const result = await discoverRecordType('Opportunity.New_Business');

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(
                result.relationships[0].metadataType,
                'CompactLayout'
            );
            assert.strictEqual(result.relationships[0].type, 'CompactLayout');
            assert.strictEqual(
                result.relationships[0].name,
                'Opportunity.Opportunity_Highlights'
            );
            assert.strictEqual(
                result.relationships[0].relationship,
                'RecordTypeCompactLayout'
            );
            assert.strictEqual(
                result.relationships[0].sourceMetadata,
                'Opportunity.New_Business'
            );
            assert.strictEqual(
                result.relationships[0].sourceField,
                'compactLayout'
            );
            assert.strictEqual(result.relationships[0].required, true);
            assert.strictEqual(result.relationships[0].selected, true);
            assert.strictEqual(
                result.relationships[0].discoveredBy,
                'RecordTypeCompactLayoutDiscoverer'
            );
        }
    );

    await runTest(
        'TEST 2: Opportunity.Renewal compactLayout → CompactLayout:Opportunity.Opportunity_Highlights',
        async () => {
            const result = await discoverRecordType('Opportunity.Renewal');

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(
                result.relationships[0].name,
                'Opportunity.Opportunity_Highlights'
            );
            assert.strictEqual(
                result.relationships[0].sourceMetadata,
                'Opportunity.Renewal'
            );
        }
    );

    await runTest(
        'TEST 3: Account.Business compactLayout → CompactLayout:Account.Account_Highlights',
        async () => {
            const result = await discoverRecordType('Account.Business');

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(
                result.relationships[0].name,
                'Account.Account_Highlights'
            );
            assert.ok(
                !result.relationships.some((item) =>
                    String(item.name).includes('Opportunity')
                )
            );
        }
    );

    await runTest(
        'TEST 4: Invoice__c.Standard compactLayout → CompactLayout:Invoice__c.Invoice_Compact',
        async () => {
            const result = await discoverRecordType('Invoice__c.Standard');

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(
                result.relationships[0].name,
                'Invoice__c.Invoice_Compact'
            );
        }
    );

    await runTest(
        'TEST 5: RecordType without compactLayout emits no CompactLayout',
        async () => {
            const result = await discoverRecordType('Opportunity.Standard');

            assert.deepStrictEqual(result.relationships, []);
        }
    );

    await runTest(
        'TEST 6: empty compactLayout emits no CompactLayout',
        async () => {
            const result = await discoverRecordType('Opportunity.Empty');

            assert.deepStrictEqual(result.relationships, []);
        }
    );

    await runTest(
        'TEST 7: whitespace around compactLayout value is trimmed',
        async () => {
            const result = await discoverRecordType('Opportunity.Spaced');

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(
                result.relationships[0].name,
                'Opportunity.Opportunity_Highlights'
            );
        }
    );

    await runTest(
        'TEST 8: CompactLayout classifies as deployable metadata',
        () => {
            const result = classifyDependency({
                type: 'CompactLayout',
                name: 'Opportunity.Opportunity_Highlights'
            });

            assert.strictEqual(
                result.classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA
            );
            assert.strictEqual(result.packageable, true);
            assert.strictEqual(result.artifactRequired, true);
            assert.strictEqual(result.defaultResolutionPolicy, ACTIONS.DEPLOY);
        }
    );

    await runTest(
        'TEST 9: default decision is DEPLOY with selected true and UNKNOWN destination',
        () => {
            const decision = createDefaultDecision({
                name: 'Opportunity.Opportunity_Highlights',
                type: 'CompactLayout',
                required: true,
                selected: true
            });

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.selected, true);
            assert.strictEqual(decision.required, true);
            assert.strictEqual(decision.destinationState, 'UNKNOWN');
        }
    );

    await runTest(
        'TEST 10: CompactLayout artifact resolves under compactLayouts/',
        () => {
            const enriched = enrichNode(
                {
                    metadataType: 'CompactLayout',
                    name: 'Opportunity.Opportunity_Highlights'
                },
                REPO_FILES
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(enriched.sourceExists, true);
            assert.strictEqual(
                enriched.filePath,
                'force-app/main/default/objects/Opportunity/compactLayouts/Opportunity_Highlights.compactLayout-meta.xml'
            );
        }
    );

    await runTest(
        'TEST 11: DEPLOY + selected CompactLayout reaches package.xml',
        () => {
            const decision = createDefaultDecision({
                name: 'Opportunity.Opportunity_Highlights',
                type: 'CompactLayout',
                required: true,
                selected: true
            });

            const pkg = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.New_Business'
                    }
                ],
                requiredDependencies: [decision],
                selectedTestClasses: []
            });

            assert.ok(
                packageHasMember(
                    pkg,
                    'CompactLayout',
                    'Opportunity.Opportunity_Highlights'
                )
            );

            const manifest = generateManifest(pkg);
            assert.match(
                manifest.packageXml,
                /<name>CompactLayout<\/name>/
            );
            assert.match(
                manifest.packageXml,
                /<members>Opportunity\.Opportunity_Highlights<\/members>/
            );
        }
    );

    await runTest(
        'TEST 12: REFERENCE / SKIP / BLOCK CompactLayout is not force-added',
        () => {
            for (const action of ['REFERENCE', 'SKIP', 'BLOCK']) {
                const pkg = generateDeploymentPackage({
                    selectedMetadata: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Opportunity.New_Business'
                        }
                    ],
                    requiredDependencies: [
                        {
                            name: 'Opportunity.Opportunity_Highlights',
                            type: 'CompactLayout',
                            action,
                            selected: action === 'SKIP' ? false : true,
                            required: true
                        }
                    ],
                    selectedTestClasses: []
                });

                assert.strictEqual(
                    packageHasMember(
                        pkg,
                        'CompactLayout',
                        'Opportunity.Opportunity_Highlights'
                    ),
                    false,
                    `${action} must not force CompactLayout into package`
                );
            }
        }
    );

    await runTest(
        'duplicate CompactLayout references from two RecordTypes emit once',
        async () => {
            const result = await recordTypeCompactLayoutDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.New_Business'
                    },
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Renewal'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(
                result.relationships[0].name,
                'Opportunity.Opportunity_Highlights'
            );
        }
    );

    await runTest(
        'registry includes RecordTypeCompactLayoutDiscoverer',
        () => {
            const ids = getRegisteredDiscoverers().map(
                (discoverer) => discoverer.id
            );
            assert.ok(ids.includes('RecordTypeCompactLayoutDiscoverer'));
            assert.ok(ids.includes('RecordTypeBusinessProcessDiscoverer'));
        }
    );

    if (process.exitCode) {
        console.error('recordTypeCompactLayout.discoverer.test.js FAILED');
    } else {
        console.log('recordTypeCompactLayout.discoverer.test.js PASSED');
    }
}

main();
