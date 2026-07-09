const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

const DETECTION_SOURCE = 'sf project deploy start --help';
const DRY_RUN_PATTERN = /--dry-run\b/i;
const CHECK_ONLY_PATTERN = /--check-only\b/i;

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

    const semanticVersionMatch = String(versionOutput).match(
        /(\d+\.\d+(?:\.\d+)?)/
    );

    if (semanticVersionMatch) {
        return semanticVersionMatch[1];
    }

    const lines = String(versionOutput)
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    return lines[0] || null;
}

function parseHelpCapabilities(helpText) {
    const normalizedHelp = String(helpText || '');

    return {
        supportsDryRun: DRY_RUN_PATTERN.test(normalizedHelp),
        supportsCheckOnly: CHECK_ONLY_PATTERN.test(normalizedHelp),
        hasHelpContent: normalizedHelp.trim().length > 0
    };
}

function resolveDeploymentValidationFlag({
    supportsDryRun,
    supportsCheckOnly
}) {
    if (supportsDryRun) {
        return '--dry-run';
    }

    if (supportsCheckOnly) {
        return '--check-only';
    }

    return null;
}

async function runCliCommand(command) {
    try {
        const result = await execAsync(command, {
            maxBuffer: 10 * 1024 * 1024
        });

        return {
            output: `${result.stdout || ''}\n${result.stderr || ''}`.trim(),
            commandFailed: false
        };
    } catch (error) {
        return {
            output: `${error.stdout || ''}\n${error.stderr || ''}`.trim(),
            commandFailed: true,
            errorMessage: error.message || null
        };
    }
}

async function readDeployHelp() {
    logSection('Reading CLI Help');

    return runCliCommand('sf project deploy start --help');
}

function buildCompatibilityResult({
    cliVersion,
    rawVersionOutput,
    helpOutput,
    supportsDryRun,
    supportsCheckOnly,
    failureReason = null
}) {
    const deploymentValidationFlag = resolveDeploymentValidationFlag({
        supportsDryRun,
        supportsCheckOnly
    });

    return {
        cliVersion,
        rawVersionOutput,
        deploymentValidationFlag,
        supportsDryRun,
        supportsCheckOnly,
        detectionSource: DETECTION_SOURCE,
        detectedAt: new Date().toISOString(),
        failureReason,
        helpDetected: Boolean(helpOutput?.trim())
    };
}

function buildCliCompatibilityDiagnostics(compatibility, { cached = false } = {}) {
    if (!compatibility) {
        return null;
    }

    return {
        cliVersion: compatibility.cliVersion || null,
        deploymentValidationFlag: compatibility.deploymentValidationFlag || null,
        supportsDryRun: compatibility.supportsDryRun === true,
        supportsCheckOnly: compatibility.supportsCheckOnly === true,
        detectionSource: compatibility.detectionSource || DETECTION_SOURCE,
        cached,
        detectedAt: compatibility.detectedAt || null
    };
}

async function detectCliCompatibility() {
    logSection('CLI Compatibility Detection Started');

    logSection('Reading CLI Version');
    const versionResult = await runCliCommand('sf --version');
    const rawVersionOutput = versionResult.output || '';
    const cliVersion = extractCliVersion(rawVersionOutput);

    console.log('CLI Version');
    console.log(cliVersion || 'Unknown');

    let helpResult = await readDeployHelp();
    let helpCapabilities = parseHelpCapabilities(helpResult.output);

    if (
        !helpCapabilities.supportsDryRun &&
        !helpCapabilities.supportsCheckOnly
    ) {
        logSection('Retrying Help Detection');
        helpResult = await readDeployHelp();
        helpCapabilities = parseHelpCapabilities(helpResult.output);
    }

    const compatibility = buildCompatibilityResult({
        cliVersion,
        rawVersionOutput,
        helpOutput: helpResult.output,
        supportsDryRun: helpCapabilities.supportsDryRun,
        supportsCheckOnly: helpCapabilities.supportsCheckOnly,
        failureReason: null
    });

    if (compatibility.deploymentValidationFlag) {
        logSection('CLI Compatibility Detected');
        console.log('Supported Validation Flag');
        console.log(compatibility.deploymentValidationFlag);
        logSection('Compatibility Cached');
        return compatibility;
    }

    const helpUnavailable =
        helpResult.commandFailed ||
        !helpCapabilities.hasHelpContent ||
        !versionResult.output;

    if (helpUnavailable) {
        logSection('CLI Compatibility Detection Failed');
        console.log('Reason: unable to determine capabilities');

        return buildCompatibilityResult({
            cliVersion,
            rawVersionOutput,
            helpOutput: helpResult.output,
            supportsDryRun: false,
            supportsCheckOnly: false,
            failureReason: 'unable_to_determine'
        });
    }

    logSection('CLI Compatibility Detection Failed');
    console.log('Reason: deployment validation flags not supported');

    return buildCompatibilityResult({
        cliVersion,
        rawVersionOutput,
        helpOutput: helpResult.output,
        supportsDryRun: false,
        supportsCheckOnly: false,
        failureReason: 'unsupported'
    });
}

async function getCliCompatibility() {
    if (cachedCompatibility) {
        logSection('Using Cached CLI Compatibility');

        return {
            compatibility: cachedCompatibility,
            cached: true
        };
    }

    if (!detectionPromise) {
        detectionPromise = detectCliCompatibility()
            .then((compatibility) => {
                if (compatibility.deploymentValidationFlag) {
                    cachedCompatibility = compatibility;
                } else {
                    detectionPromise = null;
                }

                return compatibility;
            })
            .catch((error) => {
                detectionPromise = null;
                throw error;
            });
    }

    const compatibility = await detectionPromise;

    return {
        compatibility,
        cached: false
    };
}

module.exports = {
    getCliCompatibility,
    buildCliCompatibilityDiagnostics
};
