'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const util = require('util');

const mkdir = util.promisify(fs.mkdir);
const writeFile = util.promisify(fs.writeFile);
const rm = util.promisify(fs.rm);

const statusStore = require('./deploymentValidationStatus.store');
const deploymentPackageService = require('./deploymentPackage.service');
const {
    buildBoundDeployArtifactRecord,
    computeDeployableArtifactDigest
} = require('./deploymentBoundArtifact.service');
const boundDeployService = require('./deploymentBoundDeploy.service');

function runTest(name, fn) {
    return Promise.resolve()
        .then(fn)
        .then(() => console.log(`PASS: ${name}`))
        .catch((error) => {
            console.error(`FAIL: ${name}`);
            console.error(error);
            process.exitCode = 1;
        });
}

async function createProfileWorkspace(rootDir) {
    const profilesDir = path.join(rootDir, 'profiles');
    await mkdir(profilesDir, { recursive: true });
    const profilePath = path.join(profilesDir, 'Admin.profile-meta.xml');
    const profileXml =
        '<?xml version="1.0" encoding="UTF-8"?>\n<Profile xmlns="http://soap.sforce.com/2006/04/metadata">\n</Profile>\n';
    await writeFile(profilePath, profileXml, 'utf8');

    const packageXml =
        '<?xml version="1.0" encoding="UTF-8"?>\n<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n  <types>\n    <members>Admin</members>\n    <name>Profile</name>\n  </types>\n  <version>62.0</version>\n</Package>\n';
    await writeFile(path.join(rootDir, 'package.xml'), packageXml, 'utf8');

    return { packageXml, profilePath };
}

function buildEligibleValidationResult(workspacePath, packageXml, orgId) {
    return {
        deploymentReadiness: { canDeploy: true },
        checkOnlyDeployment: {
            executed: true,
            success: true,
            status: 'SUCCESS',
            deploymentId: '0AfCHECKONLY'
        },
        generatedWorkspace: {
            status: 'READY',
            workspacePath
        },
        generatedManifest: {
            packageXml,
            summary: { apiVersion: '62.0' }
        },
        generatedDeploymentPackage: {
            profileOnlyMinimalPackage: true,
            metadata: [{ metadataType: 'Profile', metadataName: 'Admin' }],
            summary: { totalComponents: 1 }
        },
        metadataValidation: { overallStatus: 'PASSED' },
        dependencyValidation: { overallStatus: 'PASSED' }
    };
}

async function seedCompletedValidationJob({
    orgId = '00DORG123',
    profileOnlyMinimalPackage = true,
    checkOnlySuccess = true,
    canDeploy = true,
    mutateResult = null
} = {}) {
    const workspacePath = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'bound-deploy-ws-')
    );
    const { packageXml } = await createProfileWorkspace(workspacePath);

    const validationId = statusStore.createJob();
    let result = buildEligibleValidationResult(
        workspacePath,
        packageXml,
        orgId
    );

    if (profileOnlyMinimalPackage === false) {
        result.generatedDeploymentPackage.metadata = [
            { metadataType: 'Profile', metadataName: 'Admin' },
            { metadataType: 'CustomObject', metadataName: 'Account' }
        ];
    }

    if (checkOnlySuccess === false) {
        result.checkOnlyDeployment = {
            executed: true,
            success: false,
            status: 'FAILED'
        };
    }

    if (canDeploy === false) {
        result.deploymentReadiness = { canDeploy: false };
    }

    if (typeof mutateResult === 'function') {
        result = mutateResult(result) || result;
    }

    const deploymentPackage = {
        profileOnlyMinimalPackage: profileOnlyMinimalPackage !== false,
        autoExcludeShapeFormulaConflicts: false
    };

    const artifact = await buildBoundDeployArtifactRecord({
        validationId,
        orgId,
        deploymentPackage,
        finalResponse: result
    });

    if (artifact) {
        result.boundDeployArtifact = artifact;
    }

    statusStore.completeJob(validationId, result);

    return {
        validationId,
        workspacePath,
        packageXml,
        result,
        artifact
    };
}

function stubVerifiedOrg(orgId = '00DORG123') {
    boundDeployService.setResolveVerifiedDestinationOrgIdForTests(async () => orgId);
}

function stubSnapshotPassthrough() {
    boundDeployService.setRunDeployAfterOptionalSnapshotForTests(
        async ({ runDeploymentExecution, afterLockedExecution }) => {
            const deploymentExecution = await runDeploymentExecution();

            if (typeof afterLockedExecution === 'function') {
                await afterLockedExecution({
                    snapshot: null,
                    deploymentExecution
                });
            }

            return {
                deploymentExecution,
                snapshot: null,
                snapshotBlocked: false
            };
        }
    );
}

function resetBoundDeployTestDoubles() {
    boundDeployService.resetRunDeploymentExecutionForTests();
    boundDeployService.resetRunDeployAfterOptionalSnapshotForTests();
    boundDeployService.resetResolveVerifiedDestinationOrgIdForTests();
}

function setupBoundDeploySuccessStubs(orgId = '00DORG123') {
    stubVerifiedOrg(orgId);
    stubSnapshotPassthrough();
}

async function cleanupWorkspace(workspacePath) {
    if (workspacePath) {
        await rm(workspacePath, { recursive: true, force: true });
    }
}

async function main() {
    statusStore.clearAllJobs();
    statusStore.resetTtlForTests();

    await runTest(
        'successful bound deploy reuses validated workspace and manifest',
        async () => {
            setupBoundDeploySuccessStubs();
            const seeded = await seedCompletedValidationJob();
            let captured = null;

            boundDeployService.setRunDeploymentExecutionForTests(async (args) => {
                captured = args;
                return {
                    success: true,
                    deploymentId: '0AfDEPLOY',
                    deploymentSummary: { success: true }
                };
            });

            const response =
                await boundDeployService.deployBoundValidationArtifact({
                    boundValidationId: seeded.validationId,
                    refreshToken: 'rt',
                    instanceUrl: 'https://example.my.salesforce.com',
                    orgId: '00DORG123'
                });

            assert.strictEqual(response.success, true);
            assert.strictEqual(response.boundDeploy.packageRegenerated, false);
            assert.strictEqual(
                path.resolve(captured.generatedWorkspace.workspacePath),
                path.resolve(seeded.artifact.canonicalWorkspaceRoot)
            );
            assert.strictEqual(
                captured.generatedManifest.packageXml,
                seeded.packageXml
            );
            assert.strictEqual(
                captured.priorCheckOnlyDeployment.deploymentId,
                '0AfCHECKONLY'
            );

            const job = statusStore.getJob(seeded.validationId);
            assert.strictEqual(job.boundDeployClaim.state, 'CONSUMED');

            resetBoundDeployTestDoubles();
            await cleanupWorkspace(seeded.workspacePath);
        }
    );

    await runTest(
        'bound deploy does not invoke deployment package generation',
        async () => {
            setupBoundDeploySuccessStubs();
            const seeded = await seedCompletedValidationJob();
            let generateCalled = false;
            const originalGenerate =
                deploymentPackageService.generateDeploymentPackage;

            deploymentPackageService.generateDeploymentPackage = async () => {
                generateCalled = true;
                return originalGenerate.apply(deploymentPackageService, arguments);
            };

            boundDeployService.setRunDeploymentExecutionForTests(async () => ({
                success: true,
                deploymentId: '0AfDEPLOY'
            }));

            await boundDeployService.deployBoundValidationArtifact({
                boundValidationId: seeded.validationId,
                refreshToken: 'rt',
                instanceUrl: 'https://example.my.salesforce.com',
                orgId: '00DORG123'
            });

            assert.strictEqual(generateCalled, false);

            deploymentPackageService.generateDeploymentPackage = originalGenerate;
            resetBoundDeployTestDoubles();
            await cleanupWorkspace(seeded.workspacePath);
        }
    );

    await runTest('failed validation job is rejected', async () => {
        const validationId = statusStore.createJob();
        statusStore.failJob(validationId, new Error('validation failed'));

        const response = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(response.boundDeploy.code, 'BOUND_VALIDATION_FAILED');
    });

    await runTest('non Profile-only validation is not eligible', async () => {
        const seeded = await seedCompletedValidationJob({
            profileOnlyMinimalPackage: false
        });

        assert.strictEqual(seeded.artifact, null);

        const response = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(response.boundDeploy.code, 'BOUND_DEPLOY_NOT_ELIGIBLE');
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest('verified destination org mismatch is rejected', async () => {
        setupBoundDeploySuccessStubs('00DOTHER');
        const seeded = await seedCompletedValidationJob({ orgId: '00DORG123' });

        const response = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(
            response.boundDeploy.code,
            'BOUND_DESTINATION_ORG_MISMATCH'
        );

        resetBoundDeployTestDoubles();
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest('destination identity verification failure is rejected', async () => {
        const { OrgLockIdentityError } = require('./deploymentOrgLock/deploymentOrgLock.errors');
        setupBoundDeploySuccessStubs();
        boundDeployService.setResolveVerifiedDestinationOrgIdForTests(async () => {
            throw new OrgLockIdentityError('identity lookup failed');
        });
        const seeded = await seedCompletedValidationJob();

        const response = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(
            response.boundDeploy.code,
            'BOUND_DESTINATION_IDENTITY_FAILED'
        );

        resetBoundDeployTestDoubles();
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest('modified manifest rejects bound deploy', async () => {
        setupBoundDeploySuccessStubs();
        const seeded = await seedCompletedValidationJob();

        await writeFile(
            path.join(seeded.workspacePath, 'package.xml'),
            seeded.packageXml.replace('62.0', '63.0'),
            'utf8'
        );

        const response = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(
            response.boundDeploy.code,
            'BOUND_ARTIFACT_INTEGRITY_FAILED'
        );

        resetBoundDeployTestDoubles();
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest('modified deployable file rejects bound deploy', async () => {
        setupBoundDeploySuccessStubs();
        const seeded = await seedCompletedValidationJob();

        await writeFile(
            path.join(seeded.workspacePath, 'profiles', 'Admin.profile-meta.xml'),
            '<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><custom>true</custom></Profile>',
            'utf8'
        );

        const response = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(
            response.boundDeploy.code,
            'BOUND_ARTIFACT_INTEGRITY_FAILED'
        );

        resetBoundDeployTestDoubles();
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest('missing workspace rejects bound deploy', async () => {
        setupBoundDeploySuccessStubs();
        const seeded = await seedCompletedValidationJob();
        await cleanupWorkspace(seeded.workspacePath);

        const response = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(
            response.boundDeploy.code,
            'BOUND_ARTIFACT_INTEGRITY_FAILED'
        );

        resetBoundDeployTestDoubles();
    });

    await runTest('concurrent bound deploy returns in progress', async () => {
        setupBoundDeploySuccessStubs();
        const seeded = await seedCompletedValidationJob();
        let inFlight = 0;
        let maxInFlight = 0;

        boundDeployService.setRunDeployAfterOptionalSnapshotForTests(
            async ({ runDeploymentExecution }) => {
                inFlight += 1;
                maxInFlight = Math.max(maxInFlight, inFlight);
                await new Promise((resolve) => setTimeout(resolve, 40));
                const deploymentExecution = await runDeploymentExecution();
                inFlight -= 1;
                return { deploymentExecution, snapshot: null };
            }
        );
        boundDeployService.setRunDeploymentExecutionForTests(async () => ({
            success: true,
            deploymentId: '0AfCONCURRENT'
        }));

        const request = () =>
            boundDeployService.deployBoundValidationArtifact({
                boundValidationId: seeded.validationId,
                refreshToken: 'rt',
                instanceUrl: 'https://example.my.salesforce.com',
                orgId: '00DORG123'
            });

        const [first, second] = await Promise.all([request(), request()]);
        const codes = [first.boundDeploy?.code, second.boundDeploy?.code];

        assert.ok(codes.includes('BOUND_DEPLOY_IN_PROGRESS'));
        assert.ok(
            first.success === true || second.success === true,
            'one request should succeed'
        );
        assert.strictEqual(maxInFlight, 1);

        resetBoundDeployTestDoubles();
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest('consumed artifact rejects sequential redeploy', async () => {
        setupBoundDeploySuccessStubs();
        const seeded = await seedCompletedValidationJob();
        boundDeployService.setRunDeploymentExecutionForTests(async () => ({
            success: true,
            deploymentId: '0AfONCE'
        }));

        const first = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });
        assert.strictEqual(first.success, true);

        const second = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(second.boundDeploy.code, 'BOUND_DEPLOY_CONSUMED');

        resetBoundDeployTestDoubles();
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest('confirmed deploy failure allows retry', async () => {
        setupBoundDeploySuccessStubs();
        const seeded = await seedCompletedValidationJob();
        let attempts = 0;

        boundDeployService.setRunDeploymentExecutionForTests(async () => {
            attempts += 1;
            if (attempts === 1) {
                return {
                    success: false,
                    status: 'FAILED',
                    message: 'Simulated CLI failure'
                };
            }

            return {
                success: true,
                deploymentId: '0AfRETRY'
            };
        });

        const first = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(first.success, false);
        assert.strictEqual(
            statusStore.getJob(seeded.validationId).boundDeployClaim.state,
            'DEPLOY_FAILED'
        );

        const second = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(second.success, true);
        assert.strictEqual(attempts, 2);

        resetBoundDeployTestDoubles();
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest('uncertain outcome requires reconciliation before retry', async () => {
        setupBoundDeploySuccessStubs();
        const seeded = await seedCompletedValidationJob();

        boundDeployService.setRunDeployAfterOptionalSnapshotForTests(async () => {
            throw new Error('timeout after CLI dispatch');
        });

        const first = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(first.boundDeploy.code, 'BOUND_DEPLOY_UNCERTAIN');
        assert.strictEqual(
            statusStore.getJob(seeded.validationId).boundDeployClaim.state,
            'UNCERTAIN'
        );

        const retry = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(retry.boundDeploy.code, 'BOUND_DEPLOY_UNCERTAIN');

        statusStore.reconcileBoundDeployClaim(
            seeded.validationId,
            'MARK_DEPLOY_FAILED'
        );

        boundDeployService.setRunDeployAfterOptionalSnapshotForTests(
            async ({ runDeploymentExecution }) => ({
                deploymentExecution: await runDeploymentExecution(),
                snapshot: null
            })
        );
        boundDeployService.setRunDeploymentExecutionForTests(async () => ({
            success: true,
            deploymentId: '0AfAFTERRECON'
        }));

        const afterReconcile =
            await boundDeployService.deployBoundValidationArtifact({
                boundValidationId: seeded.validationId,
                refreshToken: 'rt',
                instanceUrl: 'https://example.my.salesforce.com',
                orgId: '00DORG123'
            });

        assert.strictEqual(afterReconcile.success, true);

        resetBoundDeployTestDoubles();
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest('unknown validation id is rejected', async () => {
        const response = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: 'validation_does_not_exist',
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(
            response.boundDeploy.code,
            'BOUND_VALIDATION_NOT_FOUND'
        );
    });

    await runTest('expired validation id is rejected', async () => {
        statusStore.setTtlForTests(1, 1000);
        const seeded = await seedCompletedValidationJob();
        await new Promise((resolve) => setTimeout(resolve, 25));

        const response = await boundDeployService.deployBoundValidationArtifact({
            boundValidationId: seeded.validationId,
            refreshToken: 'rt',
            instanceUrl: 'https://example.my.salesforce.com',
            orgId: '00DORG123'
        });

        assert.strictEqual(
            response.boundDeploy.code,
            'BOUND_VALIDATION_NOT_FOUND'
        );

        statusStore.resetTtlForTests();
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest('failed check-only validation does not produce artifact', async () => {
        const seeded = await seedCompletedValidationJob({
            checkOnlySuccess: false
        });

        assert.strictEqual(seeded.artifact, null);
        await cleanupWorkspace(seeded.workspacePath);
    });

    await runTest(
        'readiness blocked validation does not produce bound artifact',
        async () => {
            const seeded = await seedCompletedValidationJob({
                canDeploy: false
            });

            assert.strictEqual(seeded.artifact, null);
            await cleanupWorkspace(seeded.workspacePath);
        }
    );

    await runTest(
        'auto-validation mutation changes artifact digest before reuse',
        async () => {
            const workspacePath = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'bound-deploy-ws-')
            );
            const { packageXml } = await createProfileWorkspace(workspacePath);
            const validationId = statusStore.createJob();

            const initialResult = buildEligibleValidationResult(
                workspacePath,
                packageXml,
                '00DORG123'
            );

            const deploymentPackage = {
                profileOnlyMinimalPackage: true,
                autoExcludeShapeFormulaConflicts: false
            };

            const initialArtifact = await buildBoundDeployArtifactRecord({
                validationId,
                orgId: '00DORG123',
                deploymentPackage,
                finalResponse: initialResult
            });

            await writeFile(
                path.join(workspacePath, 'profiles', 'Admin.profile-meta.xml'),
                '<Profile xmlns="http://soap.sforce.com/2006/04/metadata"><label>mutated</label></Profile>',
                'utf8'
            );

            const mutatedResult = buildEligibleValidationResult(
                workspacePath,
                packageXml,
                '00DORG123'
            );

            const mutatedArtifact = await buildBoundDeployArtifactRecord({
                validationId,
                orgId: '00DORG123',
                deploymentPackage,
                finalResponse: mutatedResult
            });

            assert.notStrictEqual(
                initialArtifact.artifactDigest,
                mutatedArtifact.artifactDigest
            );

            await cleanupWorkspace(workspacePath);
        }
    );

    await runTest(
        'digest includes policy fields and deployable file hashes',
        async () => {
            const workspacePath = await fs.promises.mkdtemp(
                path.join(os.tmpdir(), 'bound-artifact-digest-')
            );
            const { packageXml } = await createProfileWorkspace(workspacePath);

            const digestResult = await computeDeployableArtifactDigest({
                workspacePath,
                manifestPackageXml: packageXml,
                profileOnlyMinimalPackageApplied: true,
                autoExcludeShapeFormulaConflicts: true,
                destinationOrgId: '00DORG123',
                deploymentApiVersion: '62.0'
            });

            assert.ok(digestResult.digest);
            assert.strictEqual(
                digestResult.canonicalPayload.profileOnlyMinimalPackageApplied,
                true
            );
            assert.strictEqual(
                digestResult.canonicalPayload.autoExcludeShapeFormulaConflicts,
                true
            );
            assert.strictEqual(
                digestResult.canonicalPayload.destinationOrgId,
                '00DORG123'
            );
            assert.ok(
                digestResult.canonicalPayload.deployableFiles.some((file) =>
                    file.path.includes('Admin.profile-meta.xml')
                )
            );

            await cleanupWorkspace(workspacePath);
        }
    );

    statusStore.clearAllJobs();
}

main();
