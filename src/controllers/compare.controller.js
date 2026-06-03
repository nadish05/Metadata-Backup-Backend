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

        console.log('Comparing branches...');

        const diffResult =
            await execAsync(
                `cd ${repoPath} && git diff --name-only ${sourceBranch} ${destinationBranch}`
            );

        const files =
            diffResult.stdout
                .split('\n')
                .filter(file => file.trim());

        return res.json({
            success: true,
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