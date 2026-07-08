const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

let cachedCompatibility = null;
let detectionPromise = null;

function logSection(title) {
    console.log('------------------------------------');
    console.log(title);
    console.log('------------------------------------');
}

function extractCliVersion(versionOutput) {
    if (!versionOutput) {
        return null;
    }

    const lines = String(versionOutput)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    if (!lines.length) {
        return null;
    }

    const versionLine =
        lines.find((line) => /@salesforce\/cli/i.test(line)) ||
        lines.find((line) => /\dsf\b/i.test(line)) ||
        lines[0];

    const versionMatch = versionLine.match(/(\d+\.\d+(?:\.\d+)?)/);

    return versionMatch ? versionMatch[1] : versionLine;
}

function helpSupportsFlag(helpText, flagName) {
    if (!helpText) {
        return false;
    }

    const escapedFlag = flagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flagPattern = new RegExp(`(?:^|\\s)${escapedFlag}(?:\\s|,|=|$)`, 'm');

    return flagPattern.test(helpText);
}

async function runCliCommand(command) {
    try {
        const result = await execAsync(command, {
            maxBuffer: 10 * 1024 * 1024
        });

        return `${result.stdout || ''}\n${result.stderr || ''}`;
    } catch (error) {
        return `${error.stdout || ''}\n${error.stderr || ''}`;
    }
}

async function detectCliCompatibility() {
    logSection('Salesforce CLI Compatibility Detection Started');

    const versionOutput = await runCliCommand('sf --version');
    const cliVersion = extractCliVersion(versionOutput);

    console.log('CLI Version');
    console.log(cliVersion || 'Unknown');

    const helpOutput = await runCliCommand('sf project deploy start --help');
    const supportsDryRun = helpSupportsFlag(helpOutput, '--dry-run');
    const supportsCheckOnly = helpSupportsFlag(helpOutput, '--check-only');

    let deploymentValidationFlag = null;

    if (supportsDryRun) {
        deploymentValidationFlag = '--dry-run';
    } else if (supportsCheckOnly) {
        deploymentValidationFlag = '--check-only';
    }

    console.log('Supported Validation Flag');
    console.log(deploymentValidationFlag || 'None');

    const compatibility = {
        cliVersion,
        deploymentValidationFlag,
        supportsDryRun,
        supportsCheckOnly
    };

    logSection('Compatibility Cached');

    return compatibility;
}

async function getCliCompatibility() {
    if (cachedCompatibility) {
        return cachedCompatibility;
    }

    if (!detectionPromise) {
        detectionPromise = detectCliCompatibility()
            .then((compatibility) => {
                cachedCompatibility = compatibility;
                return compatibility;
            })
            .catch((error) => {
                detectionPromise = null;
                throw error;
            });
    }

    return detectionPromise;
}

module.exports = {
    getCliCompatibility
};
