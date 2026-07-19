function extractFlexiPageNamesFromActionOverrides(content) {
    if (!content) {
        return [];
    }

    const names = [];
    const actionOverrideBlocks = content.matchAll(
        /<actionOverrides\b[^>]*>([\s\S]*?)<\/actionOverrides>/gi
    );

    for (const match of actionOverrideBlocks) {
        const block = match[1] || '';
        const typeMatch = block.match(/<type>\s*([^<]+?)\s*<\/type>/i);
        const overrideType = String(typeMatch?.[1] || '')
            .trim()
            .toLowerCase();

        if (overrideType !== 'flexipage') {
            continue;
        }

        const contentMatch = block.match(
            /<content>\s*([^<]+?)\s*<\/content>/i
        );
        const name = String(contentMatch?.[1] || '').trim();

        if (name) {
            names.push(name);
        }
    }

    return [...new Set(names)];
}

function analyzeCustomObjectFlexiPages(objectMetaXmlContent) {
    const flexiPageNames =
        extractFlexiPageNamesFromActionOverrides(objectMetaXmlContent);

    const requiredDependencies = flexiPageNames.map((name) => ({
        name,
        type: 'FlexiPage',
        required: true,
        selected: true,
        editable: false
    }));

    return {
        dependencyAnalysis: {
            requiredDependencies,
            recommendedTestClasses: [],
            optionalDependencies: []
        }
    };
}

module.exports = {
    analyzeCustomObjectFlexiPages,
    extractFlexiPageNamesFromActionOverrides
};
