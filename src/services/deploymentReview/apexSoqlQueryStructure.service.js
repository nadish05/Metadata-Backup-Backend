/**
 * Lightweight SOQL structure helpers for Apex dependency discovery.
 * Distinguishes outer SELECT/FROM from parenthesized child subqueries.
 * Not a full SOQL parser.
 */

/**
 * Extract balanced "(SELECT … )" child subquery bodies from a SOQL query
 * (content inside Apex [ … ] brackets). Only top-level parenthesized SELECTs.
 *
 * @param {string} query
 * @returns {string[]} inner query text without surrounding parentheses
 */
function extractTopLevelChildSubqueryBodies(query) {
    const text = String(query || '');
    const bodies = [];
    let depth = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (ch === '(') {
            if (depth === 0) {
                const after = text.slice(i + 1);

                if (/^\s*SELECT\b/i.test(after)) {
                    let innerDepth = 1;
                    let j = i + 1;

                    for (; j < text.length; j++) {
                        if (text[j] === '(') {
                            innerDepth += 1;
                        } else if (text[j] === ')') {
                            innerDepth -= 1;

                            if (innerDepth === 0) {
                                break;
                            }
                        }
                    }

                    if (innerDepth === 0) {
                        bodies.push(text.slice(i + 1, j));
                        i = j;
                        continue;
                    }
                }
            }

            depth += 1;
            continue;
        }

        if (ch === ')') {
            depth = Math.max(0, depth - 1);
        }
    }

    return bodies;
}

/**
 * Mask top-level child subqueries with spaces so outer SELECT/FROM matching
 * ignores nested FROM clauses.
 *
 * @param {string} query
 * @returns {string}
 */
function maskTopLevelChildSubqueries(query) {
    const text = String(query || '');
    const chars = text.split('');
    let depth = 0;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];

        if (ch === '(') {
            if (depth === 0 && /^\s*SELECT\b/i.test(text.slice(i + 1))) {
                let innerDepth = 1;
                let j = i + 1;

                for (; j < text.length; j++) {
                    if (text[j] === '(') {
                        innerDepth += 1;
                    } else if (text[j] === ')') {
                        innerDepth -= 1;

                        if (innerDepth === 0) {
                            break;
                        }
                    }
                }

                if (innerDepth === 0) {
                    for (let k = i; k <= j; k++) {
                        chars[k] = ' ';
                    }
                    i = j;
                    continue;
                }
            }

            depth += 1;
            continue;
        }

        if (ch === ')') {
            depth = Math.max(0, depth - 1);
        }
    }

    return chars.join('');
}

/**
 * Parse outer SELECT clause + FROM object from a SOQL query, ignoring nested
 * child subqueries' FROM clauses.
 *
 * @param {string} query
 * @returns {{ selectClause: string, fromObjectApiName: string }|null}
 */
function parseOuterSelectFrom(query) {
    const masked = maskTopLevelChildSubqueries(query);

    if (!/\bSELECT\b/i.test(masked) || !/\bFROM\b/i.test(masked)) {
        return null;
    }

    const fromMatch = masked.match(/\bFROM\s+([A-Za-z][A-Za-z0-9_]*)\b/i);

    if (!fromMatch) {
        return null;
    }

    const selectMatch = masked.match(/\bSELECT\s+([\s\S]*?)\s+FROM\b/i);

    if (!selectMatch) {
        return null;
    }

    return {
        selectClause: selectMatch[1],
        fromObjectApiName: fromMatch[1]
    };
}

/**
 * Parse SELECT clause + FROM object for a child subquery body
 * (already without surrounding parentheses).
 *
 * @param {string} subqueryBody
 * @returns {{ selectClause: string, fromObjectApiName: string }|null}
 */
function parseChildSubquerySelectFrom(subqueryBody) {
    const text = String(subqueryBody || '');

    if (!/\bSELECT\b/i.test(text) || !/\bFROM\b/i.test(text)) {
        return null;
    }

    const fromMatch = text.match(/\bFROM\s+([A-Za-z][A-Za-z0-9_]*)\b/i);

    if (!fromMatch) {
        return null;
    }

    const selectMatch = text.match(/\bSELECT\s+([\s\S]*?)\s+FROM\b/i);

    if (!selectMatch) {
        return null;
    }

    return {
        selectClause: selectMatch[1],
        fromObjectApiName: fromMatch[1]
    };
}

/**
 * Collect SOQL units from Apex bracket queries: outer query plus each nested
 * child subquery (unresolved relationship FROM still present on children).
 *
 * @param {string} cleanedContent
 * @returns {{
 *   kind: 'outer'|'child',
 *   selectClause: string,
 *   fromObjectApiName: string,
 *   parentFromObjectApiName: string|null
 * }[]}
 */
function collectSoqlSelectUnits(cleanedContent) {
    const units = [];
    const soqlBlocks = String(cleanedContent || '').matchAll(/\[([\s\S]*?)\]/g);

    for (const block of soqlBlocks) {
        const query = block[1];

        if (!/\bSELECT\b/i.test(query) || !/\bFROM\b/i.test(query)) {
            continue;
        }

        const outer = parseOuterSelectFrom(query);

        if (outer) {
            units.push({
                kind: 'outer',
                selectClause: outer.selectClause,
                fromObjectApiName: outer.fromObjectApiName,
                parentFromObjectApiName: null
            });
        }

        const parentFrom = outer ? outer.fromObjectApiName : null;

        for (const body of extractTopLevelChildSubqueryBodies(query)) {
            const child = parseChildSubquerySelectFrom(body);

            if (!child) {
                continue;
            }

            units.push({
                kind: 'child',
                selectClause: child.selectClause,
                fromObjectApiName: child.fromObjectApiName,
                parentFromObjectApiName: parentFrom
            });
        }
    }

    return units;
}

module.exports = {
    extractTopLevelChildSubqueryBodies,
    maskTopLevelChildSubqueries,
    parseOuterSelectFrom,
    parseChildSubquerySelectFrom,
    collectSoqlSelectUnits
};
