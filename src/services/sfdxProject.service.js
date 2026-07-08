const fs = require('fs');
const path = require('path');
const util = require('util');

const { DEFAULT_API_VERSION } = require('../config/salesforce');

const writeFile = util.promisify(fs.writeFile);
const access = util.promisify(fs.access);

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function getSfdxProjectPath(workspacePath) {
    return path.join(workspacePath, 'sfdx-project.json');
}

function buildSfdxProjectDefinition() {
    return {
        packageDirectories: [
            {
                path: 'force-app',
                default: true
            }
        ],
        namespace: '',
        sourceApiVersion: DEFAULT_API_VERSION
    };
}

async function projectFileExists(projectPath) {
    try {
        await access(projectPath, fs.constants.F_OK);
        return true;
    } catch (error) {
        return false;
    }
}

async function ensureSfdxProject(workspacePath) {
    logSection('SFDX Project Bootstrap Started');
    logSection('Checking project structure');

    if (!workspacePath) {
        return {
            success: false,
            created: false,
            projectPath: null,
            message: 'Workspace path is required to bootstrap Salesforce DX project.'
        };
    }

    const projectPath = getSfdxProjectPath(workspacePath);

    if (await projectFileExists(projectPath)) {
        console.log('Project already exists');
        logSection('Project bootstrap complete');

        return {
            success: true,
            created: false,
            projectPath,
            message: 'Salesforce DX project already exists.'
        };
    }

    try {
        console.log('Creating sfdx-project.json');

        const projectDefinition = buildSfdxProjectDefinition();

        await writeFile(
            projectPath,
            `${JSON.stringify(projectDefinition, null, 4)}\n`,
            { encoding: 'utf8', flag: 'wx' }
        );

        logSection('Project bootstrap complete');

        return {
            success: true,
            created: true,
            projectPath,
            message: 'Salesforce DX project created.'
        };
    } catch (error) {
        if (error.code === 'EEXIST') {
            console.log('Project already exists');
            logSection('Project bootstrap complete');

            return {
                success: true,
                created: false,
                projectPath,
                message: 'Salesforce DX project already exists.'
            };
        }

        return {
            success: false,
            created: false,
            projectPath,
            message:
                error.message ||
                'Unable to create sfdx-project.json for Salesforce DX project.'
        };
    }
}

module.exports = {
    ensureSfdxProject
};
