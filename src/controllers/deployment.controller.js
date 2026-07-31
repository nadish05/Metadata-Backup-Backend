const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

const dependencyAnalyzer = require('../services/dependencyAnalyzer.service');

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

    const analysis =
    dependencyAnalyzer
        .analyzeApexClass(
            cleanedContent
        );

console.log(
    'FILE CONTENT LENGTH:',
    content.length
);

        const systemClasses = [

    'System',
    'String',
    'Integer',
    'Long',
    'Boolean',
    'Decimal',
    'Double',
    'Date',
    'Datetime',
    'Time',

    'List',
    'Set',
    'Map',

    'Math',

    'JSON',
    'Schema',
    'Database',

    'Http',
    'HttpRequest',
    'HttpResponse',

    'RestContext',
    'RestRequest',
    'RestResponse',

    'XmlStreamReader',
    'XmlStreamWriter',

    'Blob',

    'Exception',
    'CalloutException',

    'UserInfo',

    'LoggingLevel',

    'Test'

];

// Apex Class References
const classRefs =
    cleanedContent.match(
        /\b[A-Z][A-Za-z0-9_]+\./g
    ) || [];

// Custom Objects (__c)
const customObjects =
    cleanedContent.match(
        /\b[A-Za-z0-9_]+__c\b/g
    ) || [];

// Custom Metadata Types (__mdt) → CustomObject classification
const customMetadataTypes =
    cleanedContent.match(
        /\b[A-Za-z0-9_]+__mdt\b/g
    ) || [];

// Custom Metadata Records → Type.Record (use original content so
// string literals in getInstance('Record') are preserved)
const customMetadataRecords = [];

for (const match of content.matchAll(
    /\b([A-Za-z][A-Za-z0-9_]*)__mdt\.getInstance\(\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]\s*\)/g
)) {
    customMetadataRecords.push(`${match[1]}.${match[2]}`);
}

for (const match of content.matchAll(
    /\bFROM\s+([A-Za-z][A-Za-z0-9_]*)__mdt\b([\s\S]{0,240}?)(?=;|\])/gi
)) {
    const typeDeveloperName = match[1];
    const clause = match[2] || '';
    for (const developerNameMatch of clause.matchAll(
        /\bDeveloperName\s*=\s*['"]([A-Za-z][A-Za-z0-9_]*)['"]/gi
    )) {
        customMetadataRecords.push(
            `${typeDeveloperName}.${developerNameMatch[1]}`
        );
    }
}

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
    [...new Set(

        classRefs

            .map(
                item =>
                    item.replace('.', '')
            )

            .filter(
                item =>

                    !systemClasses.includes(item) &&

                    !innerClasses.includes(item) &&

                    item !== currentClass

            )

    )];

const objects =
    [...new Set([...customObjects, ...customMetadataTypes])];

const metadata =
    [...new Set(customMetadataRecords)];

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

    namedCredentials:
    analysis.namedCredentials,

    customMetadata: metadata,

    dependencies,

    dependencyCount:

        objects.length +
        classes.length +
        flows.length +
        metadata.length +
        analysis.namedCredentials.length

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

const deploymentValidationService = require('../services/deploymentValidation.service');
const {
    attachReservedDeploymentSelections
} = require('../services/deploymentPlanner/deploymentSelections.foundation');
const sessionPricePackageDebug = require('../services/sessionPricePackageDebug.temp');

exports.validateDeployment = async (req, res) => {

    try {

        const {
            refreshToken,
            instanceUrl,
            orgId,
            deploymentPackage,
            // Optional Deployment Planner preferences (Deploy/Skip).
            deploymentSelections
        } = req.body;

        // TEMPORARY DEBUG — Session__c.Price__c on Validate API entry.
        sessionPricePackageDebug.logFoundBeforePackageBuild({
            collectionName: 'req.body.deploymentPackage.requiredDependencies',
            method: 'deployment.controller.validateDeployment',
            collection: deploymentPackage?.requiredDependencies
        });
        sessionPricePackageDebug.logPackageStage({
            stageName: 'VALIDATE API REQUEST BODY',
            collectionName: 'deploymentPackage.requiredDependencies',
            collection: deploymentPackage?.requiredDependencies,
            method: 'validateDeployment',
            caller: 'POST /api/deployment/validate'
        });
        sessionPricePackageDebug.logPackageStage({
            stageName: 'VALIDATE API REQUEST BODY',
            collectionName: 'deploymentPackage.selectedMetadata',
            collection: deploymentPackage?.selectedMetadata,
            method: 'validateDeployment',
            caller: 'POST /api/deployment/validate'
        });

        // TEMPORARY DIAGNOSTIC — first backend sight of client selections.
        console.log('------------------------------------------');
        console.log('DEPLOYMENT SELECTION CREATED');
        console.log('Caller');
        console.log('POST /api/deployment/validate (client request body)');
        console.log('File');
        console.log('deployment.controller.js');
        console.log('Method');
        console.log('validateDeployment');
        console.log('Current Selection Count');
        console.log(
            Array.isArray(deploymentSelections)
                ? deploymentSelections.length
                : Array.isArray(deploymentPackage?.deploymentSelections)
                  ? deploymentPackage.deploymentSelections.length
                  : 0
        );
        console.log('Last Added Entry');
        console.log(
            JSON.stringify(
                {
                    topLevelDeploymentSelections: deploymentSelections ?? null,
                    packageDeploymentSelections:
                        deploymentPackage?.deploymentSelections ?? null
                },
                null,
                2
            )
        );
        console.log('------------------------------------------');

        // Attach selections when present. Existing clients that omit this
        // field keep the same package reference and behaviour.
        const packageForValidation = attachReservedDeploymentSelections(
            deploymentPackage,
            deploymentSelections
        );

        const result =
            await deploymentValidationService.validateDeployment({
                refreshToken,
                instanceUrl,
                orgId,
                deploymentPackage: packageForValidation
            });

        return res.json(result);

    } catch (error) {

        console.error('DEPLOYMENT VALIDATION ERROR');
        console.error(error);

        return res.status(500).json({
            success: false,
            deploymentValidation: {
                destinationConnected: false,
                status: 'BLOCKED',
                message:
                    error.message ||
                    'Unable to authenticate with destination org.'
            }
        });

    }

};