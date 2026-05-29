let latestOAuthResult = null;

function setOAuthResult(data) {
    latestOAuthResult = data;
}

function getOAuthResult() {
    return latestOAuthResult;
}

module.exports = {
    setOAuthResult,
    getOAuthResult
};