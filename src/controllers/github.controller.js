const { exec } = require('child_process');

exports.checkGit = async (req, res) => {

    exec(
        'git --version',
        (error, stdout, stderr) => {

            if (error) {

                return res.status(500).json({
                    success: false,
                    error: stderr || error.message
                });

            }

            return res.json({
                success: true,
                output: stdout
            });

        }
    );

};

const util = require('util');

const execAsync = util.promisify(exec);

exports.cloneRepo = async (req, res) => {

    try {

        const {
            repoUrl,
            githubToken
        } = req.body;

        const repoPath =
            `/tmp/repo-${Date.now()}`;

        const authenticatedUrl =
            repoUrl.replace(
                'https://',
                `https://${githubToken}@`
            );

        const cloneCommand =
            `git clone ${authenticatedUrl} ${repoPath}`;

        const result =
            await execAsync(cloneCommand);

        return res.json({
            success: true,
            repoPath,
            output: result.stdout
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