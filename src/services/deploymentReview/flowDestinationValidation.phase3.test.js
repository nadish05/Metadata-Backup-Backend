const assert = require('assert');

const {
    buildExistenceQuery,
    usesToolingApi
} = require('../destinationInventory/destinationExistenceQueries');

const {
    enrichFlowDependenciesWithDestinationState,
    DESTINATION_STATE
} = require('./flowDestinationValidation.service');

const {
    analyzeFlowDependencies
} = require('./flowDependencyAnalyzer.service');

const {
    reviewDeployableMetadataItems
} = require('../deploymentReview.service');

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
    <apiVersion>63.0</apiVersion>
    <recordCreates>
        <name>Create_Invoice_Record</name>
        <inputAssignments>
            <field>Amount__c</field>
            <value>
                <numberValue>100.0</numberValue>
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
    </start>
    <subflows>
        <name>Call_Approval</name>
        <flowName>Approval_Subflow</flowName>
    </subflows>
</Flow>
`;

async function main() {
    await runTest('Flow existence query uses Tooling FlowDefinition', () => {
        assert.strictEqual(usesToolingApi('Flow'), true);
        assert.strictEqual(
            buildExistenceQuery('Flow', 'Approval_Subflow'),
            "SELECT Id FROM FlowDefinition WHERE DeveloperName = 'Approval_Subflow' LIMIT 1"
        );
    });

    await runTest(
        'EmailAlert has no reliable existence query → unsupported/null',
        () => {
            assert.strictEqual(
                buildExistenceQuery(
                    'EmailAlert',
                    'Invoice__c.Invoice_Manager_Email'
                ),
                null
            );
        }
    );

    await runTest(
        'Existing Apex/CustomObject/CustomField/RecordType queries unchanged',
        () => {
            assert.ok(
                buildExistenceQuery('ApexClass', 'CreateInvoiceAction').includes(
                    'ApexClass'
                )
            );
            assert.ok(
                buildExistenceQuery('CustomObject', 'Invoice__c').includes(
                    'EntityDefinition'
                )
            );
            assert.ok(
                buildExistenceQuery(
                    'CustomField',
                    'Invoice__c.Amount__c'
                ).includes('FieldDefinition')
            );
            assert.ok(
                buildExistenceQuery(
                    'RecordType',
                    'Invoice__c.Standard_Invoice'
                ).includes('RecordType')
            );
        }
    );

    await runTest(
        'Without credentials, Flow deps enrich as UNKNOWN (never invent MISSING)',
        async () => {
            const discovered = analyzeFlowDependencies(FLOW_XML);
            const enrichment =
                await enrichFlowDependenciesWithDestinationState(
                    discovered.requiredDependencies,
                    {}
                );

            assert.ok(enrichment.requiredDependencies.length > 0);

            for (const dep of enrichment.requiredDependencies) {
                assert.strictEqual(
                    dep.destinationState,
                    DESTINATION_STATE.UNKNOWN
                );
            }

            const email = enrichment.requiredDependencies.find(
                (dep) => dep.type === 'EmailAlert'
            );
            assert.ok(email);
            assert.strictEqual(email.destinationState, 'UNKNOWN');
        }
    );

    await runTest(
        'Flow Review attaches destinationState without rediscovery',
        async () => {
            const result = await reviewDeployableMetadataItems({
                items: [
                    {
                        metadataType: 'Flow',
                        filePath: FLOW_PATH
                    }
                ],
                readRepoFile: async () => FLOW_XML,
                listRepoFiles: async () => [FLOW_PATH],
                destinationCredentials: {}
            });

            const review = result.deploymentReview[0];
            const deps = review.dependencyAnalysis.requiredDependencies;

            assert.strictEqual(review.status, 'SUCCESS');
            assert.strictEqual(
                review.dependencyAnalysis.analysisStatus,
                'ANALYZED'
            );
            assert.ok(deps.length > 0);
            assert.ok(
                deps.every(
                    (dep) =>
                        dep.destinationState === 'EXISTS' ||
                        dep.destinationState === 'MISSING' ||
                        dep.destinationState === 'UNKNOWN'
                )
            );

            const byType = Object.fromEntries(
                deps.map((dep) => [dep.type + ':' + dep.name, dep.destinationState])
            );

            assert.strictEqual(
                byType['Flow:Approval_Subflow'],
                'UNKNOWN'
            );
            assert.strictEqual(
                byType['EmailAlert:Invoice__c.Invoice_Manager_Email'],
                'UNKNOWN'
            );
            assert.strictEqual(
                byType['CustomObject:Invoice__c'],
                'UNKNOWN'
            );
        }
    );

    await runTest(
        'Phase 2 discovery inventory shape unchanged before enrichment',
        () => {
            const discovered = analyzeFlowDependencies(FLOW_XML);
            const types = [
                ...new Set(
                    discovered.requiredDependencies.map((dep) => dep.type)
                )
            ].sort();

            assert.deepStrictEqual(types, [
                'ApexClass',
                'CustomField',
                'CustomObject',
                'EmailAlert',
                'Flow',
                'RecordType'
            ]);
            assert.ok(
                discovered.requiredDependencies.every(
                    (dep) => dep.destinationState === undefined
                )
            );
        }
    );
}

main();
