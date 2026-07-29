const assert = require('assert');

const {
    canonicalizeCustomFieldName,
    canonicalizeCustomFieldDependencies
} = require('./customFieldCanonicalizer.service');

const {
    analyzeApexContent
} = require('./dependencyAnalyzer.service');

function runTest(name, fn) {
    try {
        fn();
        console.log(`PASS: ${name}`);
    } catch (error) {
        console.error(`FAIL: ${name}`);
        console.error(error);
        process.exitCode = 1;
    }
}

const REPO_FILES = [
    'force-app/main/default/objects/Connected_Org__c/Connected_Org__c.object-meta.xml',
    'force-app/main/default/objects/Connected_Org__c/fields/Instance_URL__c.field-meta.xml',
    'force-app/main/default/objects/Connected_Org__c/fields/Org_ID__c.field-meta.xml',
    'force-app/main/default/objects/Connected_Org__c/fields/Display_Name__c.field-meta.xml',
    'force-app/main/default/classes/HelperService.cls'
];

runTest('Instance_Url__c → Instance_URL__c when single case-insensitive match', () => {
    assert.strictEqual(
        canonicalizeCustomFieldName(
            'Connected_Org__c.Instance_Url__c',
            REPO_FILES
        ),
        'Connected_Org__c.Instance_URL__c'
    );
});

runTest('Org_Id__c → Org_ID__c when single case-insensitive match', () => {
    assert.strictEqual(
        canonicalizeCustomFieldName('Connected_Org__c.Org_Id__c', REPO_FILES),
        'Connected_Org__c.Org_ID__c'
    );
});

runTest('Exact repository casing remains unchanged', () => {
    assert.strictEqual(
        canonicalizeCustomFieldName(
            'Connected_Org__c.Instance_URL__c',
            REPO_FILES
        ),
        'Connected_Org__c.Instance_URL__c'
    );
});

runTest('No match leaves original unchanged', () => {
    assert.strictEqual(
        canonicalizeCustomFieldName(
            'Connected_Org__c.Missing_Field__c',
            REPO_FILES
        ),
        'Connected_Org__c.Missing_Field__c'
    );
});

runTest('Multiple case-insensitive matches leave original unchanged', () => {
    const ambiguousRepo = [
        'force-app/main/default/objects/Connected_Org__c/fields/Status__c.field-meta.xml',
        'force-app/main/default/objects/Connected_Org__c/fields/status__c.field-meta.xml'
    ];

    assert.strictEqual(
        canonicalizeCustomFieldName('Connected_Org__c.Status__c', ambiguousRepo),
        'Connected_Org__c.Status__c'
    );
});

runTest('Only CustomField dependencies are rewritten', () => {
    const result = canonicalizeCustomFieldDependencies(
        [
            {
                name: 'Connected_Org__c.Instance_Url__c',
                type: 'CustomField',
                required: true,
                selected: true
            },
            {
                name: 'HelperService',
                type: 'ApexClass',
                required: true,
                selected: true
            },
            {
                name: 'Connected_Org__c',
                type: 'CustomObject',
                required: true,
                selected: true
            }
        ],
        REPO_FILES
    );

    assert.strictEqual(result[0].name, 'Connected_Org__c.Instance_URL__c');
    assert.strictEqual(result[1].name, 'HelperService');
    assert.strictEqual(result[2].name, 'Connected_Org__c');
});

runTest('Analyzer still extracts Apex spelling; canonicalizer corrects later', () => {
    const raw = analyzeApexContent(
        `
        public class MyController {
            public void run() {
                Connected_Org__c org = new Connected_Org__c();
                org.Instance_Url__c = 'x';
                org.Org_Id__c = 'y';
                HelperService.doWork();
                throw new AuraHandledException('no');
            }
        }
        `,
        'MyController'
    );

    assert.ok(raw.customFields.includes('Connected_Org__c.Instance_Url__c'));
    assert.ok(raw.customFields.includes('Connected_Org__c.Org_Id__c'));
    assert.ok(raw.apexClasses.includes('HelperService'));
    assert.ok(!raw.apexClasses.includes('AuraHandledException'));

    const canonicalFields = raw.customFields.map((name) =>
        canonicalizeCustomFieldName(name, REPO_FILES)
    );

    assert.ok(canonicalFields.includes('Connected_Org__c.Instance_URL__c'));
    assert.ok(canonicalFields.includes('Connected_Org__c.Org_ID__c'));
});
