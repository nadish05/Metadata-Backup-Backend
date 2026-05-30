const { exec } = require('child_process');
const fs = require('fs');

exports.checkSfCli = async (req, res) => {

    exec('sf --version', (error, stdout, stderr) => {

        if (error) {
            return res.status(500).json({
                success: false,
                error: stderr || error.message
            });
        }

        res.json({
            success: true,
            version: stdout
        });

    });

};

exports.testSfAuth = async (req, res) => {

    try {

        const { accessToken, instanceUrl } = req.body;

        const command =
            `export SF_ACCESS_TOKEN="${accessToken}" && ` +
            `sf org login access-token ` +
            `--instance-url ${instanceUrl} ` +
            `--alias backuporg ` +
            `--no-prompt`;

        exec(
            command,
            (error, stdout, stderr) => {

                if (error) {

                    return res.status(500).json({
                        success: false,
                        error: stderr || error.message
                    });

                }

                res.json({
                    success: true,
                    output: stdout
                });

            }
        );

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });

    }

};

exports.retrieveMetadata = async (req, res) => {

    try {

        const command =
        `cd /app/backup-project &&
        sf project retrieve start
        --metadata ApexClass
        --target-org backuporg`;

        exec(
            command,
            (error, stdout, stderr) => {

                if (error) {

                    return res.status(500).json({
                        success: false,
                        error: stderr || error.message
                    });

                }

                res.json({
                    success: true,
                    output: stdout,
                    warning: stderr
                });

            }
        );

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });

    }

};