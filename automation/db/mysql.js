const mysql = require('mysql2/promise');

const pool = mysql.createPool({
  host:            process.env.MYSQL_HOST     || 'localhost',
  port:            parseInt(process.env.MYSQL_PORT || '3306'),
  database:        process.env.MYSQL_DB       || 'vibepress',
  user:            process.env.MYSQL_USER     || 'vibepress',
  password:        process.env.MYSQL_PASSWORD || 'vibepress_pass',
  waitForConnections: true,
  connectionLimit: 10,
  timezone:        'Z',
});

/**
 * Chạy query có params, trả về rows.
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<any[]>}
 */
async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

/**
 * Chạy query, trả về row đầu tiên hoặc null.
 * @param {string} sql
 * @param {any[]} [params]
 * @returns {Promise<any|null>}
 */
async function queryOne(sql, params = []) {
  const rows = await query(sql, params);
  return rows[0] ?? null;
}

module.exports = { pool, query, queryOne };
