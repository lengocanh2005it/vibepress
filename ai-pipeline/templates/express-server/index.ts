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

function parseSerializedPhpStringArray(serialized: string): string[] {
  if (!serialized) return [];
  const result: string[] = [];
  const regex = /s:\d+:"([^"]+)";/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(serialized)) !== null) {
    result.push(match[1]);
  }
  return result;
}

async function getStoreCapabilities(
  conn: Awaited<ReturnType<typeof getConn>>,
  prefix: string,
) {
  const [optionRows] = await conn.query<any[]>(
    `SELECT option_name, option_value FROM \`${prefix}options\`
     WHERE option_name IN ('active_plugins', 'woocommerce_db_version')`,
  );
  const optionMap = new Map<string, string>();
  for (const row of optionRows) {
    optionMap.set(row.option_name, row.option_value ?? '');
  }

  const activePlugins = parseSerializedPhpStringArray(
    optionMap.get('active_plugins') ?? '',
  );

  const [productRows] = await conn.query<any[]>(
    `SELECT COUNT(*) AS total
     FROM \`${prefix}posts\`
     WHERE post_type = 'product' AND post_status IN ('publish', 'private')`,
  );
  const [productCategoryRows] = await conn.query<any[]>(
    `SELECT COUNT(*) AS total
     FROM \`${prefix}term_taxonomy\`
     WHERE taxonomy = 'product_cat'`,
  );
  const [corePageRows] = await conn.query<any[]>(
    `SELECT post_name
     FROM \`${prefix}posts\`
     WHERE post_type = 'page'
       AND post_status IN ('publish', 'private')
       AND post_name IN ('shop', 'cart', 'checkout', 'my-account')`,
  );

  const hasWooCommerce =
    activePlugins.some((pluginFile) => pluginFile.startsWith('woocommerce/')) ||
    !!optionMap.get('woocommerce_db_version') ||
    Number(productRows[0]?.total ?? 0) > 0 ||
    Number(productCategoryRows[0]?.total ?? 0) > 0 ||
    corePageRows.length > 0;

  return {
    wooCommerce: hasWooCommerce,
    activePlugins,
    productsCount: Number(productRows[0]?.total ?? 0),
    productCategoriesCount: Number(productCategoryRows[0]?.total ?? 0),
    corePages: corePageRows.map((row) => String(row.post_name)),
  };
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

app.get('/api/store/capabilities', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    res.json(await getStoreCapabilities(conn, prefix));
  } finally {
    await conn.end();
  }
});

app.get('/api/products', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name, p.post_status,
              p.post_date,
              sku.meta_value AS sku,
              price.meta_value AS price,
              regular_price.meta_value AS regular_price,
              sale_price.meta_value AS sale_price,
              img.guid AS featured_image,
              (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ', ')
               FROM \`${prefix}term_relationships\` tr2
               INNER JOIN \`${prefix}term_taxonomy\` tt2 ON tt2.term_taxonomy_id = tr2.term_taxonomy_id
               INNER JOIN \`${prefix}terms\` t ON t.term_id = tt2.term_id
               WHERE tt2.taxonomy = 'product_cat' AND tr2.object_id = p.ID) AS categories
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` sku ON sku.post_id = p.ID AND sku.meta_key = '_sku'
       LEFT JOIN \`${prefix}postmeta\` price ON price.post_id = p.ID AND price.meta_key = '_price'
       LEFT JOIN \`${prefix}postmeta\` regular_price ON regular_price.post_id = p.ID AND regular_price.meta_key = '_regular_price'
       LEFT JOIN \`${prefix}postmeta\` sale_price ON sale_price.post_id = p.ID AND sale_price.meta_key = '_sale_price'
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       WHERE p.post_type = 'product' AND p.post_status IN ('publish', 'private')
       ORDER BY p.menu_order ASC, p.post_date DESC`,
    );
    res.json(
      rows.map((r) => ({
        id: r.ID,
        title: r.post_title,
        content: r.post_content,
        excerpt: r.post_excerpt,
        slug: r.post_name,
        status: r.post_status,
        date: formatDate(r.post_date),
        sku: r.sku ?? '',
        price: r.price ?? null,
        regularPrice: r.regular_price ?? null,
        salePrice: r.sale_price ?? null,
        featuredImage: r.featured_image ?? null,
        categories: r.categories ? r.categories.split(', ') : [],
      })),
    );
  } finally {
    await conn.end();
  }
});

app.get('/api/products/:slug', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [rows] = await conn.query<any[]>(
      `SELECT p.ID, p.post_title, p.post_content, p.post_excerpt, p.post_name, p.post_status,
              p.post_date,
              sku.meta_value AS sku,
              price.meta_value AS price,
              regular_price.meta_value AS regular_price,
              sale_price.meta_value AS sale_price,
              img.guid AS featured_image,
              (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ', ')
               FROM \`${prefix}term_relationships\` tr2
               INNER JOIN \`${prefix}term_taxonomy\` tt2 ON tt2.term_taxonomy_id = tr2.term_taxonomy_id
               INNER JOIN \`${prefix}terms\` t ON t.term_id = tt2.term_id
               WHERE tt2.taxonomy = 'product_cat' AND tr2.object_id = p.ID) AS categories
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` sku ON sku.post_id = p.ID AND sku.meta_key = '_sku'
       LEFT JOIN \`${prefix}postmeta\` price ON price.post_id = p.ID AND price.meta_key = '_price'
       LEFT JOIN \`${prefix}postmeta\` regular_price ON regular_price.post_id = p.ID AND regular_price.meta_key = '_regular_price'
       LEFT JOIN \`${prefix}postmeta\` sale_price ON sale_price.post_id = p.ID AND sale_price.meta_key = '_sale_price'
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       WHERE p.post_type = 'product'
         AND p.post_status IN ('publish', 'private')
         AND p.post_name = ?
       LIMIT 1`,
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
      status: r.post_status,
      date: formatDate(r.post_date),
      sku: r.sku ?? '',
      price: r.price ?? null,
      regularPrice: r.regular_price ?? null,
      salePrice: r.sale_price ?? null,
      featuredImage: r.featured_image ?? null,
      categories: r.categories ? r.categories.split(', ') : [],
    });
  } finally {
    await conn.end();
  }
});

app.get('/api/product-categories', async (req, res) => {
  const conn = await getConn();
  try {
    const prefix = await getPrefix(conn);
    const [rows] = await conn.query<any[]>(
      `SELECT t.term_id, t.name, t.slug, tt.description, tt.parent, tt.count
       FROM \`${prefix}terms\` t
       INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_id = t.term_id
       WHERE tt.taxonomy = 'product_cat'
       ORDER BY tt.count DESC, t.name ASC`,
    );
    res.json(
      rows.map((row) => ({
        id: row.term_id,
        name: row.name,
        slug: row.slug,
        description: row.description ?? '',
        parentId: row.parent ?? 0,
        count: row.count ?? 0,
      })),
    );
  } finally {
    await conn.end();
  }
});

// Normalize a WordPress URL to a React Router path.
// Strips host, converts /pages/ → /page/ and /posts/ → /post/.
// External URLs (different origin) are kept as-is.
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
        items: items.map((i) => ({
          id: i.ID,
          title: i.post_title,
          url: normalizeMenuUrl(i.url ?? ''),
          order: i.menu_order,
          parentId: parseInt(i.parent_id ?? '0', 10),
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
    let postId: number | null = null;

    if (req.query.postId) {
      postId = Number(req.query.postId);
    } else if (req.query.slug) {
      const [slugRows] = await conn.query<any[]>(
        `SELECT ID FROM \`${prefix}posts\`
         WHERE post_name = ? AND post_status = 'publish' LIMIT 1`,
        [req.query.slug],
      );
      postId = slugRows[0]?.ID ?? null;
    }

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

app.listen(PORT, () =>
  console.log(`API server running on http://localhost:${PORT}`),
);
