const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    collectRecordTypeAndBusinessProcessFiles,
    buildSelectedMetadataFromRetrievedFiles,
    extractUniqueStandardValueSetNames,
    discoverStandardValueSetNamesFromRetrievedProject
} = require('./standardValueSetPostRetrieve.service');

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

function writeProjectFile(projectPath, relativePath, contents) {
    const absolutePath = path.join(projectPath, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, contents);
}

function createTempProject() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'svs-post-retrieve-'));
}

async function main() {
    await runTest(
        'RecordType XML AccountSource → StandardValueSet:LeadSource',
        async () => {
            const projectPath = createTempProject();

            try {
                writeProjectFile(
                    projectPath,
                    'force-app/main/default/objects/Account/recordTypes/Customer.recordType-meta.xml',
                    ACCOUNT_RECORD_TYPE_XML
                );

                const names = await discoverStandardValueSetNamesFromRetrievedProject(
                    projectPath
                );

                assert.deepStrictEqual(names, ['LeadSource']);
                assert.ok(!names.includes('AccountSource'));
            } finally {
                fs.rmSync(projectPath, { recursive: true, force: true });
            }
        }
    );

    await runTest(
        'BusinessProcess Opportunity process → StandardValueSet:OpportunityStage',
        async () => {
            const projectPath = createTempProject();

            try {
                writeProjectFile(
                    projectPath,
                    'force-app/main/default/objects/Opportunity/businessProcesses/Standard Sales.businessProcess-meta.xml',
                    OPPORTUNITY_BUSINESS_PROCESS_XML
                );

                const names = await discoverStandardValueSetNamesFromRetrievedProject(
                    projectPath
                );

                assert.deepStrictEqual(names, ['OpportunityStage']);
            } finally {
                fs.rmSync(projectPath, { recursive: true, force: true });
            }
        }
    );

    await runTest(
        'duplicate RecordType LeadSource dependencies are deduplicated',
        async () => {
            const projectPath = createTempProject();

            try {
                writeProjectFile(
                    projectPath,
                    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise.recordType-meta.xml',
                    OPPORTUNITY_RECORD_TYPE_XML
                );
                writeProjectFile(
                    projectPath,
                    'force-app/main/default/objects/Opportunity/recordTypes/Renewal.recordType-meta.xml',
                    SECOND_OPPORTUNITY_RECORD_TYPE_XML
                );

                const names = await discoverStandardValueSetNamesFromRetrievedProject(
                    projectPath
                );

                assert.deepStrictEqual(names, ['LeadSource']);
            } finally {
                fs.rmSync(projectPath, { recursive: true, force: true });
            }
        }
    );

    await runTest(
        'zero StandardValueSet dependencies when only custom picklists exist',
        async () => {
            const projectPath = createTempProject();

            try {
                writeProjectFile(
                    projectPath,
                    'force-app/main/default/objects/Invoice__c/recordTypes/Retail.recordType-meta.xml',
                    CUSTOM_FIELD_PICKLIST_XML
                );

                const names = await discoverStandardValueSetNamesFromRetrievedProject(
                    projectPath
                );

                assert.deepStrictEqual(names, []);
            } finally {
                fs.rmSync(projectPath, { recursive: true, force: true });
            }
        }
    );

    await runTest(
        'empty project yields no StandardValueSet members',
        async () => {
            const projectPath = createTempProject();

            try {
                const names = await discoverStandardValueSetNamesFromRetrievedProject(
                    projectPath
                );
                const files = collectRecordTypeAndBusinessProcessFiles(projectPath);

                assert.deepStrictEqual(names, []);
                assert.deepStrictEqual(files, []);
            } finally {
                fs.rmSync(projectPath, { recursive: true, force: true });
            }
        }
    );

    await runTest(
        'selected metadata is built from retrieved RecordType and BusinessProcess paths',
        () => {
            const selected = buildSelectedMetadataFromRetrievedFiles([
                'force-app/main/default/objects/Account/recordTypes/Customer.recordType-meta.xml',
                'force-app/main/default/objects/Opportunity/businessProcesses/Standard Sales.businessProcess-meta.xml'
            ]);

            assert.deepStrictEqual(selected, [
                {
                    metadataType: 'RecordType',
                    metadataName: 'Account.Customer',
                    filePath:
                        'force-app/main/default/objects/Account/recordTypes/Customer.recordType-meta.xml'
                },
                {
                    metadataType: 'BusinessProcess',
                    metadataName: 'Opportunity.Standard Sales',
                    filePath:
                        'force-app/main/default/objects/Opportunity/businessProcesses/Standard Sales.businessProcess-meta.xml'
                }
            ]);
        }
    );

    await runTest(
        'extractUniqueStandardValueSetNames deduplicates discoverer relationships',
        () => {
            const names = extractUniqueStandardValueSetNames({
                relationships: [
                    { name: 'LeadSource' },
                    { name: 'Industry' },
                    { name: 'LeadSource' }
                ]
            });

            assert.deepStrictEqual(names, ['LeadSource', 'Industry']);
        }
    );
}

main().then(() => {
    if (process.exitCode) {
        console.error('standardValueSetPostRetrieve.service.test.js FAILED');
        process.exit(process.exitCode);
    } else {
        console.log('standardValueSetPostRetrieve.service.test.js PASSED');
    }
});
