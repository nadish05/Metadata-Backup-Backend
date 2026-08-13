const assert = require('assert');

const recordTypeBusinessProcessDiscoverer = require('./recordTypeBusinessProcess.discoverer');
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
</RecordType>`;

const RENEWAL_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Renewal</fullName>
    <active>true</active>
    <businessProcess>Renewal Process</businessProcess>
    <label>Renewal</label>
</RecordType>`;

const NO_PROCESS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Standard</fullName>
    <active>true</active>
    <label>Standard</label>
</RecordType>`;

const ACCOUNT_PROCESS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Customer</fullName>
    <active>true</active>
    <businessProcess>Sales Process</businessProcess>
    <label>Customer</label>
</RecordType>`;

const CUSTOM_OBJECT_PROCESS_XML = `<?xml version="1.0" encoding="UTF-8"?>
<RecordType xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Retail</fullName>
    <active>true</active>
    <businessProcess>Some Process</businessProcess>
    <label>Retail</label>
</RecordType>`;

const REPO_FILES = [
    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/recordTypes/Renewal.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/recordTypes/Standard.recordType-meta.xml',
    'force-app/main/default/objects/Opportunity/businessProcesses/New Sales Process.businessProcess-meta.xml',
    'force-app/main/default/objects/Opportunity/businessProcesses/Renewal Process.businessProcess-meta.xml',
    'force-app/main/default/objects/Account/recordTypes/Customer.recordType-meta.xml',
    'force-app/main/default/objects/Account/businessProcesses/Sales Process.businessProcess-meta.xml',
    'force-app/main/default/objects/Invoice__c/recordTypes/Retail.recordType-meta.xml',
    'force-app/main/default/objects/Invoice__c/businessProcesses/Some Process.businessProcess-meta.xml'
];

const XML_BY_PATH = {
    'force-app/main/default/objects/Opportunity/recordTypes/Enterprise_Deal.recordType-meta.xml':
        ENTERPRISE_DEAL_XML,
    'force-app/main/default/objects/Opportunity/recordTypes/Renewal.recordType-meta.xml':
        RENEWAL_XML,
    'force-app/main/default/objects/Opportunity/recordTypes/Standard.recordType-meta.xml':
        NO_PROCESS_XML,
    'force-app/main/default/objects/Account/recordTypes/Customer.recordType-meta.xml':
        ACCOUNT_PROCESS_XML,
    'force-app/main/default/objects/Invoice__c/recordTypes/Retail.recordType-meta.xml':
        CUSTOM_OBJECT_PROCESS_XML
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

async function main() {
    await runTest(
        'TEST 1: RecordType businessProcess New Sales Process → BusinessProcess:Opportunity.New Sales Process',
        async () => {
            const result = await recordTypeBusinessProcessDiscoverer.discover({
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
            assert.strictEqual(result.relationships[0].metadataType, 'BusinessProcess');
            assert.strictEqual(
                result.relationships[0].name,
                'Opportunity.New Sales Process'
            );
            assert.strictEqual(
                result.relationships[0].relationship,
                'RecordTypeBusinessProcess'
            );
            assert.strictEqual(result.relationships[0].required, true);
            assert.strictEqual(result.relationships[0].selected, true);
        }
    );

    await runTest(
        'TEST 2: RecordType businessProcess Renewal Process → BusinessProcess:Opportunity.Renewal Process',
        async () => {
            const result = await recordTypeBusinessProcessDiscoverer.discover({
                selectedMetadata: [
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
                'Opportunity.Renewal Process'
            );
        }
    );

    await runTest(
        'TEST 3: RecordType without businessProcess emits no BusinessProcess',
        async () => {
            const result = await recordTypeBusinessProcessDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Standard'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.deepStrictEqual(result.relationships, []);
        }
    );

    await runTest(
        'TEST 4: BusinessProcess artifact resolves to businessProcesses folder',
        () => {
            const enriched = enrichNode(
                {
                    metadataType: 'BusinessProcess',
                    name: 'Opportunity.New Sales Process'
                },
                REPO_FILES
            );

            assert.strictEqual(enriched.artifactResolved, true);
            assert.strictEqual(enriched.sourceExists, true);
            assert.strictEqual(
                enriched.filePath,
                'force-app/main/default/objects/Opportunity/businessProcesses/New Sales Process.businessProcess-meta.xml'
            );

            const renewal = enrichNode(
                {
                    metadataType: 'BusinessProcess',
                    name: 'Opportunity.Renewal Process'
                },
                REPO_FILES
            );

            assert.strictEqual(
                renewal.filePath,
                'force-app/main/default/objects/Opportunity/businessProcesses/Renewal Process.businessProcess-meta.xml'
            );
        }
    );

    await runTest(
        'TEST 5: BusinessProcess classifies as deployable metadata',
        () => {
            const result = classifyDependency({
                type: 'BusinessProcess',
                name: 'Opportunity.New Sales Process'
            });

            assert.strictEqual(
                result.classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA
            );
            assert.strictEqual(result.packageable, true);
            assert.strictEqual(result.artifactRequired, true);
            assert.strictEqual(result.defaultResolutionPolicy, ACTIONS.DEPLOY);

            const decision = createDefaultDecision({
                name: 'Opportunity.New Sales Process',
                type: 'BusinessProcess',
                required: true,
                selected: true
            });

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
            assert.strictEqual(decision.destinationState, 'UNKNOWN');
        }
    );

    await runTest(
        'TEST 6: DEPLOY + selected BusinessProcess reaches package.xml',
        () => {
            const decision = createDefaultDecision({
                name: 'Opportunity.New Sales Process',
                type: 'BusinessProcess',
                required: true,
                selected: true
            });

            const pkg = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'RecordType',
                        metadataName: 'Opportunity.Enterprise_Deal'
                    }
                ],
                requiredDependencies: [decision],
                selectedTestClasses: []
            });

            assert.ok(
                packageHasMember(
                    pkg,
                    'BusinessProcess',
                    'Opportunity.New Sales Process'
                )
            );

            const manifest = generateManifest(pkg);
            assert.match(
                manifest.packageXml,
                /<name>BusinessProcess<\/name>/
            );
            assert.match(
                manifest.packageXml,
                /<members>Opportunity\.New Sales Process<\/members>/
            );
        }
    );

    await runTest(
        'TEST 7: REFERENCE / SKIP / BLOCK BusinessProcess is not force-added',
        () => {
            for (const action of ['REFERENCE', 'SKIP', 'BLOCK']) {
                const pkg = generateDeploymentPackage({
                    selectedMetadata: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Opportunity.Enterprise_Deal'
                        }
                    ],
                    requiredDependencies: [
                        {
                            name: 'Opportunity.New Sales Process',
                            type: 'BusinessProcess',
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
                        'BusinessProcess',
                        'Opportunity.New Sales Process'
                    ),
                    false,
                    `${action} must not force BusinessProcess into package`
                );
            }
        }
    );

    await runTest(
        'TEST 8: generic for Account and custom objects — no object hardcoding',
        async () => {
            const accountResult =
                await recordTypeBusinessProcessDiscoverer.discover({
                    selectedMetadata: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Account.Customer'
                        }
                    ],
                    repoFiles: REPO_FILES,
                    readRepoFile
                });

            assert.strictEqual(
                accountResult.relationships[0].name,
                'Account.Sales Process'
            );

            const customResult =
                await recordTypeBusinessProcessDiscoverer.discover({
                    selectedMetadata: [
                        {
                            metadataType: 'RecordType',
                            metadataName: 'Invoice__c.Retail'
                        }
                    ],
                    repoFiles: REPO_FILES,
                    readRepoFile
                });

            assert.strictEqual(
                customResult.relationships[0].name,
                'Invoice__c.Some Process'
            );

            const expansion = await discoverUntilStable({
                selectedMetadata: [
                    {
                        metadataType: 'Profile',
                        metadataName: 'Sales Manager'
                    }
                ],
                expandableDependencies: [],
                discoverers: [
                    {
                        id: 'StubProfileDiscoverer',
                        async discover({ selectedMetadata }) {
                            const profiles = (selectedMetadata || []).filter(
                                (item) => item.metadataType === 'Profile'
                            );

                            if (!profiles.length) {
                                return {
                                    relationships: [],
                                    warnings: [],
                                    filesScanned: 0,
                                    metadataScanned: 0
                                };
                            }

                            return {
                                relationships: [
                                    {
                                        name: 'Opportunity.Enterprise_Deal',
                                        metadataType: 'RecordType',
                                        type: 'RecordType',
                                        relationship: 'ProfileRecordTypeVisibility',
                                        required: true,
                                        selected: true
                                    }
                                ],
                                warnings: [],
                                filesScanned: 1,
                                metadataScanned: 1
                            };
                        }
                    },
                    recordTypeBusinessProcessDiscoverer
                ],
                repoFiles: REPO_FILES,
                readRepoFile,
                listRepoFiles: async () => REPO_FILES
            });

            const names = expansion.relationships.map((item) => item.name);
            assert.ok(names.includes('Opportunity.Enterprise_Deal'));
            assert.ok(
                names.includes('Opportunity.New Sales Process'),
                `Profile-discovered RecordType must expand BusinessProcess; got ${JSON.stringify(names)}`
            );
        }
    );

    if (process.exitCode) {
        console.error('recordTypeBusinessProcess.discoverer.test.js FAILED');
    } else {
        console.log('recordTypeBusinessProcess.discoverer.test.js PASSED');
    }
}

main();
