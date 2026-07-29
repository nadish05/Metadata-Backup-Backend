const assert = require('assert');
const { spawnSync } = require('child_process');
const path = require('path');

const {
    prepareDeploymentPackageForValidation
} = require('./deploymentValidation.service');

const {
    normalizeDeploymentPackage,
    runDeploymentReview
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
    await runTest(
        'Scenario 1: four LWC files → one validation selectedMetadata row',
        async () => {
            const original = {
                repoUrl: 'https://example.com/repo.git',
                sourceBranch: 'main',
                selectedMetadata: [
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.html`
                    },
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.js`
                    },
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.css`
                    },
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.js-meta.xml`
                    }
                ]
            };

            const prepared = prepareDeploymentPackageForValidation(original);

            assert.strictEqual(prepared.selectedMetadata.length, 1);
            assert.strictEqual(
                prepared.selectedMetadata[0].metadataType,
                'LightningComponentBundle'
            );
            assert.strictEqual(
                prepared.selectedMetadata[0].metadataName,
                'backupDashboard'
            );
            // Original package inventory must not be mutated.
            assert.strictEqual(original.selectedMetadata.length, 4);
        }
    );

    await runTest(
        'Scenario 2: two LWC bundles → two validation selectedMetadata rows',
        async () => {
            const prepared = prepareDeploymentPackageForValidation({
                selectedMetadata: [
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.js`
                    },
                    {
                        metadataType: 'LWC',
                        filePath: `${OTHER_LWC}/statusBadge.js`
                    },
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.html`
                    }
                ]
            });

            assert.strictEqual(prepared.selectedMetadata.length, 2);
            const names = prepared.selectedMetadata
                .map((item) => item.metadataName)
                .sort();
            assert.deepStrictEqual(names, ['backupDashboard', 'statusBadge']);
        }
    );

    await runTest(
        'Scenario 3: mixed metadata — only LWC normalized',
        async () => {
            const prepared = prepareDeploymentPackageForValidation({
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
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.html`
                    }
                ]
            });

            assert.strictEqual(prepared.selectedMetadata.length, 4);
            const byType = prepared.selectedMetadata.reduce((acc, item) => {
                acc[item.metadataType] = (acc[item.metadataType] || 0) + 1;
                return acc;
            }, {});

            assert.strictEqual(byType.ApexClass, 1);
            assert.strictEqual(byType.Flow, 1);
            assert.strictEqual(byType.CustomObject, 1);
            assert.strictEqual(byType.LightningComponentBundle, 1);
        }
    );

    await runTest(
        'Scenario 4: package shape retained (response contract field intact)',
        async () => {
            const prepared = prepareDeploymentPackageForValidation({
                repoUrl: 'https://example.com/repo.git',
                sourceBranch: 'main',
                requiredDependencies: [{ name: 'Dep', type: 'ApexClass' }],
                selectedTestClasses: ['MyTest'],
                selectedMetadata: [
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.js`
                    }
                ]
            });

            assert.strictEqual(prepared.repoUrl, 'https://example.com/repo.git');
            assert.strictEqual(prepared.sourceBranch, 'main');
            assert.deepStrictEqual(prepared.requiredDependencies, [
                { name: 'Dep', type: 'ApexClass' }
            ]);
            assert.deepStrictEqual(prepared.selectedTestClasses, ['MyTest']);
            assert.ok(Array.isArray(prepared.selectedMetadata));
        }
    );

    await runTest(
        'Scenario 5: Deployment Review still collapses LWC and has no diagnostic strings',
        async () => {
            const reviewPkg = normalizeDeploymentPackage({
                repoUrl: 'https://example.com/repo.git',
                sourceBranch: 'main',
                selectedMetadata: [
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.html`
                    },
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.js`
                    },
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.css`
                    },
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.js-meta.xml`
                    }
                ]
            });

            assert.strictEqual(reviewPkg.selectedMetadata.length, 1);

            const result = await runDeploymentReview({
                repoUrl: 'https://example.com/repo.git',
                sourceBranch: 'main',
                selectedMetadata: [
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.js`
                    },
                    {
                        metadataType: 'LWC',
                        filePath: `${LWC_BASE}/backupDashboard.html`
                    }
                ]
            });

            assert.strictEqual(result.success, true);
            assert.strictEqual(result.deploymentReview.length, 1);

            const reviewSource = path.join(
                __dirname,
                'deploymentReview.service.js'
            );
            const probe = spawnSync(
                process.execPath,
                [
                    '-e',
                    `const fs=require('fs'); const t=fs.readFileSync(${JSON.stringify(reviewSource)},'utf8'); if (t.includes('RAW SELECTED METADATA') || t.includes('NORMALIZED METADATA') || t.includes('logTemporaryMetadataDiagnostic')) process.exit(2);`
                ],
                { encoding: 'utf8' }
            );
            assert.strictEqual(
                probe.status,
                0,
                'temporary Review diagnostics must be removed'
            );
        }
    );
}

main();
