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

    exec(
        'sf org login access-token --help',
        (error, stdout, stderr) => {

            res.json({
                success: true,
                output: stdout || stderr
            });

        }
    );

};