const assert = require('assert');

const {
    analyzeDeploymentCompatibilityPlan,
    mapFormulaCompatibilityWarnings,
    mapExistingFindingWarnings,
    analyzeFlowApiCompatibility,
    analyzeLwcAndFlexiDependencies,
    CATEGORIES
} = require('./deploymentCompatibility.service');

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

async function main() {
    await runTest('Formula type change', async () => {
        const mapped = mapExistingFindingWarnings([
            {
                metadataName: 'Booking__c.Status__c',
                metadataType: 'CustomField',
                message:
                    'Cannot update a field to a Formula from something else'
            }
        ]);

        assert.strictEqual(mapped.length, 1);
        assert.strictEqual(
            mapped[0].category,
            CATEGORIES.FORMULA_TYPE_CHANGE
        );
        assert.ok(mapped[0].recommendation);

        const result = await analyzeDeploymentCompatibilityPlan({
            generatedDeploymentPackage: { metadata: [], dependencies: [] },
            existingFindings: [
                {
                    metadataName: 'Booking__c.Status__c',
                    message:
                        'Cannot update a field to a Formula from something else'
                }
            ]
        });

        assert.strictEqual(result.overallStatus, 'WARNING');
        assert.ok(
            result.compatibilityWarnings.some(
                (warning) =>
                    warning.category === CATEGORIES.FORMULA_TYPE_CHANGE
            )
        );
    });

    await runTest('Formula compile failure', async () => {
        const mapped = mapFormulaCompatibilityWarnings({
            warnings: [
                {
                    metadataName: 'Booking__c.Status_Label__c',
                    metadataType: 'CustomField',
                    category: 'MISSING_FIELD',
                    severity: 'WARNING',
                    message:
                        'Formula Booking__c.Status_Label__c references Booking__c.Is_Canceled__c, which is not in the deployment package.'
                }
            ]
        });

        assert.strictEqual(mapped[0].category, CATEGORIES.FORMULA_COMPILATION);
        assert.ok(
            mapped[0].recommendation.includes('Deploy referenced') ||
                mapped[0].recommendation.includes('formula')
        );
    });

    await runTest('Flow API mismatch', async () => {
        const flowItem = {
            metadataType: 'Flow',
            metadataName: 'Booking_Flow'
        };
        const flowXml = `
            <Flow>
                <areMetricsLoggedToDataCloud>true</areMetricsLoggedToDataCloud>
            </Flow>
        `;

        const warnings = analyzeFlowApiCompatibility(flowItem, flowXml, 60);

        assert.strictEqual(warnings.length, 1);
        assert.strictEqual(warnings[0].category, CATEGORIES.FLOW_API_VERSION);

        const result = await analyzeDeploymentCompatibilityPlan({
            generatedDeploymentPackage: {
                metadata: [
                    {
                        ...flowItem,
                        content: flowXml
                    }
                ],
                dependencies: []
            },
            deploymentApiVersionPolicy: { deploymentApiVersion: 60 }
        });

        assert.ok(
            result.compatibilityWarnings.some(
                (warning) => warning.category === CATEGORIES.FLOW_API_VERSION
            )
        );
    });

    await runTest('Missing LWC', async () => {
        const item = {
            metadataType: 'LightningComponentBundle',
            metadataName: 'parentComponent'
        };
        const content = `
            import x from 'c/childWidget';
            // markup://c:childWidget
            template uses markup://c:childWidget
        `;

        const membership = {
            keys: new Set(['LightningComponentBundle:parentComponent']),
            byType: new Map(),
            items: [item]
        };

        const warnings = analyzeLwcAndFlexiDependencies(
            item,
            content,
            membership
        );

        assert.ok(
            warnings.some(
                (warning) =>
                    warning.category === CATEGORIES.LWC_DEPENDENCY &&
                    warning.message.includes('childWidget')
            )
        );
    });

    await runTest('Missing FlexiPage dependency', async () => {
        const item = {
            metadataType: 'FlexiPage',
            metadataName: 'Booking_Record_Page'
        };
        const content = `
            <FlexiPage>
                <componentName>bookingSummary</componentName>
                markup://c:bookingSummary
            </FlexiPage>
        `;

        const result = await analyzeDeploymentCompatibilityPlan({
            generatedDeploymentPackage: {
                metadata: [{ ...item, content }],
                dependencies: []
            }
        });

        assert.ok(
            result.compatibilityWarnings.some(
                (warning) =>
                    warning.category === CATEGORIES.FLEXIPAGE_DEPENDENCY &&
                    warning.metadataName === 'Booking_Record_Page'
            )
        );
    });
}

main();
