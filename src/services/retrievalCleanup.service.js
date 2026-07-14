const util = require('util');
const fs = require('fs');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);
const rm = util.promisify(fs.rm);
const access = util.promisify(fs.access);

async function pathExists(targetPath) {
    try {
        await access(targetPath, fs.constants.F_OK);
        return true;
    } catch (error) {
        return false;
    }
}

async function deleteRetrievalWorkspace(workspacePath) {
    if (workspacePath == null) {
        return;
    }

    try {
        if (await pathExists(workspacePath)) {
            await rm(workspacePath, { recursive: true, force: true });
            console.log('Retrieval workspace deleted');
        }
    } catch (error) {
        console.warn(
            'Retrieval workspace cleanup failed:',
            error.message || error
        );
    }
}

async function logoutRetrievalAlias(alias) {
    if (alias == null) {
        return;
    }

    try {
        await execAsync(
            `sf org logout --target-org "${alias}" --noprompt`
        );
        console.log('Retrieval CLI logout completed');
    } catch (error) {
        console.warn(
            'Retrieval CLI logout failed:',
            error.stderr || error.stdout || error.message || error
        );
    }
}

async function cleanupRetrievalResources({
    workspacePath,
    alias
} = {}) {
    try {
        if (workspacePath == null && alias == null) {
            return;
        }

        console.log('Retrieval cleanup started');

        await logoutRetrievalAlias(alias);
        await deleteRetrievalWorkspace(workspacePath);

        console.log('Retrieval cleanup completed');
    } catch (error) {
        console.warn(
            'Retrieval cleanup failed:',
            error.message || error
        );
    }
}

module.exports = {
    deleteRetrievalWorkspace,
    logoutRetrievalAlias,
    cleanupRetrievalResources
};
