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

const fs = require('fs');
const path = require('path');

exports.retrieveMetadata = async (req, res) => {

    try {

        const workspace =
            `/tmp/workspace-${Date.now()}`;

        fs.mkdirSync(
            workspace,
            { recursive: true }
        );

        const command =
            `cd ${workspace} && ` +
            `sf project generate --name backup-project`;

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
                    workspace,
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