const NODE_ID_PATTERN = /^ns\s*=\s*\d+\s*;\s*(s|i|g|b)\s*=\s*.+$/i;

export function isNodeIdPattern(value: string): boolean {
    return NODE_ID_PATTERN.test(value.trim());
}

export function normalizeNodeIdInput(value: string): string {
    const trimmed = value.trim();
    const match = trimmed.match(/^ns\s*=\s*(\d+)\s*;\s*([sigbSIGB])\s*=\s*(.+)$/);

    if (match) {
        const namespace = match[1];
        const identifierType = match[2].toLowerCase();
        const identifierValue = match[3].trim();
        return `ns=${namespace};${identifierType}=${identifierValue}`;
    }

    return trimmed
        .replace(/\s*=\s*/g, '=')
        .replace(/\s*;\s*/g, ';');
}
