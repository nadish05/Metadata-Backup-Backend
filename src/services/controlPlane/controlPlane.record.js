'use strict';

function sfField(record, ...keys) {
    if (!record || typeof record !== 'object') {
        return null;
    }

    for (const key of keys) {
        if (record[key] !== undefined && record[key] !== null) {
            return record[key];
        }
    }

    return null;
}

function toIso(value) {
    if (value === null || value === undefined || value === '') {
        return null;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    const text = String(value);

    if (/^\d{4}-\d{2}-\d{2}T/.test(text)) {
        const parsed = new Date(text);

        if (!Number.isNaN(parsed.getTime())) {
            return parsed.toISOString();
        }
    }

    return text;
}

function toBoolean(value, fallback = false) {
    if (value === true || value === false) {
        return value;
    }

    if (value === null || value === undefined || value === '') {
        return fallback;
    }

    const text = String(value).toLowerCase();

    if (text === 'true') {
        return true;
    }

    if (text === 'false') {
        return false;
    }

    return fallback;
}

function toNumber(value, fallback = null) {
    if (value === null || value === undefined || value === '') {
        return fallback;
    }

    const parsed = Number(value);

    return Number.isFinite(parsed) ? parsed : fallback;
}

function toText(value) {
    if (value === null || value === undefined) {
        return null;
    }

    const text = String(value).trim();

    return text === '' ? null : text;
}

module.exports = {
    sfField,
    toBoolean,
    toIso,
    toNumber,
    toText
};
