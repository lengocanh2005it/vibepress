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
