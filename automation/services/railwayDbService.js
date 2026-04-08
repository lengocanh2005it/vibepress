const mysql = require('mysql2/promise');
const fs    = require('fs');
const { RAILWAY_DB } = require('../config/constants');

/**
 * Tạo connection tới Railway MySQL (không chỉ định database).
 */
async function getConnection() {
  return mysql.createConnection({
    host:               RAILWAY_DB.host,
    port:               RAILWAY_DB.port,
    user:               RAILWAY_DB.user,
    password:           RAILWAY_DB.password,
    multipleStatements: true,
  });
}

/**
 * Tạo database mới cho 1 site và import SQL dump vào.
 * Trả về connection string để lưu vào db.json.
 *
 * @param {string} siteId   — vd: "wp-1775531502178-9cbda082"
 * @param {string} dumpPath — đường dẫn file .sql
 */
async function createSiteDatabase(siteId, dumpPath) {
  const dbName = `site_${siteId.replace(/-/g, '_')}`;
  const conn   = await getConnection();

  try {
    // Tắt strict mode để tương thích với WordPress (0000-00-00 dates, v.v.)
    await conn.query(`SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';`);

    // Tạo database
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await conn.query(`USE \`${dbName}\`;`);

    // Import dump
    const sql = fs.readFileSync(dumpPath, 'utf8');
    await conn.query(sql);

    // Đếm tables và tổng rows
    const [tables] = await conn.query(`SHOW TABLES;`);
    const tableCount = tables.length;

    let totalRows = 0;
    for (const row of tables) {
      const tableName = Object.values(row)[0];
      const [[{ count }]] = await conn.query(
        `SELECT COUNT(*) AS count FROM \`${tableName}\`;`
      );
      totalRows += Number(count);
    }

    const connectionString = `mysql://${RAILWAY_DB.user}:${RAILWAY_DB.password}@${RAILWAY_DB.host}:${RAILWAY_DB.port}/${dbName}`;

    return {
      dbName,
      host:             RAILWAY_DB.host,
      port:             RAILWAY_DB.port,
      user:             RAILWAY_DB.user,
      password:         RAILWAY_DB.password,
      connectionString,
      tables:           tableCount,
      totalRows,
      createdAt:        new Date().toISOString(),
    };
  } finally {
    await conn.end();
  }
}

/**
 * Xóa database của 1 site (dùng khi reset).
 */
async function dropSiteDatabase(siteId) {
  const dbName = `site_${siteId.replace(/-/g, '_')}`;
  const conn   = await getConnection();
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
  } finally {
    await conn.end();
  }
}

/**
 * Sync incremental data cho 1 post vào Railway DB.
 * Nhận data từ plugin endpoint /wp-json/vibepress/v1/post-data
 * rồi REPLACE INTO các bảng wp_posts, wp_postmeta, wp_term_relationships.
 *
 * @param {string} siteId
 * @param {{ posts, postmeta, term_relationships }} postData
 */
async function syncPostToRailway(siteId, postData) {
  const dbName = `site_${siteId.replace(/-/g, '_')}`;
  const conn   = await getConnection();

  try {
    await conn.query(`USE \`${dbName}\`;`);
    await conn.query(`SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';`);
    await conn.query('SET FOREIGN_KEY_CHECKS=0;');

    // Helper: REPLACE INTO từ array of row objects
    async function replaceRows(table, rows) {
      if (!rows || rows.length === 0) return;
      for (const row of rows) {
        const cols   = Object.keys(row).map(c => `\`${c}\``).join(', ');
        const placeholders = Object.keys(row).map(() => '?').join(', ');
        const vals   = Object.values(row);
        await conn.query(`REPLACE INTO \`${table}\` (${cols}) VALUES (${placeholders})`, vals);
      }
    }

    await replaceRows('wp_posts',              postData.posts);
    await replaceRows('wp_postmeta',           postData.postmeta);
    await replaceRows('wp_term_relationships', postData.term_relationships);

    await conn.query('SET FOREIGN_KEY_CHECKS=1;');
  } finally {
    await conn.end();
  }
}

/**
 * Xóa 1 post và toàn bộ meta/term_relationships khỏi Railway DB.
 *
 * @param {string} siteId
 * @param {number} postId
 */
async function deletePostFromRailway(siteId, postId) {
  const dbName = `site_${siteId.replace(/-/g, '_')}`;
  const conn   = await getConnection();

  try {
    await conn.query(`USE \`${dbName}\`;`);
    await conn.query('SET FOREIGN_KEY_CHECKS=0;');
    await conn.query('DELETE FROM `wp_posts` WHERE ID = ?',              [postId]);
    await conn.query('DELETE FROM `wp_postmeta` WHERE post_id = ?',      [postId]);
    await conn.query('DELETE FROM `wp_term_relationships` WHERE object_id = ?', [postId]);
    await conn.query('SET FOREIGN_KEY_CHECKS=1;');
  } finally {
    await conn.end();
  }
}

module.exports = { createSiteDatabase, dropSiteDatabase, syncPostToRailway, deletePostFromRailway };
