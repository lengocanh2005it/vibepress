import {
  normalizePlainTextPostMetaArchiveLinks,
  promotePlainTextPostMetaLinks,
} from '../../../common/utils/post-meta-link.util.js';

function appendUniqueClasses(existing: string, addition: string): string {
  return [...new Set(`${existing} ${addition}`.split(/\s+/).filter(Boolean))]
    .join(' ')
    .trim();
}

export function ensureHoverUnderlineOnCanonicalTextLinks(code: string): string {
  return code.replace(/<(Link|a)\b[\s\S]{0,400}?>/g, (rawTag) => {
    if (!/\bclassName="[^"]*"/.test(rawTag)) return rawTag;
    if (/hover:underline/.test(rawTag) || /\bno-underline\b/.test(rawTag)) {
      return rawTag;
    }

    const looksLikeButton =
      /\bbg-\[/.test(rawTag) ||
      (/\bpx-/.test(rawTag) && /\bpy-/.test(rawTag)) ||
      /\bjustify-center\b/.test(rawTag);
    if (looksLikeButton) return rawTag;

    const isCanonicalTextLink =
      /\/(?:post|page|author|category|tag)\//.test(rawTag) ||
      /\bitem\.url\b/.test(rawTag) ||
      /\btoAppPath\(item\.url\)\b/.test(rawTag) ||
      /\bhref=["']https?:\/\//.test(rawTag);
    if (!isCanonicalTextLink) return rawTag;

    return rawTag.replace(
      /\bclassName="([^"]*)"/,
      (_match, classes: string) =>
        `className="${appendUniqueClasses(
          classes,
          'hover:underline underline-offset-4',
        )}"`,
    );
  });
}

export function normalizeCanonicalPostMetaAndTextLinks(code: string): string {
  return ensureHoverUnderlineOnCanonicalTextLinks(
    promotePlainTextPostMetaLinks(normalizePlainTextPostMetaArchiveLinks(code)),
  );
}

const GENERATED_ASSET_RESOLVER = `const resolveAsset = (src: string) => {
  if (src.startsWith("theme-asset:")) {
    const assetPath = src.slice("theme-asset:".length).replace(/^\\/+/, '');
    if (!assetPath) return src;
    const segments = assetPath.split('/').filter(Boolean);
    const root = segments[0] ?? '';
    const mappedRoots: Record<string, string> = {
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
    const mappedRoot = mappedRoots[root] ?? 'assets';
    const hasMappedRoot = Object.prototype.hasOwnProperty.call(mappedRoots, root);
    const relativeSegments = hasMappedRoot ? segments.slice(1) : segments;
    const relativePath = relativeSegments.join('/');
    const publicPath = relativePath ? \`\${mappedRoot}/\${relativePath}\` : mappedRoot;
    return \`\${import.meta.env.BASE_URL}\${publicPath}\`;
  }
  return src.startsWith('/assets/')
    ? \`\${import.meta.env.BASE_URL}assets/\${src.slice('/assets/'.length)}\`
    : src;
};`;

export function normalizeThemeAssetReferences(code: string): string {
  let next = code;
  if (
    !next.includes('theme-asset:') &&
    !/\bresolveThemeAsset\s*\(/.test(next) &&
    !/element\.getAttribute\((['"])src\1\)\s*\|\|\s*(['"])\2/.test(next)
  ) {
    return next;
  }

  next = next.replace(/\bresolveThemeAsset\s*\(/g, 'resolveAsset(');

  next = next.replace(
    /\bsrc=(["'])(theme-asset:[^"']+)\1/g,
    (_match, _quote: string, asset: string) =>
      `src={resolveAsset(${JSON.stringify(asset)})}`,
  );

  next = next.replace(
    /\bbackgroundImage:\s*(["'])url\((['"]?)(theme-asset:[^"'`)]+)\2\)\1/g,
    (_match, _outerQuote: string, _innerQuote: string, asset: string) =>
      'backgroundImage: `url("${resolveAsset(' +
      JSON.stringify(asset) +
      ')}")`',
  );

  next = next.replace(
    /src:\s*element\.getAttribute\((['"])src\1\)\s*\|\|\s*(['"])\2/g,
    `src: resolveAsset(element.getAttribute('src') || '')`,
  );

  if (/\bresolveAsset\s*\(/.test(next) && !hasResolveAssetDefinition(next)) {
    next = injectResolveAssetHelper(next);
  }

  return next;
}

export function normalizeCommonTypographyTypos(code: string): string {
  return code.replace(/\bsan-serif\b/gi, 'sans-serif');
}

function hasResolveAssetDefinition(code: string): boolean {
  return (
    /\bconst\s+resolveAsset\s*=/.test(code) ||
    /\bfunction\s+resolveAsset\s*\(/.test(code)
  );
}

function injectResolveAssetHelper(code: string): string {
  const importMatches = [...code.matchAll(/^import[^\n]*\n/gm)];
  if (importMatches.length === 0) {
    return `${GENERATED_ASSET_RESOLVER}\n\n${code}`;
  }
  const lastImport = importMatches[importMatches.length - 1];
  const insertAt = (lastImport.index ?? 0) + lastImport[0].length;
  return `${code.slice(0, insertAt)}\n${GENERATED_ASSET_RESOLVER}\n\n${code.slice(insertAt)}`;
}
