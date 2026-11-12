const { exec } = require('child_process');

const {
    retrieveMetadataInternal
} = require('./metadata.controller');

const {
    setStatus,
    getStatus
} = require('../status.store');

const {
    cleanupRetrievalResources
} = require('../services/retrievalCleanup.service');

const {
    publishOrgMigrationSnapshot,
    logMigrationFailure
} = require('../services/gitMigration/gitMigrationFacade.service');

const RETRIEVAL_CLI_ALIAS = 'temporg';

exports.checkGit = async (req, res) => {

    exec(
        'git --version',
        (error, stdout, stderr) => {

            if (error) {

                return res.status(500).json({
                    success: false,
                    error: stderr || error.message
                });

            }

            return res.json({
                success: true,
                output: stdout
            });

        }
    );

};

const util = require('util');

const execAsync = util.promisify(exec);

exports.cloneRepo = async (req, res) => {

    try {

        const {
            repoUrl
        } = req.body;

        const githubToken =
            process.env.GITHUB_TOKEN;

        const repoPath =
            `/tmp/repo-${Date.now()}`;

        const authenticatedUrl =
            repoUrl.replace(
                'https://',
                `https://${process.env.GITHUB_TOKEN}@`
            );

        const cloneCommand =
            `git clone ${authenticatedUrl} ${repoPath}`;

        const result =
            await execAsync(cloneCommand);

        return res.json({
            success: true,
            repoPath,
            output: result.stdout
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            error:
                error.stderr ||
                error.stdout ||
                error.message
        });

    }

};

async function runMigration(
    refreshToken,
    instanceUrl,
    repoUrl,
    branchName
) {

    const targetBranch =
        branchName || 'main';

    let workspacePath = null;

    try{

    console.log('===== MIGRATION STARTED =====');
    setStatus('Migration started');
    
    

    console.log('Retrieving metadata...');
    setStatus('Retrieving metadata');

    let projectPath;

    const metadataResult =
    await retrieveMetadataInternal(
        refreshToken,
        instanceUrl
    );

    const workspace =
    metadataResult.workspace;

    workspacePath = workspace;

    projectPath =
    `${workspace}/backup-project`;

    console.log('Metadata retrieved');
    setStatus('Metadata retrieved');

    setStatus('Publishing Git snapshot');
    await publishOrgMigrationSnapshot({
        repoUrl,
        branchName: targetBranch,
        snapshotProjectPath: projectPath
    });

    console.log('Push completed');
    setStatus('Push completed');

    
} catch(error) {

    logMigrationFailure(error, repoUrl);
    setStatus('Migration failed');

} finally {
    await cleanupRetrievalResources({
        workspacePath,
        alias: RETRIEVAL_CLI_ALIAS
    });
}



}

exports.migrateToGitHub = async (req, res) => {

    try {

        const {
            refreshToken,
            instanceUrl,
            repoUrl,
            branchName
        } = req.body;

        

        
        runMigration(
            refreshToken,
            instanceUrl,
            repoUrl,
            branchName
        ).catch(error => {
            logMigrationFailure(error, req.body?.repoUrl);
        });

        return res.json({
            success: true,
            message: 'Migration started Successfully. This may take several minutes.'
        });

        

    } catch (error) {

        return res.status(500).json({
            success: false,
            error:
                error.stderr ||
                error.stdout ||
                error.message
        });

    }

};

exports.getMigrationStatus = async (req, res) => {

    try {

        return res.json({
            success: true,
            status: getStatus()
        });

    } catch(error) {

        return res.status(500).json({
            success: false,
            error: error.message
        });

    }

};
