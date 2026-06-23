const util = require('util');
const { exec } = require('child_process');

const execAsync = util.promisify(exec);

exports.analyzeDependencies = async (req, res) => {

    try {

        const {
            repoUrl,
            branch,
            filePath
        } = req.body;

        const githubToken =
            process.env.GITHUB_TOKEN;

        const repoPath =
            `/tmp/dependency-${Date.now()}`;

        const authenticatedUrl =
            repoUrl.replace(
                'https://',
                `https://${githubToken}@`
            );

        await execAsync(
            `git clone ${authenticatedUrl} ${repoPath}`
        );

        await execAsync(
            `cd ${repoPath} && git fetch --all`
        );

        const fileContent =
            await execAsync(
                `cd ${repoPath} && git show origin/${branch}:"${filePath}"`
            );

        const content =
            fileContent.stdout;

        const matches =
            content.match(
                /\b([A-Z][A-Za-z0-9_]+)\./g
            ) || [];

        const dependencies =
            [...new Set(

                matches.map(
                    item =>
                        item.replace('.', '')
                )

            )];

        return res.json({

            success: true,

            dependencies,

            dependencyCount:
                dependencies.length

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