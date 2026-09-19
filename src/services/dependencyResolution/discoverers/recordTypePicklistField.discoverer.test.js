const assert = require('assert');

const recordTypePicklistFieldDiscoverer = require('./recordTypePicklistField.discoverer');
const standardValueSetDiscoverer = require('./standardValueSet.discoverer');
const recordTypeBusinessProcessDiscoverer = require('./recordTypeBusinessProcess.discoverer');
const {
    discoverUntilStable
} = require('../relationshipDiscovery.service');
const {
    createDefaultDecision
} = require('../dependencyResolution.service');
const {
    generateDeploymentPackage
} = require('../../deploymentPackage.service');
const { generateManifest } = require('../../packageXml.service');
const {
    enrichNode
} = require('../../repositoryArtifacts/artifactResolution.service');
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

const ENTERPRISE_DEAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Enterprise_Deal</fullName>
    <active>true</active>
    <businessProcess>New Sales Process</businessProcess>
    <label>Enterprise Deal</label>
    <picklistValues>
        <picklist>Approval_Status__c</picklist>
        <values>
            <fullName>Pending</fullName>
            <default>true</default>
        </values>
    </picklistValues>
</RecordType>`;

const MULTIPLE_CUSTOM_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Enterprise_Deal</fullName>
    <active>true</active>
    <label>Enterprise Deal</label>
    <picklistValues>
        <picklist>Approval_Status__c</picklist>
        <values><fullName>A</fullName><default>true</default></values>
    </picklistValues>
    <picklistValues>
        <picklist>Customer_Field__c</picklist>
        <values><fullName>B</fullName><default>true</default></values>
    </picklistValues>
    <picklistValues>
        <picklist>Customer_Status__c</picklist>
        <values><fullName>C</fullName><default>true</default></values>
    </picklistValues>
    <picklistValues>
        <picklist>Approval_Status__c</picklist>
        <values><fullName>D</fullName><default>false</default></values>
    </picklistValues>
</RecordType>`;

const STANDARD_ONLY_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Standard</fullName>
    <active>true</active>
    <label>Standard</label>
    <picklistValues>
        <picklist>LeadSource</picklist>
        <values><fullName>Web</fullName><default>false</default></values>
    </picklistValues>
    <picklistValues>
        <picklist>Type</picklist>
        <values><fullName>New Customer</fullName><default>false</default></values>
    </picklistValues>
</RecordType>`;

const MIXED_PICKLIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Enterprise_Deal</fullName>
    <active>true</active>
    <label>Enterprise Deal</label>
    <picklistValues>
        <picklist>Approval_Status__c</picklist>
        <values><fullName>Pending</fullName><default>true</default></values>
    </picklistValues>
    <picklistValues>
        <picklist>LeadSource</picklist>
        <values><fullName>Partner</fullName><default>false</default></values>
    </picklistValues>
    <picklistValues>
        <picklist>Type</picklist>
        <values><fullName>Existing</fullName><default>false</default></values>
    </picklistValues>
</RecordType>`;

const MISSING_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Orphan_Field</fullName>
    <active>true</active>
    <label>Orphan Field</label>
    <picklistValues>
        <picklist>Approval_Status__c</picklist>
        <values><fullName>X</fullName><default>true</default></values>
    </picklistValues>
</RecordType>`;

const FIELD_XML_STUB = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Approval_Status__c</fullName>
    <label>Approval Status</label>
    <type>Picklist</type>
</CustomField>`;

const REPO_FILES = [
    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/recordTypes/Standard.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/recordTypes/Orphan_Field.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/fields/Approval_Status__c.field-meta.xml',
    'force-app/main/default/objects/Opportunity/fields/Customer_Field__c.field-meta.xml',
    'force-app/main/default/objects/Opportunity/fields/Customer_Status__c.field-meta.xml',
    'force-app/main/default/objects/Opportunity/businessProcesses/New Sales Process.businessProcess-meta.xml',
    'force-app/main/default/standardValueSets/LeadSource.standardValueSet-meta.xml',
    'force-app/main/default/standardValueSets/OpportunityType.standardValueSet-meta.xml'
];

const XML_BY_PATH = {
    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml':
        ENTERPRISE_DEAL_XML,
    'force-app/main/default/objects/Opportunity/recordTypes/Standard.recordType-meta.xml':
        STANDARD_ONLY_XML,
    'force-app/main/default/objects/Opportunity/recordTypes/Orphan_Field.recordType-meta.xml':
        MISSING_FIELD_XML,
    'force-app/main/default/objects/Opportunity/fields/Approval_Status__c.field-meta.xml':
        FIELD_XML_STUB,
    'force-app/main/default/objects/Opportunity/fields/Customer_Field__c.field-meta.xml':
        FIELD_XML_STUB,
    'force-app/main/default/objects/Opportunity/fields/Customer_Status__c.field-meta.xml':
        FIELD_XML_STUB
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

function relationshipKeys(result) {
    return (result.relationships || []).map(
        (item) => `${item.metadataType || item.type}:${item.name}`
    );
}

async function main() {
    await runTest(
        'TEST 1: custom picklist Approval_Status__c → CustomField:Opportunity.Approval_Status__c',
        async () => {
            const result = await recordTypePicklistFieldDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.strictEqual(result.relationships.length, 1);
            assert.strictEqual(result.relationships[0].metadataType, 'CustomField');
            assert.strictEqual(
                result.relationships[0].name,
                'Opportunity.Approval_Status__c'
            );
        }
    );

    await runTest(
        'TEST 2: multiple custom picklists without duplicates',
        async () => {
            XML_BY_PATH[
                'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml'
            ] = MULTIPLE_CUSTOM_XML;

            const result = await recordTypePicklistFieldDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            const names = result.relationships.map((item) => item.name).sort();
            assert.deepStrictEqual(names, [
                'Opportunity.Approval_Status__c',
                'Opportunity.Customer_Field__c',
                'Opportunity.Customer_Status__c'
            ]);

            XML_BY_PATH[
                'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml'
            ] = ENTERPRISE_DEAL_XML;
        }
    );

    await runTest(
        'TEST 3: standard picklists do not emit CustomField',
        async () => {
            const picklistResult =
                await recordTypePicklistFieldDiscoverer.discover({
                    selectedMetadata: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Opportunity.Standard'
                        }
                    ],
                    repoFiles: REPO_FILES,
                    readRepoFile
                });

            assert.deepStrictEqual(picklistResult.relationships, []);

            const svsResult = await standardValueSetDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Standard'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            const svsNames = svsResult.relationships.map((item) => item.name);
            assert.ok(svsNames.includes('LeadSource'));
            assert.ok(svsNames.includes('OpportunityType'));
        }
    );

    await runTest(
        'TEST 4: mixed picklists — CustomField + StandardValueSet',
        async () => {
            XML_BY_PATH[
                'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml'
            ] = MIXED_PICKLIST_XML;

            const expansion = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal'
                    }
                ],
                expandableDependencies: [],
                discoverers: [
                    recordTypePicklistFieldDiscoverer,
                    standardValueSetDiscoverer
                ],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const keys = relationshipKeys(expansion);
            assert.ok(
                keys.includes('CustomField:Opportunity.Approval_Status__c')
            );
            assert.ok(keys.includes('StandardValueSet:LeadSource'));
            assert.ok(keys.includes('StandardValueSet:OpportunityType'));
            assert.ok(
                !keys.some((key) => key.startsWith('CustomField:Opportunity.LeadSource'))
            );
            assert.ok(
                !keys.some((key) => key.startsWith('CustomField:Opportunity.Type'))
            );

            XML_BY_PATH[
                'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml'
            ] = ENTERPRISE_DEAL_XML;
        }
    );

    await runTest(
        'TEST 5: GlobalValueSet:Approval_Status__c is not produced',
        async () => {
            const expansion = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal'
                    }
                ],
                expandableDependencies: [],
                discoverers: getRegisteredDiscoverers(),
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const keys = relationshipKeys(expansion);
            assert.ok(
                !keys.some((key) => key === 'GlobalValueSet:Approval_Status__c')
            );
        }
    );

    await runTest(
        'TEST 6: qualified CustomField identity uses object prefix',
        async () => {
            const result = await recordTypePicklistFieldDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.ok(
                result.relationships.every(
                    (item) => item.name !== 'Approval_Status__c'
                )
            );
            assert.ok(
                !result.relationships.some(
                    (item) => item.name === 'Approval_Status__c'
                )
            );
            assert.strictEqual(
                result.relationships[0].name,
                'Opportunity.Approval_Status__c'
            );
        }
    );

    await runTest(
        'TEST 7: package generation includes RecordType and CustomField, not GlobalValueSet',
        async () => {
            const expansion = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal'
                    }
                ],
                expandableDependencies: [],
                discoverers: [
                    recordTypePicklistFieldDiscoverer,
                    recordTypeBusinessProcessDiscoverer
                ],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const decisions = expansion.relationships.map((rel) =>
                createDefaultDecision({
                    name: rel.name,
                    type: rel.metadataType || rel.type,
                    required: rel.required,
                    selected: rel.selected
                })
            );

            const pkg = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal'
                    }
                ],
                requiredDependencies: decisions,
                selectedTestClasses: []
            });

            assert.ok(
                packageHasMember(
                    pkg,
                    'RecordType',
                    'Opportunity.Enterprise_Deal'
                )
            );
            assert.ok(
                packageHasMember(
                    pkg,
                    'CustomField',
                    'Opportunity.Approval_Status__c'
                )
            );
            assert.ok(
                packageHasMember(
                    pkg,
                    'BusinessProcess',
                    'Opportunity.New Sales Process'
                )
            );
            assert.ok(
                !packageHasMember(pkg, 'GlobalValueSet', 'Approval_Status__c')
            );
        }
    );

    await runTest(
        'TEST 8: manifest contains RecordType and CustomField members',
        async () => {
            const pkg = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal'
                    }
                ],
                requiredDependencies: [
                    createDefaultDecision({
                        name: 'Opportunity.Approval_Status__c',
                        type: 'CustomField',
                        required: true,
                        selected: true
                    }),
                    createDefaultDecision({
                        name: 'Opportunity.New Sales Process',
                        type: 'BusinessProcess',
                        required: true,
                        selected: true
                    })
                ],
                selectedTestClasses: []
            });

            const manifest = generateManifest(pkg);
            assert.match(
                manifest.packageXml,
                /<members>Opportunity\.Enterprise_Deal<\/members>/
            );
            assert.match(
                manifest.packageXml,
                /<name>RecordType<\/name>/
            );
            assert.match(
                manifest.packageXml,
                /<members>Opportunity\.Approval_Status__c<\/members>/
            );
            assert.match(manifest.packageXml, /<name>CustomField<\/name>/);
            assert.doesNotMatch(
                manifest.packageXml,
                /<name>GlobalValueSet<\/name>[\s\S]*Approval_Status__c/
            );
        }
    );

    await runTest(
        'TEST 9: repository artifacts resolve for workspace copy paths',
        () => {
            const recordType = enrichNode(
                {
                    metadataType: 'RecordType',
                    name: 'Opportunity.Enterprise_Deal'
                },
                REPO_FILES
            );

            assert.strictEqual(recordType.artifactResolved, true);
            assert.strictEqual(
                recordType.filePath,
                'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml'
            );

            const customField = enrichNode(
                {
                    metadataType: 'CustomField',
                    name: 'Opportunity.Approval_Status__c'
                },
                REPO_FILES
            );

            assert.strictEqual(customField.artifactResolved, true);
            assert.strictEqual(
                customField.filePath,
                'force-app/main/default/objects/Opportunity/fields/Approval_Status__c.field-meta.xml'
            );
        }
    );

    await runTest(
        'TEST 10: missing source CustomField file — no dependency emitted',
        async () => {
            const result = await recordTypePicklistFieldDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Orphan_Field'
                    }
                ],
                repoFiles: REPO_FILES.filter(
                    (file) =>
                        !file.endsWith(
                            'objects/Opportunity/fields/Approval_Status__c.field-meta.xml'
                        )
                ),
                readRepoFile
            });

            assert.deepStrictEqual(result.relationships, []);
        }
    );

    if (process.exitCode) {
        console.error('recordTypePicklistField.discoverer.test.js FAILED');
    } else {
        console.log('recordTypePicklistField.discoverer.test.js PASSED');
    }
}

main();
