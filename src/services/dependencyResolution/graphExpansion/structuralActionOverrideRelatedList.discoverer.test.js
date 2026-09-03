const assert = require('assert');

const customObjectGraphDiscoverer = require('./discoverers/customObject.graphDiscoverer');
const flexiPageGraphDiscoverer = require('./discoverers/flexiPage.graphDiscoverer');
const {
    collectDestinationInventoryItems
} = require('../../destinationInventory/destinationInventoryCandidateCollector.service');
const {
    DISCOVERY_METHOD,
    discoverStructuralActionOverrideFlexiPageRelatedLists,
    discoverStructuralActionOverrideRelatedLists,
    extractDynamicRelatedListReferences,
    isStructuralActionOverrideFlexiPageDependency,
    parseRelationshipNameFromRelatedListApiName,
    parseRelatedListFieldAlias,
    resolveRelationshipDefiningField
} = require('./structuralActionOverrideRelatedList.discoverer');
const structuralActionOverrideRelatedListResolver = require('../resolvers/structuralActionOverrideRelatedList.resolver');
const {
    resolveDependencies,
    ACTIONS
} = require('../dependencyResolution.service');
const {
    mergeUniqueDependencies
} = require('./structuralFormulaRelatedField.closure.service');
const { METADATA_ORIGINS } = require('../metadataGraphOrigin.model');
const {
    STRUCTURAL_MASTER_DETAIL_PARENT_DISCOVERY_METHOD
} = require('../discoverers/customObjectRelationship.discoverer');

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
const SUBSCRIPTION_RECORD_PAGE_PATH =
    'force-app/main/default/flexipages/Subscription_Record_Page.flexipage-meta.xml';
const SESSION_OBJECT_PATH =
    'force-app/main/default/objects/Session__c/Session__c.object-meta.xml';
const SESSION_MEMBER_DEMO_FIELD_PATH =
    'force-app/main/default/objects/Session__c/fields/Member_demo__c.field-meta.xml';
const SESSION_SUBSCRIPTION_FIELD_PATH =
    'force-app/main/default/objects/Session__c/fields/Subscription__c.field-meta.xml';
const SESSION_GYM_TRAINER_FIELD_PATH =
    'force-app/main/default/objects/Session__c/fields/Gym_Trainer__c.field-meta.xml';
const SESSION_ACCOUNT_FIELD_PATH =
    'force-app/main/default/objects/Session__c/fields/Account__c.field-meta.xml';
const SESSION_STATUS_FIELD_PATH =
    'force-app/main/default/objects/Session__c/fields/Status__c.field-meta.xml';

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
                    <value>Sessions__r</value>
                </componentInstanceProperties>
                <componentInstanceProperties>
                    <name>relatedListFieldAliases</name>
                    <value>NAME</value>
                </componentInstanceProperties>
                <componentInstanceProperties>
                    <name>relatedListFieldAliases</name>
                    <value>Status__c</value>
                </componentInstanceProperties>
                <componentInstanceProperties>
                    <name>relatedListFieldAliases</name>
                    <value>Gym_Trainer__c</value>
                </componentInstanceProperties>
                <componentName>lst:dynamicRelatedList</componentName>
            </componentInstance>
        </itemInstances>
    </flexiPageRegions>
</FlexiPage>`;

const MEMBER_RECORD_PAGE_VALUE_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Member__c</sobjectType>
    <masterLabel>Member Record Page</masterLabel>
    <type>RecordPage</type>
    <flexiPageRegions>
        <itemInstances>
            <componentInstance>
                <componentInstanceProperties>
                    <name>relatedListApiName</name>
                    <value>Sessions__r</value>
                </componentInstanceProperties>
                <componentInstanceProperties>
                    <name>relatedListFieldAliases</name>
                    <valueList>
                        <valueListItems>
                            <value>NAME</value>
                        </valueListItems>
                        <valueListItems>
                            <value>Status__c</value>
                        </valueListItems>
                        <valueListItems>
                            <value>Gym_Trainer__c</value>
                        </valueListItems>
                    </valueList>
                </componentInstanceProperties>
                <componentName>lst:dynamicRelatedList</componentName>
            </componentInstance>
        </itemInstances>
    </flexiPageRegions>
</FlexiPage>`;

const SUBSCRIPTION_RECORD_PAGE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexiPage xmlns="http://soap.sforce.com/2006/04/metadata">
    <sobjectType>Subscription__c</sobjectType>
    <masterLabel>Subscription Record Page</masterLabel>
    <type>RecordPage</type>
    <flexiPageRegions>
        <itemInstances>
            <componentInstance>
                <componentInstanceProperties>
                    <name>relatedListApiName</name>
                    <value>Sessions__r</value>
                </componentInstanceProperties>
                <componentName>lst:dynamicRelatedList</componentName>
            </componentInstance>
        </itemInstances>
    </flexiPageRegions>
</FlexiPage>`;

const SESSION_MEMBER_DEMO_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Member_demo__c</fullName>
    <referenceTo>Member__c</referenceTo>
    <relationshipName>Sessions</relationshipName>
    <type>Lookup</type>
</CustomField>`;

const SESSION_SUBSCRIPTION_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Subscription__c</fullName>
    <referenceTo>Subscription__c</referenceTo>
    <relationshipName>Sessions</relationshipName>
    <type>Lookup</type>
</CustomField>`;

const SESSION_GYM_TRAINER_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Gym_Trainer__c</fullName>
    <referenceTo>Gym_Trainer__c</referenceTo>
    <relationshipName>Sessions</relationshipName>
    <type>Lookup</type>
</CustomField>`;

const SESSION_ACCOUNT_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Account__c</fullName>
    <referenceTo>Account</referenceTo>
    <relationshipName>Sessions</relationshipName>
    <type>Lookup</type>
</CustomField>`;

const SESSION_STATUS_FIELD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Status__c</fullName>
    <type>Picklist</type>
</CustomField>`;

const FILE_CONTENT = {
    [MEMBER_RECORD_PAGE_PATH]: MEMBER_RECORD_PAGE_XML,
    [SUBSCRIPTION_RECORD_PAGE_PATH]: SUBSCRIPTION_RECORD_PAGE_XML,
    [SESSION_MEMBER_DEMO_FIELD_PATH]: SESSION_MEMBER_DEMO_FIELD_XML,
    [SESSION_SUBSCRIPTION_FIELD_PATH]: SESSION_SUBSCRIPTION_FIELD_XML,
    [SESSION_GYM_TRAINER_FIELD_PATH]: SESSION_GYM_TRAINER_FIELD_XML,
    [SESSION_ACCOUNT_FIELD_PATH]: SESSION_ACCOUNT_FIELD_XML,
    [SESSION_STATUS_FIELD_PATH]: SESSION_STATUS_FIELD_XML,
    [SESSION_OBJECT_PATH]: `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Session</label>
</CustomObject>`
};

const REPO_FILES = Object.keys(FILE_CONTENT);

function createReadRepoFile(files = FILE_CONTENT) {
    return async (targetPath) => {
        if (!files[targetPath]) {
            throw new Error(`Missing fixture file: ${targetPath}`);
        }

        return files[targetPath];
    };
}

function createStructuralFlexiPageDependency(name, filePath, overrides = {}) {
    return {
        name,
        metadataType: 'FlexiPage',
        type: 'FlexiPage',
        relationship: 'ActionOverride',
        discoveryMethod: 'actionOverrides',
        origin: METADATA_ORIGINS.DIRECT_DEPENDENCY,
        filePath,
        required: true,
        selected: true,
        deployable: true,
        blocking: true,
        ...overrides
    };
}

function getRelationshipNames(result) {
    return (result.relationships || result.dependencies || []).map(
        (item) => item.name
    );
}

function getSessionCustomFieldNames(result) {
    return getRelationshipNames(result)
        .filter((name) => name.startsWith('Session__c.'))
        .sort();
}

async function discoverMemberRecordPageFields(memberRecordPageXml) {
    return discoverStructuralActionOverrideRelatedLists({
        structuralFlexiPageDependencies: [
            createStructuralFlexiPageDependency(
                'Member_Record_Page',
                MEMBER_RECORD_PAGE_PATH
            )
        ],
        readRepoFile: async (targetPath) => {
            if (targetPath === MEMBER_RECORD_PAGE_PATH) {
                return memberRecordPageXml;
            }

            return createReadRepoFile()(targetPath);
        },
        repoFiles: REPO_FILES
    });
}

async function main() {
    await runTest('TEST 1: Member_Record_Page extracts Sessions__r', () => {
        const references = extractDynamicRelatedListReferences(
            MEMBER_RECORD_PAGE_XML
        );

        assert.deepStrictEqual(
            references.map((item) => item.relatedListApiName),
            ['Sessions__r']
        );
        assert.deepStrictEqual(references[0].relatedListFieldAliases, [
            'NAME',
            'Status__c',
            'Gym_Trainer__c'
        ]);
    });

    await runTest('TEST 1A: NAME related-list alias is ignored', () => {
        assert.strictEqual(
            parseRelatedListFieldAlias('NAME', 'Session__c'),
            null
        );
    });

    await runTest('TEST 1B: Status__c resolves to Session__c.Status__c', () => {
        assert.deepStrictEqual(
            parseRelatedListFieldAlias('Status__c', 'Session__c'),
            {
                fieldApiName: 'Status__c',
                qualifiedName: 'Session__c.Status__c'
            }
        );
    });

    await runTest(
        'TEST 1C: Gym_Trainer__c resolves to Session__c.Gym_Trainer__c',
        () => {
            assert.deepStrictEqual(
                parseRelatedListFieldAlias('Gym_Trainer__c', 'Session__c'),
                {
                    fieldApiName: 'Gym_Trainer__c',
                    qualifiedName: 'Session__c.Gym_Trainer__c'
                }
            );
        }
    );

    await runTest(
        'TEST 1D: production valueList XML extracts all relatedListFieldAliases',
        () => {
            const references = extractDynamicRelatedListReferences(
                MEMBER_RECORD_PAGE_VALUE_LIST_XML
            );

            assert.deepStrictEqual(references[0].relatedListFieldAliases, [
                'NAME',
                'Status__c',
                'Gym_Trainer__c'
            ]);
        }
    );

    await runTest(
        'TEST 1E: flat XML Member_Record_Page discovers relationship and column fields',
        async () => {
            const discovery = await discoverMemberRecordPageFields(
                MEMBER_RECORD_PAGE_XML
            );

            assert.deepStrictEqual(getSessionCustomFieldNames(discovery), [
                'Session__c.Gym_Trainer__c',
                'Session__c.Member_demo__c',
                'Session__c.Status__c'
            ]);
            assert.ok(
                !getSessionCustomFieldNames(discovery).includes(
                    'Session__c.Account__c'
                )
            );
            assert.ok(
                !getSessionCustomFieldNames(discovery).includes(
                    'Session__c.Subscription__c'
                )
            );
        }
    );

    await runTest(
        'TEST 1F: production valueList XML Member_Record_Page discovers relationship and column fields',
        async () => {
            const discovery = await discoverMemberRecordPageFields(
                MEMBER_RECORD_PAGE_VALUE_LIST_XML
            );

            assert.deepStrictEqual(getSessionCustomFieldNames(discovery), [
                'Session__c.Gym_Trainer__c',
                'Session__c.Member_demo__c',
                'Session__c.Status__c'
            ]);
            assert.ok(
                !getSessionCustomFieldNames(discovery).includes(
                    'Session__c.Account__c'
                )
            );
            assert.ok(
                !getSessionCustomFieldNames(discovery).includes(
                    'Session__c.Subscription__c'
                )
            );
        }
    );

    await runTest(
        'TEST 2: Subscription_Record_Page extracts Sessions__r',
        () => {
            const references = extractDynamicRelatedListReferences(
                SUBSCRIPTION_RECORD_PAGE_XML
            );

            assert.deepStrictEqual(
                references.map((item) => item.relatedListApiName),
                ['Sessions__r']
            );
        }
    );

    await runTest(
        'TEST 3: Member__c resolves to Session__c.Member_demo__c',
        async () => {
            const resolved = await resolveRelationshipDefiningField({
                relationshipName: 'Sessions',
                referenceTo: 'Member__c',
                repoFiles: REPO_FILES,
                readRepoFile: createReadRepoFile()
            });

            assert.strictEqual(resolved.qualifiedName, 'Session__c.Member_demo__c');
        }
    );

    await runTest(
        'TEST 4: Subscription__c resolves to Session__c.Subscription__c',
        async () => {
            const resolved = await resolveRelationshipDefiningField({
                relationshipName: 'Sessions',
                referenceTo: 'Subscription__c',
                repoFiles: REPO_FILES,
                readRepoFile: createReadRepoFile()
            });

            assert.strictEqual(
                resolved.qualifiedName,
                'Session__c.Subscription__c'
            );
        }
    );

    await runTest(
        'TEST 5: both pages resolve to Session__c with different relationship fields',
        async () => {
            const memberDiscovery =
                await discoverStructuralActionOverrideFlexiPageRelatedLists({
                    objectApiName: 'Member__c',
                    actionOverrideFlexiPages: [
                        {
                            name: 'Member_Record_Page',
                            relationship: 'ActionOverride'
                        }
                    ],
                    repoFiles: REPO_FILES,
                    readRepoFile: createReadRepoFile(),
                    depth: 2
                });

            const subscriptionDiscovery =
                await discoverStructuralActionOverrideFlexiPageRelatedLists({
                    objectApiName: 'Subscription__c',
                    actionOverrideFlexiPages: [
                        {
                            name: 'Subscription_Record_Page',
                            relationship: 'ActionOverride'
                        }
                    ],
                    repoFiles: REPO_FILES,
                    readRepoFile: createReadRepoFile(),
                    depth: 2
                });

            assert.ok(
                memberDiscovery.relationships.some(
                    (item) => item.name === 'Session__c.Member_demo__c'
                )
            );
            assert.ok(
                subscriptionDiscovery.relationships.some(
                    (item) => item.name === 'Session__c.Subscription__c'
                )
            );
            assert.ok(
                memberDiscovery.relationships.some(
                    (item) => item.name === 'Session__c'
                )
            );
            assert.ok(
                subscriptionDiscovery.relationships.some(
                    (item) => item.name === 'Session__c'
                )
            );
        }
    );

    await runTest(
        'TEST 6: shared Sessions relationshipName does not infer Gym_Trainer__c lookup for Member__c',
        async () => {
            const resolved = await resolveRelationshipDefiningField({
                relationshipName: 'Sessions',
                referenceTo: 'Member__c',
                repoFiles: REPO_FILES,
                readRepoFile: createReadRepoFile()
            });

            assert.strictEqual(resolved.qualifiedName, 'Session__c.Member_demo__c');
            assert.notStrictEqual(resolved.qualifiedName, 'Session__c.Gym_Trainer__c');
        }
    );

    await runTest(
        'TEST 7: Account relationship is not selected for Member__c or Subscription__c',
        async () => {
            const memberDiscovery =
                await discoverStructuralActionOverrideFlexiPageRelatedLists({
                    objectApiName: 'Member__c',
                    actionOverrideFlexiPages: [
                        {
                            name: 'Member_Record_Page',
                            relationship: 'ActionOverride'
                        }
                    ],
                    repoFiles: REPO_FILES,
                    readRepoFile: createReadRepoFile(),
                    depth: 2
                });
            const subscriptionDiscovery =
                await discoverStructuralActionOverrideFlexiPageRelatedLists({
                    objectApiName: 'Subscription__c',
                    actionOverrideFlexiPages: [
                        {
                            name: 'Subscription_Record_Page',
                            relationship: 'ActionOverride'
                        }
                    ],
                    repoFiles: REPO_FILES,
                    readRepoFile: createReadRepoFile(),
                    depth: 2
                });

            assert.ok(
                !getRelationshipNames(memberDiscovery).includes(
                    'Session__c.Account__c'
                )
            );
            assert.ok(
                !getRelationshipNames(subscriptionDiscovery).includes(
                    'Session__c.Account__c'
                )
            );
        }
    );

    await runTest(
        'TEST 8A: column field destination EXISTS → SKIP',
        () => {
            const decision = structuralActionOverrideRelatedListResolver.resolve(
                {
                    type: 'CustomField',
                    name: 'Session__c.Gym_Trainer__c',
                    discoveryMethod: DISCOVERY_METHOD,
                    sourceMetadata: 'Member_Record_Page',
                    relationship: 'ActionOverrideRelatedList'
                },
                {
                    destinationStates: new Map([
                        ['CustomField:Session__c.Gym_Trainer__c', 'EXISTS']
                    ])
                }
            );

            assert.strictEqual(decision.action, ACTIONS.SKIP);
        }
    );

    await runTest(
        'TEST 8B: column field destination MISSING → DEPLOY',
        () => {
            const decision = structuralActionOverrideRelatedListResolver.resolve(
                {
                    type: 'CustomField',
                    name: 'Session__c.Status__c',
                    discoveryMethod: DISCOVERY_METHOD,
                    sourceMetadata: 'Member_Record_Page',
                    relationship: 'ActionOverrideRelatedList'
                },
                {
                    destinationStates: new Map([
                        ['CustomField:Session__c.Status__c', 'MISSING']
                    ])
                }
            );

            assert.strictEqual(decision.action, ACTIONS.DEPLOY);
        }
    );

    await runTest(
        'TEST 8: destination EXISTS for object and field → SKIP field',
        async () => {
            const decision = structuralActionOverrideRelatedListResolver.resolve(
                {
                    type: 'CustomField',
                    name: 'Session__c.Member_demo__c',
                    discoveryMethod: DISCOVERY_METHOD,
                    sourceMetadata: 'Member_Record_Page',
                    relationship: 'ActionOverrideRelatedList'
                },
                {
                    destinationStates: new Map([
                        ['CustomField:Session__c.Member_demo__c', 'EXISTS'],
                        ['CustomObject:Session__c', 'EXISTS']
                    ])
                }
            );

            assert.strictEqual(decision.action, ACTIONS.SKIP);
            assert.strictEqual(decision.selected, false);
        }
    );

    await runTest(
        'TEST 9: destination object EXISTS + field MISSING → DEPLOY field only',
        async () => {
            const resolution = await resolveDependencies({
                requiredDependencies: [
                    {
                        type: 'CustomField',
                        name: 'Session__c.Member_demo__c',
                        discoveryMethod: DISCOVERY_METHOD,
                        sourceMetadata: 'Member_Record_Page',
                        relationship: 'ActionOverrideRelatedList',
                        required: true,
                        selected: true
                    },
                    {
                        type: 'CustomObject',
                        name: 'Session__c',
                        discoveryMethod: DISCOVERY_METHOD,
                        sourceMetadata: 'Member_Record_Page',
                        relationship: 'ActionOverrideRelatedList',
                        required: true,
                        selected: true
                    }
                ],
                destinationStates: new Map([
                    ['CustomField:Session__c.Member_demo__c', 'MISSING'],
                    ['CustomObject:Session__c', 'EXISTS']
                ])
            });

            const fieldDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'Session__c.Member_demo__c'
            );
            const objectDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'Session__c'
            );

            assert.strictEqual(fieldDecision.action, ACTIONS.DEPLOY);
            assert.strictEqual(objectDecision.action, ACTIONS.REFERENCE);
        }
    );

    await runTest(
        'TEST 10: destination object MISSING → DEPLOY object shell + field',
        async () => {
            const resolution = await resolveDependencies({
                requiredDependencies: [
                    {
                        type: 'CustomField',
                        name: 'Session__c.Subscription__c',
                        discoveryMethod: DISCOVERY_METHOD,
                        sourceMetadata: 'Subscription_Record_Page',
                        relationship: 'ActionOverrideRelatedList',
                        required: true,
                        selected: true
                    },
                    {
                        type: 'CustomObject',
                        name: 'Session__c',
                        discoveryMethod: DISCOVERY_METHOD,
                        sourceMetadata: 'Subscription_Record_Page',
                        relationship: 'ActionOverrideRelatedList',
                        required: true,
                        selected: true
                    }
                ],
                destinationStates: new Map([
                    ['CustomField:Session__c.Subscription__c', 'MISSING'],
                    ['CustomObject:Session__c', 'MISSING']
                ])
            });

            const fieldDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'Session__c.Subscription__c'
            );
            const objectDecision = resolution.resolvedDependencies.find(
                (item) => item.name === 'Session__c'
            );

            assert.strictEqual(fieldDecision.action, ACTIONS.DEPLOY);
            assert.strictEqual(objectDecision.action, ACTIONS.DEPLOY);
        }
    );

    await runTest(
        'TEST 11: Session__c prerequisite node does not undergo broad expansion',
        async () => {
            const result = await customObjectGraphDiscoverer.discover({
                metadata: {
                    name: 'Session__c',
                    metadataType: 'CustomObject',
                    discoveryMethod: DISCOVERY_METHOD,
                    origin: METADATA_ORIGINS.DIRECT_DEPENDENCY
                },
                repoFiles: REPO_FILES,
                readRepoFile: createReadRepoFile(),
                depth: 2
            });

            assert.deepStrictEqual(result.discoveredNodes, []);
            assert.deepStrictEqual(result.discoveredEdges, []);
        }
    );

    await runTest(
        'TEST 12: no unrelated Session__c fields are emitted',
        async () => {
            const discovery =
                await discoverStructuralActionOverrideFlexiPageRelatedLists({
                    objectApiName: 'Member__c',
                    actionOverrideFlexiPages: [
                        {
                            name: 'Member_Record_Page',
                            relationship: 'ActionOverride'
                        }
                    ],
                    repoFiles: REPO_FILES,
                    readRepoFile: createReadRepoFile(),
                    depth: 2
                });
            const fieldNames = getRelationshipNames(discovery).filter((name) =>
                name.includes('.')
            );

            assert.ok(fieldNames.includes('Session__c.Member_demo__c'));
            assert.ok(fieldNames.includes('Session__c.Status__c'));
            assert.ok(fieldNames.includes('Session__c.Gym_Trainer__c'));
            assert.ok(!fieldNames.includes('Session__c.Account__c'));
            assert.ok(!fieldNames.includes('Session__c.Subscription__c'));
        }
    );

    await runTest(
        'TEST 13: no unrelated Session__c relationships are emitted',
        async () => {
            const discovery =
                await discoverStructuralActionOverrideRelatedLists({
                    structuralFlexiPageDependencies: [
                        createStructuralFlexiPageDependency(
                            'Member_Record_Page',
                            MEMBER_RECORD_PAGE_PATH
                        ),
                        createStructuralFlexiPageDependency(
                            'Subscription_Record_Page',
                            SUBSCRIPTION_RECORD_PAGE_PATH
                        )
                    ],
                    readRepoFile: createReadRepoFile(),
                    repoFiles: REPO_FILES
                });

            const fieldNames = getRelationshipNames(discovery).filter((name) =>
                name.includes('.')
            );

            assert.deepStrictEqual(
                fieldNames.sort(),
                [
                    'Session__c.Gym_Trainer__c',
                    'Session__c.Member_demo__c',
                    'Session__c.Status__c',
                    'Session__c.Subscription__c'
                ].sort()
            );
        }
    );

    await runTest(
        'TEST 14: structural FlexiPage graph guard remains active',
        async () => {
            const result = await flexiPageGraphDiscoverer.discover({
                metadata: {
                    name: 'Member_Record_Page',
                    metadataType: 'FlexiPage',
                    origin: METADATA_ORIGINS.DIRECT_DEPENDENCY,
                    relationship: 'ActionOverride',
                    discoveryMethod: 'actionOverrides'
                },
                repoFiles: REPO_FILES,
                readRepoFile: createReadRepoFile(),
                depth: 2
            });

            assert.deepStrictEqual(result.discoveredNodes, []);
        }
    );

    await runTest(
        'TEST 15: provenance fields are preserved on closure dependencies',
        async () => {
            const discovery = await discoverStructuralActionOverrideRelatedLists(
                {
                    structuralFlexiPageDependencies: [
                        createStructuralFlexiPageDependency(
                            'Member_Record_Page',
                            MEMBER_RECORD_PAGE_PATH
                        )
                    ],
                    readRepoFile: createReadRepoFile(),
                    repoFiles: REPO_FILES
                }
            );

            const fieldDependency = discovery.dependencies.find(
                (item) => item.name === 'Session__c.Member_demo__c'
            );

            assert.ok(fieldDependency);
            assert.strictEqual(fieldDependency.discoveryMethod, DISCOVERY_METHOD);
            assert.strictEqual(
                fieldDependency.sourceMetadata,
                'Member_Record_Page'
            );
            assert.strictEqual(fieldDependency.sourceField, 'Sessions__r');
            assert.strictEqual(
                fieldDependency.relationship,
                'ActionOverrideRelatedList'
            );
            assert.strictEqual(fieldDependency.expansionPolicy, 'PREREQUISITE_ONLY');
            assert.strictEqual(
                fieldDependency.origin,
                METADATA_ORIGINS.DIRECT_DEPENDENCY
            );
        }
    );

    await runTest(
        'TEST 16: mergeUniqueDependencies preserves structuralActionOverrideRelatedList provenance',
        () => {
            const dependency = {
                name: 'Session__c.Member_demo__c',
                type: 'CustomField',
                metadataType: 'CustomField',
                discoveryMethod: DISCOVERY_METHOD,
                sourceMetadata: 'Member_Record_Page',
                sourceField: 'Sessions__r',
                relationship: 'ActionOverrideRelatedList',
                expansionPolicy: 'PREREQUISITE_ONLY',
                origin: 'Member_Record_Page'
            };

            const merged = mergeUniqueDependencies([], [dependency]);
            const item = merged.find(
                (entry) => entry.name === 'Session__c.Member_demo__c'
            );

            assert.ok(item);
            assert.strictEqual(item.discoveryMethod, DISCOVERY_METHOD);
            assert.strictEqual(item.sourceMetadata, 'Member_Record_Page');
            assert.strictEqual(item.sourceField, 'Sessions__r');
            assert.strictEqual(item.relationship, 'ActionOverrideRelatedList');
            assert.strictEqual(item.expansionPolicy, 'PREREQUISITE_ONLY');
            assert.strictEqual(item.origin, 'Member_Record_Page');
        }
    );

    await runTest(
        'TEST 17: closure candidates enter destination inventory pass',
        async () => {
            const discovery = await discoverStructuralActionOverrideRelatedLists({
                structuralFlexiPageDependencies: [
                    createStructuralFlexiPageDependency(
                        'Subscription_Record_Page',
                        SUBSCRIPTION_RECORD_PAGE_PATH
                    )
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES
            });

            const inventoryItems = collectDestinationInventoryItems({
                closureCandidates: discovery.closureCandidates
            });

            assert.ok(
                inventoryItems.some(
                    (item) =>
                        item.metadataType === 'CustomField' &&
                        item.metadataName === 'Session__c.Subscription__c'
                )
            );
            assert.ok(
                inventoryItems.some(
                    (item) =>
                        item.metadataType === 'CustomObject' &&
                        item.metadataName === 'Session__c'
                )
            );
        }
    );

    await runTest(
        'TEST 18: parseRelationshipNameFromRelatedListApiName converts Sessions__r',
        () => {
            assert.strictEqual(
                parseRelationshipNameFromRelatedListApiName('Sessions__r'),
                'Sessions'
            );
        }
    );

    await runTest(
        'TEST 18A: closure eligibility accepts DIRECT_DEPENDENCY origin',
        () => {
            assert.strictEqual(
                isStructuralActionOverrideFlexiPageDependency(
                    createStructuralFlexiPageDependency(
                        'Member_Record_Page',
                        MEMBER_RECORD_PAGE_PATH
                    )
                ),
                true
            );
        }
    );

    await runTest(
        'TEST 18B: closure eligibility accepts RELATIONSHIP_TARGET origin',
        () => {
            assert.strictEqual(
                isStructuralActionOverrideFlexiPageDependency(
                    createStructuralFlexiPageDependency(
                        'Member_Record_Page',
                        MEMBER_RECORD_PAGE_PATH,
                        { origin: METADATA_ORIGINS.RELATIONSHIP_TARGET }
                    )
                ),
                true
            );
        }
    );

    await runTest(
        'TEST 18C: closure eligibility rejects unrelated origin',
        () => {
            assert.strictEqual(
                isStructuralActionOverrideFlexiPageDependency(
                    createStructuralFlexiPageDependency(
                        'Member_Record_Page',
                        MEMBER_RECORD_PAGE_PATH,
                        { origin: METADATA_ORIGINS.SECONDARY_DEPENDENCY }
                    )
                ),
                false
            );
        }
    );

    await runTest(
        'TEST 18D: closure eligibility rejects wrong relationship',
        () => {
            assert.strictEqual(
                isStructuralActionOverrideFlexiPageDependency(
                    createStructuralFlexiPageDependency(
                        'Member_Record_Page',
                        MEMBER_RECORD_PAGE_PATH,
                        { relationship: 'Field' }
                    )
                ),
                false
            );
        }
    );

    await runTest(
        'TEST 18E: closure eligibility rejects wrong discoveryMethod',
        () => {
            assert.strictEqual(
                isStructuralActionOverrideFlexiPageDependency(
                    createStructuralFlexiPageDependency(
                        'Member_Record_Page',
                        MEMBER_RECORD_PAGE_PATH,
                        { discoveryMethod: 'graphExpansion' }
                    )
                ),
                false
            );
        }
    );

    await runTest(
        'TEST 18F: RELATIONSHIP_TARGET Member_Record_Page closes Session__c.Member_demo__c',
        async () => {
            const discovery = await discoverStructuralActionOverrideRelatedLists({
                structuralFlexiPageDependencies: [
                    createStructuralFlexiPageDependency(
                        'Member_Record_Page',
                        MEMBER_RECORD_PAGE_PATH,
                        { origin: METADATA_ORIGINS.RELATIONSHIP_TARGET }
                    )
                ],
                readRepoFile: createReadRepoFile(),
                repoFiles: REPO_FILES
            });

            assert.ok(
                getRelationshipNames(discovery).includes(
                    'Session__c.Member_demo__c'
                )
            );
            assert.ok(
                getRelationshipNames(discovery).includes('Session__c.Status__c')
            );
            assert.ok(
                getRelationshipNames(discovery).includes(
                    'Session__c.Gym_Trainer__c'
                )
            );
            assert.ok(
                !getRelationshipNames(discovery).includes(
                    'Session__c.Subscription__c'
                )
            );
        }
    );

    await runTest(
        'TEST 19: graph expansion from Member__c structural parent discovers related-list field',
        async () => {
            const result = await customObjectGraphDiscoverer.discover({
                metadata: {
                    name: 'Member__c',
                    metadataType: 'CustomObject',
                    discoveryMethod:
                        STRUCTURAL_MASTER_DETAIL_PARENT_DISCOVERY_METHOD
                },
                repoFiles: [
                    ...REPO_FILES,
                    'force-app/main/default/objects/Member__c/Member__c.object-meta.xml'
                ],
                readRepoFile: async (targetPath) => {
                    if (targetPath.endsWith('Member__c.object-meta.xml')) {
                        return `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <actionOverrides>
        <actionName>View</actionName>
        <type>Flexipage</type>
        <content>Member_Record_Page</content>
    </actionOverrides>
</CustomObject>`;
                    }

                    return createReadRepoFile()(targetPath);
                },
                depth: 1
            });

            const names = (result.discoveredNodes || []).map((node) => node.name);

            assert.ok(names.includes('Session__c.Member_demo__c'));
            assert.ok(names.includes('Session__c'));
            assert.ok(names.includes('Session__c.Gym_Trainer__c'));
            assert.ok(names.includes('Session__c.Status__c'));
            assert.ok(!names.includes('Session__c.Subscription__c'));
        }
    );
}

main().then(() => {
    if (process.exitCode) {
        console.error(
            'structuralActionOverrideRelatedList.discoverer.test.js FAILED'
        );
    } else {
        console.log(
            'structuralActionOverrideRelatedList.discoverer.test.js PASSED'
        );
    }
});
