const assert = require('assert');

const standardValueSetDiscoverer = require('./standardValueSet.discoverer');
const {
    resolveRecordTypePicklistStandardValueSet,
    resolveBusinessProcessStandardValueSet
} = require('../../../config/standardValueSetRelationships');
const {
    discoverUntilStable
} = require('../relationshipDiscovery.service');
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

const ACCOUNT_RECORD_TYPE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Customer</fullName>
    <active>true</active>
    <label>Customer</label>
    <picklistValues>
        <picklist>AccountSource</picklist>
        <values>
            <fullName>Ads</fullName>
            <default>false</default>
        </values>
    </picklistValues>
</RecordType>`;

const OPPORTUNITY_RECORD_TYPE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Enterprise</fullName>
    <active>true</active>
    <label>Enterprise</label>
    <picklistValues>
        <picklist>LeadSource</picklist>
        <values>
            <fullName>Partner Referral</fullName>
            <default>false</default>
        </values>
    </picklistValues>
</RecordType>`;

const SECOND_OPPORTUNITY_RECORD_TYPE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Renewal</fullName>
    <active>true</active>
    <label>Renewal</label>
    <picklistValues>
        <picklist>LeadSource</picklist>
        <values>
            <fullName>Partner Referral</fullName>
            <default>false</default>
        </values>
    </picklistValues>
</RecordType>`;

const CUSTOM_FIELD_PICKLIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Retail</fullName>
    <active>true</active>
    <label>Retail</label>
    <picklistValues>
        <picklist>Status__c</picklist>
        <values>
            <fullName>Open</fullName>
            <default>true</default>
        </values>
    </picklistValues>
</RecordType>`;

const OPPORTUNITY_BUSINESS_PROCESS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<BusinessProcess xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Standard Sales</fullName>
    <isActive>true</isActive>
    <values>
        <fullName>Renewal Review</fullName>
        <default>false</default>
    </values>
</BusinessProcess>`;

const REPO_FILES = [
    'force-app/main/default/objects/Account/recordTypes/Customer.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/recordTypes/Renewal.recordType-meta.xml',
    'force-app/main/default/objects/Invoice__c/recordTypes/Retail.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/businessProcesses/Standard Sales.businessProcess-meta.xml',
    'force-app/main/default/standardValueSets/AccountSource.standardValueSet-meta.xml',
    'force-app/main/default/standardValueSets/LeadSource.standardValueSet-meta.xml',
    'force-app/main/default/standardValueSets/OpportunityStage.standardValueSet-meta.xml'
];

const XML_BY_PATH = {
    'force-app/main/default/objects/Account/recordTypes/Customer.recordType-meta.xml':
        ACCOUNT_RECORD_TYPE_XML,
    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise.recordType-meta.xml':
        OPPORTUNITY_RECORD_TYPE_XML,
    'force-app/main/default/objects/Opportunity/recordTypes/Renewal.recordType-meta.xml':
        SECOND_OPPORTUNITY_RECORD_TYPE_XML,
    'force-app/main/default/objects/Invoice__c/recordTypes/Retail.recordType-meta.xml':
        CUSTOM_FIELD_PICKLIST_XML,
    'force-app/main/default/objects/Opportunity/businessProcesses/Standard Sales.businessProcess-meta.xml':
        OPPORTUNITY_BUSINESS_PROCESS_XML
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

function relationshipNames(result) {
    return (result.relationships || []).map((item) => item.name);
}

async function main() {
    await runTest(
        'A: RecordType picklist AccountSource → StandardValueSet:AccountSource',
        async () => {
            const result = await standardValueSetDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Account.Customer'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(
                result.relationships[0].metadataType,
                'StandardValueSet'
            );
            assert.strictEqual(result.relationships[0].type, 'StandardValueSet');
            assert.strictEqual(result.relationships[0].name, 'AccountSource');
            assert.strictEqual(
                result.relationships[0].relationship,
                'RecordTypeStandardValueSet'
            );
            assert.strictEqual(
                result.relationships[0].sourceMetadata,
                'Account.Customer'
            );
            assert.strictEqual(result.relationships[0].required, true);
            assert.strictEqual(result.relationships[0].selected, true);
            assert.ok(
                !result.relationships.some(
                    (item) => item.metadataType === 'CustomObject'
                )
            );
            assert.ok(
                !result.relationships.some(
                    (item) => item.metadataType === 'CustomField'
                )
            );
        }
    );

    await runTest(
        'B: RecordType picklist LeadSource → StandardValueSet:LeadSource',
        async () => {
            const result = await standardValueSetDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(result.relationships[0].name, 'LeadSource');
            assert.strictEqual(
                result.relationships[0].metadataType,
                'StandardValueSet'
            );
        }
    );

    await runTest(
        'C: Opportunity BusinessProcess → StandardValueSet:OpportunityStage',
        async () => {
            const result = await standardValueSetDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'BusinessProcess',
                        metadataName: 'Opportunity.Standard Sales'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(
                result.relationships[0].name,
                'OpportunityStage'
            );
            assert.strictEqual(
                result.relationships[0].metadataType,
                'StandardValueSet'
            );
            assert.strictEqual(
                result.relationships[0].relationship,
                'BusinessProcessStandardValueSet'
            );
        }
    );

    await runTest(
        'D: multiple RecordTypes referencing LeadSource deduplicate',
        async () => {
            const result = await standardValueSetDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise'
                    },
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Renewal'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            const leadSource = result.relationships.filter(
                (item) =>
                    item.metadataType === 'StandardValueSet' &&
                    item.name === 'LeadSource'
            );

            assert.strictEqual(leadSource.length, 1);
            assert.strictEqual(result.relationships.length, 1);
        }
    );

    await runTest(
        'E: individual picklist values are not StandardValueSet members',
        async () => {
            const accountResult = await standardValueSetDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Account.Customer'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });
            const opportunityResult =
                await standardValueSetDiscoverer.discover({
                    selectedMetadata: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Opportunity.Enterprise'
                        }
                    ],
                    repoFiles: REPO_FILES,
                    readRepoFile
                });
            const processResult = await standardValueSetDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'BusinessProcess',
                        metadataName: 'Opportunity.Standard Sales'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            const names = [
                ...relationshipNames(accountResult),
                ...relationshipNames(opportunityResult),
                ...relationshipNames(processResult)
            ];

            assert.ok(!names.includes('Ads'));
            assert.ok(!names.includes('Partner Referral'));
            assert.ok(!names.includes('Renewal Review'));
            assert.strictEqual(
                resolveRecordTypePicklistStandardValueSet('Account', 'Ads'),
                null
            );
            assert.strictEqual(
                resolveRecordTypePicklistStandardValueSet(
                    'Opportunity',
                    'Partner Referral'
                ),
                null
            );
            assert.strictEqual(
                resolveBusinessProcessStandardValueSet('Renewal Review'),
                null
            );
        }
    );

    await runTest(
        'custom field picklists are not StandardValueSets',
        async () => {
            const result = await standardValueSetDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Invoice__c.Retail'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.deepStrictEqual(result.relationships, []);
            assert.strictEqual(
                resolveRecordTypePicklistStandardValueSet(
                    'Invoice__c',
                    'Status__c'
                ),
                null
            );
        }
    );

    await runTest(
        'F: StandardValueSet artifact resolves under standardValueSets/',
        () => {
            const enriched = enrichNode(
                {
                    metadataType: 'StandardValueSet',
                    name: 'AccountSource'
                },
                REPO_FILES
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(enriched.sourceExists, true);
            assert.strictEqual(
                enriched.filePath,
                'force-app/main/default/standardValueSets/AccountSource.standardValueSet-meta.xml'
            );

            const leadSource = enrichNode(
                {
                    metadataType: 'StandardValueSet',
                    name: 'LeadSource'
                },
                REPO_FILES
            );
            assert.strictEqual(
                leadSource.filePath,
                'force-app/main/default/standardValueSets/LeadSource.standardValueSet-meta.xml'
            );

            const stage = enrichNode(
                {
                    metadataType: 'StandardValueSet',
                    name: 'OpportunityStage'
                },
                REPO_FILES
            );
            assert.strictEqual(
                stage.filePath,
                'force-app/main/default/standardValueSets/OpportunityStage.standardValueSet-meta.xml'
            );
        }
    );

    await runTest(
        'G: StandardValueSet classifies as DEPLOYABLE_METADATA',
        () => {
            const result = classifyDependency({
                type: 'StandardValueSet',
                name: 'AccountSource'
            });

            assert.strictEqual(
                result.classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA
            );
            assert.strictEqual(result.packageable, true);
            assert.strictEqual(result.artifactRequired, true);
            assert.strictEqual(result.defaultResolutionPolicy, ACTIONS.DEPLOY);

            const decision = createDefaultDecision({
                name: 'AccountSource',
                type: 'StandardValueSet',
                required: true,
                selected: true
            });

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.destinationState, 'UNKNOWN');
        }
    );

    await runTest(
        'H: DEPLOY + selected StandardValueSet reaches package.xml',
        () => {
            const decision = createDefaultDecision({
                name: 'AccountSource',
                type: 'StandardValueSet',
                required: true,
                selected: true
            });

            const pkg = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Account.Customer'
                    }
                ],
                requiredDependencies: [decision],
                selectedTestClasses: []
            });

            assert.ok(
                packageHasMember(pkg, 'StandardValueSet', 'AccountSource')
            );

            const manifest = generateManifest(pkg);
            assert.match(
                manifest.packageXml,
                /<name>StandardValueSet<\/name>/
            );
            assert.match(
                manifest.packageXml,
                /<members>AccountSource<\/members>/
            );
        }
    );

    await runTest(
        'I: REFERENCE / SKIP / BLOCK StandardValueSet is not force-added',
        () => {
            for (const action of ['REFERENCE', 'SKIP', 'BLOCK']) {
                const pkg = generateDeploymentPackage({
                    selectedMetadata: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Account.Customer'
                        }
                    ],
                    requiredDependencies: [
                        {
                            name: 'AccountSource',
                            type: 'StandardValueSet',
                            action,
                            selected: action === 'SKIP' ? false : true,
                            required: true
                        }
                    ],
                    selectedTestClasses: []
                });

                assert.strictEqual(
                    packageHasMember(pkg, 'StandardValueSet', 'AccountSource'),
                    false,
                    `${action} must not force StandardValueSet into package`
                );
            }
        }
    );

    await runTest(
        'BusinessProcess expansion discovers OpportunityStage',
        async () => {
            const expansion = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'BusinessProcess',
                        metadataName: 'Opportunity.Standard Sales'
                    }
                ],
                expandableDependencies: [],
                discoverers: [standardValueSetDiscoverer],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const names = expansion.relationships.map((item) => item.name);
            assert.ok(
                names.includes('OpportunityStage'),
                `expected OpportunityStage; got ${JSON.stringify(names)}`
            );
            assert.ok(!names.includes('Renewal Review'));
        }
    );

    await runTest(
        'registry includes StandardValueSetDiscoverer',
        () => {
            const ids = getRegisteredDiscoverers().map(
                (discoverer) => discoverer.id
            );
            assert.ok(ids.includes('StandardValueSetDiscoverer'));
        }
    );

    await runTest(
        'unmapped objects do not invent a StandardValueSet',
        () => {
            assert.strictEqual(
                resolveBusinessProcessStandardValueSet('Invoice__c'),
                null
            );
            assert.strictEqual(
                resolveRecordTypePicklistStandardValueSet(
                    'Account',
                    'UnknownPicklist'
                ),
                null
            );
        }
    );

    if (process.exitCode) {
        console.error('standardValueSet.discoverer.test.js FAILED');
    } else {
        console.log('standardValueSet.discoverer.test.js PASSED');
    }
}

main();
