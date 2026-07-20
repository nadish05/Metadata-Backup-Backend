/**
 * FlexiPage compatibility rules.
 * Removes destination-unsupported tabset label properties from workspace copies only.
 */

const FLEXIPAGE_FILE_SUFFIX = '.flexipage-meta.xml';
const TABSET_COMPONENT_NAME = 'flexipage:tabset';

const COMPONENT_INSTANCE_PATTERN =
    /<componentInstance\b[^>]*>[\s\S]*?<\/componentInstance>/gi;

const TABSET_COMPONENT_NAME_PATTERN =
    /<componentName>\s*flexipage:tabset\s*<\/componentName>/i;

const TABSET_LABEL_PROPERTY_PATTERN =
    /<componentInstanceProperties>\s*<name>\s*label\s*<\/name>\s*<value>[\s\S]*?<\/value>\s*<\/componentInstanceProperties>\s*/gi;

function isFlexiPageFile(filePath) {
    const normalized = String(filePath || '')
        .replace(/\\/g, '/')
        .toLowerCase();

    return normalized.endsWith(FLEXIPAGE_FILE_SUFFIX);
}

function removeTabsetLabelProperties(componentInstanceXml) {
    if (!TABSET_COMPONENT_NAME_PATTERN.test(componentInstanceXml)) {
        return {
            xml: componentInstanceXml,
            removedCount: 0
        };
    }

    // RegExp with /g retains lastIndex; reset before counting/replacing.
    TABSET_COMPONENT_NAME_PATTERN.lastIndex = 0;

    let removedCount = 0;
    const xml = componentInstanceXml.replace(
        TABSET_LABEL_PROPERTY_PATTERN,
        () => {
            removedCount += 1;
            return '';
        }
    );

    TABSET_LABEL_PROPERTY_PATTERN.lastIndex = 0;

    return {
        xml,
        removedCount
    };
}

function transformFlexiPageContent(content) {
    let removedCount = 0;

    const nextContent = String(content).replace(
        COMPONENT_INSTANCE_PATTERN,
        (componentInstanceXml) => {
            const result = removeTabsetLabelProperties(componentInstanceXml);
            removedCount += result.removedCount;
            return result.xml;
        }
    );

    COMPONENT_INSTANCE_PATTERN.lastIndex = 0;

    return {
        content: nextContent,
        changed: removedCount > 0,
        removedCount
    };
}

const removeTabsetLabelRule = {
    id: 'flexipage.remove-tabset-label',
    description:
        `Remove unsupported componentInstanceProperties name=label from ${TABSET_COMPONENT_NAME}`,
    metadataTypes: ['FlexiPage'],

    applies(filePath) {
        return isFlexiPageFile(filePath);
    },

    transform(content) {
        const result = transformFlexiPageContent(content);

        if (!result.changed) {
            return {
                content,
                changed: false,
                summary: null
            };
        }

        return {
            content: result.content,
            changed: true,
            summary: `Removed ${result.removedCount} unsupported tabset label propert${
                result.removedCount === 1 ? 'y' : 'ies'
            }`
        };
    }
};

module.exports = [removeTabsetLabelRule];
