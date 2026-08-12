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

runTest('Site platform type is not emitted as ApexClass dependency', () => {
    const result = analyzeApexContent(
        `
        public class ExperienceController {
            public String base() {
                return Site.getBaseUrl();
            }
        }
        `,
        'ExperienceController'
    );

    assert.ok(
        !result.apexClasses.includes('Site'),
        'Site must not be emitted as deployable ApexClass'
    );
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

runTest(
    'SOQL relationship field Experience__r.Price__c → Experience__c.Price__c (not Session__c)',
    () => {
        const result = analyzeApexContent(
            `
            public class ExperienceController {
                public void load() {
                    List<Session__c> sessions = [
                        SELECT Experience__r.Price__c
                        FROM Session__c
                    ];
                }
            }
            `,
            'ExperienceController'
        );

        assert.ok(
            result.customFields.includes('Experience__c.Price__c'),
            `Expected Experience__c.Price__c, got: ${result.customFields.join(', ')}`
        );
        assert.ok(
            !result.customFields.includes('Session__c.Price__c'),
            'Must not emit Session__c.Price__c for Experience__r.Price__c'
        );
    }
);

runTest(
    'SOQL mixes bare FROM fields with relationship-qualified fields',
    () => {
        const result = analyzeApexContent(
            `
            public class ExperienceController {
                public void load() {
                    List<Session__c> sessions = [
                        SELECT Booked_Slots__c,
                               Capacity__c,
                               Status__c,
                               Start_Time__c,
                               Experience__r.Price__c
                        FROM Session__c
                    ];
                }
            }
            `,
            'ExperienceController'
        );

        assert.ok(result.customFields.includes('Session__c.Booked_Slots__c'));
        assert.ok(result.customFields.includes('Session__c.Capacity__c'));
        assert.ok(result.customFields.includes('Session__c.Status__c'));
        assert.ok(result.customFields.includes('Session__c.Start_Time__c'));
        assert.ok(result.customFields.includes('Experience__c.Price__c'));
        assert.ok(
            !result.customFields.includes('Session__c.Price__c'),
            'Relationship field must not be qualified with FROM object'
        );
    }
);

runTest('VF Page.* does not produce ApexClass Page', () => {
    const result = analyzeApexContent(
        `
        public class SiteController {
            public PageReference go() {
                return Page.ChangePassword;
            }
            public PageReference confirm() {
                return Page.CommunitiesSelfRegConfirm;
            }
        }
        `,
        'SiteController'
    );

    assert.ok(
        !result.apexClasses.includes('Page'),
        `Page must not be emitted, got: ${result.apexClasses.join(', ')}`
    );
});

runTest('Schema.SObjectType.User does not produce ApexClass SObjectType', () => {
    const result = analyzeApexContent(
        `
        public class DescribeHelper {
            public void run() {
                Schema.DescribeSObjectResult d = Schema.SObjectType.User;
            }
        }
        `,
        'DescribeHelper'
    );

    assert.ok(!result.apexClasses.includes('SObjectType'));
    assert.ok(!result.apexClasses.includes('Schema'));
    assert.ok(!result.apexClasses.includes('User'));
});

runTest('Standard sObject dotted/new references are not ApexClass deps', () => {
    const result = analyzeApexContent(
        `
        public class StandardObjectConsumer {
            public void run() {
                Schema.SObjectField f = User.fields.Name;
                Account a = new Account();
                Contact c = new Contact();
                Case k = new Case();
                User u = new User();
                Decimal rev = Account.Total_Revenue__c;
            }
        }
        `,
        'StandardObjectConsumer'
    );

    assert.ok(!result.apexClasses.includes('User'));
    assert.ok(!result.apexClasses.includes('Account'));
    assert.ok(!result.apexClasses.includes('Contact'));
    assert.ok(!result.apexClasses.includes('Case'));
});

runTest('NoAccessException is not emitted as ApexClass dependency', () => {
    const result = analyzeApexContent(
        `
        public class AccessGuard {
            public void deny() {
                throw new NoAccessException();
            }
        }
        `,
        'AccessGuard'
    );

    assert.ok(!result.apexClasses.includes('NoAccessException'));
});

runTest('Legitimate custom Apex classes still discovered after FP guards', () => {
    const result = analyzeApexContent(
        `
        public class MyController {
            public void run() {
                HelperService.doWork();
                new AccountHelper();
                new HelperService();
            }
        }
        `,
        'MyController'
    );

    assert.ok(result.apexClasses.includes('HelperService'));
    assert.ok(result.apexClasses.includes('AccountHelper'));
});

runTest('Legitimate custom objects still discovered', () => {
    const result = analyzeApexContent(
        `
        public class FleetService {
            public void run() {
                Vehicle__c v = new Vehicle__c();
                Error_Log__c e;
                List<Maintenance_Request__c> rows;
                Equipment_Maintenance_Item__c item =
                    new Equipment_Maintenance_Item__c();
                Comparison_Result__c comparison;
            }
        }
        `,
        'FleetService'
    );

    assert.ok(result.customObjects.includes('Vehicle__c'));
    assert.ok(result.customObjects.includes('Error_Log__c'));
    assert.ok(result.customObjects.includes('Maintenance_Request__c'));
    assert.ok(
        result.customObjects.includes('Equipment_Maintenance_Item__c')
    );
    assert.ok(result.customObjects.includes('Comparison_Result__c'));
});

runTest(
    'Weak typed field API names are not promoted to CustomObject',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceService {
                public void load() {
                    Date_Due__c d;
                    End_Time__c endTime;
                    Start_Time__c startTime;
                    Maintenance_Request__c request;
                    List<Maintenance_Request__c> rows = [
                        SELECT Date_Due__c,
                               End_Time__c,
                               Start_Time__c
                        FROM Maintenance_Request__c
                    ];
                }
            }
            `,
            'MaintenanceService'
        );

        assert.ok(
            result.customObjects.includes('Maintenance_Request__c'),
            'Maintenance_Request__c must remain a CustomObject'
        );
        assert.ok(
            result.customFields.includes('Maintenance_Request__c.Date_Due__c')
        );
        assert.ok(
            result.customFields.includes('Maintenance_Request__c.End_Time__c')
        );
        assert.ok(
            result.customFields.includes(
                'Maintenance_Request__c.Start_Time__c'
            )
        );
        assert.ok(
            !result.customObjects.includes('Date_Due__c'),
            'Date_Due__c must not be CustomObject'
        );
        assert.ok(
            !result.customObjects.includes('End_Time__c'),
            'End_Time__c must not be CustomObject'
        );
        assert.ok(
            !result.customObjects.includes('Start_Time__c'),
            'Start_Time__c must not be CustomObject'
        );
    }
);

runTest('ApexPages.Severity.ERROR does not produce ApexClass Severity', () => {
    const result = analyzeApexContent(
        `
        public class SiteController {
            public void log() {
                ApexPages.Severity.ERROR;
            }
        }
        `,
        'SiteController'
    );

    assert.ok(
        !result.apexClasses.includes('Severity'),
        `Severity must not be emitted, got: ${result.apexClasses.join(', ')}`
    );
});

runTest('Page.ChangePassword does not produce ApexClass ChangePassword', () => {
    const result = analyzeApexContent(
        `
        public class SiteController {
            public PageReference go() {
                return Page.ChangePassword;
            }
        }
        `,
        'SiteController'
    );

    assert.ok(
        !result.apexClasses.includes('ChangePassword'),
        `ChangePassword must not be emitted as ApexClass, got: ${result.apexClasses.join(', ')}`
    );
    assert.ok(!result.apexClasses.includes('Page'));
});

runTest(
    'SOQL field names without weak vars are not promoted to CustomObject',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceService {
                public void load() {
                    List<Maintenance_Request__c> rows = [
                        SELECT Date_Due__c,
                               End_Time__c,
                               Start_Time__c
                        FROM Maintenance_Request__c
                    ];
                }
            }
            `,
            'MaintenanceService'
        );

        assert.ok(result.customObjects.includes('Maintenance_Request__c'));
        assert.ok(
            result.customFields.includes('Maintenance_Request__c.Date_Due__c')
        );
        assert.ok(
            result.customFields.includes('Maintenance_Request__c.End_Time__c')
        );
        assert.ok(
            result.customFields.includes(
                'Maintenance_Request__c.Start_Time__c'
            )
        );
        assert.ok(!result.customObjects.includes('Date_Due__c'));
        assert.ok(!result.customObjects.includes('End_Time__c'));
        assert.ok(!result.customObjects.includes('Start_Time__c'));
    }
);

runTest('new Vehicle__c() still produces CustomObject Vehicle__c', () => {
    const result = analyzeApexContent(
        `
        public class FleetService {
            public void run() {
                Vehicle__c vehicle = new Vehicle__c();
            }
        }
        `,
        'FleetService'
    );

    assert.ok(result.customObjects.includes('Vehicle__c'));
});

runTest(
    'new Equipment_Maintenance_Item__c() still produces CustomObject',
    () => {
        const result = analyzeApexContent(
            `
            public class FleetService {
                public void run() {
                    new Equipment_Maintenance_Item__c();
                }
            }
            `,
            'FleetService'
        );

        assert.ok(
            result.customObjects.includes('Equipment_Maintenance_Item__c')
        );
    }
);

runTest(
    'End_Time__c false type is not CustomObject when known as field segment',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceService {
                public void load() {
                    End_Time__c e;
                    List<Maintenance_Request__c> rows = [
                        SELECT End_Time__c FROM Maintenance_Request__c
                    ];
                }
            }
            `,
            'MaintenanceService'
        );

        assert.ok(!result.customObjects.includes('End_Time__c'));
        assert.ok(
            result.customFields.includes('Maintenance_Request__c.End_Time__c')
        );
    }
);

runTest(
    'Start_Time__c false type is not CustomObject when known as field segment',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceService {
                public void load() {
                    Start_Time__c s;
                    List<Maintenance_Request__c> rows = [
                        SELECT Start_Time__c FROM Maintenance_Request__c
                    ];
                }
            }
            `,
            'MaintenanceService'
        );

        assert.ok(!result.customObjects.includes('Start_Time__c'));
        assert.ok(
            result.customFields.includes(
                'Maintenance_Request__c.Start_Time__c'
            )
        );
    }
);

runTest(
    'End_Time__c method return type is not CustomObject when known as field',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceService {
                End_Time__c getEnd() {
                    return null;
                }
                public void load() {
                    List<Maintenance_Request__c> rows = [
                        SELECT End_Time__c FROM Maintenance_Request__c
                    ];
                }
            }
            `,
            'MaintenanceService'
        );

        assert.ok(!result.customObjects.includes('End_Time__c'));
        assert.ok(
            result.customFields.includes('Maintenance_Request__c.End_Time__c')
        );
    }
);

runTest(
    'End_Time__c cast is not CustomObject when known as field',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceService {
                public void load(Object obj) {
                    End_Time__c e = (End_Time__c) obj;
                    List<Maintenance_Request__c> rows = [
                        SELECT End_Time__c FROM Maintenance_Request__c
                    ];
                }
            }
            `,
            'MaintenanceService'
        );

        assert.ok(!result.customObjects.includes('End_Time__c'));
        assert.ok(
            result.customFields.includes('Maintenance_Request__c.End_Time__c')
        );
    }
);

runTest('new Maintenance_Request__c() still produces CustomObject', () => {
    const result = analyzeApexContent(
        `
        public class FleetService {
            public void run() {
                new Maintenance_Request__c();
            }
        }
        `,
        'FleetService'
    );

    assert.ok(result.customObjects.includes('Maintenance_Request__c'));
});

runTest(
    'Date_Due__c remains suppressed as CustomObject when known as field',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceService {
                public void load() {
                    Date_Due__c d;
                    List<Maintenance_Request__c> rows = [
                        SELECT Date_Due__c FROM Maintenance_Request__c
                    ];
                }
            }
            `,
            'MaintenanceService'
        );

        assert.ok(!result.customObjects.includes('Date_Due__c'));
        assert.ok(
            result.customFields.includes('Maintenance_Request__c.Date_Due__c')
        );
    }
);
