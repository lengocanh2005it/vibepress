import express from 'express';
import cors from 'cors';
import { createConnection } from 'mysql2/promise';
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(process.cwd(), '.env'), override: true });

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.API_PORT) || 3100;

function formatDate(mysqlDate: string | Date | null): string {
  if (!mysqlDate) return '';
  const d = new Date(mysqlDate);
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
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
    return logoUrl?.trim() ? logoUrl : null;
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
        (await resolveCustomLogoUrl(conn, prefix)),
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
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name, p.post_type, p.post_status,
              p.post_date,
              u.display_name AS author_name,
              img.guid AS featured_image,
              (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ', ')
               FROM \`${prefix}term_relationships\` tr2
               INNER JOIN \`${prefix}term_taxonomy\` tt2 ON tt2.term_taxonomy_id = tr2.term_taxonomy_id
               INNER JOIN \`${prefix}terms\` t ON t.term_id = tt2.term_id
               WHERE tt2.taxonomy = 'category' AND tr2.object_id = p.ID) AS categories
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       LEFT JOIN \`${prefix}users\` u ON u.ID = p.post_author
       WHERE p.post_type = 'post' AND p.post_status = 'publish'
       ORDER BY p.post_date DESC`,
    );
    res.json(
      rows.map((r) => ({
        id: r.ID,
        title: r.post_title,
        content: r.post_content,
        excerpt: r.post_excerpt,
        slug: r.post_name,
        type: r.post_type,
        status: r.post_status,
        date: formatDate(r.post_date),
        author: r.author_name ?? '',
        categories: r.categories ? r.categories.split(', ') : [],
        featuredImage: r.featured_image ?? null,
      })),
    );
  } finally {
    await conn.end();
  }
});

app.get('/api/posts/:slug', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name, p.post_type, p.post_status,
              p.post_date,
              u.display_name AS author_name,
              img.guid AS featured_image,
              (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ', ')
               FROM \`${prefix}term_relationships\` tr2
               INNER JOIN \`${prefix}term_taxonomy\` tt2 ON tt2.term_taxonomy_id = tr2.term_taxonomy_id
               INNER JOIN \`${prefix}terms\` t ON t.term_id = tt2.term_id
               WHERE tt2.taxonomy = 'category' AND tr2.object_id = p.ID) AS categories
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       LEFT JOIN \`${prefix}users\` u ON u.ID = p.post_author
       WHERE p.post_name = ? AND p.post_status = 'publish' LIMIT 1`,
      [req.params.slug],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    res.json({
      id: r.ID,
      title: r.post_title,
      content: r.post_content,
      excerpt: r.post_excerpt,
      slug: r.post_name,
      type: r.post_type,
      status: r.post_status,
      date: formatDate(r.post_date),
      author: r.author_name ?? '',
      categories: r.categories ? r.categories.split(', ') : [],
      featuredImage: r.featured_image ?? null,
    });
  } finally {
    await conn.end();
  }
});

app.get('/api/pages/:slug', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_name, p.menu_order,
              COALESCE(pm.meta_value, '') AS template
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` pm ON pm.post_id = p.ID AND pm.meta_key = '_wp_page_template'
       WHERE p.post_type = 'page' AND p.post_status = 'publish' AND p.post_name = ? LIMIT 1`,
      [req.params.slug],
    );
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const r = rows[0];
    res.json({
      id: r.ID,
      title: r.post_title,
      content: r.post_content,
      slug: r.post_name,
      menuOrder: r.menu_order,
      template: r.template,
    });
  } finally {
    await conn.end();
  }
});

app.get('/api/pages', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_name, p.menu_order,
              COALESCE(pm.meta_value, '') AS template
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` pm ON pm.post_id = p.ID AND pm.meta_key = '_wp_page_template'
       WHERE p.post_type = 'page' AND p.post_status = 'publish'
       ORDER BY p.menu_order`,
    );
    res.json(
      rows.map((r) => ({
        id: r.ID,
        title: r.post_title,
        content: r.post_content,
        slug: r.post_name,
        menuOrder: r.menu_order,
        template: r.template,
      })),
    );
  } finally {
    await conn.end();
  }
});

// Normalize a WordPress URL to a React Router path.
// Strips host, converts /pages/ → /page/ and /posts/ → /post/.
// External URLs (different origin) are kept as-is.
/**
 * Parse PHP serialized nav_menu_locations option.
 * Format: a:N:{s:len:"locationSlug";i:termId;...}
 * Returns Map<termId, locationSlug> — only entries where termId > 0.
 */
function parseNavMenuLocations(serialized: string): Map<number, string> {
  const termToLocation = new Map<number, string>();
  const pattern = /s:\d+:"([^"]+)";i:(\d+);/g;
  let match;
  while ((match = pattern.exec(serialized)) !== null) {
    const termId = parseInt(match[2], 10);
    if (termId > 0) termToLocation.set(termId, match[1]);
  }
  return termToLocation;
}

/**
 * Parse wp:navigation-link blocks from a wp_navigation post's content.
 * Handles both self-closing and block-with-children forms.
 */
function parseNavigationBlockItems(
  content: string,
): { id: number; title: string; url: string; order: number; parentId: number }[] {
  const items: { id: number; title: string; url: string; order: number; parentId: number }[] = [];
  const pattern = /<!--\s*wp:navigation-link\s+(\{[^}]*\})\s*(?:\/-->|-->)/g;
  let match;
  let order = 0;
  while ((match = pattern.exec(content)) !== null) {
    try {
      const attrs = JSON.parse(match[1]) as {
        label?: string;
        url?: string;
        id?: number;
      };
      const url = normalizeMenuUrl(attrs.url ?? '');
      if (attrs.label && url) {
        items.push({
          id: attrs.id ?? 0,
          title: attrs.label,
          url,
          order: order++,
          parentId: 0,
        });
      }
    } catch {
      // skip malformed block attrs
    }
  }
  return items;
}

function normalizeMenuUrl(raw: string): string {
  if (!raw) return '';
  try {
    // If it's an absolute URL, extract the pathname
    if (raw.startsWith('http://') || raw.startsWith('https://')) {
      const u = new URL(raw);
      raw = u.pathname;
    }
  } catch {
    // not a valid URL — treat as relative path
  }
  return raw
    .replace(/^\/pages\//, '/page/')
    .replace(/^\/posts\//, '/post/');
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
    // Fallback: no nav menus registered → return published pages as "primary" menu
    if (menus.length === 0) {
      const [pages] = await conn.query<any[]>(
        `SELECT ID, post_title, post_name, menu_order FROM \`${prefix}posts\`
         WHERE post_type = 'page' AND post_status = 'publish'
         ORDER BY menu_order, ID`,
      );
      return res.json([
        {
          name: 'Primary',
          slug: 'primary',
          items: pages.map((p, idx) => ({
            id: p.ID,
            title: p.post_title,
            url: `/page/${p.post_name}`,
            order: p.menu_order || idx,
            parentId: 0,
          })),
        },
      ]);
    }

    // Resolve theme location assignments: termId → locationSlug
    let termToLocation = new Map<number, string>();
    const [locRows] = await conn.query<any[]>(
      `SELECT option_value FROM \`${prefix}options\` WHERE option_name = 'nav_menu_locations' LIMIT 1`,
    );
    if (locRows.length > 0 && locRows[0].option_value) {
      termToLocation = parseNavMenuLocations(locRows[0].option_value as string);
    }

    const result = [];
    for (const menu of menus) {
      const [items] = await conn.query<any[]>(
        `SELECT p.ID, p.post_title, p.menu_order,
                url_meta.meta_value AS url,
                parent_meta.meta_value AS parent_id
         FROM \`${prefix}posts\` p
         INNER JOIN \`${prefix}term_relationships\` tr ON tr.object_id = p.ID
         INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
         LEFT JOIN \`${prefix}postmeta\` url_meta ON url_meta.post_id = p.ID AND url_meta.meta_key = '_menu_item_url'
         LEFT JOIN \`${prefix}postmeta\` parent_meta ON parent_meta.post_id = p.ID AND parent_meta.meta_key = '_menu_item_menu_item_parent'
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
          url: normalizeMenuUrl(i.url ?? ''),
          order: i.menu_order,
          parentId: parseInt(i.parent_id ?? '0', 10),
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
      const items = parseNavigationBlockItems(navPost.post_content ?? '');
      if (items.length > 0) {
        result.push({
          name: navPost.post_title || navPost.post_name,
          slug: navPost.post_name as string,
          location: null,
          items,
        });
      }
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
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name,
              p.post_type, p.post_status, p.post_date,
              u.display_name AS author_name,
              img.guid AS featured_image
       FROM \`${prefix}posts\` p
       INNER JOIN \`${prefix}term_relationships\` tr ON tr.object_id = p.ID
       INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
       INNER JOIN \`${prefix}terms\` t ON t.term_id = tt.term_id
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       LEFT JOIN \`${prefix}users\` u ON u.ID = p.post_author
       WHERE tt.taxonomy = ? AND t.slug = ? AND p.post_status = 'publish'
       ORDER BY p.post_date DESC`,
      [req.params.taxonomy, req.params.term],
    );
    res.json(
      rows.map((r: any) => ({
        id: r.ID,
        title: r.post_title,
        content: r.post_content,
        excerpt: r.post_excerpt,
        slug: r.post_name,
        type: r.post_type,
        status: r.post_status,
        date: formatDate(r.post_date),
        author: r.author_name ?? '',
        featuredImage: r.featured_image ?? null,
      })),
    );
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
      return res.status(400).json({ error: 'postId or slug query param required' });
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
      return res.status(400).json({ error: 'clientToken query param required' });
    }

    const postId = await resolvePostId(conn, prefix, {
      postId: req.query.postId,
      slug: req.query.slug,
    });
    if (!postId) {
      return res.status(400).json({ error: 'postId or slug query param required' });
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
    const { author, email, content, website = '', parentId = 0 } = req.body ?? {};
    const clientToken =
      typeof req.body?.clientToken === 'string'
        ? req.body.clientToken.trim().substring(0, 120)
        : '';

    // Validate required fields
    if (!author || typeof author !== 'string' || !author.trim()) {
      return res.status(400).json({ error: 'author is required' });
    }
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
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
      return res.status(403).json({ error: 'comments are closed for this post' });
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

app.listen(PORT, () =>
  console.log(`API server running on http://localhost:${PORT}`),
);
