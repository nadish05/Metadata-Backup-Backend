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
                    List<Experience__c> experiences;
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
                    List<Experience__c> experiences;
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

runTest(
    'Equipment__r.Maintenance_Cycle__c does not invent Equipment__c.Maintenance_Cycle__c',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceRequestHelper {
                public void load() {
                    List<Equipment_Maintenance_Item__c> items = [
                        SELECT Maintenance_Request__c,
                               Equipment__r.Maintenance_Cycle__c
                        FROM Equipment_Maintenance_Item__c
                    ];
                    Case c = [
                        SELECT Id, Equipment__c, Equipment__r.Maintenance_Cycle__c
                        FROM Case
                    ];
                }
            }
            `,
            'MaintenanceRequestHelper'
        );

        assert.ok(
            !result.customFields.includes('Equipment__c.Maintenance_Cycle__c'),
            `Must not invent Equipment__c.Maintenance_Cycle__c, got: ${result.customFields.join(', ')}`
        );
        assert.ok(
            !result.customObjects.includes('Equipment__c'),
            'Equipment__c must not be emitted as CustomObject'
        );
        assert.ok(
            result.customObjects.includes('Equipment_Maintenance_Item__c'),
            'Equipment_Maintenance_Item__c must remain CustomObject'
        );
    }
);

runTest(
    'Relationship__r.Field__c emits CustomField when related __c has strong object evidence',
    () => {
        const result = analyzeApexContent(
            `
            public class RegistrationController {
                public void load() {
                    List<Experience__c> experiences;
                    List<Experience_Registration__c> rows = [
                        SELECT Experience__r.Price__c
                        FROM Experience_Registration__c
                    ];
                }
            }
            `,
            'RegistrationController'
        );

        assert.ok(result.customFields.includes('Experience__c.Price__c'));
        assert.ok(result.customObjects.includes('Experience__c'));
        assert.ok(
            result.customObjects.includes('Experience_Registration__c')
        );
    }
);

runTest(
    'Direct Vehicle__c.Some_Field__c remains CustomField when Vehicle__c is proven',
    () => {
        const result = analyzeApexContent(
            `
            public class FleetService {
                public void run() {
                    Vehicle__c v = new Vehicle__c();
                    v.Some_Field__c = 'x';
                }
            }
            `,
            'FleetService'
        );

        assert.ok(result.customObjects.includes('Vehicle__c'));
        assert.ok(result.customFields.includes('Vehicle__c.Some_Field__c'));
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

runTest(
    'SELECT Maintenance_Request__c from Equipment_Maintenance_Item__c is field not object',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceService {
                public void load() {
                    List<Equipment_Maintenance_Item__c> items = [
                        SELECT Id, Maintenance_Request__c
                        FROM Equipment_Maintenance_Item__c
                    ];
                }
            }
            `,
            'MaintenanceService'
        );

        assert.ok(
            result.customObjects.includes('Equipment_Maintenance_Item__c')
        );
        assert.ok(
            result.customFields.includes(
                'Equipment_Maintenance_Item__c.Maintenance_Request__c'
            )
        );
        assert.ok(
            !result.customObjects.includes('Maintenance_Request__c'),
            'Maintenance_Request__c must not be CustomObject when only a field'
        );
    }
);

runTest(
    'Constructor named field and WHERE Maintenance_Request__c do not emit CustomObject',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceRequestHelperTest {
                private static Equipment_Maintenance_Item__c createWorkPart(
                    Id equipmentId,
                    Id requestId
                ) {
                    Equipment_Maintenance_Item__c wp =
                        new Equipment_Maintenance_Item__c(
                            Equipment__c = equipmentId,
                            Maintenance_Request__c = requestId
                        );
                    return wp;
                }

                private static void assertLinked(Id newReqId) {
                    Equipment_Maintenance_Item__c workPart = [
                        SELECT Id
                        FROM Equipment_Maintenance_Item__c
                        WHERE Maintenance_Request__c = :newReqId
                    ];
                    Equipment_Maintenance_Item__c other = [
                        SELECT Id
                        FROM Equipment_Maintenance_Item__c
                        WHERE Maintenance_Request__c IN :new Set<Id>{ newReqId }
                    ];
                }
            }
            `,
            'MaintenanceRequestHelperTest'
        );

        assert.ok(
            result.customObjects.includes('Equipment_Maintenance_Item__c')
        );
        assert.ok(
            result.customFields.includes(
                'Equipment_Maintenance_Item__c.Maintenance_Request__c'
            )
        );
        assert.ok(
            result.customFields.includes(
                'Equipment_Maintenance_Item__c.Equipment__c'
            )
        );
        assert.ok(
            !result.customObjects.includes('Maintenance_Request__c'),
            `Maintenance_Request__c must be absent as CustomObject, got: ${result.customObjects.join(', ')}`
        );
    }
);

runTest(
    'Local collection variable ClonedWPs.add does not produce ApexClass ClonedWPs',
    () => {
        const result = analyzeApexContent(
            `
            public class MaintenanceRequestHelper {
                public void cloneParts(List<Equipment_Maintenance_Item__c> source) {
                    List<Equipment_Maintenance_Item__c> clonedWPs =
                        new List<Equipment_Maintenance_Item__c>();
                    for (Equipment_Maintenance_Item__c wp : source) {
                        Equipment_Maintenance_Item__c wpClone = wp.clone();
                        ClonedWPs.add(wpClone);
                    }
                    insert ClonedWPs;
                    HelperService.doWork();
                    new AccountHelper();
                }
            }
            `,
            'MaintenanceRequestHelper'
        );

        assert.ok(
            !result.apexClasses.includes('ClonedWPs'),
            `ClonedWPs must not be ApexClass, got: ${result.apexClasses.join(', ')}`
        );
        assert.ok(result.apexClasses.includes('HelperService'));
        assert.ok(result.apexClasses.includes('AccountHelper'));
        assert.ok(
            result.customObjects.includes('Equipment_Maintenance_Item__c')
        );
    }
);

runTest(
    'Standard-object CustomField Account.Total_Revenue__c is discovered',
    () => {
        const result = analyzeApexContent(
            `
            public class AccountService1 {
                public static void run() {
                    for (AggregateResult ar : [
                        SELECT AccountId accId
                        FROM Opportunity
                        WHERE Account.Total_Revenue__c > 50000
                        GROUP BY AccountId
                    ]) {
                    }
                }
            }
            `,
            'AccountService1'
        );

        assert.ok(
            result.customFields.includes('Account.Total_Revenue__c'),
            `expected Account.Total_Revenue__c, got: ${result.customFields.join(', ')}`
        );
        assert.ok(!result.customObjects.includes('Account'));
        assert.ok(!result.customObjects.includes('Total_Revenue__c'));
    }
);

runTest(
    'SOQL FROM Account qualifies Total_Revenue__c as Account.Total_Revenue__c',
    () => {
        const result = analyzeApexContent(
            `
            public class AccountQuery {
                public List<Account> run() {
                    return [
                        SELECT Id, Total_Revenue__c
                        FROM Account
                    ];
                }
            }
            `,
            'AccountQuery'
        );

        assert.ok(result.customFields.includes('Account.Total_Revenue__c'));
        assert.ok(!result.customObjects.includes('Total_Revenue__c'));
    }
);

runTest(
    'SOQL FROM Case qualifies Vehicle__c, Equipment__c, Date_Reported__c',
    () => {
        const result = analyzeApexContent(
            `
            public class CaseQuery {
                public List<Case> run() {
                    return [
                        SELECT Id, Vehicle__c, Equipment__c, Date_Reported__c
                        FROM Case
                    ];
                }
            }
            `,
            'CaseQuery'
        );

        assert.ok(result.customFields.includes('Case.Vehicle__c'));
        assert.ok(result.customFields.includes('Case.Equipment__c'));
        assert.ok(result.customFields.includes('Case.Date_Reported__c'));
        assert.ok(!result.customObjects.includes('Vehicle__c'));
        assert.ok(!result.customObjects.includes('Equipment__c'));
        assert.ok(!result.customObjects.includes('Date_Reported__c'));
    }
);

runTest(
    'SOQL FROM Product2 qualifies Replacement_Part__c, lifespan_months__c, maintenance_cycle__c',
    () => {
        const result = analyzeApexContent(
            `
            public class ProductQuery {
                public List<Product2> run() {
                    return [
                        SELECT Id, Replacement_Part__c, lifespan_months__c, maintenance_cycle__c
                        FROM Product2
                    ];
                }
            }
            `,
            'ProductQuery'
        );

        assert.ok(result.customFields.includes('Product2.Replacement_Part__c'));
        assert.ok(result.customFields.includes('Product2.lifespan_months__c'));
        assert.ok(result.customFields.includes('Product2.maintenance_cycle__c'));
    }
);

runTest(
    'Product2 constructor named fields become Product2 CustomFields',
    () => {
        const result = analyzeApexContent(
            `
            public class ProductFactory {
                public Product2 create() {
                    return new Product2(
                        Replacement_Part__c = true,
                        lifespan_months__c = 10,
                        maintenance_cycle__c = 10
                    );
                }
            }
            `,
            'ProductFactory'
        );

        assert.ok(result.customFields.includes('Product2.Replacement_Part__c'));
        assert.ok(result.customFields.includes('Product2.lifespan_months__c'));
        assert.ok(result.customFields.includes('Product2.maintenance_cycle__c'));
        assert.ok(!result.customObjects.includes('Product2'));
    }
);

runTest(
    'lowercase new product2 with mixed-case __C fields still emits Product2 CustomFields',
    () => {
        const result = analyzeApexContent(
            `
            public class ProductFactory {
                public product2 createEq() {
                    product2 equipment = new product2(
                        name = 'SuperEquipment',
                        lifespan_months__C = 10,
                        maintenance_cycle__C = 10,
                        replacement_part__c = true
                    );
                    return equipment;
                }
            }
            `,
            'ProductFactory'
        );

        const lowerFields = result.customFields.map((name) =>
            name.toLowerCase()
        );

        assert.ok(lowerFields.includes('product2.lifespan_months__c'));
        assert.ok(lowerFields.includes('product2.maintenance_cycle__c'));
        assert.ok(lowerFields.includes('product2.replacement_part__c'));
        assert.ok(
            result.customFields.some((name) => name.startsWith('Product2.'))
        );
    }
);

runTest(
    'Case constructor and typed variable fields become Case CustomFields',
    () => {
        const result = analyzeApexContent(
            `
            public class CaseFactory {
                public void cloneCase(Case cc) {
                    Case nc = new Case(
                        Vehicle__c = cc.Vehicle__c,
                        Equipment__c = cc.Equipment__c,
                        Date_Reported__c = Date.today()
                    );
                }
            }
            `,
            'CaseFactory'
        );

        assert.ok(result.customFields.includes('Case.Vehicle__c'));
        assert.ok(result.customFields.includes('Case.Equipment__c'));
        assert.ok(result.customFields.includes('Case.Date_Reported__c'));
    }
);

runTest(
    'new Maintenance_Request__c remains CustomObject when used as object type',
    () => {
        const result = analyzeApexContent(
            `
            public class RequestFactory {
                public Maintenance_Request__c create() {
                    return new Maintenance_Request__c();
                }
            }
            `,
            'RequestFactory'
        );

        assert.ok(result.customObjects.includes('Maintenance_Request__c'));
    }
);
