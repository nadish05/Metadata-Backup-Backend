const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

const DETECTION_SOURCE = 'sf project deploy start --help';
const DRY_RUN_PATTERN = /--dry-run\b/i;
const CHECK_ONLY_PATTERN = /--check-only\b/i;

let cachedCompatibility = null;
let detectionPromise = null;

function isDebugEnabled() {
    return process.env.DEPLOYMENT_DEBUG === 'true';
}

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

async function runCliCommand(command, { collectDiagnostics = false } = {}) {
    const startedAt = Date.now();

    try {
        const result = await execAsync(command, {
            maxBuffer: 10 * 1024 * 1024
        });
        const stdout = result.stdout || '';
        const stderr = result.stderr || '';
        const response = {
            output: `${stdout}\n${stderr}`.trim(),
            commandFailed: false,
            stdout,
            stderr,
            exitCode: 0
        };

        if (collectDiagnostics) {
            response.diagnostics = buildHelpDiagnostics({
                command,
                exitCode: 0,
                durationMs: Date.now() - startedAt,
                stdout,
                stderr,
                output: response.output
            });
        }

        return response;
    } catch (error) {
        const stdout = error.stdout || '';
        const stderr = error.stderr || '';
        const response = {
            output: `${stdout}\n${stderr}`.trim(),
            commandFailed: true,
            errorMessage: error.message || null,
            stdout,
            stderr,
            exitCode:
                typeof error.code === 'number' && Number.isFinite(error.code)
                    ? error.code
                    : 1
        };

        if (collectDiagnostics) {
            response.diagnostics = buildHelpDiagnostics({
                command,
                exitCode: response.exitCode,
                durationMs: Date.now() - startedAt,
                stdout,
                stderr,
                output: response.output
            });
        }

        return response;
    }
}

function truncatePreview(value, maxLength = 1000) {
    const text = String(value || '');

    if (text.length <= maxLength) {
        return text;
    }

    return text.slice(0, maxLength);
}

function formatDiagnosticDuration(durationMs) {
    return `${Math.round(durationMs)}ms`;
}

function buildHelpDiagnostics({
    command,
    exitCode,
    durationMs,
    stdout,
    stderr,
    output
}) {
    const detectionInput = String(output || '');

    return {
        command,
        exitCode,
        duration: formatDiagnosticDuration(durationMs),
        stdoutLength: stdout.length,
        stderrLength: stderr.length,
        dryRunDetected: DRY_RUN_PATTERN.test(detectionInput),
        checkOnlyDetected: CHECK_ONLY_PATTERN.test(detectionInput),
        stdoutPreview: truncatePreview(stdout),
        stderrPreview: truncatePreview(stderr)
    };
}

async function readDeployHelp() {
    logSection('Reading CLI Help');

    if (isDebugEnabled()) {
        logSection('CLI Diagnostics Started');
        logSection('Executing Help Command');
    }

    const result = await runCliCommand(DETECTION_SOURCE, {
        collectDiagnostics: isDebugEnabled()
    });

    if (isDebugEnabled()) {
        logSection('Parsing Help Output');
        logSection('Diagnostics Complete');
    }

    return result;
}

function buildCompatibilityResult({
    cliVersion,
    rawVersionOutput,
    helpOutput,
    supportsDryRun,
    supportsCheckOnly,
    failureReason = null,
    helpDiagnostics = null
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
        helpDetected: Boolean(helpOutput?.trim()),
        helpDiagnostics
    };
}

function buildCliCompatibilityDiagnostics(compatibility, { cached = false } = {}) {
    if (!compatibility) {
        return null;
    }

    const diagnostics = {
        cliVersion: compatibility.cliVersion || null,
        deploymentValidationFlag: compatibility.deploymentValidationFlag || null,
        supportsDryRun: compatibility.supportsDryRun === true,
        supportsCheckOnly: compatibility.supportsCheckOnly === true,
        detectionSource: compatibility.detectionSource || DETECTION_SOURCE,
        cached,
        detectedAt: compatibility.detectedAt || null
    };

    if (isDebugEnabled() && compatibility.helpDiagnostics) {
        diagnostics.debug = compatibility.helpDiagnostics;
    }

    return diagnostics;
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
        failureReason: null,
        helpDiagnostics: helpResult.diagnostics || null
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
            failureReason: 'unable_to_determine',
            helpDiagnostics: helpResult.diagnostics || null
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
        failureReason: 'unsupported',
        helpDiagnostics: helpResult.diagnostics || null
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
