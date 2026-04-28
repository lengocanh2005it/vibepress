import express from 'express';
import cors from 'cors';
import { createConnection } from 'mysql2/promise';
import dotenv from 'dotenv';
import { createHash } from 'crypto';
import { basename, extname, resolve, join } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env'), override: true });

const app = express();
app.use(cors());
app.use(express.json());

// Serve static assets copied from wp-content/uploads during preview build
app.use('/assets', express.static(join(resolve(process.cwd(), '..', 'frontend', 'public', 'assets'))));

app.get('/api', (_req, res) => {
  res.json({
    message: 'Hello World from the preview backend',
    status: 'ok',
    service: 'express-preview-api',
    endpoints: [
      '/api/site-info',
      '/api/posts',
      '/api/pages',
      '/api/menus',
      '/api/footer-links',
      '/api/taxonomies',
      '/api/comments',
    ],
  });
});

const PORT = Number(process.env.API_PORT) || 3100;
const PREVIEW_BASE = process.env.PREVIEW_BASE ?? '';
const DEFAULT_POSTS_PER_PAGE = 10;
const MAX_POSTS_PER_PAGE = 50;
const BUILTIN_POST_TYPES = new Set([
  'attachment',
  'revision',
  'nav_menu_item',
  'custom_css',
  'customize_changeset',
  'oembed_cache',
  'user_request',
  'wp_block',
  'wp_template',
  'wp_template_part',
  'wp_global_styles',
  'wp_navigation',
  'wp_font_face',
  'wp_font_family',
]);

function formatDate(mysqlDate: string | Date | null): string {
  if (!mysqlDate) return '';
  const d = new Date(mysqlDate);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

function rebaseToSiteOrigin(url: string, siteUrl: string): string {
  try {
    const parsed = new URL(url);
    const site = new URL(siteUrl);
    if (parsed.origin !== site.origin) {
      parsed.protocol = site.protocol;
      parsed.hostname = site.hostname;
      parsed.port = site.port;
    }
    return parsed.toString();
  } catch {
    return url;
  }
}

function rewriteWpContentAssetUrls(html: string | null | undefined): string {
  if (!html) return '';
  return String(html).replace(
    /(?:https?:\/\/[^"'\s)]+)?\/wp-content\/uploads\/[^"'\s)]+/gi,
    (match: string) => localizeWpUploadAssetUrl(match) ?? match,
  );
}

function normalizeWpUploadAssetUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed || !/\/wp-content\/uploads\//i.test(trimmed)) return null;
  try {
    const siteUrl = process.env.SITE_URL?.trim();
    if (/^https?:\/\//i.test(trimmed)) {
      return siteUrl ? rebaseToSiteOrigin(trimmed, siteUrl) : new URL(trimmed).toString();
    }
    if (siteUrl) return new URL(trimmed, siteUrl).toString();
  } catch {
    // Fall through to returning the original string.
  }
  return trimmed;
}

function buildWpUploadAssetFileName(raw: string): string {
  const normalized = normalizeWpUploadAssetUrl(raw) ?? raw;
  let pathname = normalized;
  try {
    pathname = new URL(normalized).pathname;
  } catch {
    pathname = normalized.split(/[?#]/)[0] ?? normalized;
  }
  const originalName = basename(pathname) || 'wp-asset';
  const ext = extname(originalName) || '.jpg';
  const safeExt = /^[.][a-zA-Z0-9]+$/.test(ext) ? ext.toLowerCase() : '.jpg';
  const baseName = basename(originalName, ext)
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  const safeBaseName = baseName || 'wp-asset';
  const hash = createHash('sha1').update(normalized).digest('hex').slice(0, 12);
  return `${hash}-${safeBaseName}${safeExt}`;
}

function localizeWpUploadAssetUrl(raw: string | null | undefined): string | null {
  const normalized = normalizeWpUploadAssetUrl(raw);
  if (!normalized) return raw?.trim() ? String(raw).trim() : null;
  return `${PREVIEW_BASE}assets/images/${buildWpUploadAssetFileName(normalized)}`;
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#039;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>');
}

function generateExcerpt(
  explicitExcerpt: string | null | undefined,
  contentHtml: string | null | undefined,
): string {
  const trimmedExcerpt = String(explicitExcerpt ?? '').trim();
  if (trimmedExcerpt) return trimmedExcerpt;

  const plainText = decodeHtmlEntities(
    String(contentHtml ?? '')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/\[[^\]]+\]/g, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );

  if (!plainText) return '';

  const words = plainText.split(/\s+/);
  if (words.length <= 55) return plainText;
  return `${words.slice(0, 55).join(' ')}...`;
}

function stripGutenbergBlockComments(html: string): string {
  return html.replace(/<!--\s*\/?wp:[\s\S]*?-->/gi, '');
}

function parseBlockAttrs(raw: string | undefined): Record<string, any> {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (
    match: RegExpExecArray,
  ) => Promise<string>,
): Promise<string> {
  let result = '';
  let lastIndex = 0;
  pattern.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) !== null) {
    result += input.slice(lastIndex, match.index);
    result += await replacer(match);
    lastIndex = match.index + match[0].length;
  }

  result += input.slice(lastIndex);
  return result;
}

async function renderLatestPostsBlock(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  attrs: Record<string, any>,
): Promise<string> {
  const requestedLimit = Number(attrs.postsToShow ?? attrs.posts_to_show ?? 5);
  const limit = Number.isFinite(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 12)
    : 5;
  const showDate = !!attrs.displayPostDate;
  const order = String(attrs.order ?? 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
  const orderBy = String(attrs.orderBy ?? 'date');
  const orderBySql =
    orderBy === 'title'
      ? 'p.post_title'
      : orderBy === 'modified'
        ? 'p.post_modified'
        : orderBy === 'id'
          ? 'p.ID'
          : 'p.post_date';
  const [rows] = await conn.query<any[]>(
    `SELECT p.ID, p.post_title, p.post_name, p.post_date
     FROM \`${prefix}posts\` p
     WHERE p.post_type = 'post' AND p.post_status = 'publish'
     ORDER BY ${orderBySql} ${order}
     LIMIT ?`,
    [limit],
  );

  return `<ul class="wp-block-latest-posts">${rows
    .map(
      (row) =>
        `<li><a href="${PREVIEW_BASE}post/${row.post_name}">${row.post_title}</a>${
          showDate
            ? ` <time datetime="${new Date(row.post_date).toISOString()}">${formatDate(row.post_date)}</time>`
            : ''
        }</li>`,
    )
    .join('')}</ul>`;
}

async function renderTermListBlock(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  taxonomy: 'category' | 'post_tag',
  className: string,
  hrefBase: string,
): Promise<string> {
  const [rows] = await conn.query<any[]>(
    `SELECT t.name, t.slug, tt.count
     FROM \`${prefix}terms\` t
     INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_id = t.term_id
     WHERE tt.taxonomy = ? AND tt.count > 0
     ORDER BY t.name ASC`,
    [taxonomy],
  );

  if (taxonomy === 'post_tag') {
    return `<div class="${className}">${rows
      .map(
        (row) =>
          `<a href="${hrefBase}/${row.slug}" class="wp-block-tag-cloud-link">${row.name}</a>`,
      )
      .join(' ')}</div>`;
  }

  return `<ul class="${className}">${rows
    .map(
      (row) =>
        `<li><a href="${hrefBase}/${row.slug}">${row.name}</a></li>`,
    )
    .join('')}</ul>`;
}

async function renderArchivesBlock(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
): Promise<string> {
  const [rows] = await conn.query<any[]>(
    `SELECT YEAR(post_date) AS year, MONTH(post_date) AS month, COUNT(*) AS count
     FROM \`${prefix}posts\`
     WHERE post_type = 'post' AND post_status = 'publish'
     GROUP BY YEAR(post_date), MONTH(post_date)
     ORDER BY YEAR(post_date) DESC, MONTH(post_date) DESC
     LIMIT 12`,
  );

  return `<ul class="wp-block-archives-list">${rows
    .map((row) => {
      const monthLabel = new Date(
        Number(row.year),
        Number(row.month) - 1,
        1,
      ).toLocaleDateString('en-US', {
        month: 'long',
        year: 'numeric',
      });
      return `<li><a href="${PREVIEW_BASE}archive?month=${row.year}-${String(row.month).padStart(2, '0')}">${monthLabel}</a> (${row.count})</li>`;
    })
    .join('')}</ul>`;
}

async function renderDynamicGutenbergBlock(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  blockName: string,
  attrs: Record<string, any>,
): Promise<string | null> {
  switch (blockName) {
    case 'core/latest-posts':
    case 'latest-posts':
      return renderLatestPostsBlock(conn, prefix, attrs);
    case 'core/categories':
    case 'categories':
      return renderTermListBlock(
        conn,
        prefix,
        'category',
        'wp-block-categories-list',
        `${PREVIEW_BASE}category`,
      );
    case 'core/tag-cloud':
    case 'tag-cloud':
      return renderTermListBlock(
        conn,
        prefix,
        'post_tag',
        'wp-block-tag-cloud',
        `${PREVIEW_BASE}tag`,
      );
    case 'core/archives':
    case 'archives':
      return renderArchivesBlock(conn, prefix);
    default:
      return null;
  }
}

function rewriteInternalLinks(html: string): string {
  if (!PREVIEW_BASE || PREVIEW_BASE === '/') return html;
  // Rewrite <a href="/internal/path"> → <a href="${PREVIEW_BASE}internal/path">
  // Leave external URLs (http/https/mailto/tel/#) unchanged.
  return html.replace(
    /(<a\b[^>]*?\bhref=)(["'])(\/(?!\/)[^"']*)\2/gi,
    (_match, tagPart: string, quote: string, path: string) => {
      // Already has preview prefix → skip
      if (path.startsWith(PREVIEW_BASE)) return _match;
      const joined = `${PREVIEW_BASE}${path.replace(/^\//, '')}`;
      return `${tagPart}${quote}${joined}${quote}`;
    },
  );
}

async function normalizeRichContent(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  html: string | null | undefined,
): Promise<string> {
  if (!html) return '';

  let normalized = rewriteWpContentAssetUrls(html);
  normalized = await replaceAsync(
    normalized,
    /<!--\s*wp:([a-z0-9/-]+)(?:\s+(\{[\s\S]*?\}))?\s*\/-->/gi,
    async (match) => {
      const blockName = String(match[1] ?? '').toLowerCase();
      const attrs = parseBlockAttrs(match[2]);
      const rendered = await renderDynamicGutenbergBlock(
        conn,
        prefix,
        blockName,
        attrs,
      );
      return rendered ?? '';
    },
  );

  normalized = rewriteInternalLinks(normalized);
  return stripGutenbergBlockComments(normalized).trim();
}

function splitTermList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return String(raw)
    .split(', ')
    .map((item) => item.trim())
    .filter(Boolean);
}

function taxonomyNamesSubquery(prefix: string, taxonomy: string): string {
  return `(SELECT GROUP_CONCAT(DISTINCT t.name ORDER BY t.name SEPARATOR ', ')
           FROM \`${prefix}term_relationships\` tr2
           INNER JOIN \`${prefix}term_taxonomy\` tt2 ON tt2.term_taxonomy_id = tr2.term_taxonomy_id
           INNER JOIN \`${prefix}terms\` t ON t.term_id = tt2.term_id
           WHERE tt2.taxonomy = '${taxonomy}' AND tr2.object_id = p.ID)`;
}

function taxonomySlugsSubquery(prefix: string, taxonomy: string): string {
  return `(SELECT GROUP_CONCAT(DISTINCT t.slug ORDER BY t.slug SEPARATOR ', ')
           FROM \`${prefix}term_relationships\` tr2
           INNER JOIN \`${prefix}term_taxonomy\` tt2 ON tt2.term_taxonomy_id = tr2.term_taxonomy_id
           INNER JOIN \`${prefix}terms\` t ON t.term_id = tt2.term_id
           WHERE tt2.taxonomy = '${taxonomy}' AND tr2.object_id = p.ID)`;
}

function parsePositiveInt(raw: unknown, fallback: number): number {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function parsePostsPaginationQuery(req: express.Request) {
  const page = parsePositiveInt(req.query.page, 1);
  const perPage = Math.min(
    parsePositiveInt(req.query.perPage, DEFAULT_POSTS_PER_PAGE),
    MAX_POSTS_PER_PAGE,
  );
  return {
    page,
    perPage,
    offset: (page - 1) * perPage,
  };
}

function applyPostsPaginationHeaders(
  res: express.Response,
  total: number,
  page: number,
  perPage: number,
) {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  res.setHeader('X-WP-Total', String(total));
  res.setHeader('X-WP-TotalPages', String(totalPages));
  res.setHeader('X-WP-CurrentPage', String(Math.min(page, totalPages)));
  res.setHeader('X-WP-PerPage', String(perPage));
}

async function getApiPostTypes(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
): Promise<string[]> {
  const [rows] = await conn.query<any[]>(
    `SELECT DISTINCT post_type
     FROM \`${prefix}posts\`
     WHERE post_status = 'publish'`,
  );
  return rows
    .map((row) => String(row.post_type ?? ''))
    .filter((postType) => postType && !BUILTIN_POST_TYPES.has(postType))
    .sort();
}

async function getPostTypeSummaries(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
) {
  const publicTypes = await getApiPostTypes(conn, prefix);
  if (publicTypes.length === 0) return [];
  const [countRows] = await conn.query<any[]>(
    `SELECT post_type, COUNT(*) AS cnt
     FROM \`${prefix}posts\`
     WHERE post_status = 'publish'
       AND post_type IN (${publicTypes.map(() => '?').join(', ')})
     GROUP BY post_type
     ORDER BY post_type ASC`,
    publicTypes,
  );
  const [taxonomyRows] = await conn.query<any[]>(
    `SELECT DISTINCT p.post_type, tt.taxonomy
     FROM \`${prefix}posts\` p
     INNER JOIN \`${prefix}term_relationships\` tr ON tr.object_id = p.ID
     INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
     WHERE p.post_status = 'publish'
       AND p.post_type IN (${publicTypes.map(() => '?').join(', ')})
       AND tt.taxonomy NOT IN ('nav_menu', 'link_category', 'post_format')
     ORDER BY p.post_type ASC, tt.taxonomy ASC`,
    publicTypes,
  );

  const taxonomyMap = new Map<string, string[]>();
  for (const row of taxonomyRows) {
    const key = String(row.post_type ?? '');
    const list = taxonomyMap.get(key) ?? [];
    list.push(String(row.taxonomy ?? ''));
    taxonomyMap.set(key, list);
  }

  return countRows.map((row) => ({
    postType: String(row.post_type),
    count: Number(row.cnt),
    taxonomies: taxonomyMap.get(String(row.post_type)) ?? [],
  }));
}

function normalizeRequestedPostTypes(
  raw: unknown,
  availableTypes: string[],
  defaults: string[],
): string[] {
  const requested = typeof raw === 'string' ? raw.trim() : '';
  if (!requested) return defaults;
  if (requested === 'all') return availableTypes;
  const requestedTypes = requested
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const filtered = requestedTypes.filter((value) => availableTypes.includes(value));
  return filtered.length > 0 ? filtered : defaults;
}

function buildPostTypeWhereClause(
  conn: Awaited<ReturnType<typeof getConn>>,
  postTypes: string[],
): string {
  if (postTypes.length === 0) return `AND 1 = 0`;
  return `AND p.post_type IN (${postTypes.map((type) => conn.escape(type)).join(', ')})`;
}

async function serializePost(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  r: any,
) {
  return {
    id: r.ID,
    title: r.post_title,
    content: await normalizeRichContent(conn, prefix, r.post_content),
    excerpt: generateExcerpt(r.post_excerpt, r.post_content),
    slug: r.post_name,
    type: r.post_type,
    status: r.post_status,
    date: formatDate(r.post_date),
    author: r.author_name ?? '',
    authorSlug: r.author_slug ?? '',
    categories: splitTermList(r.categories),
    categorySlugs: splitTermList(r.category_slugs),
    tags: splitTermList(r.tags),
    featuredImage: localizeWpUploadAssetUrl(r.featured_image ?? null),
  };
}

async function serializePage(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  r: any,
) {
  return {
    id: r.ID,
    title: r.post_title,
    content: await normalizeRichContent(conn, prefix, r.post_content),
    slug: r.post_name,
    parentId: Number(r.post_parent ?? 0),
    menuOrder: r.menu_order,
    template: r.template ?? '',
    featuredImage: localizeWpUploadAssetUrl(r.featured_image ?? null),
  };
}

async function serializePostRows(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  rows: any[],
) {
  const result = [];
  for (const row of rows) {
    result.push(await serializePost(conn, prefix, row));
  }
  return result;
}

async function serializePageRows(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  rows: any[],
) {
  const result = [];
  for (const row of rows) {
    result.push(await serializePage(conn, prefix, row));
  }
  return result;
}

async function getConn() {
  return createConnection({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'wordpress',
  });
}

process.on('unhandledRejection', (err: any) => {
  const code = err?.code;
  console.error(`[DB Error] ${code ?? 'Unknown'}: ${err?.message ?? err}`);
});

async function getPrefix(
  conn: Awaited<ReturnType<typeof getConn>>,
): Promise<string> {
  const [rows] = await conn.query<any[]>(
    `SELECT table_name AS tableName FROM information_schema.tables
     WHERE table_schema = DATABASE() AND table_name LIKE '%options' LIMIT 1`,
  );
  if (!rows.length) return 'wp_';
  return rows[0].tableName.replace(/options$/, '');
}

function phpUnserializeSimple(input: string): Record<string, any> | null {
  let pos = 0;

  function readValue(): any {
    const type = input[pos];
    pos += 2;
    if (type === 'i') {
      const end = input.indexOf(';', pos);
      const n = parseInt(input.slice(pos, end), 10);
      pos = end + 1;
      return n;
    }
    if (type === 's') {
      const lenEnd = input.indexOf(':', pos);
      const len = parseInt(input.slice(pos, lenEnd), 10);
      pos = lenEnd + 2;
      const str = input.slice(pos, pos + len);
      pos += len + 2;
      return str;
    }
    if (type === 'a') {
      const countEnd = input.indexOf(':', pos);
      const count = parseInt(input.slice(pos, countEnd), 10);
      pos = countEnd + 2;
      const obj: Record<string, any> = {};
      for (let i = 0; i < count; i++) {
        const key = readValue();
        const val = readValue();
        obj[String(key)] = val;
      }
      pos += 1;
      return obj;
    }
    if (type === 'b') {
      const end = input.indexOf(';', pos);
      const b = input.slice(pos, end) === '1';
      pos = end + 1;
      return b;
    }
    if (type === 'N') {
      pos -= 1;
      return null;
    }
    return undefined;
  }

  try {
    return readValue() as Record<string, any>;
  } catch {
    return null;
  }
}

async function resolveCustomLogoUrl(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  siteUrl: string,
): Promise<string | null> {
  try {
    const [[stylesheetRow]] = await conn.query<any[]>(
      `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'stylesheet' LIMIT 1`,
    );
    const stylesheet = stylesheetRow?.option_value as string | undefined;
    if (!stylesheet) return null;

    const [[modsRow]] = await conn.query<any[]>(
      `SELECT option_value FROM \`${prefix}options\` WHERE option_name = ? LIMIT 1`,
      [`theme_mods_${stylesheet}`],
    );
    const serialized = modsRow?.option_value as string | undefined;
    if (!serialized) return null;

    const parsed = phpUnserializeSimple(serialized);
    const customLogoId = Number(parsed?.custom_logo ?? 0);
    if (!Number.isFinite(customLogoId) || customLogoId <= 0) return null;

    const [[logoRow]] = await conn.query<any[]>(
      `SELECT guid
       FROM \`${prefix}posts\`
       WHERE ID = ? AND post_type = 'attachment'
       LIMIT 1`,
      [customLogoId],
    );
    const logoUrl = logoRow?.guid as string | undefined;
    if (!logoUrl?.trim()) return null;
    return siteUrl ? rebaseToSiteOrigin(logoUrl.trim(), siteUrl) : logoUrl.trim();
  } catch {
    return null;
  }
}

async function resolveSiteLogoOptionUrl(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  siteUrl: string,
): Promise<string | null> {
  try {
    const [[siteLogoRow]] = await conn.query<any[]>(
      `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'site_logo' LIMIT 1`,
    );
    const logoId = Number(siteLogoRow?.option_value ?? 0);
    if (!Number.isFinite(logoId) || logoId <= 0) return null;
    return resolveAttachmentUrlById(conn, prefix, logoId, siteUrl);
  } catch {
    return null;
  }
}

async function resolveSiteLogoUrl(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  siteUrl: string,
): Promise<string | null> {
  const siteLogoOptionUrl = await resolveSiteLogoOptionUrl(
    conn,
    prefix,
    siteUrl,
  );
  if (siteLogoOptionUrl) return siteLogoOptionUrl;

  const customLogoUrl = await resolveCustomLogoUrl(conn, prefix, siteUrl);
  if (customLogoUrl) return customLogoUrl;
  return resolveLogoUrlFromTemplateMarkup(conn, prefix, siteUrl);
}

async function resolveLogoUrlFromTemplateMarkup(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  siteUrl: string,
): Promise<string | null> {
  try {
    const [rows] = await conn.query<any[]>(
      `SELECT ID, post_name, post_type, post_content
       FROM \`${prefix}posts\`
       WHERE post_type IN ('wp_template_part', 'wp_template')
         AND post_status IN ('publish', 'private', 'draft', 'auto-draft')
         AND (
           post_name LIKE '%header%'
           OR post_name LIKE '%logo%'
           OR post_content LIKE '%wp:site-logo%'
           OR post_content LIKE '%/wp-content/uploads/%'
           OR post_content LIKE '%<img%'
         )
       ORDER BY
         CASE WHEN post_type = 'wp_template_part' THEN 0 ELSE 1 END,
         CASE WHEN post_name LIKE '%header%' THEN 0 ELSE 1 END,
         ID DESC
       LIMIT 20`,
    );

    for (const row of rows) {
      const markup = String(row.post_content ?? '');
      const resolved = await extractLogoUrlFromMarkup(conn, prefix, markup, siteUrl);
      if (resolved) return resolved;
    }

    return null;
  } catch {
    return null;
  }
}

async function extractLogoUrlFromMarkup(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  markup: string,
  siteUrl: string,
): Promise<string | null> {
  if (!markup.trim()) return null;

  const siteLogoBlockPattern =
    /<!--\s*wp:site-logo(?:\s+(\{[\s\S]*?\}))?[\s/]*-->/gi;
  for (const match of markup.matchAll(siteLogoBlockPattern)) {
    const attrs = tryParseBlockAttrs(match[1]);
    const attrUrl = normalizeLogoCandidateUrl(
      typeof attrs?.url === 'string' ? attrs.url : null,
      siteUrl,
    );
    if (attrUrl) return attrUrl;

    const attrId = Number(attrs?.id ?? 0);
    if (Number.isFinite(attrId) && attrId > 0) {
      const attachmentUrl = await resolveAttachmentUrlById(
        conn,
        prefix,
        attrId,
        siteUrl,
      );
      if (attachmentUrl) return attachmentUrl;
    }
  }

  const imagePattern = /<img\b[^>]*\bsrc="([^"]+)"[^>]*>/gi;
  for (const match of markup.matchAll(imagePattern)) {
    const src = normalizeLogoCandidateUrl(match[1], siteUrl);
    if (src) return src;
  }

  const uploadUrlPattern =
    /(?:https?:\/\/[^\s"'<>]+)?\/wp-content\/uploads\/[^\s"'<>]+/gi;
  for (const match of markup.matchAll(uploadUrlPattern)) {
    const src = normalizeLogoCandidateUrl(match[0], siteUrl);
    if (src) return src;
  }

  const attachmentIdPattern =
    /(?:wp-image-|\"id\"\s*:\s*|data-id=")(\d{1,12})/gi;
  for (const match of markup.matchAll(attachmentIdPattern)) {
    const attachmentId = Number(match[1] ?? 0);
    if (!Number.isFinite(attachmentId) || attachmentId <= 0) continue;
    const attachmentUrl = await resolveAttachmentUrlById(
      conn,
      prefix,
      attachmentId,
      siteUrl,
    );
    if (attachmentUrl) return attachmentUrl;
  }

  return null;
}

function tryParseBlockAttrs(raw: string | null | undefined): Record<string, any> | null {
  if (!raw?.trim()) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function extractSiteLogoWidth(markup: string): number | null {
  if (!markup) return null;
  const pattern = /<!--\s*wp:site-logo(?:\s+(\{[\s\S]*?\}))?[\s/]*-->/gi;
  for (const match of markup.matchAll(pattern)) {
    const attrs = tryParseBlockAttrs(match[1]);
    const w = Number(attrs?.width ?? 0);
    if (Number.isFinite(w) && w > 0) return w;
  }
  return null;
}

async function resolveSiteLogoWidth(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
): Promise<number | null> {
  try {
    const [rows] = await conn.query<any[]>(
      `SELECT post_content FROM \`${prefix}posts\`
       WHERE post_type IN ('wp_template', 'wp_template_part')
         AND post_status IN ('publish', 'auto-draft')
         AND post_content LIKE '%wp:site-logo%'
       ORDER BY post_modified DESC LIMIT 10`,
    );
    for (const row of rows) {
      const width = extractSiteLogoWidth(row.post_content as string);
      if (width) return width;
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeLogoCandidateUrl(
  raw: string | null | undefined,
  siteUrl: string,
): string | null {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (!trimmed) return null;

  try {
    if (/^https?:\/\//i.test(trimmed)) {
      return siteUrl ? rebaseToSiteOrigin(trimmed, siteUrl) : new URL(trimmed).toString();
    }
    if (siteUrl) {
      if (trimmed.startsWith('/')) {
        return new URL(trimmed, siteUrl).toString();
      }
      if (trimmed.includes('wp-content/uploads/')) {
        return new URL(
          trimmed.startsWith('wp-content/')
            ? `/${trimmed}`
            : `/wp-content/uploads/${trimmed.split('wp-content/uploads/')[1] ?? ''}`,
          siteUrl,
        ).toString();
      }
    }
  } catch {
    return null;
  }

  return null;
}

async function resolveAttachmentUrlById(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  attachmentId: number,
  siteUrl: string,
): Promise<string | null> {
  try {
    const [[attachmentRow]] = await conn.query<any[]>(
      `SELECT guid
       FROM \`${prefix}posts\`
       WHERE ID = ? AND post_type = 'attachment'
       LIMIT 1`,
      [attachmentId],
    );
    return normalizeLogoCandidateUrl(
      attachmentRow?.guid as string | undefined,
      siteUrl,
    );
  } catch {
    return null;
  }
}

function normalizeCommentModerationStatus(
  raw: unknown,
): 'approved' | 'pending' | 'spam' | 'trash' {
  const value = String(raw ?? '0').trim();
  if (value === '1') return 'approved';
  if (value === 'spam') return 'spam';
  if (value === 'trash' || value === 'post-trashed') return 'trash';
  return 'pending';
}

async function resolvePostId(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
  input: { postId?: unknown; slug?: unknown },
): Promise<number | null> {
  if (input.postId != null && String(input.postId).trim()) {
    const numericPostId = Number(input.postId);
    if (Number.isFinite(numericPostId) && numericPostId > 0) {
      return numericPostId;
    }
  }

  if (typeof input.slug === 'string' && input.slug.trim()) {
    const [slugRows] = await conn.query<any[]>(
      `SELECT ID FROM \`${prefix}posts\`
       WHERE post_name = ? AND post_status = 'publish' LIMIT 1`,
      [input.slug.trim()],
    );
    return slugRows[0]?.ID ?? null;
  }

  return null;
}

app.get('/api/site-info', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const keys = [
      'siteurl',
      'blogname',
      'blogdescription',
      'admin_email',
      'WPLANG',
    ];
    const [rows] = await conn.query<any[]>(
      `SELECT option_name, option_value FROM \`${prefix}options\`
       WHERE option_name IN (${keys.map(() => '?').join(',')})`,
      keys,
    );
    const opts: Record<string, string> = {};
    for (const row of rows) opts[row.option_name] = row.option_value;
    res.json({
      siteUrl: opts['siteurl'] ?? '',
      siteName: opts['blogname'] ?? '',
      blogDescription: opts['blogdescription'] ?? '',
      logoUrl:
        process.env.SITE_LOGO_URL ||
        (await resolveSiteLogoUrl(conn, prefix, opts['siteurl'] ?? '')),
      logoWidth: await resolveSiteLogoWidth(conn, prefix),
      adminEmail: opts['admin_email'] ?? '',
      language: opts['WPLANG'] ?? 'en',
    });
  } finally {
    await conn.end();
  }
});

app.get('/api/posts', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const availablePostTypes = await getApiPostTypes(conn, prefix);
    const selectedPostTypes = normalizeRequestedPostTypes(
      req.query.type,
      availablePostTypes,
      ['post'],
    );
    const authorSlug =
      typeof req.query.author === 'string' ? req.query.author : null;
    const authorFilter = authorSlug
      ? `AND u.user_nicename = ${conn.escape(authorSlug)}`
      : '';
    const typeFilter = buildPostTypeWhereClause(conn, selectedPostTypes);
    const { page, perPage, offset } = parsePostsPaginationQuery(req);
    const [[countRow]] = await conn.query<any[]>(
      `SELECT COUNT(*) AS total
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}users\` u ON u.ID = p.post_author
       WHERE p.post_status = 'publish' ${typeFilter} ${authorFilter}`,
    );
    applyPostsPaginationHeaders(
      res,
      Number(countRow?.total ?? 0),
      page,
      perPage,
    );
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name, p.post_type, p.post_status,
              p.post_date,
              u.display_name AS author_name,
              u.user_nicename AS author_slug,
              img.guid AS featured_image,
              ${taxonomyNamesSubquery(prefix, 'category')} AS categories,
              ${taxonomySlugsSubquery(prefix, 'category')} AS category_slugs,
              ${taxonomyNamesSubquery(prefix, 'post_tag')} AS tags
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       LEFT JOIN \`${prefix}users\` u ON u.ID = p.post_author
       WHERE p.post_status = 'publish' ${typeFilter} ${authorFilter}
       ORDER BY p.post_date DESC
       LIMIT ? OFFSET ?`,
      [perPage, offset],
    );
    res.json(await serializePostRows(conn, prefix, rows));
  } finally {
    await conn.end();
  }
});

app.get('/api/posts/:slug', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const availablePostTypes = await getApiPostTypes(conn, prefix);
    const selectedPostTypes = normalizeRequestedPostTypes(
      req.query.type,
      availablePostTypes,
      availablePostTypes,
    );
    const typeFilter = buildPostTypeWhereClause(conn, selectedPostTypes);
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name, p.post_type, p.post_status,
              p.post_date,
              u.display_name AS author_name,
              u.user_nicename AS author_slug,
              img.guid AS featured_image,
              ${taxonomyNamesSubquery(prefix, 'category')} AS categories,
              ${taxonomySlugsSubquery(prefix, 'category')} AS category_slugs,
              ${taxonomyNamesSubquery(prefix, 'post_tag')} AS tags
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       LEFT JOIN \`${prefix}users\` u ON u.ID = p.post_author
       WHERE p.post_name = ? AND p.post_status = 'publish' ${typeFilter} LIMIT 1`,
      [req.params.slug],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(await serializePost(conn, prefix, rows[0]));
  } finally {
    await conn.end();
  }
});

app.get('/api/pages/:slug', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_name, p.post_parent, p.menu_order,
              COALESCE(pm.meta_value, '') AS template,
              img.guid AS featured_image
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` pm ON pm.post_id = p.ID AND pm.meta_key = '_wp_page_template'
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       WHERE p.post_type = 'page' AND p.post_status = 'publish' AND p.post_name = ? LIMIT 1`,
      [req.params.slug],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(await serializePage(conn, prefix, rows[0]));
  } finally {
    await conn.end();
  }
});

app.get('/api/pages', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_name, p.post_parent, p.menu_order,
              COALESCE(pm.meta_value, '') AS template,
              img.guid AS featured_image
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` pm ON pm.post_id = p.ID AND pm.meta_key = '_wp_page_template'
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       WHERE p.post_type = 'page' AND p.post_status = 'publish'
       ORDER BY p.menu_order`,
    );
    res.json(await serializePageRows(conn, prefix, rows));
  } finally {
    await conn.end();
  }
});

app.get('/api/post-types', async (_req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    res.json(await getPostTypeSummaries(conn, prefix));
  } finally {
    await conn.end();
  }
});

app.get('/api/post-types/:postType/posts', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const availablePostTypes = await getApiPostTypes(conn, prefix);
    if (!availablePostTypes.includes(req.params.postType)) {
      return res.status(404).json({ error: 'Post type not found' });
    }
    const typeFilter = buildPostTypeWhereClause(conn, [req.params.postType]);
    const { page, perPage, offset } = parsePostsPaginationQuery(req);
    const [[countRow]] = await conn.query<any[]>(
      `SELECT COUNT(*) AS total
       FROM \`${prefix}posts\` p
       WHERE p.post_status = 'publish' ${typeFilter}`,
    );
    applyPostsPaginationHeaders(
      res,
      Number(countRow?.total ?? 0),
      page,
      perPage,
    );
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name, p.post_type, p.post_status,
              p.post_date,
              u.display_name AS author_name,
              u.user_nicename AS author_slug,
              img.guid AS featured_image,
              ${taxonomyNamesSubquery(prefix, 'category')} AS categories,
              ${taxonomySlugsSubquery(prefix, 'category')} AS category_slugs,
              ${taxonomyNamesSubquery(prefix, 'post_tag')} AS tags
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       LEFT JOIN \`${prefix}users\` u ON u.ID = p.post_author
       WHERE p.post_status = 'publish' ${typeFilter}
       ORDER BY p.post_date DESC
       LIMIT ? OFFSET ?`,
      [perPage, offset],
    );
    res.json(await serializePostRows(conn, prefix, rows));
  } finally {
    await conn.end();
  }
});

app.get('/api/post-types/:postType/:slug', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const availablePostTypes = await getApiPostTypes(conn, prefix);
    if (!availablePostTypes.includes(req.params.postType)) {
      return res.status(404).json({ error: 'Post type not found' });
    }
    const typeFilter = buildPostTypeWhereClause(conn, [req.params.postType]);
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name, p.post_type, p.post_status,
              p.post_date,
              u.display_name AS author_name,
              u.user_nicename AS author_slug,
              img.guid AS featured_image,
              ${taxonomyNamesSubquery(prefix, 'category')} AS categories,
              ${taxonomySlugsSubquery(prefix, 'category')} AS category_slugs,
              ${taxonomyNamesSubquery(prefix, 'post_tag')} AS tags
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       LEFT JOIN \`${prefix}users\` u ON u.ID = p.post_author
       WHERE p.post_name = ? AND p.post_status = 'publish' ${typeFilter}
       LIMIT 1`,
      [req.params.slug],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    res.json(await serializePost(conn, prefix, rows[0]));
  } finally {
    await conn.end();
  }
});

// Normalize a WordPress URL to a React Router path.
// Strips host, converts /pages/ → /page/ and /posts/ → /post/.
// External URLs (different origin) are kept as-is.
/**
 * Read nav_menu_locations from WordPress theme_mods.
 * Returns Map<termId, locationSlug>.
 */
async function queryNavMenuLocations(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
): Promise<Map<number, string>> {
  try {
    const [[stylesheetRow]] = await conn.query<any[]>(
      `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'stylesheet' LIMIT 1`,
    );
    const stylesheet = stylesheetRow?.option_value as string | undefined;
    if (!stylesheet) return new Map();

    const [[modsRow]] = await conn.query<any[]>(
      `SELECT option_value FROM \`${prefix}options\` WHERE option_name = ? LIMIT 1`,
      [`theme_mods_${stylesheet}`],
    );
    const serialized = modsRow?.option_value as string | undefined;
    if (!serialized) return new Map();

    const parsed = phpUnserializeSimple(serialized);
    const locations = parsed?.nav_menu_locations as
      | Record<string, number>
      | undefined;
    if (!locations || typeof locations !== 'object') return new Map();

    const termToLocation = new Map<number, string>();
    for (const [locationSlug, termId] of Object.entries(locations)) {
      if (termId) termToLocation.set(Number(termId), locationSlug);
    }
    return termToLocation;
  } catch {
    return new Map();
  }
}

/**
 * Parse wp:navigation-link blocks from a wp_navigation post's content.
 * Handles both self-closing and block-with-children forms.
 */
function parseNavigationBlockItems(
  content: string,
  siteUrl?: string | null,
): {
  id: number;
  title: string;
  url: string;
  order: number;
  parentId: number;
  target: string | null;
  }[] {
  const items: {
    id: number;
    title: string;
    url: string;
    order: number;
    parentId: number;
    target: string | null;
  }[] = [];
  const blockStart = /<!--\s*wp:navigation-link\s+/g;
  let order = 0;
  let startMatch: RegExpExecArray | null;

  while ((startMatch = blockStart.exec(content)) !== null) {
    const jsonStart = startMatch.index + startMatch[0].length;
    if (content[jsonStart] !== '{') continue;

    let depth = 0;
    let jsonEnd = jsonStart;
    for (let i = jsonStart; i < content.length; i++) {
      if (content[i] === '{') depth++;
      else if (content[i] === '}') {
        depth--;
        if (depth === 0) {
          jsonEnd = i + 1;
          break;
        }
      }
    }
    if (depth !== 0) continue;

    const jsonStr = content.slice(jsonStart, jsonEnd);
    try {
      const attrs = JSON.parse(jsonStr) as {
        label?: string;
        url?: string;
        id?: number;
        type?: string;
        opensInNewTab?: boolean;
      };
      const url = normalizeMenuUrl(attrs.url ?? '', siteUrl, attrs.type);
      if (attrs.label && url) {
        items.push({
          id: attrs.id ?? 0,
          title: attrs.label,
          url,
          order: order++,
          parentId: 0,
          target: attrs.opensInNewTab ? '_blank' : null,
        });
      }
    } catch {
      // skip malformed block attrs
    }
  }
  return items;
}

function normalizeMenuUrl(
  raw: string,
  siteUrl?: string | null,
  objectType?: string | null,
): string {
  if (!raw) return '';
  const trimmed = raw.trim();
  try {
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      const url = new URL(trimmed);
      if (siteUrl) {
        try {
          const site = new URL(siteUrl);
          if (url.origin !== site.origin) return trimmed;
        } catch {
          // invalid site URL — fall back to pathname rewrite
        }
      }
      raw = `${url.pathname}${url.search}${url.hash}`;
    } else {
      raw = trimmed;
    }
  } catch {
    // not a valid URL — treat as relative path
    raw = trimmed;
  }
  raw = raw.replace(/^\/pages\//, '/page/').replace(/^\/posts\//, '/post/');
  // Ensure local paths always start with / so React Router treats them as
  // absolute, not relative. A relative path like "page/slug" would be resolved
  // against the current URL — navigating from /page/x to page/slug would
  // produce /page/page/slug instead of /page/slug.
  if (
    raw &&
    !raw.startsWith('/') &&
    !raw.startsWith('#') &&
    !raw.startsWith('http://') &&
    !raw.startsWith('https://') &&
    !raw.startsWith('mailto:')
  ) {
    raw = '/' + raw;
  }
  return rewriteCanonicalMenuDetailPath(raw, objectType);
}

function rewriteCanonicalMenuDetailPath(
  raw: string,
  objectType?: string | null,
): string {
  const normalizedObjectType = String(objectType ?? '')
    .trim()
    .toLowerCase();
  if (normalizedObjectType !== 'page' && normalizedObjectType !== 'post') {
    return raw;
  }

  try {
    const parsed = new URL(raw, 'http://vp.local');
    const segments = parsed.pathname.split('/').filter(Boolean);
    const slug = segments.at(-1);
    if (!slug) return raw;

    const detailPrefix = normalizedObjectType === 'page' ? '/page/' : '/post/';
    return `${detailPrefix}${slug}${parsed.search}${parsed.hash}`;
  } catch {
    return raw;
  }
}

app.get('/api/menus', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [menus] = await conn.query<any[]>(
      `SELECT t.term_id, t.name, t.slug
       FROM \`${prefix}terms\` t
       INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_id = t.term_id
       WHERE tt.taxonomy = 'nav_menu'`,
    );

    const termToLocation = await queryNavMenuLocations(conn, prefix);

    const [[siteUrlRow]] = await conn.query<any[]>(
      `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'siteurl' LIMIT 1`,
    );
    const siteUrl = (siteUrlRow?.option_value as string | undefined) ?? null;

    const result = [];
    for (const menu of menus) {
      const [items] = await conn.query<any[]>(
        `SELECT p.ID, p.post_title, p.menu_order,
                url_meta.meta_value AS url,
                object_meta.meta_value AS object_type,
                parent_meta.meta_value AS parent_id,
                target_meta.meta_value AS target
         FROM \`${prefix}posts\` p
         INNER JOIN \`${prefix}term_relationships\` tr ON tr.object_id = p.ID
         INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
         LEFT JOIN \`${prefix}postmeta\` url_meta ON url_meta.post_id = p.ID AND url_meta.meta_key = '_menu_item_url'
         LEFT JOIN \`${prefix}postmeta\` object_meta ON object_meta.post_id = p.ID AND object_meta.meta_key = '_menu_item_object'
         LEFT JOIN \`${prefix}postmeta\` parent_meta ON parent_meta.post_id = p.ID AND parent_meta.meta_key = '_menu_item_menu_item_parent'
         LEFT JOIN \`${prefix}postmeta\` target_meta ON target_meta.post_id = p.ID AND target_meta.meta_key = '_menu_item_target'
         WHERE tt.term_id = ? AND p.post_type = 'nav_menu_item' AND p.post_status = 'publish'
         ORDER BY p.menu_order`,
        [menu.term_id],
      );
      result.push({
        name: menu.name,
        slug: menu.slug,
        location: termToLocation.get(menu.term_id) ?? null,
        items: items.map((i) => ({
          id: i.ID,
          title: i.post_title,
          url: normalizeMenuUrl(i.url ?? '', siteUrl, i.object_type ?? null),
          order: i.menu_order,
          parentId: parseInt(i.parent_id ?? '0', 10),
          target: i.target?.trim() ? i.target : null,
        })),
      });
    }
    // Also include FSE block-theme Navigation blocks (post_type = 'wp_navigation').
    // These are used by block themes instead of classic registered menus.
    const [wpNavPosts] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_name
       FROM \`${prefix}posts\` p
       WHERE p.post_type = 'wp_navigation' AND p.post_status = 'publish'
       ORDER BY p.ID`,
    );
    for (const navPost of wpNavPosts) {
      const items = parseNavigationBlockItems(
        navPost.post_content ?? '',
        siteUrl,
      );
      if (items.length > 0) {
        // FSE block themes use wp_navigation as the authoritative nav source.
        // If termToLocation is empty, no real WP nav_menu_locations are configured,
        // meaning any classic menu's 'primary' assignment was heuristic. Demote it
        // so the wp_navigation post becomes the primary menu instead.
        const existingPrimary = result.find((m) => m.location === 'primary');
        if (existingPrimary && termToLocation.size === 0) {
          existingPrimary.location = null;
        }
        result.push({
          name: navPost.post_title || navPost.post_name,
          slug: navPost.post_name as string,
          location: result.some((menu) => menu.location === 'primary')
            ? null
            : 'primary',
          items,
        });
      }
    }

    if (result.length === 0) {
      const [pages] = await conn.query<any[]>(
        `SELECT ID, post_title, post_name, menu_order FROM \`${prefix}posts\`
         WHERE post_type = 'page' AND post_status = 'publish'
         ORDER BY menu_order, ID`,
      );
      result.push({
        name: 'Primary',
        slug: 'primary',
        location: 'primary',
        items: pages.map((p, idx) => ({
          id: p.ID,
          title: p.post_title,
          url: `/page/${p.post_name}`,
          order: p.menu_order || idx,
          parentId: 0,
          target: null,
        })),
      });
    }

    res.json(result);
  } finally {
    await conn.end();
  }
});

// ── Taxonomy endpoints ─────────────────────────────────────────────────────

// List all taxonomy slugs that have published posts
app.get('/api/taxonomies', async (_req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [rows] = await conn.query<any[]>(
      `SELECT DISTINCT tt.taxonomy
       FROM \`${prefix}term_taxonomy\` tt
       INNER JOIN \`${prefix}term_relationships\` tr ON tr.term_taxonomy_id = tt.term_taxonomy_id
       INNER JOIN \`${prefix}posts\` p ON p.ID = tr.object_id
       WHERE p.post_status = 'publish'
         AND tt.taxonomy NOT IN ('nav_menu', 'link_category', 'post_format')
       ORDER BY tt.taxonomy`,
    );
    res.json(rows.map((r: any) => r.taxonomy));
  } finally {
    await conn.end();
  }
});

// Get terms for a specific taxonomy (e.g. category, post_tag, product_cat)
app.get('/api/taxonomies/:taxonomy', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [rows] = await conn.query<any[]>(
      `SELECT t.term_id, t.name, t.slug, tt.description, tt.count, tt.parent
       FROM \`${prefix}terms\` t
       INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_id = t.term_id
       WHERE tt.taxonomy = ? AND tt.count > 0
       ORDER BY tt.count DESC, t.name ASC`,
      [req.params.taxonomy],
    );
    res.json(
      rows.map((r: any) => ({
        id: r.term_id,
        name: r.name,
        slug: r.slug,
        description: r.description ?? '',
        count: r.count,
        parentId: r.parent ?? 0,
      })),
    );
  } finally {
    await conn.end();
  }
});

// Get published posts filtered by taxonomy + term slug
app.get('/api/taxonomies/:taxonomy/:term/posts', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const { page, perPage, offset } = parsePostsPaginationQuery(req);
    const [[countRow]] = await conn.query<any[]>(
      `SELECT COUNT(*) AS total
       FROM \`${prefix}posts\` p
       INNER JOIN \`${prefix}term_relationships\` tr ON tr.object_id = p.ID
       INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
       INNER JOIN \`${prefix}terms\` t ON t.term_id = tt.term_id
       WHERE tt.taxonomy = ? AND t.slug = ? AND p.post_status = 'publish'`,
      [req.params.taxonomy, req.params.term],
    );
    applyPostsPaginationHeaders(
      res,
      Number(countRow?.total ?? 0),
      page,
      perPage,
    );
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name,
              p.post_type, p.post_status, p.post_date,
              u.display_name AS author_name,
              u.user_nicename AS author_slug,
              img.guid AS featured_image,
              ${taxonomyNamesSubquery(prefix, 'category')} AS categories,
              ${taxonomySlugsSubquery(prefix, 'category')} AS category_slugs,
              ${taxonomyNamesSubquery(prefix, 'post_tag')} AS tags
       FROM \`${prefix}posts\` p
       INNER JOIN \`${prefix}term_relationships\` tr ON tr.object_id = p.ID
       INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
       INNER JOIN \`${prefix}terms\` t ON t.term_id = tt.term_id
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       LEFT JOIN \`${prefix}users\` u ON u.ID = p.post_author
       WHERE tt.taxonomy = ? AND t.slug = ? AND p.post_status = 'publish'
       ORDER BY p.post_date DESC
       LIMIT ? OFFSET ?`,
      [req.params.taxonomy, req.params.term, perPage, offset],
    );
    res.json(await serializePostRows(conn, prefix, rows));
  } finally {
    await conn.end();
  }
});

// ── Comments endpoint ──────────────────────────────────────────────────────

// Get approved comments for a post — supports ?postId=<id> or ?slug=<post-slug>
app.get('/api/comments', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const postId = await resolvePostId(conn, prefix, {
      postId: req.query.postId,
      slug: req.query.slug,
    });

    if (!postId) {
      return res
        .status(400)
        .json({ error: 'postId or slug query param required' });
    }

    const [rows] = await conn.query<any[]>(
      `SELECT c.comment_ID, c.comment_author, c.comment_date,
              c.comment_content, c.comment_parent, c.user_id
       FROM \`${prefix}comments\` c
       WHERE c.comment_post_ID = ? AND c.comment_approved = '1'
       ORDER BY c.comment_date ASC`,
      [postId],
    );
    res.json(
      rows.map((r: any) => ({
        id: r.comment_ID,
        author: r.comment_author,
        date: formatDate(r.comment_date),
        content: r.comment_content,
        parentId: r.comment_parent ?? 0,
        userId: r.user_id ?? 0,
      })),
    );
  } finally {
    await conn.end();
  }
});

// Get tracked comment submissions for a post and client token so the React app
// can poll moderation status after a comment is submitted.
app.get('/api/comments/submissions', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const clientToken =
      typeof req.query.clientToken === 'string'
        ? req.query.clientToken.trim().substring(0, 120)
        : '';

    if (!clientToken) {
      return res
        .status(400)
        .json({ error: 'clientToken query param required' });
    }

    const postId = await resolvePostId(conn, prefix, {
      postId: req.query.postId,
      slug: req.query.slug,
    });
    if (!postId) {
      return res
        .status(400)
        .json({ error: 'postId or slug query param required' });
    }

    const [rows] = await conn.query<any[]>(
      `SELECT c.comment_ID, c.comment_author, c.comment_date,
              c.comment_content, c.comment_parent, c.user_id, c.comment_approved
       FROM \`${prefix}comments\` c
       INNER JOIN \`${prefix}commentmeta\` cm
         ON cm.comment_id = c.comment_ID
        AND cm.meta_key = '_vibepress_client_token'
        AND cm.meta_value = ?
       WHERE c.comment_post_ID = ?
       ORDER BY c.comment_date DESC`,
      [clientToken, postId],
    );

    res.json(
      rows.map((r: any) => ({
        id: r.comment_ID,
        author: r.comment_author,
        date: formatDate(r.comment_date),
        content: r.comment_content,
        parentId: r.comment_parent ?? 0,
        userId: r.user_id ?? 0,
        moderationStatus: normalizeCommentModerationStatus(r.comment_approved),
      })),
    );
  } finally {
    await conn.end();
  }
});

// Submit a new comment for a post
// Body: { postId?: number, slug?: string, author: string, email: string, content: string, website?: string, parentId?: number, clientToken?: string }
app.post('/api/comments', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const {
      author,
      email,
      content,
      website = '',
      parentId = 0,
    } = req.body ?? {};
    const clientToken =
      typeof req.body?.clientToken === 'string'
        ? req.body.clientToken.trim().substring(0, 120)
        : '';

    // Validate required fields
    if (!author || typeof author !== 'string' || !author.trim()) {
      return res.status(400).json({ error: 'author is required' });
    }
    if (
      !email ||
      typeof email !== 'string' ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
    ) {
      return res.status(400).json({ error: 'valid email is required' });
    }
    if (!content || typeof content !== 'string' || !content.trim()) {
      return res.status(400).json({ error: 'content is required' });
    }

    // Resolve postId from body or slug
    const postId = await resolvePostId(conn, prefix, {
      postId: req.body?.postId,
      slug: req.body?.slug,
    });
    if (!postId) {
      return res.status(400).json({ error: 'postId or slug is required' });
    }

    // Verify the post actually exists, is published, and accepts comments.
    const [postRows] = await conn.query<any[]>(
      `SELECT ID, comment_status
       FROM \`${prefix}posts\`
       WHERE ID = ? AND post_status = 'publish'
       LIMIT 1`,
      [postId],
    );
    if (!postRows.length) {
      return res.status(404).json({ error: 'post not found' });
    }
    if (String(postRows[0]?.comment_status ?? '').trim() !== 'open') {
      return res
        .status(403)
        .json({ error: 'comments are closed for this post' });
    }

    const now = new Date();
    // New comments enter WordPress moderation first. Approved comments become
    // visible later through GET /api/comments and polling via /api/comments/submissions.
    const [result] = await conn.query<any>(
      `INSERT INTO \`${prefix}comments\`
         (comment_post_ID, comment_author, comment_author_email, comment_author_url,
          comment_content, comment_date, comment_date_gmt, comment_approved,
          comment_parent, comment_type, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, '0', ?, 'comment', 0)`,
      [
        postId,
        author.trim().substring(0, 245),
        email.trim().substring(0, 100),
        typeof website === 'string' ? website.trim().substring(0, 200) : '',
        content.trim(),
        now,
        now,
        Number(parentId) || 0,
      ],
    );

    const commentId = result.insertId;

    if (clientToken) {
      await conn.query(
        `INSERT INTO \`${prefix}commentmeta\`
           (comment_id, meta_key, meta_value)
         VALUES (?, '_vibepress_client_token', ?)`,
        [commentId, clientToken],
      );
    }

    res.status(202).json({
      id: commentId,
      author: author.trim(),
      date: formatDate(now.toISOString()),
      content: content.trim(),
      parentId: Number(parentId) || 0,
      userId: 0,
      moderationStatus: 'pending',
      tracked: Boolean(clientToken),
    });
  } finally {
    await conn.end();
  }
});

// Parse wp_template_part 'footer' block content into structured columns.
// Extracts <!-- wp:heading --> + <!-- wp:navigation-link --> sequences.
function parseFooterBlocks(
  content: string,
  siteUrl?: string | null,
): Array<{ heading: string; links: Array<{ label: string; url: string }> }> {
  const columns: Array<{
    heading: string;
    links: Array<{ label: string; url: string }>;
  }> = [];
  const parts = content.split(/(?=<!--\s*wp:heading)/);
  for (const part of parts) {
    const headingMatch =
      /<!--\s*wp:heading[^>]*-->\s*<[^>]+>([^<]+)<\/[^>]+>/.exec(part);
    if (!headingMatch) continue;
    const heading = headingMatch[1].trim();
    const links: Array<{ label: string; url: string }> = [];
    let m: RegExpExecArray | null;
    const re = /<!--\s*wp:navigation-link\s+(\{[^}]+\})/g;
    while ((m = re.exec(part)) !== null) {
      try {
        const attrs = JSON.parse(m[1]);
        if (attrs.label) {
          const url = normalizeMenuUrl(attrs.url ?? '', siteUrl);
          links.push({ label: attrs.label, url: url || '#' });
        }
      } catch {
        /* skip malformed */
      }
    }
    if (links.length > 0) columns.push({ heading, links });
  }
  return columns;
}

app.get('/api/footer-links', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [[siteUrlRow]] = await conn.query<any[]>(
      `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'siteurl' LIMIT 1`,
    );
    const siteUrl = (siteUrlRow?.option_value as string | undefined) ?? null;
    const [[row]] = await conn.query<any[]>(
      `SELECT post_content FROM \`${prefix}posts\`
       WHERE post_type = 'wp_template_part' AND post_name = 'footer' AND post_status = 'publish' LIMIT 1`,
    );
    if (!row?.post_content) return res.json([]);
    res.json(parseFooterBlocks(row.post_content, siteUrl));
  } finally {
    await conn.end();
  }
});

app.listen(PORT, () =>
  console.log(`API server running on http://localhost:${PORT}`),
);
