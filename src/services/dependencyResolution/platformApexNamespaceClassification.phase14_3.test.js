const assert = require('assert');

const {
    analyzeApexContent,
    SYSTEM_CLASSES
} = require('../deploymentReview/dependencyAnalyzer.service');
const {
    CLASSIFICATIONS,
    classifyDependency
} = require('./dependencyClassification.service');
const {
    ACTIONS,
    resolveDependencies
} = require('./dependencyResolution.service');
const artifactExistsRule = require('../deploymentCompatibility/rules/artifactExists.rule');
const {
    resolveRepositoryArtifacts
} = require('../repositoryArtifacts/artifactResolution.service');

const ADDED_PLATFORM_APEX_RUNTIME_TYPES = Object.freeze([
    'AppLauncher',
    'Approval',
    'Auth',
    'Cache',
    'Canvas',
    'ChatterAnswers',
    'CommerceBuyGrp',
    'CommerceExtension',
    'CommerceOrders',
    'CommercePayments',
    'CommerceTax',
    'ComplianceMgmt',
    'Compression',
    'ConnectApi',
    'Context',
    'Crypto',
    'Datacloud',
    'DataRetrieval',
    'DataSource',
    'DataWeave',
    'Dom',
    'EncodingUtil',
    'EventBus',
    'ExternalService',
    'FeatureManagement',
    'Flowtesting',
    'FormulaEval',
    'Functions',
    'IndustriesDigitalLending',
    'Invocable',
    'InvoiceWriteOff',
    'IssueCreditMemo',
    'IsvPartners',
    'KbManagement',
    'LxScheduler',
    'Messaging',
    'Metadata',
    'Network',
    'PlaceQuote',
    'Process',
    'QuickAction',
    'Reports',
    'RevSalesTrxn',
    'RevSignaling',
    'RichMessaging',
    'RulesAppln',
    'Search',
    'Security',
    'SessionManagement',
    'Sfc',
    'Sfdc_Checkout',
    'Sfdc_Enablement',
    'Slack',
    'Support',
    'TerritoryMgmt',
    'TxnSecurity',
    'UserProvisioning',
    'VisualEditor',
    'Wave'
]);

const REQUIRED_REGRESSION_TYPES = Object.freeze([
    'Approval',
    'Auth',
    'Crypto',
    'Database',
    'Messaging',
    'Network',
    'Site',
    'System'
]);

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

async function main() {
    await runTest('registry contains documented platform Apex runtime types', () => {
        for (const name of ADDED_PLATFORM_APEX_RUNTIME_TYPES) {
            assert.ok(SYSTEM_CLASSES.has(name), name);
        }
    });

    await runTest(
        'Approval and representative platform API syntax emit no ApexClass dependencies',
        () => {
            const analysis = analyzeApexContent(
                `
                public class PlatformApiConsumer {
                    public void execute() {
                        Approval.ProcessSubmitRequest request =
                            new Approval.ProcessSubmitRequest();
                        Approval.process(request);
                        Messaging.sendEmail(new List<Messaging.Email>());
                        Auth.SessionManagement.getCurrentSession();
                        Crypto.generateDigest('SHA-256', Blob.valueOf('value'));
                        Network.getNetworkId();
                        Database.insert(new List<Account>());
                        Site.getBaseUrl();
                        System.debug('platform');
                    }
                }
                `,
                'PlatformApiConsumer'
            );

            for (const name of REQUIRED_REGRESSION_TYPES) {
                assert.ok(
                    !analysis.apexClasses.includes(name),
                    `${name} must not be emitted as a deployable ApexClass`
                );
            }
        }
    );

    await runTest(
        'platform Apex runtime types classify through the existing PLATFORM_REFERENCE policy',
        () => {
            for (const name of [
                ...ADDED_PLATFORM_APEX_RUNTIME_TYPES,
                'Database',
                'Site',
                'System'
            ]) {
                const classification = classifyDependency({
                    type: 'ApexClass',
                    name
                });

                assert.strictEqual(
                    classification.classification,
                    CLASSIFICATIONS.PLATFORM_REFERENCE,
                    name
                );
                assert.strictEqual(classification.artifactRequired, false, name);
                assert.strictEqual(classification.packageable, false, name);
                assert.strictEqual(
                    classification.defaultResolutionPolicy,
                    ACTIONS.SKIP,
                    name
                );
            }
        }
    );

    await runTest(
        'platform Apex runtime types resolve to SKIP and cannot block artifact.exists',
        async () => {
            const requiredDependencies = REQUIRED_REGRESSION_TYPES.map((name) => ({
                type: 'ApexClass',
                name,
                required: true,
                selected: true
            }));
            const resolution = await resolveDependencies({
                requiredDependencies,
                selectedMetadata: []
            });

            for (const dependency of resolution.resolvedDependencies) {
                assert.strictEqual(dependency.action, ACTIONS.SKIP, dependency.name);
                assert.strictEqual(
                    dependency.classification,
                    CLASSIFICATIONS.PLATFORM_REFERENCE,
                    dependency.name
                );
                assert.strictEqual(
                    dependency.artifactRequired,
                    false,
                    dependency.name
                );
                assert.strictEqual(dependency.packageable, false, dependency.name);
            }

            const findings = artifactExistsRule.analyze({
                selectedMetadata: [],
                resolvedDependencies: resolution.resolvedDependencies,
                discoveredReferences: []
            });

            assert.deepStrictEqual(findings, []);
        }
    );

    await runTest(
        'analyzer-filtered platform APIs produce no repository artifact candidates',
        async () => {
            const analysis = analyzeApexContent(
                `
                public class PlatformApiConsumer {
                    public void execute() {
                        Approval.process(new Approval.ProcessSubmitRequest());
                        Messaging.sendEmail(new List<Messaging.Email>());
                        Auth.SessionManagement.getCurrentSession();
                        Crypto.generateDigest('SHA-256', Blob.valueOf('value'));
                        Network.getNetworkId();
                    }
                }
                `,
                'PlatformApiConsumer'
            );
            const dependencies = analysis.apexClasses.map((name) => ({
                type: 'ApexClass',
                name
            }));
            const artifactResult = await resolveRepositoryArtifacts({
                enrichedDependencies: dependencies,
                repoUrl: 'unused',
                sourceBranch: 'unused',
                repoFiles: []
            });

            assert.deepStrictEqual(dependencies, []);
            assert.strictEqual(artifactResult.summary.nodesResolved, 0);
            assert.strictEqual(artifactResult.summary.artifactsMissing, 0);
            assert.deepStrictEqual(artifactResult.summary.warnings, []);
        }
    );

    await runTest('customer Apex classes remain deployable and discoverable', () => {
        const analysis = analyzeApexContent(
            `
            public class PlatformApiConsumer {
                public void execute() {
                    HelperService.execute();
                    new AccountHelper();
                }
            }
            `,
            'PlatformApiConsumer'
        );

        assert.deepStrictEqual(analysis.apexClasses, [
            'AccountHelper',
            'HelperService'
        ]);

        for (const name of analysis.apexClasses) {
            const classification = classifyDependency({
                type: 'ApexClass',
                name
            });

            assert.strictEqual(
                classification.classification,
                CLASSIFICATIONS.DEPLOYABLE_METADATA,
                name
            );
            assert.strictEqual(classification.artifactRequired, true, name);
            assert.strictEqual(classification.packageable, true, name);
        }
    });
}

main();
