'use strict';

function normalizeBodyText(text) {
    return String(text || '').replace(/\r\n/g, '\n').trim();
}

function rootCallableMembers(parsed) {
    const qn = parsed.primaryClassName;

    return parsed.methods.filter(
        (member) =>
            member.declaringClassQualifiedName === qn &&
            (member.kind === 'method' || member.kind === 'constructor')
    );
}

module.exports = {
    normalizeBodyText,
    rootCallableMembers
};