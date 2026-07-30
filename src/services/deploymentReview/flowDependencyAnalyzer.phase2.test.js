const assert = require('assert');

const {
    analyzeFlowDependencies,
    extractSubflowNames,
    extractApexClassNames,
    extractEmailAlertNames
} = require('./flowDependencyAnalyzer.service');

const {
    analyzeFlowReview,
    extractFlowApiVersion
} = require('./flowReview.service');

const {
    reviewDeployableMetadataItems
} = require('../deploymentReview.service');

const {
    analyzeApexContent
} = require('./dependencyAnalyzer.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => {
            console.log(`PASS: ${name}`);
        })
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

const FLOW_PATH =
    'force-app/main/default/flows/Invoice_Orchestrator.flow-meta.xml';

const FLOW_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Flow xmlns="http://soap.sforce.com/2006/04/metadata">
    <actionCalls>
        <name>Create_Invoice</name>
        <actionName>CreateInvoiceAction</actionName>
        <actionType>apex</actionType>
    </actionCalls>
    <actionCalls>
        <name>Notify_Manager</name>
        <actionName>Invoice__c.Invoice_Manager_Email</actionName>
        <actionType>emailAlert</actionType>
    </actionCalls>
    <actionCalls>
        <name>Post_Chatter</name>
        <actionName>chatterPost</actionName>
        <actionType>chatterPost</actionType>
    </actionCalls>
    <apiVersion>63.0</apiVersion>
    <apexPluginCalls>
        <name>Legacy_Plugin</name>
        <apexClass>LegacyInvoicePlugin</apexClass>
    </apexPluginCalls>
    <recordCreates>
        <name>Create_Invoice_Record</name>
        <inputAssignments>
            <field>Amount__c</field>
            <value>
                <numberValue>100.0</numberValue>
            </value>
        </inputAssignments>
        <inputAssignments>
            <field>Name</field>
            <value>
                <stringValue>Test</stringValue>
            </value>
        </inputAssignments>
        <object>Invoice__c</object>
    </recordCreates>
    <recordLookups>
        <name>Find_Invoice</name>
        <filters>
            <field>RecordType.DeveloperName</field>
            <operator>EqualTo</operator>
            <value>
                <stringValue>Standard_Invoice</stringValue>
            </value>
        </filters>
        <object>Invoice__c</object>
    </recordLookups>
    <start>
        <object>Invoice__c</object>
        <recordTriggerType>Create</recordTriggerType>
        <triggerType>RecordAfterSave</triggerType>
    </start>
    <status>Active</status>
    <subflows>
        <name>Call_Approval</name>
        <flowName>Approval_Subflow</flowName>
    </subflows>
    <variables>
        <name>invoiceRecord</name>
        <dataType>SObject</dataType>
        <objectType>Invoice__c</objectType>
    </variables>
</Flow>
`;

async function main() {
    await runTest('extracts subflows as Flow dependencies', () => {
        assert.deepStrictEqual(extractSubflowNames(FLOW_XML), [
            'Approval_Subflow'
        ]);
    });

    await runTest(
        'extracts invocable apex and apexPluginCalls; ignores platform actions',
        () => {
            assert.deepStrictEqual(extractApexClassNames(FLOW_XML), [
                'CreateInvoiceAction',
                'LegacyInvoicePlugin'
            ]);
        }
    );

    await runTest('extracts email alerts', () => {
        assert.deepStrictEqual(extractEmailAlertNames(FLOW_XML), [
            'Invoice__c.Invoice_Manager_Email'
        ]);
    });

    await runTest('analyzeFlowDependencies builds review DTO inventory', () => {
        const result = analyzeFlowDependencies(FLOW_XML);
        const byType = result.requiredDependencies.reduce((acc, dep) => {
            acc[dep.type] = acc[dep.type] || [];
            acc[dep.type].push(dep.name);
            return acc;
        }, {});

        assert.strictEqual(result.analysisStatus, 'ANALYZED');
        assert.deepStrictEqual(byType.Flow, ['Approval_Subflow']);
        assert.deepStrictEqual(byType.ApexClass, [
            'CreateInvoiceAction',
            'LegacyInvoicePlugin'
        ]);
        assert.deepStrictEqual(byType.CustomObject, ['Invoice__c']);
        assert.deepStrictEqual(byType.CustomField, ['Invoice__c.Amount__c']);
        assert.deepStrictEqual(byType.EmailAlert, [
            'Invoice__c.Invoice_Manager_Email'
        ]);
        assert.deepStrictEqual(byType.RecordType, [
            'Invoice__c.Standard_Invoice'
        ]);

        for (const dep of result.requiredDependencies) {
            assert.strictEqual(dep.required, true);
            assert.strictEqual(dep.selected, true);
            assert.strictEqual(dep.editable, false);
        }
    });

    await runTest(
        'analyzeFlowReview keeps API version and analyzed dependencies',
        () => {
            const result = analyzeFlowReview({
                content: FLOW_XML,
                filePath: FLOW_PATH
            });

            assert.strictEqual(result.status, 'SUCCESS');
            assert.strictEqual(extractFlowApiVersion(FLOW_XML), '63.0');
            assert.strictEqual(result.apiValidation.apiVersion, '63.0');
            assert.strictEqual(
                result.dependencyAnalysis.analysisStatus,
                'ANALYZED'
            );
            assert.ok(
                result.dependencyAnalysis.requiredDependencies.length > 0
            );
            assert.strictEqual(
                result.dependencyAnalysis.message,
                undefined
            );
        }
    );

    await runTest(
        'reviewDeployableMetadataItems surfaces Flow dependencies',
        async () => {
            const result = await reviewDeployableMetadataItems({
                items: [
                    {
                        metadataType: 'Flow',
                        filePath: FLOW_PATH
                    }
                ],
                readRepoFile: async () => FLOW_XML,
                listRepoFiles: async () => [FLOW_PATH]
            });

            assert.strictEqual(result.reviewsExecuted, 1);
            assert.strictEqual(result.deploymentReview[0].status, 'SUCCESS');
            assert.ok(result.requiredDependencies.length > 0);
            assert.ok(
                result.requiredDependencies.some(
                    (dep) =>
                        dep.type === 'Flow' && dep.name === 'Approval_Subflow'
                )
            );
            assert.ok(
                result.requiredDependencies.some(
                    (dep) =>
                        dep.type === 'ApexClass' &&
                        dep.name === 'CreateInvoiceAction'
                )
            );
        }
    );

    await runTest('Apex dependency discovery unchanged', () => {
        const result = analyzeApexContent(
            `
            public class MyController {
                public void run() {
                    HelperService.doWork();
                    Connected_Org__c org = new Connected_Org__c();
                    org.Instance_Url__c = 'x';
                    Flow.Interview.Approval_Subflow flowInterview =
                        new Flow.Interview.Approval_Subflow(
                            new Map<String, Object>()
                        );
                }
            }
            `,
            'MyController'
        );

        assert.ok(result.apexClasses.includes('HelperService'));
        assert.ok(result.customObjects.includes('Connected_Org__c'));
        assert.ok(
            result.customFields.includes('Connected_Org__c.Instance_Url__c')
        );
        assert.ok(result.flows.includes('Approval_Subflow'));
    });
}

main();
