export function sanitizeTailwindClasses(raw: string): string {
  let out = raw;
  out = out.replace(/\[(min|max|clamp)\(([^[\]]*)\)\]/g, (_m, fn, inner) => {
    const compact = String(inner).replace(/,\s+/g, ',');
    return `[${fn}(${compact})]`;
  });
  out = out.replace(
    /\b(gap|mt|mb|ml|mr|pt|pb|pl|pr|mx|my|px|py|m|p|w|h|text|leading|tracking|rounded(?:-[a-z]+)?|font|min-[wh]|max-[wh])-(\d[\d.]*)(px|rem|em|vh|vw|%)\b/g,
    (_m, prefix, num, unit) => `${prefix}-[${num}${unit}]`,
  );
  return out;
}

export function stripDebugStatements(raw: string): string {
  return raw
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim();
      return !/^console\.(log|warn|error|info|debug)\s*\(/.test(trimmed);
    })
    .join('\n');
}

export function repairBrokenArbitraryValueClasses(raw: string): string {
  const repairClassList = (classList: string) =>
    classList
      .split(/(\s+)/)
      .map((token) => {
        if (!token || /^\s+$/.test(token)) return token;
        if (!token.includes('[') || token.includes(']')) return token;
        if (!/-\[[^\]]+$/.test(token)) return token;
        return `${token}]`;
      })
      .join('');

  return raw
    .replace(
      /className="([^"]*)"/g,
      (_match, classList: string) =>
        `className="${repairClassList(classList)}"`,
    )
    .replace(
      /className='([^']*)'/g,
      (_match, classList: string) =>
        `className='${repairClassList(classList)}'`,
    )
    .replace(
      /className=\{`([^`]+)`\}/g,
      (_match, classList: string) =>
        `className={\`${repairClassList(classList)}\`}`,
    );
}

export function appendUniqueClasses(
  existing: string,
  addition: string,
): string {
  return [...new Set(`${existing} ${addition}`.split(/[\s,]+/).filter(Boolean))]
    .join(' ')
    .trim();
}

export function ensureReactRouterLinkImport(code: string): string {
  if (!/<Link\b/.test(code)) return code;

  const namedImportPattern =
    /import\s*\{([^}]*)\}\s*from\s*['"]react-router-dom['"];?/;
  if (namedImportPattern.test(code)) {
    return code.replace(namedImportPattern, (_match, imported: string) => {
      const next = appendUniqueClasses(imported.replace(/\s+/g, ' '), 'Link')
        .split(' ')
        .filter(Boolean)
        .join(', ');
      return `import { ${next} } from 'react-router-dom';`;
    });
  }

  const lines = code.split('\n');
  const reactImportIndex = lines.findIndex((line) =>
    /from\s*['"]react['"]/.test(line),
  );
  const importLine = `import { Link } from 'react-router-dom';`;
  if (reactImportIndex !== -1) {
    lines.splice(reactImportIndex + 1, 0, importLine);
    return lines.join('\n');
  }

  lines.unshift(importLine);
  return lines.join('\n');
}

export function findPlaceholderLinkSnippets(code: string, max = 3): string[] {
  const snippets: string[] = [];
  const tagPattern =
    /<(?:Link|a)\b[^>]*(?:to|href)\s*=\s*(?:["']#["']|\{["']#["']\})[^>]*>[\s\S]*?<\/(?:Link|a)>/g;

  for (const match of code.matchAll(tagPattern)) {
    const raw = match[0]?.replace(/\s+/g, ' ').trim();
    if (!raw) continue;
    snippets.push(raw.length > 160 ? `${raw.slice(0, 157)}...` : raw);
    if (snippets.length >= max) return snippets;
  }

  for (const line of code.split('\n')) {
    const trimmed = line.trim();
    if (/(?:\bto=|\bhref=)\s*(?:["']#["']|\{["']#["']\})/.test(trimmed)) {
      snippets.push(
        trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed,
      );
      if (snippets.length >= max) break;
    }
  }

  return snippets;
}

export function findCanonicalTextLinkSnippetsWithoutHoverUnderline(
  code: string,
  max = 3,
): string[] {
  const snippets: string[] = [];
  const tagPattern = /<(?:Link|a)\b[\s\S]{0,400}?>/g;

  for (const match of code.matchAll(tagPattern)) {
    const raw = match[0]?.replace(/\s+/g, ' ').trim();
    if (!raw || !/\bclassName=/.test(raw)) continue;
    if (/hover:underline/.test(raw) || /\bno-underline\b/.test(raw)) continue;
    const looksLikeButton =
      /\bbg-\[/.test(raw) ||
      (/\bpx-/.test(raw) && /\bpy-/.test(raw)) ||
      /\bjustify-center\b/.test(raw);
    if (looksLikeButton) continue;

    const isCanonicalTextLink =
      /\/(?:post|page|author|category|tag)\//.test(raw) ||
      /\bitem\.url\b/.test(raw) ||
      /\btoAppPath\(item\.url\)\b/.test(raw) ||
      /\bhref=["']https?:\/\//.test(raw);
    if (!isCanonicalTextLink) continue;

    snippets.push(raw.length > 180 ? `${raw.slice(0, 177)}...` : raw);
    if (snippets.length >= max) break;
  }

  return snippets;
}

export function isWithinSlugTernaryFallback(
  code: string,
  offset: number,
): boolean {
  const before = code.slice(Math.max(0, offset - 600), offset);
  return (
    /\bauthorSlug\s*\?/.test(before) ||
    /\bcategorySlugs(?:\?\.)?\s*\[\s*0\s*\]\s*\?/.test(before) ||
    /\b(?:post|item|postDetail)\.author\s*&&/.test(before) ||
    /\b(?:post|item|postDetail)\.categories(?:\?\.)?(?:\[0\])?\s*&&/.test(
      before,
    )
  );
}

export function isWithinHeadingTitleContext(
  code: string,
  offset: number,
): boolean {
  const start = Math.max(0, offset - 220);
  const end = Math.min(code.length, offset + 220);
  const window = code.slice(start, end);
  const before = code.slice(start, offset);
  const openHeading = before.match(/<h[1-6]\b[^>]*>/gi);
  const closeHeading = before.match(/<\/h[1-6]>/gi);
  if ((openHeading?.length ?? 0) > (closeHeading?.length ?? 0)) {
    return true;
  }

  return /\b(?:title|heading)\b/i.test(window);
}
