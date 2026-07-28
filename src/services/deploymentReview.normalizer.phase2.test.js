const assert = require('assert');

const {
    runDeploymentReview,
    normalizeDeploymentPackage
} = require('./deploymentReview.service');

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

const LWC_BASE = 'force-app/main/default/lwc/backupDashboard';
const OTHER_LWC = 'force-app/main/default/lwc/statusBadge';

async function main() {
    await runTest('Scenario 1: four LWC files → one review card', async () => {
        const result = await runDeploymentReview({
            repoUrl: 'https://example.com/repo.git',
            sourceBranch: 'main',
            selectedMetadata: [
                {
                    metadataType: 'LightningComponentBundle',
                    filePath: `${LWC_BASE}/backupDashboard.html`
                },
                {
                    metadataType: 'LightningComponentBundle',
                    filePath: `${LWC_BASE}/backupDashboard.js`
                },
                {
                    metadataType: 'LightningComponentBundle',
                    filePath: `${LWC_BASE}/backupDashboard.css`
                },
                {
                    metadataType: 'LightningComponentBundle',
                    filePath: `${LWC_BASE}/backupDashboard.js-meta.xml`
                }
            ]
        });

        assert.strictEqual(result.success, true);
        assert.strictEqual(result.deploymentReview.length, 1);
        assert.strictEqual(
            result.deploymentReview[0].metadataType,
            'LightningComponentBundle'
        );
        assert.strictEqual(
            result.deploymentReview[0].metadataName,
            'backupDashboard'
        );
        assert.strictEqual(result.deploymentReview[0].status, 'NOT_SUPPORTED_YET');
    });

    await runTest('Scenario 2: two LWC bundles → two review cards', async () => {
        const result = await runDeploymentReview({
            repoUrl: 'https://example.com/repo.git',
            sourceBranch: 'main',
            selectedMetadata: [
                {
                    metadataType: 'LightningComponentBundle',
                    filePath: `${LWC_BASE}/backupDashboard.js`
                },
                {
                    metadataType: 'LightningComponentBundle',
                    filePath: `${OTHER_LWC}/statusBadge.js`
                },
                {
                    metadataType: 'LightningComponentBundle',
                    filePath: `${LWC_BASE}/backupDashboard.html`
                }
            ]
        });

        assert.strictEqual(result.deploymentReview.length, 2);
        const names = result.deploymentReview
            .map((item) => item.metadataName)
            .sort();
        assert.deepStrictEqual(names, ['backupDashboard', 'statusBadge']);
    });

    await runTest(
        'Scenario 3: mixed metadata — only LWC normalized at package ingress',
        async () => {
            const pkg = normalizeDeploymentPackage({
                repoUrl: 'https://example.com/repo.git',
                sourceBranch: 'main',
                selectedMetadata: [
                    {
                        metadataType: 'ApexClass',
                        metadataName: 'MyController',
                        filePath:
                            'force-app/main/default/classes/MyController.cls'
                    },
                    {
                        metadataType: 'Flow',
                        metadataName: 'My_Flow',
                        filePath:
                            'force-app/main/default/flows/My_Flow.flow-meta.xml'
                    },
                    {
                        metadataType: 'CustomObject',
                        metadataName: 'Job__c',
                        filePath:
                            'force-app/main/default/objects/Job__c/Job__c.object-meta.xml'
                    },
                    {
                        metadataType: 'LightningComponentBundle',
                        filePath: `${LWC_BASE}/backupDashboard.js`
                    },
                    {
                        metadataType: 'LightningComponentBundle',
                        filePath: `${LWC_BASE}/backupDashboard.html`
                    }
                ]
            });

            assert.strictEqual(pkg.selectedMetadata.length, 4);

            const byType = pkg.selectedMetadata.reduce((acc, item) => {
                acc[item.metadataType] = (acc[item.metadataType] || 0) + 1;
                return acc;
            }, {});

            assert.strictEqual(byType.ApexClass, 1);
            assert.strictEqual(byType.Flow, 1);
            assert.strictEqual(byType.CustomObject, 1);
            assert.strictEqual(byType.LightningComponentBundle, 1);

            const apex = pkg.selectedMetadata.find(
                (item) => item.metadataType === 'ApexClass'
            );
            assert.strictEqual(
                apex.filePath,
                'force-app/main/default/classes/MyController.cls'
            );
        }
    );

    await runTest(
        'Scenario 5: review response contract unchanged for LWC-only package',
        async () => {
            const result = await runDeploymentReview({
                repoUrl: 'https://example.com/repo.git',
                sourceBranch: 'main',
                selectedMetadata: [
                    {
                        metadataType: 'LightningComponentBundle',
                        filePath: `${LWC_BASE}/backupDashboard.js`
                    }
                ]
            });

            assert.deepStrictEqual(Object.keys(result).sort(), [
                'deploymentReview',
                'success'
            ]);
            assert.deepStrictEqual(
                Object.keys(result.deploymentReview[0]).sort(),
                ['filePath', 'metadataName', 'metadataType', 'status']
            );
        }
    );

    await runTest(
        'Non-LWC selectedMetadata shape unchanged through ingress',
        async () => {
            const pkg = normalizeDeploymentPackage({
                repoUrl: 'https://example.com/repo.git',
                sourceBranch: 'main',
                selectedMetadata: [
                    {
                        metadataType: 'ApexClass',
                        filePath:
                            'force-app/main/default/classes/AccountService.cls'
                    },
                    {
                        metadataType: 'NamedCredential',
                        filePath:
                            'force-app/main/default/namedCredentials/My_NC.namedCredential-meta.xml'
                    }
                ]
            });

            assert.strictEqual(pkg.selectedMetadata.length, 2);
            assert.deepStrictEqual(pkg.selectedMetadata[0], {
                metadataType: 'ApexClass',
                filePath: 'force-app/main/default/classes/AccountService.cls'
            });
            assert.strictEqual(
                pkg.selectedMetadata[1].metadataType,
                'NamedCredential'
            );
        }
    );
}

main();
