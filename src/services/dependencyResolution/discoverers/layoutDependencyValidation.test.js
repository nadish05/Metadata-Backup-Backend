const assert = require('assert');

const { parseLayoutMemberName } = require('../../../utils/layoutMemberName.util');
const layoutReferenceDiscoverer = require('./layoutReference.discoverer');
const {
    mergeDeployableReferences,
    resolveDependencies
} = require('../dependencyResolution.service');
const {
    analyzeDeploymentCompatibility
} = require('../../deploymentCompatibility/deploymentCompatibilityAnalyzer.service');
const { validateDependencies } = require('../../dependencyValidation.service');
const { generateDeploymentPackage } = require('../../deploymentPackage.service');
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

const ACCOUNT_GYM_LAYOUT = 'Account-Gym Member Layout';
const WORKACCESS_LAYOUT = 'WorkAccess-Access Layout';
const ACCOUNT_GYM_LAYOUT_PATH =
    'force-app/main/default/layouts/Account-Gym Member Layout.layout-meta.xml';
const WORKACCESS_LAYOUT_PATH =
    'force-app/main/default/layouts/WorkAccess-Access Layout.layout-meta.xml';

function buildProductionAccountGymLayoutXml() {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <excludeButtons>Submit</excludeButtons>
    <layoutSections>
        <customLabel>true</customLabel>
        <detailHeading>false</detailHeading>
        <editHeading>false</editHeading>
        <label>Fields</label>
        <layoutColumns>
            <layoutItems>
                <behavior>Required</behavior>
                <field>Name</field>
            </layoutItems>
            <layoutItems>
                <behavior>Edit</behavior>
                <field>ParentId</field>
            </layoutItems>
            <layoutItems>
                <behavior>Edit</behavior>
                <field>Phone</field>
            </layoutItems>
            <layoutItems>
                <behavior>Edit</behavior>
                <field>DOB__c</field>
            </layoutItems>
            <layoutItems>
                <behavior>Edit</behavior>
                <field>Address__c</field>
            </layoutItems>
            <layoutItems>
                <behavior>Edit</behavior>
                <field>F__c</field>
            </layoutItems>
            <layoutItems>
                <behavior>Edit</behavior>
                <field>Email__c</field>
            </layoutItems>
        </layoutColumns>
        <layoutColumns/>
        <style>TwoColumnsLeftToRight</style>
    </layoutSections>
    <relatedLists>
        <fields>FULL_NAME</fields>
        <fields>LEAD.COMPANY</fields>
        <fields>LEAD.PHONE</fields>
        <relatedList>Lead.Converted_Account__c</relatedList>
    </relatedLists>
    <relatedLists>
        <fields>NAME</fields>
        <relatedList>Gym_Trainer__c.Gym_Member__c</relatedList>
    </relatedLists>
    <relatedLists>
        <fields>NAME</fields>
        <relatedList>Payment__c.Account__c</relatedList>
    </relatedLists>
    <relatedObjects>ParentId</relatedObjects>
    <showEmailCheckbox>false</showEmailCheckbox>
    <summaryLayout>
        <masterLabel>00hd200000Roq5V</masterLabel>
        <sizeX>4</sizeX>
        <sizeY>0</sizeY>
        <summaryLayoutStyle>Default</summaryLayoutStyle>
    </summaryLayout>
</Layout>`;
}

function buildLayoutXmlWithRelatedLists(relatedLists = [], extraXml = '') {
    const relatedListXml = relatedLists
        .map(
            (entry) => `    <relatedLists>
        <fields>NAME</fields>
        <relatedList>${entry}</relatedList>
    </relatedLists>`
        )
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <layoutColumns>
            <layoutItems>
                <field>DOB__c</field>
            </layoutItems>
        </layoutColumns>
    </layoutSections>
${relatedListXml}
${extraXml}
</Layout>`;
}

function findReference(references, metadataType, name) {
    return (references || []).find(
        (ref) => ref.metadataType === metadataType && ref.name === name
    );
}

function findReferences(references, metadataType, name) {
    return (references || []).filter(
        (ref) => ref.metadataType === metadataType && ref.name === name
    );
}

function findResolvedDependency(resolvedDependencies, metadataType, name) {
    return (resolvedDependencies || []).find(
        (dependency) =>
            (dependency.metadataType || dependency.type) === metadataType &&
            (dependency.metadataName || dependency.name) === name
    );
}

function getPackageMemberNames(generatedPackage, metadataType) {
    return (generatedPackage?.metadata || [])
        .filter((item) => item.metadataType === metadataType)
        .map((item) => item.metadataName);
}

function buildLayoutXml(fields = []) {
    const fieldXml = fields
        .map((field) => `            <field>${field}</field>`)
        .join('\n');

    return `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <layoutSections>
        <layoutColumns>
            <layoutItems>
${fieldXml}
            </layoutItems>
        </layoutColumns>
    </layoutSections>
</Layout>`;
}

async function discoverLayoutReferences({
    layoutMemberName,
    layoutPath,
    layoutXml
}) {
    return layoutReferenceDiscoverer.discover({
        selectedMetadata: [
            {
                metadataType: 'Layout',
                metadataName: layoutMemberName,
                filePath: layoutPath
            }
        ],
        repoFiles: [layoutPath],
        readRepoFile: async () => layoutXml,
        depth: 1
    });
}

async function resolveLayoutPipeline({
    discoveredReferences,
    destinationStates,
    selectedMetadata,
    artifactFlags = {}
}) {
    const mergedDependencies = mergeDeployableReferences(
        [],
        discoveredReferences
    );

    const resolution = await resolveDependencies({
        requiredDependencies: mergedDependencies,
        discoveredReferences,
        selectedMetadata,
        destinationStates
    });

    const resolvedDependencies = (resolution.resolvedDependencies || []).map(
        (dependency) => {
            const metadataType = dependency.metadataType || dependency.type;
            const metadataName = dependency.name || dependency.metadataName;
            const key = `${metadataType}:${metadataName}`;
            const flags = artifactFlags[key] || {};
            const inventoryState = destinationStates.get(key);

            return {
                ...dependency,
                ...(inventoryState ? { destinationState: inventoryState } : {}),
                ...flags
            };
        }
    );

    const generatedPackage = generateDeploymentPackage({
        selectedMetadata,
        requiredDependencies: resolvedDependencies
    });

    const compatibility = analyzeDeploymentCompatibility({
        selectedMetadata,
        discoveredReferences,
        resolvedDependencies,
        destinationStates
    });

    const dependencyValidation = await validateDependencies({
        accessToken: 'token',
        instanceUrl: 'https://example.my.salesforce.com',
        generatedDeploymentPackage: generatedPackage,
        destinationStates
    });

    return {
        mergedDependencies,
        resolvedDependencies,
        generatedPackage,
        compatibility,
        dependencyValidation
    };
}

async function main() {
    await runTest(
        'T1: parseLayoutMemberName Account-Gym Member Layout',
        async () => {
            const parsed = parseLayoutMemberName(ACCOUNT_GYM_LAYOUT);

            assert.deepStrictEqual(parsed, {
                objectApiName: 'Account',
                layoutName: 'Gym Member Layout'
            });
        }
    );

    await runTest(
        'T2: parseLayoutMemberName WorkAccess-Access Layout',
        async () => {
            const parsed = parseLayoutMemberName(WORKACCESS_LAYOUT);

            assert.deepStrictEqual(parsed, {
                objectApiName: 'WorkAccess',
                layoutName: 'Access Layout'
            });
        }
    );

    await runTest(
        'T10: parseLayoutMemberName splits only on first hyphen',
        async () => {
            const parsed = parseLayoutMemberName('Account-Gym-Member-Layout');

            assert.deepStrictEqual(parsed, {
                objectApiName: 'Account',
                layoutName: 'Gym-Member-Layout'
            });
        }
    );

    await runTest(
        'T3: layout XML DOB__c emits CustomField Account.DOB__c',
        async () => {
            const result = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['DOB__c'])
            });

            const fieldRef = (result.references || []).find(
                (ref) =>
                    ref.metadataType === 'CustomField' &&
                    ref.name === 'Account.DOB__c'
            );

            assert.ok(fieldRef, 'expected Account.DOB__c reference');
            assert.strictEqual(fieldRef.blocking, true);
            assert.strictEqual(fieldRef.deployable, true);
            assert.strictEqual(fieldRef.discoveryMethod, 'layoutReference');

            const parentRef = (result.references || []).find(
                (ref) =>
                    ref.metadataType === 'CustomObject' && ref.name === 'Account'
            );

            assert.ok(parentRef, 'expected Account parent object reference');
        }
    );

    await runTest(
        'T4: layout XML Name does not emit blocking CustomField dependency',
        async () => {
            const result = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['Name'])
            });

            const fieldRefs = (result.references || []).filter(
                (ref) => ref.metadataType === 'CustomField'
            );

            assert.strictEqual(fieldRefs.length, 0);
        }
    );

    await runTest(
        'T5: layout XML OwnerId does not emit blocking CustomField dependency',
        async () => {
            const result = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['OwnerId'])
            });

            const fieldRefs = (result.references || []).filter(
                (ref) => ref.metadataType === 'CustomField'
            );

            assert.strictEqual(fieldRefs.length, 0);
        }
    );

    await runTest(
        'T6: Account EXISTS + Account.DOB__c MISSING blocks before deployment',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['DOB__c'])
            });

            const destinationStates = new Map([
                ['CustomObject:Account', 'EXISTS'],
                ['CustomField:Account.DOB__c', 'MISSING']
            ]);

            const selectedMetadata = [
                {
                    metadataType: 'Layout',
                    metadataName: ACCOUNT_GYM_LAYOUT,
                    filePath: ACCOUNT_GYM_LAYOUT_PATH
                }
            ];

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata,
                artifactFlags: {
                    'CustomField:Account.DOB__c': {
                        artifactResolved: false,
                        sourceExists: false
                    }
                }
            });

            assert.strictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );

            const layoutFieldBlocker = (
                pipeline.compatibility.findings || []
            ).find(
                (finding) =>
                    finding.ruleId === 'layout.fieldReference' &&
                    finding.metadataName === 'Account.DOB__c' &&
                    (finding.status === 'BLOCK' || finding.blocking === true)
            );

            assert.ok(
                layoutFieldBlocker,
                'expected layout.fieldReference blocker for Account.DOB__c'
            );
        }
    );

    await runTest(
        'T7: Account EXISTS + Account.DOB__c EXISTS is not blocked',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['DOB__c'])
            });

            const destinationStates = new Map([
                ['CustomObject:Account', 'EXISTS'],
                ['CustomField:Account.DOB__c', 'EXISTS']
            ]);

            const selectedMetadata = [
                {
                    metadataType: 'Layout',
                    metadataName: ACCOUNT_GYM_LAYOUT,
                    filePath: ACCOUNT_GYM_LAYOUT_PATH
                }
            ];

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata
            });

            const fieldBlocker = (pipeline.compatibility.findings || []).find(
                (finding) =>
                    finding.metadataType === 'CustomField' &&
                    finding.metadataName === 'Account.DOB__c' &&
                    (finding.status === 'BLOCK' || finding.blocking === true)
            );

            assert.strictEqual(fieldBlocker, undefined);
            assert.notStrictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );
        }
    );

    await runTest(
        'T8: WorkAccess parent MISSING blocks before deployment',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: WORKACCESS_LAYOUT,
                layoutPath: WORKACCESS_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['Name'])
            });

            const destinationStates = new Map([
                ['CustomObject:WorkAccess', 'MISSING']
            ]);

            const selectedMetadata = [
                {
                    metadataType: 'Layout',
                    metadataName: WORKACCESS_LAYOUT,
                    filePath: WORKACCESS_LAYOUT_PATH
                }
            ];

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata,
                artifactFlags: {
                    'CustomObject:WorkAccess': {
                        artifactResolved: false,
                        sourceExists: false
                    }
                }
            });

            assert.strictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );

            const parentBlocker = (pipeline.compatibility.findings || []).find(
                (finding) =>
                    finding.ruleId === 'layout.parentObject' &&
                    finding.metadataName === 'WorkAccess' &&
                    (finding.status === 'BLOCK' || finding.blocking === true)
            );

            assert.ok(
                parentBlocker,
                'expected layout.parentObject blocker for WorkAccess'
            );
        }
    );

    await runTest(
        'T9: WorkAccess parent EXISTS passes parent dependency validation',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: WORKACCESS_LAYOUT,
                layoutPath: WORKACCESS_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['Name'])
            });

            const destinationStates = new Map([
                ['CustomObject:WorkAccess', 'EXISTS']
            ]);

            const selectedMetadata = [
                {
                    metadataType: 'Layout',
                    metadataName: WORKACCESS_LAYOUT,
                    filePath: WORKACCESS_LAYOUT_PATH
                }
            ];

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata
            });

            const parentBlocker = (pipeline.compatibility.findings || []).find(
                (finding) =>
                    finding.metadataType === 'CustomObject' &&
                    finding.metadataName === 'WorkAccess' &&
                    (finding.status === 'BLOCK' || finding.blocking === true)
            );

            assert.strictEqual(parentBlocker, undefined);
        }
    );

    await runTest(
        'T11: two layouts keep independent field dependencies',
        async () => {
            const accountDiscovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['DOB__c'])
            });

            const workAccessDiscovery = await discoverLayoutReferences({
                layoutMemberName: WORKACCESS_LAYOUT,
                layoutPath: WORKACCESS_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['Access_Code__c'])
            });

            const accountField = (accountDiscovery.references || []).find(
                (ref) => ref.metadataType === 'CustomField'
            );
            const workAccessField = (workAccessDiscovery.references || []).find(
                (ref) => ref.metadataType === 'CustomField'
            );

            assert.strictEqual(accountField?.name, 'Account.DOB__c');
            assert.strictEqual(
                workAccessField?.name,
                'WorkAccess.Access_Code__c'
            );
        }
    );

    await runTest(
        'REGRESSION: Account-Gym Member Layout production failure is blocked pre-deploy',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['DOB__c'])
            });

            const destinationStates = new Map([
                ['CustomObject:Account', 'EXISTS'],
                ['CustomField:Account.DOB__c', 'MISSING']
            ]);

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: ACCOUNT_GYM_LAYOUT,
                        filePath: ACCOUNT_GYM_LAYOUT_PATH
                    }
                ],
                artifactFlags: {
                    'CustomField:Account.DOB__c': {
                        artifactResolved: false,
                        sourceExists: false
                    }
                }
            });

            assert.strictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );

            const fieldFinding = (pipeline.compatibility.findings || []).find(
                (finding) =>
                    finding.metadataName === 'Account.DOB__c' &&
                    (finding.status === 'BLOCK' ||
                        finding.status === 'FAIL' ||
                        finding.blocking === true)
            );

            assert.ok(fieldFinding);
            assert.ok(
                /missing|does not exist/i.test(String(fieldFinding.reason || '')),
                `unexpected reason: ${fieldFinding.reason}`
            );
        }
    );

    await runTest(
        'REGRESSION: WorkAccess-Access Layout production failure is blocked pre-deploy',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: WORKACCESS_LAYOUT,
                layoutPath: WORKACCESS_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['Name'])
            });

            const destinationStates = new Map([
                ['CustomObject:WorkAccess', 'MISSING']
            ]);

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: WORKACCESS_LAYOUT,
                        filePath: WORKACCESS_LAYOUT_PATH
                    }
                ],
                artifactFlags: {
                    'CustomObject:WorkAccess': {
                        artifactResolved: false,
                        sourceExists: false
                    }
                }
            });

            assert.strictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );

            const parentFinding = (pipeline.compatibility.findings || []).find(
                (finding) =>
                    finding.metadataName === 'WorkAccess' &&
                    (finding.status === 'BLOCK' ||
                        finding.status === 'FAIL' ||
                        finding.blocking === true)
            );

            assert.ok(parentFinding);
            assert.ok(
                /missing|does not exist/i.test(String(parentFinding.reason || '')),
                `unexpected reason: ${parentFinding.reason}`
            );
        }
    );

    await runTest(
        'T13: production Account-Gym Layout discovers parent, fields, and related lists',
        async () => {
            const result = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildProductionAccountGymLayoutXml()
            });

            const refs = result.references || [];

            assert.ok(findReference(refs, 'CustomObject', 'Account'));
            assert.ok(findReference(refs, 'CustomField', 'Account.DOB__c'));
            assert.ok(findReference(refs, 'CustomField', 'Account.Address__c'));
            assert.ok(findReference(refs, 'CustomField', 'Account.F__c'));
            assert.ok(findReference(refs, 'CustomField', 'Account.Email__c'));
            assert.ok(
                findReference(refs, 'CustomField', 'Lead.Converted_Account__c')
            );
            assert.ok(
                findReference(refs, 'CustomField', 'Gym_Trainer__c.Gym_Member__c')
            );
            assert.ok(
                findReference(refs, 'CustomField', 'Payment__c.Account__c')
            );

            assert.strictEqual(
                findReference(refs, 'CustomField', 'Account.Name'),
                undefined
            );
            assert.strictEqual(
                findReference(refs, 'CustomField', 'Account.ParentId'),
                undefined
            );
            assert.strictEqual(
                findReference(refs, 'CustomField', 'Account.Phone'),
                undefined
            );
            assert.strictEqual(
                findReference(refs, 'CustomField', 'Account.FULL_NAME'),
                undefined
            );
            assert.strictEqual(
                findReference(refs, 'CustomField', 'Lead.COMPANY'),
                undefined
            );
        }
    );

    await runTest(
        'T14: related list Lead.Converted_Account__c blocks when dest and source missing',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([
                    'Lead.Converted_Account__c'
                ])
            });

            const destinationStates = new Map([
                ['CustomObject:Account', 'EXISTS'],
                ['CustomField:Account.DOB__c', 'EXISTS'],
                ['CustomField:Lead.Converted_Account__c', 'MISSING']
            ]);

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: ACCOUNT_GYM_LAYOUT,
                        filePath: ACCOUNT_GYM_LAYOUT_PATH
                    }
                ],
                artifactFlags: {
                    'CustomField:Lead.Converted_Account__c': {
                        artifactResolved: false,
                        sourceExists: false
                    }
                }
            });

            assert.strictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );

            const relatedListBlocker = (
                pipeline.compatibility.findings || []
            ).find(
                (finding) =>
                    finding.metadataName === 'Lead.Converted_Account__c' &&
                    finding.ruleId === 'layout.fieldReference'
            );

            assert.ok(relatedListBlocker);
        }
    );

    await runTest(
        'T15: multiple relatedLists discovered without duplicates',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([
                    'Lead.Converted_Account__c',
                    'Gym_Trainer__c.Gym_Member__c',
                    'Payment__c.Account__c'
                ])
            });

            assert.strictEqual(
                findReferences(
                    discovery.references,
                    'CustomField',
                    'Lead.Converted_Account__c'
                ).length,
                1
            );
            assert.ok(
                findReference(
                    discovery.references,
                    'CustomField',
                    'Gym_Trainer__c.Gym_Member__c'
                )
            );
            assert.ok(
                findReference(
                    discovery.references,
                    'CustomField',
                    'Payment__c.Account__c'
                )
            );
        }
    );

    await runTest(
        'T16: customButtons discover WebLink references',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([], `
    <customButtons>Send_Invoice__c</customButtons>
    <customButtons>Submit</customButtons>`)
            });

            const webLink = findReference(
                discovery.references,
                'WebLink',
                'Account.Send_Invoice__c'
            );

            assert.ok(webLink);
            assert.strictEqual(webLink.referenceType, 'CustomButton');
            assert.strictEqual(
                findReference(discovery.references, 'WebLink', 'Account.Submit'),
                undefined
            );
        }
    );

    await runTest(
        'T17: quickActionList discovers non-standard quick actions as deferred',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([], `
    <quickActionList>
        <quickActionListItems>
            <quickActionName>Account.Custom_Action__c</quickActionName>
        </quickActionListItems>
        <quickActionListItems>
            <quickActionName>Edit</quickActionName>
        </quickActionListItems>
    </quickActionList>`)
            });

            const quickAction = findReference(
                discovery.references,
                'QuickAction',
                'Account.Custom_Action__c'
            );

            assert.ok(quickAction);
            assert.strictEqual(quickAction.deployable, false);
            assert.strictEqual(quickAction.blocking, false);
        }
    );

    await runTest(
        'T18: platformActionList discovers custom actions as deferred',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([], `
    <platformActionList>
        <platformActionListItems>
            <actionName>Account.Platform_Action__c</actionName>
        </platformActionListItems>
        <platformActionListItems>
            <actionName>FeedItem.TextPost</actionName>
        </platformActionListItems>
    </platformActionList>`)
            });

            const action = findReference(
                discovery.references,
                'QuickAction',
                'Account.Platform_Action__c'
            );

            assert.ok(action);
            assert.strictEqual(action.referenceType, 'PlatformAction');
            assert.strictEqual(action.blocking, false);
        }
    );

    await runTest(
        'T19: relatedObjects ParentId does not create false dependency',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([], `
    <relatedObjects>ParentId</relatedObjects>`)
            });

            assert.strictEqual(
                findReference(discovery.references, 'CustomField', 'Account.ParentId'),
                undefined
            );
        }
    );

    await runTest(
        'T20: destination EXISTS avoids unnecessary field deployment block',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildProductionAccountGymLayoutXml()
            });

            const destinationStates = new Map([
                ['CustomObject:Account', 'EXISTS'],
                ['CustomField:Account.DOB__c', 'EXISTS'],
                ['CustomField:Account.Address__c', 'EXISTS'],
                ['CustomField:Account.F__c', 'EXISTS'],
                ['CustomField:Account.Email__c', 'EXISTS'],
                ['CustomField:Lead.Converted_Account__c', 'EXISTS'],
                ['CustomField:Gym_Trainer__c.Gym_Member__c', 'EXISTS'],
                ['CustomField:Payment__c.Account__c', 'EXISTS']
            ]);

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: ACCOUNT_GYM_LAYOUT,
                        filePath: ACCOUNT_GYM_LAYOUT_PATH
                    }
                ]
            });

            const blockers = (pipeline.compatibility.findings || []).filter(
                (finding) =>
                    finding.status === 'BLOCK' || finding.blocking === true
            );

            assert.strictEqual(blockers.length, 0);
            assert.notStrictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );
        }
    );

    await runTest(
        'T21: destination MISSING + source EXISTS allows deploy scheduling',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([
                    'Lead.Converted_Account__c'
                ])
            });

            const destinationStates = new Map([
                ['CustomObject:Account', 'EXISTS'],
                ['CustomField:Lead.Converted_Account__c', 'MISSING']
            ]);

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: ACCOUNT_GYM_LAYOUT,
                        filePath: ACCOUNT_GYM_LAYOUT_PATH
                    }
                ],
                artifactFlags: {
                    'CustomField:Lead.Converted_Account__c': {
                        artifactResolved: true,
                        sourceExists: true
                    }
                }
            });

            const relatedListPass = (pipeline.compatibility.findings || []).find(
                (finding) =>
                    finding.metadataName === 'Lead.Converted_Account__c' &&
                    finding.ruleId === 'layout.fieldReference' &&
                    finding.status === 'PASS'
            );

            assert.ok(relatedListPass);
            assert.notStrictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );
        }
    );

    await runTest(
        'T22: Gym_Trainer__c.Gym_Member__c emits parent CustomObject and CustomField',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([
                    'Gym_Trainer__c.Gym_Member__c'
                ])
            });

            const refs = discovery.references || [];

            assert.ok(
                findReference(refs, 'CustomObject', 'Gym_Trainer__c'),
                'expected CustomObject:Gym_Trainer__c'
            );
            assert.ok(
                findReference(
                    refs,
                    'CustomField',
                    'Gym_Trainer__c.Gym_Member__c'
                ),
                'expected CustomField:Gym_Trainer__c.Gym_Member__c'
            );
        }
    );

    await runTest(
        'T23: Payment__c.Account__c emits parent CustomObject and CustomField',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([
                    'Payment__c.Account__c'
                ])
            });

            const refs = discovery.references || [];

            assert.ok(findReference(refs, 'CustomObject', 'Payment__c'));
            assert.ok(
                findReference(refs, 'CustomField', 'Payment__c.Account__c')
            );
        }
    );

    await runTest(
        'T24: Lead.Converted_Account__c emits CustomField only without CustomObject:Lead',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([
                    'Lead.Converted_Account__c'
                ])
            });

            const refs = discovery.references || [];

            assert.ok(
                findReference(refs, 'CustomField', 'Lead.Converted_Account__c')
            );
            assert.strictEqual(findReference(refs, 'CustomObject', 'Lead'), undefined);
        }
    );

    await runTest(
        'T25: Layout parent Account and Account fields do not duplicate CustomObject:Account',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXml(['DOB__c', 'Address__c'])
            });

            assert.strictEqual(
                findReferences(discovery.references, 'CustomObject', 'Account')
                    .length,
                1
            );
        }
    );

    await runTest(
        'T26: related-list display fields remain ignored',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: `<?xml version="1.0" encoding="UTF-8"?>
<Layout xmlns="http://soap.sforce.com/2006/04/metadata">
    <relatedLists>
        <fields>FULL_NAME</fields>
        <fields>NAME</fields>
        <fields>LEAD.COMPANY</fields>
        <fields>LEAD.PHONE</fields>
        <relatedList>Lead.Converted_Account__c</relatedList>
    </relatedLists>
</Layout>`
            });

            const refs = discovery.references || [];

            assert.strictEqual(
                findReference(refs, 'CustomField', 'Account.FULL_NAME'),
                undefined
            );
            assert.strictEqual(
                findReference(refs, 'CustomField', 'Account.NAME'),
                undefined
            );
            assert.strictEqual(
                findReference(refs, 'CustomField', 'Lead.COMPANY'),
                undefined
            );
            assert.strictEqual(
                findReference(refs, 'CustomField', 'Lead.PHONE'),
                undefined
            );
        }
    );

    await runTest(
        'T27: source object and field available with destination missing schedules DEPLOY for both',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([
                    'Gym_Trainer__c.Gym_Member__c',
                    'Payment__c.Account__c'
                ])
            });

            const destinationStates = new Map([
                ['CustomObject:Account', 'EXISTS'],
                ['CustomObject:Gym_Trainer__c', 'MISSING'],
                ['CustomField:Gym_Trainer__c.Gym_Member__c', 'MISSING'],
                ['CustomObject:Payment__c', 'MISSING'],
                ['CustomField:Payment__c.Account__c', 'MISSING']
            ]);

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: ACCOUNT_GYM_LAYOUT,
                        filePath: ACCOUNT_GYM_LAYOUT_PATH
                    }
                ],
                artifactFlags: {
                    'CustomObject:Gym_Trainer__c': {
                        artifactResolved: true,
                        sourceExists: true
                    },
                    'CustomField:Gym_Trainer__c.Gym_Member__c': {
                        artifactResolved: true,
                        sourceExists: true
                    },
                    'CustomObject:Payment__c': {
                        artifactResolved: true,
                        sourceExists: true
                    },
                    'CustomField:Payment__c.Account__c': {
                        artifactResolved: true,
                        sourceExists: true
                    }
                }
            });

            const gymTrainerObject = findResolvedDependency(
                pipeline.resolvedDependencies,
                'CustomObject',
                'Gym_Trainer__c'
            );
            const gymTrainerField = findResolvedDependency(
                pipeline.resolvedDependencies,
                'CustomField',
                'Gym_Trainer__c.Gym_Member__c'
            );
            const paymentObject = findResolvedDependency(
                pipeline.resolvedDependencies,
                'CustomObject',
                'Payment__c'
            );
            const paymentField = findResolvedDependency(
                pipeline.resolvedDependencies,
                'CustomField',
                'Payment__c.Account__c'
            );

            assert.strictEqual(gymTrainerObject?.action, 'DEPLOY');
            assert.strictEqual(gymTrainerField?.action, 'DEPLOY');
            assert.strictEqual(paymentObject?.action, 'DEPLOY');
            assert.strictEqual(paymentField?.action, 'DEPLOY');

            const packageObjects = getPackageMemberNames(
                pipeline.generatedPackage,
                'CustomObject'
            );
            const packageFields = getPackageMemberNames(
                pipeline.generatedPackage,
                'CustomField'
            );

            assert.ok(packageObjects.includes('Gym_Trainer__c'));
            assert.ok(packageObjects.includes('Payment__c'));
            assert.ok(packageFields.includes('Gym_Trainer__c.Gym_Member__c'));
            assert.ok(packageFields.includes('Payment__c.Account__c'));

            assert.notStrictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );
        }
    );

    await runTest(
        'T28: missing source object blocks deployment via artifact.exists',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildLayoutXmlWithRelatedLists([
                    'Gym_Trainer__c.Gym_Member__c'
                ])
            });

            const destinationStates = new Map([
                ['CustomObject:Account', 'EXISTS'],
                ['CustomObject:Gym_Trainer__c', 'MISSING'],
                ['CustomField:Gym_Trainer__c.Gym_Member__c', 'MISSING']
            ]);

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: ACCOUNT_GYM_LAYOUT,
                        filePath: ACCOUNT_GYM_LAYOUT_PATH
                    }
                ],
                artifactFlags: {
                    'CustomObject:Gym_Trainer__c': {
                        artifactResolved: false,
                        sourceExists: false
                    },
                    'CustomField:Gym_Trainer__c.Gym_Member__c': {
                        artifactResolved: true,
                        sourceExists: true
                    }
                }
            });

            assert.strictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );

            const artifactBlocker = (pipeline.compatibility.findings || []).find(
                (finding) =>
                    finding.ruleId === 'artifact.exists' &&
                    finding.metadataName === 'Gym_Trainer__c' &&
                    (finding.status === 'FAIL' ||
                        finding.status === 'BLOCK' ||
                        finding.blocking === true)
            );

            assert.ok(artifactBlocker);
        }
    );

    await runTest(
        'INTEGRATION: production Account-Gym Layout package includes related-list parent objects',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildProductionAccountGymLayoutXml()
            });

            const destinationStates = new Map([
                ['CustomObject:Account', 'EXISTS'],
                ['CustomObject:Gym_Trainer__c', 'MISSING'],
                ['CustomField:Gym_Trainer__c.Gym_Member__c', 'MISSING'],
                ['CustomObject:Payment__c', 'MISSING'],
                ['CustomField:Payment__c.Account__c', 'MISSING'],
                ['CustomField:Lead.Converted_Account__c', 'EXISTS'],
                ['CustomField:Account.DOB__c', 'EXISTS'],
                ['CustomField:Account.Address__c', 'EXISTS'],
                ['CustomField:Account.F__c', 'EXISTS'],
                ['CustomField:Account.Email__c', 'EXISTS']
            ]);

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: ACCOUNT_GYM_LAYOUT,
                        filePath: ACCOUNT_GYM_LAYOUT_PATH
                    }
                ],
                artifactFlags: {
                    'CustomObject:Gym_Trainer__c': {
                        artifactResolved: true,
                        sourceExists: true
                    },
                    'CustomField:Gym_Trainer__c.Gym_Member__c': {
                        artifactResolved: true,
                        sourceExists: true
                    },
                    'CustomObject:Payment__c': {
                        artifactResolved: true,
                        sourceExists: true
                    },
                    'CustomField:Payment__c.Account__c': {
                        artifactResolved: true,
                        sourceExists: true
                    }
                }
            });

            assert.ok(
                getPackageMemberNames(pipeline.generatedPackage, 'Layout').includes(
                    ACCOUNT_GYM_LAYOUT
                )
            );
            assert.ok(
                getPackageMemberNames(
                    pipeline.generatedPackage,
                    'CustomField'
                ).includes('Gym_Trainer__c.Gym_Member__c')
            );
            assert.ok(
                getPackageMemberNames(
                    pipeline.generatedPackage,
                    'CustomField'
                ).includes('Payment__c.Account__c')
            );
            assert.ok(
                getPackageMemberNames(
                    pipeline.generatedPackage,
                    'CustomObject'
                ).includes('Gym_Trainer__c')
            );
            assert.ok(
                getPackageMemberNames(
                    pipeline.generatedPackage,
                    'CustomObject'
                ).includes('Payment__c')
            );
            assert.notStrictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );
        }
    );

    await runTest(
        'REGRESSION: production relatedList Lead.Converted_Account__c blocked pre-deploy',
        async () => {
            const discovery = await discoverLayoutReferences({
                layoutMemberName: ACCOUNT_GYM_LAYOUT,
                layoutPath: ACCOUNT_GYM_LAYOUT_PATH,
                layoutXml: buildProductionAccountGymLayoutXml()
            });

            const destinationStates = new Map([
                ['CustomObject:Account', 'EXISTS'],
                ['CustomField:Account.DOB__c', 'MISSING'],
                ['CustomField:Account.Address__c', 'MISSING'],
                ['CustomField:Account.F__c', 'MISSING'],
                ['CustomField:Account.Email__c', 'MISSING'],
                ['CustomField:Lead.Converted_Account__c', 'MISSING'],
                ['CustomField:Gym_Trainer__c.Gym_Member__c', 'MISSING'],
                ['CustomField:Payment__c.Account__c', 'MISSING']
            ]);

            const artifactFlags = {
                'CustomField:Account.DOB__c': {
                    artifactResolved: false,
                    sourceExists: false
                },
                'CustomField:Lead.Converted_Account__c': {
                    artifactResolved: false,
                    sourceExists: false
                }
            };

            const pipeline = await resolveLayoutPipeline({
                discoveredReferences: discovery.references,
                destinationStates,
                selectedMetadata: [
                    {
                        metadataType: 'Layout',
                        metadataName: ACCOUNT_GYM_LAYOUT,
                        filePath: ACCOUNT_GYM_LAYOUT_PATH
                    }
                ],
                artifactFlags
            });

            assert.strictEqual(
                pipeline.compatibility.overallCompatibility,
                'BLOCKED'
            );

            const leadRelatedListBlocker = (
                pipeline.compatibility.findings || []
            ).find(
                (finding) =>
                    finding.metadataName === 'Lead.Converted_Account__c' &&
                    (finding.status === 'BLOCK' || finding.blocking === true)
            );

            assert.ok(leadRelatedListBlocker);
        }
    );

    await runTest(
        'T12: FlexiPage dependency discovery remains unchanged',
        async () => {
            const flexiPagePath =
                'force-app/main/default/flexipages/Test_Page.flexipage-meta.xml';
            const flexiPageXml = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Account</sobjectType>
    <flexiPageRegions>
        <itemInstances>
            <fieldInstance>
                <fieldItem>Record.Custom_Field__c</fieldItem>
            </fieldInstance>
        </itemInstances>
    </flexiPageRegions>
</FlexiPage>`;

            const result = await flexiPageReferenceDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'FlexiPage',
                        metadataName: 'Test_Page',
                        filePath: flexiPagePath
                    }
                ],
                repoFiles: [flexiPagePath],
                readRepoFile: async () => flexiPageXml
            });

            const fieldRef = (result.references || []).find(
                (ref) => ref.name === 'Account.Custom_Field__c'
            );

            assert.ok(fieldRef);
            assert.strictEqual(fieldRef.discoveryMethod, 'flexiPageReference');
        }
    );
}

main();
