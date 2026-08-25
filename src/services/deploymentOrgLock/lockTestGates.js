'use strict';

function createGate() {
    let open = null;
    const promise = new Promise((resolve) => {
        open = resolve;
    });

    return {
        promise,
        open: () => open()
    };
}

module.exports = {
    createGate
};
