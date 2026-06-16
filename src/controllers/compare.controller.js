const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

exports.getDifferentFiles = async (req, res) => {

    try {

        const {
            repoUrl,
            sourceBranch,
            destinationBranch
        } = req.body;

        const githubToken =
            process.env.GITHUB_TOKEN;

        const repoPath =
            `/tmp/compare-${Date.now()}`;

        const authenticatedUrl =
            repoUrl.replace(
                'https://',
                `https://${githubToken}@`
            );

        console.log('Cloning repository...');

        await execAsync(
            `git clone ${authenticatedUrl} ${repoPath}`
        );

        

        console.log('Fetching branches...');

await execAsync(
    `cd ${repoPath} && git fetch --all`
);

const branches =
    await execAsync(
        `cd ${repoPath} && git branch -a`
    );

console.log(branches.stdout);

console.log('Comparing branches...');

const diffResult =
    await execAsync(
        `cd ${repoPath} && git diff --name-status origin/${sourceBranch} origin/${destinationBranch}`
    );

    console.log('RAW DIFF OUTPUT');
    console.log(diffResult.stdout);

const files =
    diffResult.stdout
        .split('\n')
        .filter(line => line.trim())
        .map(line => {

            const parts = line.split('\t');

            const gitStatus = parts[0];

            const filePath = parts[1];

            const isFlow =
    filePath.includes('/flows/') &&
    filePath.endsWith('.flow-meta.xml');


    let flowStatus = null;

    if (isFlow) {

    const fileContentResult =
        await execAsync(
            `cd ${repoPath} && git show origin/${sourceBranch}:"${filePath}"`
        );

    const content =
        fileContentResult.stdout;

    const statusMatch =
        content.match(
            /<status>(.*?)<\/status>/
        );

    if (statusMatch) {
        flowStatus = statusMatch[1];
    }

    console.log(
        'FLOW:',
        filePath,
        'STATUS:',
        flowStatus
    );
}

            let changeType = 'MODIFIED';

if (gitStatus.startsWith('A')) {

    changeType = 'NEW';

}
else if (gitStatus.startsWith('D')) {

    changeType = 'DELETED';

}
else if (gitStatus.startsWith('M')) {

    changeType = 'MODIFIED';

}
else if (gitStatus.startsWith('R')) {

    changeType = 'DELETED';

}

            console.log(
    'GIT STATUS:',
    gitStatus,
    'FILE:',
    filePath,
    'FINAL TYPE:',
    changeType
);

            return {
                filePath,
                changeType,
                flowStatus
            };

        });

console.log(
    JSON.stringify(files, null, 2)
);

return res.json({
    success: true,
    sourceBranch,
    destinationBranch,
    totalFiles: files.length,
    files
});

    } catch (error) {

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



exports.getDifferenceReport = async (req, res) => {

    try {

        const {
            repoUrl,
            sourceBranch,
            destinationBranch,
            filePath
        } = req.body;

        const repoPath =
            `/tmp/compare-report-${Date.now()}`;

        const cleanRepoUrl =
            repoUrl.replace(
                'https://github.com/',
                ''
            );

        const gitUrl =
            `https://${process.env.GITHUB_TOKEN}@github.com/${cleanRepoUrl}.git`;

        await execAsync(
            `git clone ${gitUrl} ${repoPath}`
        );

        await execAsync(
            `cd ${repoPath} && git fetch --all`
        );

        const diffResult =
            await execAsync(
                `cd ${repoPath} && git diff origin/${sourceBranch} origin/${destinationBranch} -- "${filePath}"`
            );

        const diffText =
    diffResult.stdout;

let changeType =
    'MODIFIED';

if (
    diffText.includes(
        'new file mode'
    )
) {

    changeType =
        'NEW';

}
else if (
    diffText.includes(
        'deleted file mode'
    )
) {

    changeType =
        'DELETED';

}

const addedLines =
    diffText
        .split('\n')
        .filter(line =>
            line.startsWith('+')
            &&
            !line.startsWith('+++')
        )
        .length;

const removedLines =
    diffText
        .split('\n')
        .filter(line =>
            line.startsWith('-')
            &&
            !line.startsWith('---')
        )
        .length;

return res.json({

    success: true,

    filePath,

    changeType,

    addedLines,

    removedLines,

    diff: diffText

});

    } catch (error) {

        return res.status(500).json({
            success: false,
            error:
                error.stderr ||
                error.stdout ||
                error.message
        });

    }





};


exports.getFileContent = async (req, res) => {

    try {

        const {
            repoUrl,
            branch,
            filePath
        } = req.body;

        const repoPath =
            `/tmp/file-content-${Date.now()}`;

        const cleanRepoUrl =
            repoUrl.replace(
                'https://github.com/',
                ''
            );

        const gitUrl =
            `https://${process.env.GITHUB_TOKEN}@github.com/${cleanRepoUrl}.git`;

        await execAsync(
            `git clone ${gitUrl} ${repoPath}`
        );

        await execAsync(
            `cd ${repoPath} && git checkout origin/${branch}`
        );

        const file =
            await execAsync(
                `cat ${repoPath}/${filePath}`
            );

        const content = file.stdout;

        let flowStatus = null;

        if (
            filePath.endsWith('.flow-meta.xml')
        ) {

            const statusMatch =
                content.match(
                    /<status>(.*?)<\/status>/
                );

            if (statusMatch) {
                flowStatus = statusMatch[1];
            }

        }

        return res.json({
            success: true,
            flowStatus,
            content
        });

    } catch (error) {

        return res.status(500).json({
            success: false,
            error:
                error.stderr ||
                error.stdout ||
                error.message
        });

    }

};