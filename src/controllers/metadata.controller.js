const axios = require('axios');
const fs = require('fs');
const { exec } = require('child_process');
const util = require('util');

const execAsync = util.promisify(exec);

const {
    setStatus
} = require('../status.store');

const {
    cleanupRetrievalResources
} = require('../services/retrievalCleanup.service');
const {
    persistRetrievalSnapshotMetadata
} = require('../services/retrievalSnapshotMetadata.service');
const {
    getLatestApiVersion
} = require('../services/destinationInventory/destinationInventoryBuilder.service');

const RETRIEVAL_CLI_ALIAS = 'temporg';

/**
 * Metadata types requested by retrieveMetadataInternal via `-m <Type>`.
 * Keep in sync with the migrate backup retrieve path only.
 */
const RETRIEVAL_METADATA_TYPES = [
    'ApexClass',
    'ApexTrigger',
    'LightningComponentBundle',
    'AuraDefinitionBundle',
    'FlexiPage',
    'ApexPage',
    'ApexComponent',
    'CustomObject',
    'CustomField',
    'CustomTab',
    'ValidationRule',
    'RecordType',
    'Flow',
    'Workflow',
    'AssignmentRules',
    'EscalationRules',
    'PermissionSet',
    'CustomPermission',
    'Profile',
    'NamedCredential',
    'ExternalCredential',
    'CustomLabel',
    'CustomMetadata'
];

/**
 * Standard-object members required so Profile RecordTypes on Account /
 * Opportunity are retrieved. Bare `-m CustomObject` does not return these.
 * Do NOT add Equipment__c (Equipment label maps to Product2).
 */
const RETRIEVAL_STANDARD_OBJECT_MEMBERS = [
    'CustomObject:Account',
    'CustomObject:Opportunity'
];

const RETRIEVE_RESULT_PROBES = [
    'Equipment_Maintenance_Item__c',
    'Maintenance_Request__c'
];

function buildRetrieveMetadataMembers() {
    return [
        ...RETRIEVAL_METADATA_TYPES,
        ...RETRIEVAL_STANDARD_OBJECT_MEMBERS
    ];
}

function buildRetrieveMetadataArgs(members = buildRetrieveMetadataMembers()) {
    return members.map((member) => `-m ${member}`).join(' ');
}

function extractJsonPayload(stdout) {
    const text = String(stdout || '').trim();
    if (!text) {
        return null;
    }

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end < start) {
        return null;
    }

    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch (error) {
        return null;
    }
}

function collectRetrieveFileStrings(files) {
    if (!Array.isArray(files)) {
        return [];
    }

    return files.map((file) => {
        if (typeof file === 'string') {
            return file;
        }
        if (!file || typeof file !== 'object') {
            return String(file);
        }

        return [
            file.filePath,
            file.path,
            file.fullName,
            file.type,
            file.state
        ]
            .filter(Boolean)
            .join(' ');
    });
}

function summarizeRetrieveResultJson(stdout) {
    const text = String(stdout || '').trim();
    if (!text) {
        return {
            parsed: false,
            reason: 'empty_stdout'
        };
    }

    const payload = extractJsonPayload(text);
    if (!payload) {
        return {
            parsed: false,
            reason: 'invalid_json',
            stdoutLength: text.length
        };
    }

    const result = payload.result && typeof payload.result === 'object'
        ? payload.result
        : payload;
    const files = result.files || result.fileProperties || [];
    const failures = result.failures
        || (Array.isArray(result.messages) ? result.messages : null)
        || payload.warnings
        || [];
    const fileStrings = collectRetrieveFileStrings(files);
    const searchText = `${fileStrings.join('\n')}\n${JSON.stringify(failures)}`;

    const probes = {};
    for (const name of RETRIEVE_RESULT_PROBES) {
        probes[name] = searchText.includes(name);
    }

    return {
        parsed: true,
        status: payload.status,
        fileCount: fileStrings.length,
        failureCount: Array.isArray(failures) ? failures.length : 0,
        failures: Array.isArray(failures) ? failures.slice(0, 25) : failures,
        sampleFiles: fileStrings.slice(0, 40),
        probes
    };
}

function logRetrieveResultDebug(stdout) {
    const summary = summarizeRetrieveResultJson(stdout);

    console.log('========================================');
    console.log('METADATA RETRIEVE RESULT DEBUG');
    console.log('========================================');

    if (!summary.parsed) {
        console.log('parsed: false');
        console.log('reason:', summary.reason);
        if (summary.stdoutLength != null) {
            console.log('stdoutLength:', summary.stdoutLength);
        }
        console.log('========================================');
        return summary;
    }

    console.log('status:', summary.status);
    console.log('fileCount:', summary.fileCount);
    console.log('failureCount:', summary.failureCount);
    console.log('probes:', JSON.stringify(summary.probes, null, 2));

    if (summary.failureCount > 0) {
        console.log('failures (truncated):');
        console.log(JSON.stringify(summary.failures, null, 2));
    }

    if (summary.sampleFiles.length > 0) {
        console.log('sampleFiles (truncated):');
        for (const file of summary.sampleFiles) {
            console.log(' -', file);
        }
        if (summary.fileCount > summary.sampleFiles.length) {
            console.log(
                ` - ... ${summary.fileCount - summary.sampleFiles.length} more file(s)`
            );
        }
    } else {
        console.log('sampleFiles: (none)');
    }

    console.log('========================================');
    return summary;
}

exports.RETRIEVAL_METADATA_TYPES = RETRIEVAL_METADATA_TYPES;
exports.RETRIEVAL_STANDARD_OBJECT_MEMBERS = RETRIEVAL_STANDARD_OBJECT_MEMBERS;
exports.buildRetrieveMetadataMembers = buildRetrieveMetadataMembers;
exports.buildRetrieveMetadataArgs = buildRetrieveMetadataArgs;
exports.summarizeRetrieveResultJson = summarizeRetrieveResultJson;

function resolveSourceOrgId(identityUrl) {
    try {
        const segments = new URL(identityUrl).pathname
            .split('/')
            .filter(Boolean);

        return segments[0] === 'id' ? segments[1] || null : null;
    } catch (error) {
        return null;
    }
}

async function createRetrievalSnapshot({
    projectPath,
    tokenResponse,
    instanceUrl,
    accessToken
}) {
    const sourceOrgId = resolveSourceOrgId(tokenResponse?.data?.id);
    let result;

    try {
        result = await persistRetrievalSnapshotMetadata({
            projectPath,
            sourceOrgId,
            instanceUrl,
            accessToken,
            retrievedAt: new Date().toISOString(),
            getLatestApiVersionFn: getLatestApiVersion
        });
    } catch (error) {
        result = {
            snapshotMetadata: {
                sourceOrgId,
                sourceMetadataApiVersion: null
            },
            written: false
        };
    }

    console.log('================================================');
    console.log('RETRIEVAL SNAPSHOT METADATA');
    console.log('================================================');
    console.log('');
    console.log(
        'Source Org:',
        result.snapshotMetadata.sourceOrgId || '(unknown)'
    );
    console.log('');
    console.log(
        'Metadata API:',
        result.snapshotMetadata.sourceMetadataApiVersion || '(unknown)'
    );
    console.log('');
    console.log(
        'Snapshot File:',
        '.metadata-backup/retrieval-metadata.json'
    );
    console.log('');
    console.log('Written:', result.written ? 'YES' : 'NO');

    return result;
}

exports.retrieveMetadataInternal = async (
    refreshToken,
    instanceUrl
) => {

    let workspace;
    let deferCleanup = false;

    try {
 
        console.log('STEP 1 - Generating token');
        setStatus('Generating token');
 
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

        console.log(
    JSON.stringify(
        tokenResponse.data,
        null,
        2
    )
);
 
        console.log('STEP 1 COMPLETE');
 
        const accessToken =
        tokenResponse.data.access_token;

        console.log('TOKEN RESPONSE');

console.log(
    JSON.stringify(
        tokenResponse.data,
        null,
        2
    )
);
 
        console.log('STEP 2 - Creating workspace');
        setStatus('Creating workspace');
 
        workspace =
        `/tmp/workspace-${Date.now()}`;
 
        fs.mkdirSync(
            workspace,
            { recursive: true }
        );
 
        console.log('STEP 2 COMPLETE');
 
        console.log('STEP 3 - Generating project');
        setStatus('Generating project');
        await execAsync(
            `cd ${workspace} && sf project generate --name backup-project`
        );
 
        console.log('STEP 3 COMPLETE');

        await createRetrievalSnapshot({
            projectPath: `${workspace}/backup-project`,
            tokenResponse,
            instanceUrl,
            accessToken
        });
 
        console.log('STEP 4 - CLI Login');
        setStatus('CLI Login');
 
        const loginCommand =
`export SF_ACCESS_TOKEN="${accessToken}" && ` +
`sf org login access-token ` +
`-r ${instanceUrl} ` +
`--alias temporg ` +
`--no-prompt`;

try {

    const loginResult =
        await execAsync(loginCommand);

    console.log('LOGIN STDOUT');
    console.log(loginResult.stdout);

    console.log('LOGIN STDERR');
    console.log(loginResult.stderr);

}
catch(error) {

    console.log('LOGIN FAILED');

    console.log('STDOUT');
    console.log(error.stdout);

    console.log('STDERR');
    console.log(error.stderr);

    throw error;

}

console.log('STEP 4 COMPLETE');
 
        console.log('STEP 5 - Retrieving ApexClass');
        setStatus('Retrieving ApexClass');

const metadataArgs = buildRetrieveMetadataArgs();

console.log(
 'Retrieving Full Metadata...'
);
console.log('Retrieve metadata args:', metadataArgs);
setStatus('Retrieving Full Metadata');

let retrieveStdout = '';
let retrieveStderr = '';

try {
    const retrieveCliResult = await execAsync(
        `cd ${workspace}/backup-project && ` +
        `sf project retrieve start ` +
        `-o temporg ` +
        `${metadataArgs} ` +
        `--json`,
        {
            maxBuffer: 50 * 1024 * 1024
        }
    );

    retrieveStdout = retrieveCliResult.stdout || '';
    retrieveStderr = retrieveCliResult.stderr || '';
} catch (error) {
    retrieveStdout = error.stdout || '';
    retrieveStderr = error.stderr || '';

    logRetrieveResultDebug(retrieveStdout);

    if (retrieveStderr) {
        console.log('RETRIEVE STDERR');
        console.log(retrieveStderr);
    }

    // Preserve existing behavior: CLI non-zero exit still fails the migrate.
    throw error;
}

const retrieveSummary = logRetrieveResultDebug(retrieveStdout);

if (retrieveStderr) {
    console.log('RETRIEVE STDERR');
    console.log(retrieveStderr);
}

// Narrow check only: Salesforce CLI reported a non-zero JSON status
// even though the process may have returned stdout. Do not change
// behavior for status 0 / unparsable stdout (continue as before).
if (
    retrieveSummary.parsed &&
    typeof retrieveSummary.status === 'number' &&
    retrieveSummary.status !== 0
) {
    throw new Error(
        `Salesforce CLI retrieve reported status ${retrieveSummary.status}`
    );
}

console.log(
 'Full Metadata Retrieval Complete'
);
setStatus('Full Metadata Retrieval Complete');

        console.log('STEP 5 COMPLETE');

        deferCleanup = true;

        return {
            workspace,
            accessToken
        };
 
    } catch (error) {
 
        console.error(
            'retrieveMetadataInternal FAILED:',
            error
        );
 
        throw error;
    } finally {
        await cleanupRetrievalResources({
            workspacePath: deferCleanup ? null : workspace,
            alias: deferCleanup ? null : RETRIEVAL_CLI_ALIAS
        });
    }
};
 
 

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

    let workspacePath = null;

    try {
 
        const {
            refreshToken,
            instanceUrl
        } = req.body;
 
        const result =
            await exports.retrieveMetadataInternal(
                refreshToken,
                instanceUrl
            );

        workspacePath = result.workspace;
 
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
 
    } finally {
        await cleanupRetrievalResources({
            workspacePath,
            alias: RETRIEVAL_CLI_ALIAS
        });
    }
 
};
 

exports.retrieveAllMetadata = async (req, res) => {

    let workspace = null;

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
        workspace =
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

        await createRetrievalSnapshot({
            projectPath: `${workspace}/backup-project`,
            tokenResponse,
            instanceUrl,
            accessToken
        });

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
  'CustomObject',
  'CustomTab',
  'NamedCredential',
  'ExternalCredential',
  'CustomLabel',
  'CustomMetadata'
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

    } finally {
        await cleanupRetrievalResources({
            workspacePath: workspace,
            alias: RETRIEVAL_CLI_ALIAS
        });
    }

};