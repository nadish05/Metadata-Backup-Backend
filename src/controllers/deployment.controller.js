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

const cleanedContent =
    content.replace(
        /'[^']*'/g,
        ''
    );

console.log(
    'FILE CONTENT LENGTH:',
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
    cleanedContent.match(
        /\b[A-Z][A-Za-z0-9_]+\./g
    ) || [];

// Custom Objects
const customObjects =
    cleanedContent.match(
        /\b[A-Za-z0-9_]+__c\b/g
    ) || [];

// Custom Metadata
const customMetadata =
    cleanedContent.match(
        /\b[A-Za-z0-9_]+__mdt\b/g
    ) || [];

const namedCredentialMatches =
    cleanedContent.match(
        /callout:([A-Za-z0-9_]+)/g
    ) || [];

const namedCredentials =
    [...new Set(

        namedCredentialMatches.map(
            item =>
                item.replace(
                    'callout:',
                    ''
                )
        )

    )];

const constructorMatches =
    cleanedContent.match(
        /new\s+([A-Z][A-Za-z0-9_]+)/g
    ) || [];

const constructorClasses =
    constructorMatches.map(
        item =>
            item.replace(
                'new ',
                ''
            )
    );

    const innerClassMatches =
    cleanedContent.match(
        /(public|private)\s+class\s+([A-Za-z0-9_]+)/g
    ) || [];

const innerClasses =
    innerClassMatches.map(
        item =>
            item.split('class ')[1]
    );

// Flow References
const flowRefs =
    cleanedContent.match(
        /Flow\.Interview\.([A-Za-z0-9_]+)/g
    ) || [];

const classes =
    [...new Set([

        ...classRefs.map(
            item =>
                item.replace('.', '')
        ),

        ...constructorClasses,

        ...innerClasses

    ])]
    .filter(
        item =>
            !systemClasses.includes(
                item
            )
    );

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

    namedCredentials,

    customMetadata: metadata,

    dependencies,

    dependencyCount:

        objects.length +
        classes.length +
        flows.length +
        metadata.length +
        namedCredentials.length

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