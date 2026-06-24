const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

exports.analyzeDependencies = async (req, res) => {

    try {

        const {
            repoUrl,
            branch,
            filePath
        } = req.body;

        console.log('================================');
        console.log('DEPENDENCY ANALYSIS STARTED');
        console.log('BRANCH:', branch);
        console.log('FILE:', filePath);

        const githubToken =
            process.env.GITHUB_TOKEN;

        const repoPath =
            `/tmp/dependency-${Date.now()}`;

        const authenticatedUrl =
            repoUrl.replace(
                'https://',
                `https://${githubToken}@`
            );

        console.log('Cloning repository...');

        await execAsync(
            `git clone ${authenticatedUrl} ${repoPath}`
        );

        await execAsync(
            `cd ${repoPath} && git fetch --all`
        );

        console.log('Reading file...');

        const fileContent =
            await execAsync(
                `cd ${repoPath} && git show origin/${branch}:"${filePath}"`
            );

        const content =
            fileContent.stdout;

        console.log('FILE CONTENT LENGTH:',
            content.length
        );

        const systemClasses = [

    'System',
    'String',
    'Database',
    'List',
    'Set',
    'Map',
    'Math',
    'Date',
    'Datetime',
    'Time',
    'LoggingLevel',
    'Exception',
    'JSON',
    'Schema',
    'UserInfo',
    'Test'

];

// Apex Class References
const classRefs =
    content.match(
        /\b[A-Z][A-Za-z0-9_]+\./g
    ) || [];

// Custom Objects
const customObjects =
    content.match(
        /\b[A-Za-z0-9_]+__c\b/g
    ) || [];

// Custom Metadata
const customMetadata =
    content.match(
        /\b[A-Za-z0-9_]+__mdt\b/g
    ) || [];

// Flow References
const flowRefs =
    content.match(
        /Flow\.Interview\.([A-Za-z0-9_]+)/g
    ) || [];

const classes =
    [...new Set(

        classRefs
            .map(
                item =>
                    item.replace('.', '')
            )
            .filter(
                item =>
                    !systemClasses.includes(
                        item
                    )
            )

    )];

const objects =
    [...new Set(customObjects)];

const metadata =
    [...new Set(customMetadata)];

const flows =
    [...new Set(

        flowRefs.map(
            item =>
                item.replace(
                    'Flow.Interview.',
                    ''
                )
        )

    )];

const dependencies = [

    ...objects,
    ...metadata,
    ...classes,
    ...flows

];

        console.log(
            'DEPENDENCIES FOUND:',
            dependencies
        );

        await execAsync(
            `rm -rf ${repoPath}`
        );

        return res.json({

    success: true,

    objects,

    classes,

    flows,

    customMetadata: metadata,

    dependencies,

    dependencyCount:
        dependencies.length

});

    }
    catch (error) {

        console.error(
            'DEPENDENCY ANALYSIS ERROR'
        );

        console.error(error);

        return res.status(500).json({

            success: false,

            error:
                error.stderr ||
                error.stdout ||
                error.message

        });

    }

};