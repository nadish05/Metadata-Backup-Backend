const { exec } = require('child_process');

const {
    retrieveMetadataInternal
} = require('./metadata.controller');

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
    branchName,
    jobId
) {

    const targetBranch =
        branchName || 'main';

    try{

    console.log('===== MIGRATION STARTED =====');

    await axios.post(
    process.env.SF_JOB_API +
    '/updateMigrationJob',
    {
        jobId,
        status: 'Running'
    }
);

    console.log('Retrieving metadata...');

    let projectPath;

    const metadataResult =
    await retrieveMetadataInternal(
        refreshToken,
        instanceUrl
    );

    const workspace =
    metadataResult.workspace;

    projectPath =
    `${workspace}/backup-project`;

    console.log('Metadata retrieved');

    console.log('Initializing Git...');

    await execAsync(
        `cd ${projectPath} && git init`
    );

    console.log('Adding files...');

    await execAsync(
        `cd ${projectPath} && git add .`
    );

    console.log('Creating commit...');

    await execAsync(
        `cd ${projectPath} && git config user.email "backup@system.com" && ` +
        `git config user.name "Salesforce Backup Bot" && ` +
        `git commit -m "Salesforce Metadata Backup"`
    );

    console.log('Pushing to GitHub...');

    const githubToken =
    process.env.GITHUB_TOKEN;

    const authenticatedUrl =
    repoUrl.replace(
        'https://',
        `https://${githubToken}@`
    );

    await execAsync(
        `cd ${projectPath} && ` +
        `git remote add origin ${authenticatedUrl} && ` +
        `git checkout -B ${targetBranch} && ` +
        `git push -u origin ${targetBranch} --force`
    );

    console.log('Push completed');

    await axios.post(
    process.env.SF_JOB_API +
    '/updateMigrationJob',
    {
        jobId,
        status: 'Completed'
    }
);
} catch(error) {

    console.error(
        'BACKGROUND MIGRATION ERROR:',
        error
    );

    try {

        await axios.post(
            process.env.SF_JOB_API +
            '/updateMigrationJob',
            {
                jobId,
                status: 'Failed',
                errorMessage:
                    error.message ||
                    error.stderr ||
                    'Unknown Error'
            }
        );

    } catch(ex) {

        console.error(
            'Failed updating job status',
            ex
        );

    }

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

        const jobResponse =
await axios.post(
    process.env.SF_JOB_API +
    '/createMigrationJob',
    {
        comparisonId,
        branchName,
        migrationType
    }
);

const jobId =
jobResponse.data.jobId;

        
        runMigration(
            refreshToken,
            instanceUrl,
            repoUrl,
            branchName,
            jobId
        ).catch(error => {
            console.error(
                'RUN MIGRATION FAILED:',
                error
            );
        });

        return res.json({
    success: true,
    jobId: jobId,
    status: 'Running',
    message:
        'Migration Started Successfully'
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
 