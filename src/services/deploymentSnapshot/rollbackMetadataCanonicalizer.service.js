'use strict';

const {
    packMemberFiles,
    unpackMemberFiles
} = require('./destinationMemberArtifact.service');
const { hashBytes } = require('./snapshotIntegrity.service');

const CANONICALIZATION_VERSION = 'CANONICAL_V1';
const SUPPORTED_METADATA_TYPES = new Set(['CustomField', 'CustomObject']);
const SALESFORCE_METADATA_NS = 'http://soap.sforce.com/2006/04/metadata';
const FIELD_META_SUFFIX = '.field-meta.xml';
const OBJECT_META_SUFFIX = '.object-meta.xml';
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

const RULES = Object.freeze({
    CustomField: Object.freeze({ deprecated: 'false' }),
    CustomObject: Object.freeze({ deprecated: 'false' })
});

function toBuffer(bytes) {
    if (Buffer.isBuffer(bytes)) {
        return Buffer.from(bytes);
    }

    if (bytes instanceof Uint8Array) {
        return Buffer.from(bytes);
    }

    throw new TypeError('Rollback canonicalization requires binary artifact bytes.');
}

function normalizeRelativePath(filePath) {
    return String(filePath || '').replace(/\\/g, '/');
}

function localName(name) {
    const value = String(name || '');
    const separator = value.indexOf(':');
    return separator === -1 ? value : value.slice(separator + 1);
}

function prefixName(name) {
    const value = String(name || '');
    const separator = value.indexOf(':');

    if (separator === -1) {
        return null;
    }

    return value.slice(0, separator);
}

function parseCustomFieldIdentity(metadataName) {
    const value = String(metadataName || '');

    if (!value.includes('.')) {
        throw new Error(
            'Rollback canonicalization CustomField metadataName must be Object.Field.'
        );
    }

    const separator = value.indexOf('.');
    const objectName = value.slice(0, separator);
    const fieldName = value.slice(separator + 1);

    if (!objectName || !fieldName || value.indexOf('.', separator + 1) !== -1) {
        throw new Error(
            'Rollback canonicalization CustomField metadataName must be Object.Field.'
        );
    }

    return { objectName, fieldName };
}

function expectedLogicalSuffix(metadataType, metadataName) {
    if (metadataType === 'CustomField') {
        const { objectName, fieldName } = parseCustomFieldIdentity(metadataName);

        return `/objects/${objectName}/fields/${fieldName}${FIELD_META_SUFFIX}`;
    }

    if (metadataType === 'CustomObject') {
        const objectName = String(metadataName || '');

        if (!objectName) {
            throw new Error(
                'Rollback canonicalization CustomObject metadataName is required.'
            );
        }

        return `/objects/${objectName}/${objectName}${OBJECT_META_SUFFIX}`;
    }

    throw new Error(
        `Rollback canonicalization does not define a logical path for ${metadataType}.`
    );
}

function assertLogicalPathMatches(metadataType, metadataName, relativePath) {
    const normalized = normalizeRelativePath(relativePath);
    const suffix = expectedLogicalSuffix(metadataType, metadataName);

    if (!normalized.endsWith(suffix)) {
        throw new Error(
            `Rollback canonicalization logical file path does not match ${metadataType}:${metadataName}.`
        );
    }

    if (
        metadataType === 'CustomField' &&
        normalized.endsWith(OBJECT_META_SUFFIX)
    ) {
        throw new Error(
            'Rollback canonicalization CustomField identity cannot use CustomObject XML.'
        );
    }

    if (
        metadataType === 'CustomObject' &&
        normalized.endsWith(FIELD_META_SUFFIX)
    ) {
        throw new Error(
            'Rollback canonicalization CustomObject identity cannot use CustomField XML.'
        );
    }
}

function assertUniqueRelativePaths(files) {
    const seen = new Set();

    for (const file of files) {
        const normalized = normalizeRelativePath(file.relativePath);

        if (seen.has(normalized)) {
            throw new Error(
                'Rollback canonicalization found duplicate artifact file paths.'
            );
        }

        seen.add(normalized);
    }
}

function isLogicalTargetXml(relativePath, metadataType, metadataName) {
    if (!/\.xml$/i.test(relativePath)) {
        return false;
    }

    try {
        assertLogicalPathMatches(metadataType, metadataName, relativePath);
        return true;
    } catch (error) {
        return false;
    }
}

function selectTargetFile(files, metadataType, metadataName, filePath) {
    assertUniqueRelativePaths(files);

    if (filePath !== undefined && filePath !== null) {
        const normalizedFilePath = normalizeRelativePath(filePath);

        if (!normalizedFilePath) {
            throw new Error(
                'Rollback canonicalization requires metadata identity context.'
            );
        }

        const exactMatches = files.filter(
            (file) =>
                normalizeRelativePath(file.relativePath) === normalizedFilePath
        );

        if (exactMatches.length === 0) {
            throw new Error(
                `Rollback canonicalization found no artifact file at ${normalizedFilePath}.`
            );
        }

        if (exactMatches.length > 1) {
            throw new Error(
                'Rollback canonicalization found ambiguous duplicate target file paths.'
            );
        }

        const target = exactMatches[0];

        if (!/\.xml$/i.test(target.relativePath)) {
            throw new Error(
                'Rollback canonicalization target file must be XML metadata.'
            );
        }

        assertLogicalPathMatches(
            metadataType,
            metadataName,
            target.relativePath
        );

        return target;
    }

    const candidates = files.filter((file) =>
        isLogicalTargetXml(file.relativePath, metadataType, metadataName)
    );

    if (candidates.length === 0) {
        throw new Error(
            `Rollback canonicalization found no XML member for ${metadataType}:${metadataName}.`
        );
    }

    if (candidates.length > 1) {
        throw new Error(
            `Rollback canonicalization found multiple XML members for ${metadataType}:${metadataName}.`
        );
    }

    return candidates[0];
}

function assertSupportedVersion(canonicalizationVersion) {
    if (
        typeof canonicalizationVersion !== 'string' ||
        canonicalizationVersion.trim() !== CANONICALIZATION_VERSION
    ) {
        throw new Error(
            `Unsupported rollback canonicalization version: ${
                canonicalizationVersion == null ||
                (typeof canonicalizationVersion === 'string' &&
                    !canonicalizationVersion.trim())
                    ? 'missing'
                    : canonicalizationVersion
            }.`
        );
    }
}

function decodeSafeXmlBytes(bytes) {
    const buffer = toBuffer(bytes);

    if (
        buffer.length >= 2 &&
        ((buffer[0] === 0xff && buffer[1] === 0xfe) ||
            (buffer[0] === 0xfe && buffer[1] === 0xff))
    ) {
        throw new Error(
            'Rollback canonicalization does not support UTF-16 encoded XML.'
        );
    }

    let payload = buffer;
    let hasBom = false;

    if (buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM)) {
        hasBom = true;
        payload = buffer.subarray(3);
    }

    try {
        new TextDecoder('utf-8', { fatal: true }).decode(payload);
    } catch (error) {
        throw new Error(
            'Rollback canonicalization requires UTF-8 encoded Salesforce metadata XML.'
        );
    }

    return {
        text: payload.toString('utf8'),
        hasBom,
        originalBytes: buffer
    };
}

function encodeXmlBytes(text, { hasBom, preserveOriginalBytes, originalBytes }) {
    if (preserveOriginalBytes) {
        return Buffer.from(originalBytes);
    }

    const body = Buffer.from(text, 'utf8');

    if (hasBom) {
        return Buffer.concat([UTF8_BOM, body]);
    }

    return body;
}

function parseTagName(source, start) {
    let index = start;

    while (index < source.length && /[A-Za-z0-9_.:-]/.test(source[index])) {
        index += 1;
    }

    if (index === start) {
        throw new Error('Rollback canonicalization found an XML tag without a name.');
    }

    return { name: source.slice(start, index), end: index };
}

function findTagEnd(source, start) {
    let quote = null;

    for (let index = start; index < source.length; index += 1) {
        const character = source[index];

        if (quote) {
            if (character === quote) {
                quote = null;
            }
            continue;
        }

        if (character === '"' || character === "'") {
            quote = character;
        } else if (character === '>') {
            return index;
        }
    }

    throw new Error('Rollback canonicalization found an unterminated XML tag.');
}

function parseAttributes(source, start, end) {
    const attributes = new Map();
    let index = start;

    while (index < end) {
        while (index < end && /\s/.test(source[index])) {
            index += 1;
        }

        if (index >= end || source[index] === '/') {
            break;
        }

        const name = parseTagName(source, index);
        index = name.end;

        while (index < end && /\s/.test(source[index])) {
            index += 1;
        }

        if (source[index] !== '=') {
            throw new Error(
                'Rollback canonicalization found a malformed XML attribute.'
            );
        }

        index += 1;

        while (index < end && /\s/.test(source[index])) {
            index += 1;
        }

        const quote = source[index];

        if (quote !== '"' && quote !== "'") {
            throw new Error(
                'Rollback canonicalization found a malformed XML attribute value.'
            );
        }

        index += 1;
        const valueStart = index;

        while (index < end && source[index] !== quote) {
            index += 1;
        }

        if (index >= end) {
            throw new Error(
                'Rollback canonicalization found an unterminated XML attribute value.'
            );
        }

        const value = source.slice(valueStart, index);
        index += 1;

        if (attributes.has(name.name)) {
            throw new Error(
                'Rollback canonicalization found duplicate XML attributes.'
            );
        }

        attributes.set(name.name, value);
    }

    return attributes;
}

function validateXmlDeclaration(source, start, end) {
    const body = source.slice(start + 2, end).trim();

    if (!/^xml(\s+[A-Za-z_:][A-Za-z0-9_.:-]*=(["']).*?\2)*\s*$/.test(body)) {
        throw new Error(
            'Rollback canonicalization found an invalid XML declaration.'
        );
    }
}

function createNamespaceContext() {
    const scopes = [{}];

    return {
        push(attributes) {
            const next = { ...scopes[0] };

            for (const [name, value] of attributes.entries()) {
                if (name === 'xmlns') {
                    next[''] = value;
                } else if (name.startsWith('xmlns:')) {
                    next[name.slice('xmlns:'.length)] = value;
                }
            }

            scopes.unshift(next);
        },
        pop() {
            scopes.shift();
        },
        assertDeclared(name) {
            const prefix = prefixName(name);

            if (!prefix || prefix === 'xml') {
                return;
            }

            if (!Object.prototype.hasOwnProperty.call(scopes[0], prefix)) {
                throw new Error(
                    'Rollback canonicalization found an undeclared XML namespace prefix.'
                );
            }
        }
    };
}

function validateRootNamespace(attributes) {
    const xmlns = attributes.get('xmlns');

    if (xmlns && xmlns !== SALESFORCE_METADATA_NS) {
        throw new Error(
            'Rollback canonicalization found an unsupported Salesforce metadata namespace.'
        );
    }
}

function parseXml(source) {
    const stack = [];
    const roots = [];
    const namespaces = createNamespaceContext();
    let index = 0;
    let sawXmlDeclaration = false;

    function appendText(text) {
        if (stack.length) {
            stack[stack.length - 1].text += text;
            return;
        }

        if (text.trim()) {
            throw new Error(
                'Rollback canonicalization found text outside the XML document.'
            );
        }
    }

    while (index < source.length) {
        const open = source.indexOf('<', index);

        if (open === -1) {
            appendText(source.slice(index));
            break;
        }

        if (open > index) {
            appendText(source.slice(index, open));
        }

        if (source.startsWith('<!--', open)) {
            const end = source.indexOf('-->', open + 4);

            if (end === -1) {
                throw new Error(
                    'Rollback canonicalization found an unterminated XML comment.'
                );
            }

            index = end + 3;
            continue;
        }

        if (source.startsWith('<![CDATA[', open)) {
            const end = source.indexOf(']]>', open + 9);

            if (end === -1) {
                throw new Error(
                    'Rollback canonicalization found an unterminated CDATA section.'
                );
            }

            appendText(source.slice(open + 9, end));
            index = end + 3;
            continue;
        }

        if (source.startsWith('<?', open)) {
            const end = source.indexOf('?>', open + 2);

            if (end === -1) {
                throw new Error(
                    'Rollback canonicalization found an unterminated XML processing instruction.'
                );
            }

            validateXmlDeclaration(source, open, end);
            sawXmlDeclaration = true;
            index = end + 2;
            continue;
        }

        if (source.startsWith('<!DOCTYPE', open)) {
            const end = findTagEnd(source, open + 2);

            if (source.slice(open, end).includes('[')) {
                throw new Error(
                    'Rollback canonicalization does not support XML internal subsets.'
                );
            }

            index = end + 1;
            continue;
        }

        if (source[open + 1] === '!') {
            throw new Error(
                'Rollback canonicalization found an unsupported XML declaration.'
            );
        }

        if (source[open + 1] === '/') {
            const name = parseTagName(source, open + 2);
            const end = findTagEnd(source, name.end);
            const trailing = source.slice(name.end, end).trim();

            if (trailing) {
                throw new Error(
                    'Rollback canonicalization found invalid XML closing-tag content.'
                );
            }

            namespaces.assertDeclared(name.name);

            const node = stack.pop();

            if (!node || node.name !== name.name) {
                throw new Error(
                    'Rollback canonicalization found mismatched XML closing tags.'
                );
            }

            node.end = end + 1;
            namespaces.pop();

            if (stack.length === 0) {
                roots.push(node);
            }

            index = end + 1;
            continue;
        }

        const name = parseTagName(source, open + 1);
        namespaces.assertDeclared(name.name);
        const end = findTagEnd(source, name.end);
        const attributes = parseAttributes(source, name.end, end);
        const body = source.slice(name.end, end);
        const selfClosing = /\/\s*$/.test(body);
        const node = {
            name: name.name,
            attributes,
            start: open,
            end: selfClosing ? end + 1 : null,
            text: '',
            parent: stack.length ? stack[stack.length - 1] : null,
            children: []
        };

        namespaces.push(attributes);

        if (node.parent) {
            node.parent.children.push(node);
        }

        if (stack.length === 0) {
            validateRootNamespace(attributes);
        }

        if (selfClosing) {
            namespaces.pop();

            if (!node.parent) {
                roots.push(node);
            }
        } else {
            stack.push(node);
        }

        index = end + 1;
    }

    if (stack.length || roots.length !== 1) {
        throw new Error(
            'Rollback canonicalization found an incomplete or multi-root XML document.'
        );
    }

    if (!sawXmlDeclaration && source.trimStart().startsWith('<?xml')) {
        throw new Error(
            'Rollback canonicalization found an invalid XML declaration.'
        );
    }

    return roots[0];
}

function removeNodePreservingFormatting(source, node) {
    let start = node.start;
    let end = node.end;
    const beforeLine = source.lastIndexOf('\n', start - 1) + 1;
    const afterLine = source.indexOf('\n', end);
    const lineEnd = afterLine === -1 ? source.length : afterLine;
    const before = source.slice(beforeLine, start);
    const after = source.slice(end, lineEnd);

    if (/^[ \t]*$/.test(before) && /^[ \t]*$/.test(after)) {
        start = beforeLine;
        end = afterLine === -1 ? lineEnd : afterLine + 1;
    } else if (/^[ \t]*$/.test(before) && after === '') {
        start = beforeLine;
    } else if (before === '' && /^[ \t]*$/.test(after)) {
        end = afterLine === -1 ? lineEnd : afterLine + 1;
    } else if (/^[ \t]*$/.test(before) && after.startsWith('\r\n')) {
        throw new Error(
            'Rollback canonicalization found ambiguous deprecated formatting.'
        );
    }

    return source.slice(0, start) + source.slice(end);
}

function listDirectDeprecatedElements(root) {
    return root.children.filter(
        (child) => localName(child.name) === 'deprecated'
    );
}

function canonicalizeXml({ metadataType, xml }) {
    const root = parseXml(xml);

    if (localName(root.name) !== metadataType) {
        throw new Error(
            `Rollback canonicalization XML root does not match ${metadataType}.`
        );
    }

    const deprecatedElements = listDirectDeprecatedElements(root);

    if (deprecatedElements.length > 1) {
        throw new Error(
            'Rollback canonicalization found duplicate deprecated elements.'
        );
    }

    if (!deprecatedElements.length) {
        return { xml, appliedRules: [], changed: false };
    }

    const deprecated = deprecatedElements[0];

    if (deprecated.children.length) {
        throw new Error(
            'Rollback canonicalization found malformed deprecated element structure.'
        );
    }

    const value = deprecated.text;

    if (value === 'false') {
        return {
            xml: removeNodePreservingFormatting(xml, deprecated),
            appliedRules: [`${metadataType}.deprecated.false-omitted`],
            changed: true
        };
    }

    if (value === 'true') {
        return { xml, appliedRules: [], changed: false };
    }

    if (value.trim() === 'false' || value.trim() === 'true') {
        throw new Error(
            'Rollback canonicalization found non-exact deprecated boolean value.'
        );
    }

    throw new Error(
        'Rollback canonicalization found unsupported deprecated value.'
    );
}

function canonicalizeForRollback({
    metadataType,
    metadataName,
    filePath,
    artifactBytes,
    canonicalizationVersion
} = {}) {
    if (typeof metadataType !== 'string' || !metadataType.trim()) {
        throw new TypeError(
            'Rollback canonicalization requires a metadata type.'
        );
    }

    if (!SUPPORTED_METADATA_TYPES.has(metadataType)) {
        return {
            canonicalArtifactBytes: toBuffer(artifactBytes),
            canonicalHash: hashBytes(toBuffer(artifactBytes)),
            canonicalizationVersion: null,
            appliedRules: []
        };
    }

    assertSupportedVersion(canonicalizationVersion);

    if (!metadataName) {
        throw new Error(
            'Rollback canonicalization requires metadata identity context.'
        );
    }

    const original = toBuffer(artifactBytes);
    const files = unpackMemberFiles(original);
    const targetFile = selectTargetFile(
        files,
        metadataType,
        metadataName,
        filePath
    );
    const canonicalFiles = [];
    const appliedRules = [];

    for (const file of files) {
        const bytes = Buffer.from(file.bytes);

        if (file.relativePath !== targetFile.relativePath) {
            canonicalFiles.push({
                relativePath: file.relativePath,
                bytes
            });
            continue;
        }

        const decoded = decodeSafeXmlBytes(bytes);
        const result = canonicalizeXml({
            metadataType,
            xml: decoded.text
        });
        appliedRules.push(...result.appliedRules);

        const outputBytes = encodeXmlBytes(result.xml, {
            hasBom: decoded.hasBom,
            preserveOriginalBytes: !result.changed,
            originalBytes: decoded.originalBytes
        });

        canonicalFiles.push({
            relativePath: file.relativePath,
            bytes: outputBytes
        });
    }

    const canonicalArtifactBytes = packMemberFiles(canonicalFiles);

    return {
        canonicalArtifactBytes,
        canonicalHash: hashBytes(canonicalArtifactBytes),
        canonicalizationVersion,
        appliedRules
    };
}

module.exports = {
    CANONICALIZATION_VERSION,
    RULES,
    canonicalizeForRollback
};
