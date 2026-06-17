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


        console.log('==========================');
console.log('REPO URL:', repoUrl);
console.log('SOURCE BRANCH:', sourceBranch);
console.log('DESTINATION BRANCH:', destinationBranch);
console.log('==========================');

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

const sourceHead = await execAsync(
    `cd ${repoPath} && git rev-parse origin/${sourceBranch}`
);

const destinationHead = await execAsync(
    `cd ${repoPath} && git rev-parse origin/${destinationBranch}`
);

console.log('SOURCE HEAD:', sourceHead.stdout);
console.log('DEST HEAD:', destinationHead.stdout);

const sourceCommit = await execAsync(
    `cd ${repoPath} && git log --oneline origin/${sourceBranch} -1`
);

const destinationCommit = await execAsync(
    `cd ${repoPath} && git log --oneline origin/${destinationBranch} -1`
);

console.log('SOURCE COMMIT:', sourceCommit.stdout);
console.log('DEST COMMIT:', destinationCommit.stdout);

const branches =
    await execAsync(
        `cd ${repoPath} && git branch -a`
    );

console.log(branches.stdout);

console.log('Comparing branches...');

console.log(
    `git diff --name-status origin/${sourceBranch} origin/${destinationBranch}`
);


    console.log('RAW DIFF OUTPUT');
    console.log(diffResult.stdout);

const files = await Promise.all(

    diffResult.stdout
        .split('\n')
        .filter(line => line.trim())
        .map(async line => {

            const parts = line.split('\t');

            const gitStatus = parts[0];
            const filePath = parts[1];

            const isFlow =
                filePath.includes('/flows/') &&
                filePath.endsWith('.flow-meta.xml');

            let flowStatus = null;

            if (isFlow) {

                try {

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

                } catch(error) {

                    console.log(
                        'Could not read flow:',
                        filePath
                    );

                }

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

            return {
                filePath,
                changeType,
                flowStatus
            };

        })
);

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