const assert = require('assert');

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

runTest('AuraHandledException is not emitted as ApexClass dependency', () => {
    const result = analyzeApexContent(
        `
        public class MyController {
            public void fail() {
                throw new AuraHandledException('blocked');
            }
        }
        `,
        'MyController'
    );

    assert.ok(!result.apexClasses.includes('AuraHandledException'));
});

runTest('URL platform type is not emitted as ApexClass dependency', () => {
    const result = analyzeApexContent(
        `
        public class MyController {
            public String base() {
                return URL.getOrgDomainUrl().toExternalForm();
            }
        }
        `,
        'MyController'
    );

    assert.ok(!result.apexClasses.includes('URL'));
});

runTest('User Apex classes are still discovered', () => {
    const result = analyzeApexContent(
        `
        public class MyController {
            public void run() {
                HelperService.doWork();
                new AccountHelper();
            }
        }
        `,
        'MyController'
    );

    assert.ok(result.apexClasses.includes('HelperService'));
    assert.ok(result.apexClasses.includes('AccountHelper'));
});

runTest('CustomObject and CustomField discovery still works', () => {
    const result = analyzeApexContent(
        `
        public class MyController {
            public void run() {
                Connected_Org__c org = new Connected_Org__c();
                org.Instance_Url__c = 'https://example.com';
                List<Connected_Org__c> rows = [
                    SELECT Org_Id__c FROM Connected_Org__c
                ];
            }
        }
        `,
        'MyController'
    );

    assert.ok(result.customObjects.includes('Connected_Org__c'));
    assert.ok(
        result.customFields.includes('Connected_Org__c.Instance_Url__c')
    );
    assert.ok(result.customFields.includes('Connected_Org__c.Org_Id__c'));
});
