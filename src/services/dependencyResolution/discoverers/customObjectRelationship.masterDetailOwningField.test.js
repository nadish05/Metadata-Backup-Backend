const assert = require('assert');

const customObjectRelationshipDiscoverer = require('./customObjectRelationship.discoverer');
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
const { CLASSIFICATIONS } = require('../dependencyClassification.model');

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

function namesOf(relationships) {
    return (relationships || []).map((item) => item.name).sort();
}

function findByName(relationships, name) {
    return (relationships || []).find((item) => item.name === name);
}

function packageHasMember(pkg, type, name) {
    return (pkg.metadata || []).some(
        (item) => item.metadataType === type && item.metadataName === name
    );
}

const COURSE_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Course</label>
    <sharingModel>ControlledByParent</sharingModel>
</CustomObject>`;

const COURSE_DEPARTMENT_MD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Department__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Department__c</referenceTo>
    <label>Department</label>
</CustomField>`;

const COURSE_LOOKUP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Coordinator__c</fullName>
    <type>Lookup</type>
    <referenceTo>Employee__c</referenceTo>
    <label>Coordinator</label>
</CustomField>`;

const MEMBER_TRAINER_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Member Trainer</label>
    <sharingModel>ControlledByParent</sharingModel>
</CustomObject>`;

const MEMBER_TRAINER_MEMBER_MD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Member__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Member__c</referenceTo>
    <relationshipOrder>0</relationshipOrder>
    <label>Member</label>
</CustomField>`;

const MEMBER_TRAINER_GYM_MD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Gym_Trainer__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Gym_Trainer__c</referenceTo>
    <relationshipOrder>1</relationshipOrder>
    <label>Gym Trainer</label>
</CustomField>`;

const TRAINING_SESSION_OBJECT_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomObject xmlns="http://soap.sforce.com/2006/04/metadata">
    <label>Training Session</label>
    <sharingModel>ControlledByParent</sharingModel>
</CustomObject>`;

const TRAINING_SESSION_PROGRAM_MD_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Training_Program__c</fullName>
    <type>MasterDetail</type>
    <referenceTo>Training_Program__c</referenceTo>
    <label>Training Program</label>
</CustomField>`;

const TRAINING_SESSION_LOCATION_LOOKUP_XML = `<?xml version="1.0" encoding="UTF-8"?>
<CustomField xmlns="http://soap.sforce.com/2006/04/metadata">
    <fullName>Campus__c</fullName>
    <type>Lookup</type>
    <referenceTo>Department__c</referenceTo>
    <label>Campus</label>
</CustomField>`;

const FILE_CONTENT = {
    'force-app/main/default/objects/Course__c/Course__c.object-meta.xml':
        COURSE_OBJECT_XML,
    'force-app/main/default/objects/Course__c/fields/Department__c.field-meta.xml':
        COURSE_DEPARTMENT_MD_XML,
    'force-app/main/default/objects/Course__c/fields/Coordinator__c.field-meta.xml':
        COURSE_LOOKUP_XML,
    'force-app/main/default/objects/Member_Trainer__c/Member_Trainer__c.object-meta.xml':
        MEMBER_TRAINER_OBJECT_XML,
    'force-app/main/default/objects/Member_Trainer__c/fields/Member__c.field-meta.xml':
        MEMBER_TRAINER_MEMBER_MD_XML,
    'force-app/main/default/objects/Member_Trainer__c/fields/Gym_Trainer__c.field-meta.xml':
        MEMBER_TRAINER_GYM_MD_XML,
    'force-app/main/default/objects/Training_Session__c/Training_Session__c.object-meta.xml':
        TRAINING_SESSION_OBJECT_XML,
    'force-app/main/default/objects/Training_Session__c/fields/Training_Program__c.field-meta.xml':
        TRAINING_SESSION_PROGRAM_MD_XML,
    'force-app/main/default/objects/Training_Session__c/fields/Campus__c.field-meta.xml':
        TRAINING_SESSION_LOCATION_LOOKUP_XML
};

const REPO_FILES = Object.keys(FILE_CONTENT);

async function readRepoFile(filePath) {
    const normalized = String(filePath).replace(/\\/g, '/');
    const xml = FILE_CONTENT[normalized];

    if (!xml) {
        throw new Error(`Unexpected file read: ${filePath}`);
    }

    return xml;
}

async function discoverObject(metadataName) {
    return customObjectRelationshipDiscoverer.discover({
        selectedMetadata: [
            {
                metadataType: 'CustomObject',
                metadataName
            }
        ],
        repoFiles: REPO_FILES,
        readRepoFile
    });
}

async function main() {
    await runTest(
        'TEST 1: ControlledByParent object + one MasterDetail field emits owning CustomField',
        async () => {
            const result = await discoverObject('Course__c');
            const field = findByName(
                result.relationships,
                'Course__c.Department__c'
            );

            assert.ok(field, `expected owning MD field; got ${JSON.stringify(namesOf(result.relationships))}`);
            assert.strictEqual(field.metadataType, 'CustomField');
            assert.strictEqual(field.type, 'CustomField');
            assert.strictEqual(field.relationship, 'MasterDetail');
            assert.strictEqual(field.required, true);
            assert.strictEqual(field.selected, true);
            assert.strictEqual(field.sourceMetadata, 'Course__c');
            assert.strictEqual(field.sourceField, 'Department__c');
        }
    );

    await runTest(
        'TEST 2: junction object emits both MasterDetail CustomFields',
        async () => {
            const result = await discoverObject('Member_Trainer__c');
            const names = namesOf(result.relationships);

            assert.ok(names.includes('Member_Trainer__c.Member__c'));
            assert.ok(names.includes('Member_Trainer__c.Gym_Trainer__c'));

            const memberField = findByName(
                result.relationships,
                'Member_Trainer__c.Member__c'
            );
            const gymField = findByName(
                result.relationships,
                'Member_Trainer__c.Gym_Trainer__c'
            );

            assert.strictEqual(memberField.metadataType, 'CustomField');
            assert.strictEqual(memberField.relationship, 'MasterDetail');
            assert.strictEqual(gymField.metadataType, 'CustomField');
            assert.strictEqual(gymField.relationship, 'MasterDetail');
        }
    );

    await runTest(
        'TEST 3: Training_Session__c emits Training_Program__c MasterDetail CustomField',
        async () => {
            const result = await discoverObject('Training_Session__c');
            const field = findByName(
                result.relationships,
                'Training_Session__c.Training_Program__c'
            );

            assert.ok(field);
            assert.strictEqual(field.metadataType, 'CustomField');
            assert.strictEqual(field.relationship, 'MasterDetail');
        }
    );

    await runTest(
        'TEST 4: Lookup field is not emitted as an owning CustomField',
        async () => {
            const course = await discoverObject('Course__c');
            const session = await discoverObject('Training_Session__c');

            assert.strictEqual(
                findByName(course.relationships, 'Course__c.Coordinator__c'),
                undefined
            );
            assert.strictEqual(
                findByName(
                    session.relationships,
                    'Training_Session__c.Campus__c'
                ),
                undefined
            );

            const lookupTargets = course.relationships.filter(
                (item) => item.relationship === 'Lookup'
            );

            assert.ok(
                lookupTargets.some(
                    (item) =>
                        item.name === 'Employee__c' &&
                        item.metadataType === 'CustomObject'
                )
            );
        }
    );

    await runTest(
        'TEST 5: MasterDetail target CustomObject is still discovered',
        async () => {
            const result = await discoverObject('Course__c');

            const target = findByName(result.relationships, 'Department__c');
            assert.ok(target);
            assert.strictEqual(target.metadataType, 'CustomObject');
            assert.strictEqual(target.relationship, 'MasterDetail');

            const owningField = findByName(
                result.relationships,
                'Course__c.Department__c'
            );
            assert.ok(owningField);
            assert.strictEqual(owningField.metadataType, 'CustomField');

            const junction = await discoverObject('Member_Trainer__c');
            assert.ok(findByName(junction.relationships, 'Member__c'));
            assert.ok(findByName(junction.relationships, 'Gym_Trainer__c'));
            assert.strictEqual(
                findByName(junction.relationships, 'Member__c').metadataType,
                'CustomObject'
            );
            assert.strictEqual(
                findByName(junction.relationships, 'Gym_Trainer__c')
                    .metadataType,
                'CustomObject'
            );
        }
    );

    await runTest(
        'TEST 6: REFERENCE / SKIP / BLOCK owning MD fields are not force-added',
        async () => {
            const discovered = await discoverObject('Course__c');
            const owningField = findByName(
                discovered.relationships,
                'Course__c.Department__c'
            );

            assert.ok(owningField);

            const classification = classifyDependency(owningField);
            assert.strictEqual(
                classification.classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA
            );

            const deployDecision = createDefaultDecision(owningField);
            assert.strictEqual(deployDecision.action, ACTIONS.DEPLOY);

            const composed = generateDeploymentPackage({
                selectedMetadata: [
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Course__c'
                    }
                ],
                requiredDependencies: [deployDecision],
                selectedTestClasses: []
            });

            assert.ok(
                packageHasMember(
                    composed,
                    'CustomField',
                    'Course__c.Department__c'
                )
            );

            for (const action of ['REFERENCE', 'SKIP', 'BLOCK']) {
                const pkg = generateDeploymentPackage({
                    selectedMetadata: [
                        {
                            metadataType: 'CustomObject',
                            metadataName: 'Course__c'
                        }
                    ],
                    requiredDependencies: [
                        {
                            name: 'Course__c.Department__c',
                            type: 'CustomField',
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
                        'CustomField',
                        'Course__c.Department__c'
                    ),
                    false,
                    `${action} must not force MasterDetail CustomField into package`
                );
            }
        }
    );

    await runTest(
        'CustomField-only MasterDetail scan still emits only the target object',
        async () => {
            const result = await customObjectRelationshipDiscoverer.discover({
                selectedMetadata: [
                    {
                        metadataType: 'CustomField',
                        metadataName: 'Course__c.Department__c'
                    }
                ],
                repoFiles: REPO_FILES,
                readRepoFile
            });

            assert.deepStrictEqual(namesOf(result.relationships), [
                'Department__c'
            ]);
            assert.strictEqual(
                result.relationships[0].metadataType,
                'CustomObject'
            );
        }
    );

    if (process.exitCode) {
        console.error(
            'customObjectRelationship.masterDetailOwningField.test.js FAILED'
        );
    } else {
        console.log(
            'customObjectRelationship.masterDetailOwningField.test.js PASSED'
        );
    }
}

main();
