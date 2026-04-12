const mysql = require('mysql2/promise');
const fs    = require('fs');

/**
 * Connection không chỉ định database — dùng để CREATE DATABASE.
 * Cần quyền root.
 */
async function getAdminConnection() {
  return mysql.createConnection({
    host:               process.env.MYSQL_HOST     || 'localhost',
    port:               parseInt(process.env.MYSQL_PORT || '3306'),
    user:               process.env.MYSQL_ROOT_USER || 'root',
    password:           process.env.MYSQL_ROOT_PASSWORD || 'vibepress_root',
    multipleStatements: true,
  });
}

/**
 * Tạo database riêng cho 1 WP site trên local MySQL và import SQL dump.
 * dbName = site_<siteId với dấu - thành _>
 */
async function createSiteDatabase(siteId, dumpPath) {
  const dbName = `site_${siteId.replace(/-/g, '_')}`;
  const conn   = await getAdminConnection();

  try {
    await conn.query(`SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';`);
    await conn.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`);
    await conn.query(`USE \`${dbName}\`;`);

    const sql = fs.readFileSync(dumpPath, 'utf8');
    await conn.query(sql);

    const [tables] = await conn.query(`SHOW TABLES;`);
    let totalRows = 0;
    for (const row of tables) {
      const tableName = Object.values(row)[0];
      const [[{ count }]] = await conn.query(`SELECT COUNT(*) AS count FROM \`${tableName}\`;`);
      totalRows += Number(count);
    }

    const host     = process.env.MYSQL_HOST ;
    const port     = parseInt(process.env.MYSQL_PORT );
    const user     = process.env.MYSQL_ROOT_USER ;
    const password = process.env.MYSQL_ROOT_PASSWORD ;

    return {
      dbName,
      host,
      port,
      user,
      password,
      connectionString: `mysql://${user}:${password}@${host}:${port}/${dbName}`,
      tables:           tables.length,
      totalRows,
      createdAt:        new Date().toISOString(),
    };
  } finally {
    await conn.end();
  }
}

async function dropSiteDatabase(siteId) {
  const dbName = `site_${siteId.replace(/-/g, '_')}`;
  const conn   = await getAdminConnection();
  try {
    await conn.query(`DROP DATABASE IF EXISTS \`${dbName}\`;`);
  } finally {
    await conn.end();
  }
}

async function syncPostToLocalDb(siteId, postData) {
  const dbName = `site_${siteId.replace(/-/g, '_')}`;
  const conn   = await getAdminConnection();

  try {
    await conn.query(`USE \`${dbName}\`;`);
    await conn.query(`SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION';`);
    await conn.query('SET FOREIGN_KEY_CHECKS=0;');

    async function replaceRows(table, rows) {
      if (!rows || rows.length === 0) return;
      for (const row of rows) {
        const cols         = Object.keys(row).map(c => `\`${c}\``).join(', ');
        const placeholders = Object.keys(row).map(() => '?').join(', ');
        await conn.query(`REPLACE INTO \`${table}\` (${cols}) VALUES (${placeholders})`, Object.values(row));
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

async function deletePostFromLocalDb(siteId, postId) {
  const dbName = `site_${siteId.replace(/-/g, '_')}`;
  const conn   = await getAdminConnection();
  try {
    await conn.query(`USE \`${dbName}\`;`);
    await conn.query('SET FOREIGN_KEY_CHECKS=0;');
    await conn.query('DELETE FROM `wp_posts` WHERE ID = ?',                        [postId]);
    await conn.query('DELETE FROM `wp_postmeta` WHERE post_id = ?',                [postId]);
    await conn.query('DELETE FROM `wp_term_relationships` WHERE object_id = ?',    [postId]);
    await conn.query('SET FOREIGN_KEY_CHECKS=1;');
  } finally {
    await conn.end();
  }
}

module.exports = { createSiteDatabase, dropSiteDatabase, syncPostToLocalDb, deletePostFromLocalDb };
