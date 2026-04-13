export interface SourceRef {
  sourceNodeId: string;
  templateName: string;
  sourceFile: string;
  topLevelIndex: number;
  parentSourceNodeId?: string;
  blockName?: string;
}

export function buildSourceNodeId(input: {
  templateName: string;
  blockName?: string;
  topLevelIndex: number;
  childPath?: number[];
  blockClientId?: string;
}): string {
  const templateToken = normalizeSourceToken(input.templateName, 'template');
  const blockToken = normalizeSourceToken(input.blockName, 'node');
  const pathToken = [input.topLevelIndex, ...(input.childPath ?? [])].join('.');
  const blockClientToken = input.blockClientId
    ? normalizeSourceToken(input.blockClientId, '')
    : '';

  return [templateToken, blockToken, pathToken || '0', blockClientToken || null]
    .filter(Boolean)
    .join('::');
}

export function normalizeSourceToken(
  value: string | undefined,
  fallback: string,
): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.(php|html)$/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  return normalized || fallback;
}
