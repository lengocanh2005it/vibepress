"use strict";

const mysql = require("mysql2/promise");
const path  = require("path");
const fs    = require("fs");

const { stripHtml, normalizeContent } = require("./textUtils");

const DB_FILE = path.join(__dirname, "..", "db.json");

// ─── DB CONNECTION ────────────────────────────────────────────────────────────

/**
 * Đọc DB info từ db.json (lấy site đầu tiên)
 * hoặc truyền thẳng dbInfo object / siteId vào
 */
function resolveDbInfo(dbInfoOrSiteId) {
  if (dbInfoOrSiteId && typeof dbInfoOrSiteId === "object") {
    return dbInfoOrSiteId;
  }

  if (!fs.existsSync(DB_FILE)) {
    throw new Error("db.json not found — plugin chưa register?");
  }

  const db    = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  const sites = Object.values(db.wpSites ?? {});

  if (!sites.length) throw new Error("Không có site nào trong db.json");

  const site = dbInfoOrSiteId
    ? sites.find((s) => s.siteId === dbInfoOrSiteId)
    : sites[0];

  if (!site) throw new Error(`Site không tìm thấy: ${dbInfoOrSiteId}`);

  return site.dbInfo;
}

async function getConn(dbInfo) {
  const [rawHost, portStr] = String(dbInfo.db_host).split(":");
  // "db" là Docker-internal hostname — remap về localhost khi chạy ngoài container.
  // Override qua env DB_HOST nếu cần.
  const host = process.env.DB_HOST
    || (rawHost === "db" ? "localhost" : rawHost)
    || "localhost";
  return mysql.createConnection({
    host,
    port:     Number(portStr || dbInfo.db_port || 3306),
    user:     dbInfo.db_user,
    password: dbInfo.db_password,
    database: dbInfo.db_name,
    charset:  dbInfo.db_charset || "utf8mb4",
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
 * @param {object|string} dbInfoOrSiteId
 * @param {object}   [opts]
 * @param {string[]} [opts.postTypes]  - giới hạn post types (mặc định tự detect)
 * @param {number}   [opts.limit]      - giới hạn số bài mỗi type (mặc định không giới hạn)
 */
async function fetchAllWpContent(dbInfoOrSiteId, { postTypes, limit } = {}) {
  const dbInfo = resolveDbInfo(dbInfoOrSiteId);
  const conn   = await getConn(dbInfo);
  const prefix = dbInfo.db_prefix || "wp_";

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
