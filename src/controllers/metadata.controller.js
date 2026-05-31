const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

async function retrieveMetadataInternal(
    refreshToken,
    instanceUrl
) {
 
    /*
     * STEP 1
     * Generate Access Token
     */
 
    const tokenResponse =
        await axios.post(
            'https://login.salesforce.com/services/oauth2/token',
            null,
            {
                params: {
                    grant_type: 'refresh_token',
                    client_id: process.env.SF_CLIENT_ID,
                    client_secret: process.env.SF_CLIENT_SECRET,
                    refresh_token: refreshToken
                }
            }
        );
 
    const accessToken =
        tokenResponse.data.access_token;
 
    /*
     * STEP 2
     * Create Workspace
     */
 
    const workspace =
        `/tmp/workspace-${Date.now()}`;
 
    fs.mkdirSync(
        workspace,
        { recursive: true }
    );
 
    /*
     * STEP 3
     * Generate Project
     */
 
    await execAsync(
        `cd ${workspace} && sf project generate --name backup-project`
    );
 
    /*
     * STEP 4
     * CLI Login
     */
 
    const loginCommand =
        `export SF_ACCESS_TOKEN="${accessToken}" && ` +
        `sf org login access-token ` +
        `-r ${instanceUrl} ` +
        `--alias temporg ` +
        `--no-prompt`;
 
    await execAsync(loginCommand);
 
    /*
     * STEP 5
     * Retrieve Metadata
     */
 
    await execAsync(
        `cd ${workspace}/backup-project && ` +
        `sf project retrieve start ` +
        `-o temporg ` +
        `-m ApexClass`
    );
 
    return {
        workspace,
        accessToken
    };
 
}
 

exports.checkSfCli = async (req, res) => {

    exec('sf --version', (error, stdout, stderr) => {

        if (error) {
            return res.status(500).json({
                success: false,
                error: stderr || error.message
            });
        }

        res.json({
            success: true,
            version: stdout
        });

    });

};

exports.testSfAuth = async (req, res) => {

    try {

        const { accessToken, instanceUrl } = req.body;

        const command =
            `export SF_ACCESS_TOKEN="${accessToken}" && ` +
            `sf org login access-token ` +
            `--instance-url ${instanceUrl} ` +
            `--alias backuporg ` +
            `--no-prompt`;

        exec(
            command,
            (error, stdout, stderr) => {

                if (error) {

                    return res.status(500).json({
                        success: false,
                        error: stderr || error.message
                    });

                }

                res.json({
                    success: true,
                    output: stdout
                });

            }
        );

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });

    }

};

const path = require('path');

exports.retrieveMetadata = async (req, res) => {
 
    try {
 
        const {
            refreshToken,
            instanceUrl
        } = req.body;
 
        const result =
            await retrieveMetadataInternal(
                refreshToken,
                instanceUrl
            );
 
        return res.json({
            success: true,
            workspace: result.workspace
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
 

exports.retrieveAllMetadata = async (req, res) => {

    try {

        console.log('===== RETRIEVE ALL STARTED =====');

        const {
            refreshToken,
            instanceUrl
        } = req.body;
        console.log('Instance URL:', instanceUrl);
        // STEP 1
        console.log('Generating access token...');
        const tokenResponse =
            await axios.post(
                'https://login.salesforce.com/services/oauth2/token',
                null,
                {
                    params: {
                        grant_type: 'refresh_token',
                        client_id: process.env.SF_CLIENT_ID,
                        client_secret: process.env.SF_CLIENT_SECRET,
                        refresh_token: refreshToken
                    }
                }
            );

        const accessToken =
            tokenResponse.data.access_token;

        console.log('Access token generated');

        // STEP 2
        const workspace =
            `/tmp/workspace-${Date.now()}`;

        console.log('Workspace:', workspace);

        fs.mkdirSync(
            workspace,
            { recursive: true }
        );

        // STEP 3

        console.log('Generating Salesforce project...');
        await execAsync(
            `cd ${workspace} && sf project generate --name backup-project`
        );

        console.log('Project generated');

        // STEP 4
        console.log('Logging into Salesforce CLI...');
        const loginCommand =
            `export SF_ACCESS_TOKEN="${accessToken}" && ` +
            `sf org login access-token ` +
            `-r ${instanceUrl} ` +
            `--alias temporg ` +
            `--no-prompt`;

        await execAsync(loginCommand);

        console.log('CLI login successful');

// STEP 5
// STEP 5
console.log('Retrieving metadata...');
 
const metadataTypes = [
  'ApexClass',
  'ApexTrigger',
  'CustomObject'
];

const metadataArgs =
metadataTypes
.map(type => `-m ${type}`)
.join(' ');

console.time('retrieve');
 
const retrieveResult =
await execAsync(
  `cd ${workspace}/backup-project && ` +
  `sf project retrieve start ` +
  `-o temporg ` +
  `${metadataArgs} ` +
  `--json`
);

console.timeEnd('retrieve');
 
console.log('Metadata retrieval completed');

// STEP 6 - GIT INIT

console.log('Initializing Git...');

await execAsync(
  `cd ${workspace}/backup-project && git init`
);

await execAsync(
  `cd ${workspace}/backup-project && git config user.email "backup@system.com"`
);

await execAsync(
  `cd ${workspace}/backup-project && git config user.name "Metadata Backup"`
);

console.log('Git initialized');

// STEP 7 - COMMIT

console.log('Adding files...');

await execAsync(
  `cd ${workspace}/backup-project && git add .`
);

console.log('Creating commit...');

await execAsync(
  `cd ${workspace}/backup-project && git commit -m "Metadata Backup"`
);

console.log('Commit completed');

const githubToken = process.env.GITHUB_TOKEN;

const authenticatedRepoUrl =
`https://${githubToken}@github.com/nadish05/New-salesforce-Backup.git`;

console.log('Adding GitHub remote...');

await execAsync(
  `cd ${workspace}/backup-project && git branch -M main`
);

await execAsync(
  `cd ${workspace}/backup-project && git remote add origin ${authenticatedRepoUrl}`
);

console.log('Pushing to GitHub...');

await execAsync(
  `cd ${workspace}/backup-project && git push origin main --force`
);

console.log('GitHub push completed');



// STEP 8 - FILE COUNT

const fileCount =
await execAsync(
  `find ${workspace}/backup-project -type f | wc -l`
);

console.log(
  'Total Files Retrieved:',
  fileCount.stdout
);

const filesResult =
await execAsync(
  `find ${workspace}/backup-project -type f | head -200`
);

console.log(filesResult.stdout);
 

        return res.json({
            success: true,
            workspace,
            files: filesResult.stdout,
            retrieveOutput: JSON.parse(
                retrieveResult.stdout
            )
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