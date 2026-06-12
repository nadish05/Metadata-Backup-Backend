let currentStatus = 'Idle';

function setStatus(status) {
    currentStatus = status;
    console.log(status);
}

function getStatus() {
    return currentStatus;
}

module.exports = {
    setStatus,
    getStatus
};