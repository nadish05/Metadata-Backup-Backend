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
