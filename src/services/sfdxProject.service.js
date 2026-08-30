const fs = require('fs');
const path = require('path');
const util = require('util');

const { DEFAULT_API_VERSION } = require('../config/salesforce');

const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const mkdir = util.promisify(fs.mkdir);
const access = util.promisify(fs.access);

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function getSfdxProjectPath(workspacePath) {
    return path.join(workspacePath, 'sfdx-project.json');
}

function buildSfdxProjectDefinition(sourceApiVersion = DEFAULT_API_VERSION) {
    return {
        packageDirectories: [
            {
                path: 'force-app',
                default: true
            }
        ],
        namespace: '',
        sourceApiVersion: sourceApiVersion || DEFAULT_API_VERSION
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

async function readProjectDefinition(workspacePath) {
    const projectPath = getSfdxProjectPath(workspacePath);

    try {
        const raw = await readFile(projectPath, 'utf8');
        return JSON.parse(raw);
    } catch (error) {
        return null;
    }
}

async function ensurePackageDirectories(workspacePath, projectDefinition) {
    const packageDirectories = projectDefinition?.packageDirectories || [];

    for (const entry of packageDirectories) {
        const packagePath = entry?.path;

        if (!packagePath) {
            continue;
        }

        await mkdir(path.join(workspacePath, packagePath), { recursive: true });
    }
}

async function ensureSfdxProject(workspacePath, options = {}) {
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

    const sourceApiVersion =
        options.sourceApiVersion || DEFAULT_API_VERSION;
    const projectPath = getSfdxProjectPath(workspacePath);

    if (await projectFileExists(projectPath)) {
        console.log('Project already exists');

        const existingDefinition = await readProjectDefinition(workspacePath);

        if (existingDefinition) {
            await ensurePackageDirectories(workspacePath, existingDefinition);
        }

        logSection('Project bootstrap complete');

        return {
            success: true,
            created: false,
            projectPath,
            message: 'Salesforce DX project already exists.',
            sourceApiVersion
        };
    }

    try {
        console.log('Creating sfdx-project.json');

        const projectDefinition = buildSfdxProjectDefinition(sourceApiVersion);

        await writeFile(
            projectPath,
            `${JSON.stringify(projectDefinition, null, 4)}\n`,
            { encoding: 'utf8', flag: 'wx' }
        );
        await ensurePackageDirectories(workspacePath, projectDefinition);

        logSection('Project bootstrap complete');

        return {
            success: true,
            created: true,
            projectPath,
            message: 'Salesforce DX project created.',
            sourceApiVersion
        };
    } catch (error) {
        if (error.code === 'EEXIST') {
            console.log('Project already exists');

            const existingDefinition =
                (await readProjectDefinition(workspacePath)) ||
                buildSfdxProjectDefinition(sourceApiVersion);

            await ensurePackageDirectories(workspacePath, existingDefinition);
            logSection('Project bootstrap complete');

            return {
                success: true,
                created: false,
                projectPath,
                message: 'Salesforce DX project already exists.',
                sourceApiVersion
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
    ensureSfdxProject,
    ensurePackageDirectories,
    buildSfdxProjectDefinition
};
