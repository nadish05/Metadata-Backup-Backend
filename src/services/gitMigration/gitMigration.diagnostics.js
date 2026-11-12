'use strict';

const MAX_DIAGNOSTIC_TEXT_LENGTH = 2000;

function sanitizeGitOutput(text) {
    if (text === null || text === undefined) {
        return '';
    }

    let sanitized = String(text);

    sanitized = sanitized.replace(/https:\/\/[^@\s/]+@[^\s'"]+/gi, 'https://[redacted]@github.com/...');
    sanitized = sanitized.replace(/https:\/\/[^@\s/]+@/gi, 'https://[redacted]@');
    sanitized = sanitized.replace(/\bgh[pousr]_[A-Za-z0-9_]+\b/g, '[redacted-token]');
    sanitized = sanitized.replace(/\bgithub_pat_[A-Za-z0-9_]+\b/g, '[redacted-token]');
    sanitized = sanitized.replace(/GITHUB_TOKEN\s*=\s*\S+/gi, 'GITHUB_TOKEN=[redacted]');
    sanitized = sanitized.replace(
        /\bBearer\s+[A-Za-z0-9._\-]+\b/gi,
        'Bearer [redacted]'
    );

    if (sanitized.length > MAX_DIAGNOSTIC_TEXT_LENGTH) {
        return `${sanitized.slice(0, MAX_DIAGNOSTIC_TEXT_LENGTH)}...[truncated]`;
    }

    return sanitized;
}

function resolveExitCode(error) {
    if (error && typeof error.code === 'number' && Number.isFinite(error.code)) {
        return error.code;
    }

    if (error && typeof error.code === 'string' && /^\d+$/.test(error.code)) {
        return Number.parseInt(error.code, 10);
    }

    return null;
}

function buildGitExecDiagnostic(error, context = {}) {
    const stage = context.stage || 'unknown';
    const command = context.command || 'git';

    return {
        stage,
        command,
        exitCode: resolveExitCode(error),
        stderr: sanitizeGitOutput(error?.stderr || ''),
        message: sanitizeGitOutput(error?.message || '')
    };
}

function formatGitDiagnosticForLog(gitDiagnostic) {
    if (!gitDiagnostic) {
        return null;
    }

    return {
        stage: gitDiagnostic.stage,
        command: gitDiagnostic.command,
        exitCode: gitDiagnostic.exitCode,
        stderr: sanitizeGitOutput(gitDiagnostic.stderr),
        message: sanitizeGitOutput(gitDiagnostic.message)
    };
}

module.exports = {
    MAX_DIAGNOSTIC_TEXT_LENGTH,
    sanitizeGitOutput,
    buildGitExecDiagnostic,
    formatGitDiagnosticForLog,
    resolveExitCode
};
