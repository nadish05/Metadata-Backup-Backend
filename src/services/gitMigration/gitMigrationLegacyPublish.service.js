'use strict';

const {
    getAuthenticatedRepoUrl,
    runGit,
    shellQuote,
    execAsync
} = require('./gitMigration.shell');

async function publishLegacyOrgSnapshot({
    projectPath,
    repoUrl,
    branchName
} = {}) {
    const authenticatedUrl = getAuthenticatedRepoUrl(repoUrl);

    await execAsync(`cd ${shellQuote(projectPath)} && git init`);
    await runGit(projectPath, 'config user.email "backup@system.com"');
    await runGit(projectPath, 'config user.name "Salesforce Backup Bot"');
    await runGit(projectPath, 'add .');
    await runGit(projectPath, 'commit -m "Salesforce Metadata Backup"');
    await execAsync(
        `cd ${shellQuote(projectPath)} && ` +
            `git remote add origin ${shellQuote(authenticatedUrl)} && ` +
            `git checkout -B ${shellQuote(branchName)} && ` +
            `git push -u origin ${shellQuote(branchName)} --force`
    );
}

module.exports = {
    publishLegacyOrgSnapshot
};
