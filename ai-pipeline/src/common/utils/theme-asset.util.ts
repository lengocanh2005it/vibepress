export const THEME_ASSET_TOKEN_PREFIX = 'theme-asset:';

export const THEME_ASSET_PUBLIC_ROOTS: Record<string, string> = {
  assets: 'assets',
  css: 'assets/css',
  js: 'assets/js',
  scripts: 'assets/scripts',
  images: 'assets/images',
  img: 'assets/img',
  fonts: 'assets/fonts',
  svg: 'assets/svg',
  icons: 'assets/icons',
};

const THEME_ASSET_EXT_RE =
  /\.(?:png|jpe?g|gif|webp|svg|avif|ico|bmp|mp4|webm|ogg|mp3|wav|pdf|css|js|woff2?|ttf|otf|eot)(?:[?#].*)?$/i;
const STATIC_IMAGE_EXT_RE =
  /\.(?:png|jpe?g|gif|webp|svg|avif|ico|bmp)(?:[?#].*)?$/i;
const THEME_FUNCTION_RE =
  /\b(?:get_template_directory_uri|get_stylesheet_directory_uri|get_parent_theme_file_uri|get_theme_file_uri|bloginfo\s*\(\s*['"]template_url['"]\s*\)|bloginfo\s*\(\s*['"]stylesheet_directory['"]\s*\))\b/i;

export function isThemeAssetToken(value?: string | null): boolean {
  return (
    typeof value === 'string' &&
    value.trim().startsWith(THEME_ASSET_TOKEN_PREFIX)
  );
}

export function extractThemeAssetTokenPath(
  value?: string | null,
): string | undefined {
  if (!isThemeAssetToken(value)) return undefined;
  const rawPath = value!.trim().slice(THEME_ASSET_TOKEN_PREFIX.length);
  const normalized = normalizeThemeAssetPath(rawPath);
  return normalized || undefined;
}

export function canonicalizeThemeAssetReference(
  value?: string | null,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  const tokenPath = extractThemeAssetTokenPath(trimmed);
  if (tokenPath) {
    return `${THEME_ASSET_TOKEN_PREFIX}${tokenPath}`;
  }

  const themePath =
    extractThemeAssetPathFromPhp(trimmed) ??
    extractThemeAssetPathFromThemeUrl(trimmed) ??
    extractThemeAssetPathFromLocalReference(trimmed);
  if (themePath) {
    return `${THEME_ASSET_TOKEN_PREFIX}${themePath}`;
  }

  return trimmed;
}

export function resolveThemeAssetPublicPath(
  value?: string | null,
): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('/assets/')) return trimmed;

  const tokenPath =
    extractThemeAssetTokenPath(trimmed) ??
    extractThemeAssetPathFromLocalReference(trimmed);
  if (!tokenPath) return undefined;

  const normalized = tokenPath.replace(/^\/+/, '');
  if (!normalized) return undefined;

  const [root, ...rest] = normalized.split('/');
  const hasMappedRoot = root in THEME_ASSET_PUBLIC_ROOTS;
  const mappedRoot = THEME_ASSET_PUBLIC_ROOTS[root] ?? 'assets';
  const publicPath = [mappedRoot, ...(hasMappedRoot ? rest : [root, ...rest])]
    .filter(Boolean)
    .join('/');
  return publicPath ? `/${publicPath}` : undefined;
}

export function extractStaticImageSources(templateSource: string): string[] {
  const result = new Set<string>();
  const push = (candidate: unknown) => {
    if (typeof candidate !== 'string') return;
    const canonical = canonicalizeThemeAssetReference(candidate);
    if (!canonical) return;
    if (
      isThemeAssetToken(canonical) ||
      STATIC_IMAGE_EXT_RE.test(canonical) ||
      /^https?:\/\/[^\s"'()<>]+$/i.test(canonical)
    ) {
      result.add(canonical);
    }
  };

  try {
    const parsed = JSON.parse(templateSource);
    const visit = (node: any) => {
      if (!node || typeof node !== 'object') return;
      push(node.src);
      push(node.imageSrc);
      push(node.authorAvatar);
      if (Array.isArray(node.children)) node.children.forEach(visit);
      if (Array.isArray(node.tabs)) node.tabs.forEach(visit);
      if (Array.isArray(node.slides)) node.slides.forEach(visit);
      if (Array.isArray(node.cards)) node.cards.forEach(visit);
      if (Array.isArray(node.sourceSegments))
        node.sourceSegments.forEach(visit);
      if (Array.isArray(node)) node.forEach(visit);
    };
    visit(parsed);
  } catch {
    for (const match of templateSource.matchAll(
      /(?:src|imageSrc|authorAvatar)=["']([^"']+)["']/g,
    )) {
      push(match[1]);
    }
    for (const match of templateSource.matchAll(
      /"(?:src|imageSrc|authorAvatar)":"([^"]+)"/g,
    )) {
      push(match[1]);
    }
    for (const match of templateSource.matchAll(
      /https?:\/\/[^\s"'()<>]+\.(?:png|jpe?g|gif|webp|svg|avif|ico|bmp)(?:\?[^\s"'()<>]*)?/gi,
    )) {
      push(match[0]);
    }
  }

  return [...result];
}

function extractThemeAssetPathFromPhp(value: string): string | undefined {
  if (!value.includes('<?php') && !THEME_FUNCTION_RE.test(value))
    return undefined;

  const afterPhp = value.split('?>').pop()?.trim() ?? '';
  if (afterPhp) {
    const fromTail = extractThemeAssetPathFromLocalReference(afterPhp);
    if (fromTail) return fromTail;
  }

  const pathMatch = value.match(
    /['"]([^'"]+\.(?:png|jpe?g|gif|webp|svg|avif|ico|bmp|mp4|webm|ogg|mp3|wav|pdf|css|js|woff2?|ttf|otf|eot))['"]/i,
  );
  if (pathMatch?.[1] && THEME_FUNCTION_RE.test(value)) {
    return normalizeThemeAssetPath(pathMatch[1]);
  }

  return undefined;
}

function extractThemeAssetPathFromThemeUrl(value: string): string | undefined {
  const match = value.match(
    /\/wp-content\/themes\/[^/]+\/([^"'?#]+\.(?:png|jpe?g|gif|webp|svg|avif|ico|bmp|mp4|webm|ogg|mp3|wav|pdf|css|js|woff2?|ttf|otf|eot))(?:[?#][^"'#]*)?$/i,
  );
  return match?.[1] ? normalizeThemeAssetPath(match[1]) : undefined;
}

function extractThemeAssetPathFromLocalReference(
  value: string,
): string | undefined {
  const normalized = value
    .trim()
    .replace(/^['"]+|['"]+$/g, '')
    .replace(/\\/g, '/');
  if (!normalized || !THEME_ASSET_EXT_RE.test(normalized)) return undefined;
  if (/^(?:https?:|data:|blob:|mailto:|tel:|#)/i.test(normalized)) {
    return undefined;
  }

  const withoutQuery = stripQueryAndHash(normalized);
  const trimmedPath = withoutQuery.replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!trimmedPath) return undefined;

  const [root] = trimmedPath.split('/');
  if (
    root in THEME_ASSET_PUBLIC_ROOTS ||
    /^(?:assets|images|img|fonts|svg|icons|css|js|scripts)$/i.test(root)
  ) {
    return normalizeThemeAssetPath(trimmedPath);
  }

  return undefined;
}

function normalizeThemeAssetPath(value: string): string {
  const normalized = stripQueryAndHash(
    value
      .trim()
      .replace(/^['"]+|['"]+$/g, '')
      .replace(/\\/g, '/')
      .replace(/^\.\/+/, ''),
  ).replace(/^\/+/, '');
  return normalized ? `/${normalized}` : '';
}

function stripQueryAndHash(value: string): string {
  return value.split('#')[0]?.split('?')[0] ?? value;
}
