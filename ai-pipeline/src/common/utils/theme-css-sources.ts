import { readFile, readdir } from 'fs/promises';
import { join, relative, sep } from 'path';

export interface ThemeCssSources {
  themeName?: string;
  styleCss: string;
  combinedCss: string;
  files: string[];
}

export async function collectThemeCssSources(
  themeDir: string,
): Promise<ThemeCssSources> {
  const stylePath = join(themeDir, 'style.css');
  let styleCss = '';
  let themeName: string | undefined;

  try {
    styleCss = await readFile(stylePath, 'utf-8');
    const nameMatch = styleCss.match(/Theme Name:\s*(.+)/);
    if (nameMatch) themeName = nameMatch[1].trim();
  } catch {
    // style.css is optional here.
  }

  const candidatePaths = new Set<string>();
  if (styleCss.trim()) candidatePaths.add(stylePath);

  for (const relPath of await collectThemeCssAssetPaths(themeDir)) {
    candidatePaths.add(join(themeDir, relPath));
  }

  const files = Array.from(candidatePaths).sort((a, b) => a.localeCompare(b));
  const chunks: string[] = [];

  for (const filePath of files) {
    try {
      const css = await readFile(filePath, 'utf-8');
      if (!css.trim()) continue;
      const relPath = relative(themeDir, filePath).split(sep).join('/');
      chunks.push(`/* ${relPath} */\n${css}`);
    } catch {
      // Ignore unreadable CSS assets. They are supplemental only.
    }
  }

  return {
    themeName,
    styleCss,
    combinedCss: chunks.join('\n\n'),
    files: files.map((filePath) =>
      relative(themeDir, filePath).split(sep).join('/'),
    ),
  };
}

async function collectThemeCssAssetPaths(themeDir: string): Promise<string[]> {
  const relPaths = new Set<string>();

  const functionsPhp = await tryRead(join(themeDir, 'functions.php'));
  if (functionsPhp) {
    for (const relPath of extractCssPathsFromPhp(functionsPhp)) {
      relPaths.add(relPath);
    }
  }

  for (const cssDir of ['assets/css', 'css']) {
    await walkCssDir(join(themeDir, cssDir), themeDir, relPaths);
  }

  return Array.from(relPaths).filter((relPath) =>
    shouldIncludeThemeCss(relPath),
  );
}

async function walkCssDir(
  dir: string,
  themeDir: string,
  relPaths: Set<string>,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkCssDir(fullPath, themeDir, relPaths);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.css')) continue;
    relPaths.add(relative(themeDir, fullPath).split(sep).join('/'));
  }
}

function extractCssPathsFromPhp(source: string): string[] {
  const relPaths = new Set<string>();
  const patterns = [
    /get_(?:parent_)?theme_file_path\(\s*['"]([^'"]+\.css)['"]\s*\)/gi,
    /get_(?:parent_)?theme_file_uri\(\s*['"]([^'"]+\.css)['"]\s*\)/gi,
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      const relPath = normalizeCssPath(match[1]);
      if (relPath) relPaths.add(relPath);
    }
  }

  return Array.from(relPaths);
}

function normalizeCssPath(value: string): string | null {
  const relPath = value
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/');
  if (!relPath || relPath.startsWith('../') || relPath.startsWith('/')) {
    return null;
  }
  return relPath;
}

function shouldIncludeThemeCss(relPath: string): boolean {
  const normalized = relPath.toLowerCase();
  if (!normalized.endsWith('.css')) return false;
  if (normalized === 'style.css') return true;

  return !/(^|\/)(admin|editor|login|customize|customizer|woocommerce-admin)[^/]*\.css$/.test(
    normalized,
  );
}

async function tryRead(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}
