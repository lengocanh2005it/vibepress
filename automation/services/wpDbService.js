"use strict";

const mysql = require("mysql2/promise");

const { stripHtml, normalizeContent } = require("./textUtils");
const db = require("../db/mysql");

// ─── DB CONNECTION ────────────────────────────────────────────────────────────

/**
 * Lấy cloned_db info từ bảng wp_sites theo site_id
 * hoặc dùng thẳng object nếu đã có sẵn
 */
async function resolveDbInfo(wpSiteId) {
  if (!wpSiteId) {
    throw new Error("Cần truyền siteId để lấy thông tin DB");
  }

  const site = await db.queryOne(
    "SELECT cloned_db FROM wp_sites WHERE site_id = ?",
    [wpSiteId]
  );

  if (!site) throw new Error(`Site không tìm thấy: ${wpSiteId}`);
  if (!site.cloned_db) throw new Error(`Site ${wpSiteId} chưa có cloned_db`);

  const clonedDb = typeof site.cloned_db === "string"
    ? JSON.parse(site.cloned_db)
    : site.cloned_db;

  return clonedDb;
}

async function getConn(dbInfo) {
  const uri = new URL(dbInfo.connectionString);
  return mysql.createConnection({
    host:     process.env.DB_HOST || uri.hostname,
    port:     Number(uri.port || 3306),
    user:     uri.username,
    password: uri.password,
    database: uri.pathname.slice(1),
    charset:  "utf8mb4",
  });
}

// ─── INTERNAL HELPERS ────────────────────────────────────────────────────────

/**
 * Lấy tất cả post_type có bài publish, loại bỏ các internal type của WP
 */
async function discoverPostTypes(conn, prefix) {
  const [rows] = await conn.query(
    `SELECT DISTINCT post_type
     FROM \`${prefix}posts\`
     WHERE post_status = 'publish'
       AND post_type NOT IN (
         'attachment','revision','nav_menu_item','wp_block',
         'wp_template','wp_template_part','wp_global_styles',
         'wp_navigation','wp_font_family','wp_font_face'
       )
     ORDER BY post_type`
  );
  return rows.map((r) => r.post_type);
}

function normalizeDbItem(row) {
  return {
    id:          row.id,
    slug:        row.slug,
    type:        row.type,
    titleText:   stripHtml(row.title ?? ""),
    contentText: normalizeContent(row.content ?? ""),
    date:        row.date     ? new Date(row.date).toISOString()     : null,
    modified:    row.modified ? new Date(row.modified).toISOString() : null,
    categories:  row.categories ? row.categories.split(",") : [],
  };
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Lấy toàn bộ nội dung từ WP DB theo từng post type
 *
 * @param {object|string} wpSiteId
 * @param {object}   [opts]
 * @param {string[]} [opts.postTypes]  - giới hạn post types (mặc định tự detect)
 * @param {number}   [opts.limit]      - giới hạn số bài mỗi type (mặc định không giới hạn)
 */
async function fetchAllWpContent(wpSiteId, { postTypes, limit } = {}) {
  const dbInfo = await resolveDbInfo(wpSiteId);
  const conn   = await getConn(dbInfo);
  const prefix = "wp_";

  try {
    const types = postTypes ?? await discoverPostTypes(conn, prefix);
    console.log(`✅ WP DB: detected types → ${types.join(", ")}`);

    const results = [];

    for (const postType of types) {
      const [rows] = await conn.query(
        `SELECT
           p.ID            AS id,
           p.post_title    AS title,
           p.post_content  AS content,
           p.post_excerpt  AS excerpt,
           p.post_name     AS slug,
           p.post_type     AS type,
           p.post_date     AS date,
           p.post_modified AS modified,
           (SELECT GROUP_CONCAT(t.name ORDER BY t.name SEPARATOR ',')
            FROM \`${prefix}term_relationships\` tr
            INNER JOIN \`${prefix}term_taxonomy\` tt ON tt.term_taxonomy_id = tr.term_taxonomy_id
            INNER JOIN \`${prefix}terms\` t ON t.term_id = tt.term_id
            WHERE tt.taxonomy = 'category' AND tr.object_id = p.ID
           ) AS categories
         FROM \`${prefix}posts\` p
         WHERE p.post_type = ? AND p.post_status = 'publish'
         ORDER BY p.post_date DESC
         ${limit ? "LIMIT ?" : ""}`,
        limit ? [postType, limit] : [postType]
      );

      results.push(...rows.map(normalizeDbItem));
      console.log(`   [${postType}] ${rows.length} items`);
    }

    console.log(`✅ WP DB total: ${results.length} items`);
    return results;

  } finally {
    await conn.end();
  }
}

module.exports = { fetchAllWpContent };
