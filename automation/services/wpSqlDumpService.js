const axios = require("axios");

const TIMEOUT = 30_000;

/**
 * Lấy danh sách tất cả tables với row count và schema.
 * GET /wp-json/vibepress/v1/sql-dump/tables
 */
async function getTables(siteUrl, apiKey) {
  const res = await axios.get(
    `${siteUrl}/wp-json/vibepress/v1/sql-dump/tables`,
    {
      headers: { "X-Vibepress-Key": apiKey },
      timeout: TIMEOUT,
    },
  );
  return res.data;
}

/**
 * Lấy rows của 1 table, có phân trang.
 * GET /wp-json/vibepress/v1/sql-dump?table=wp_posts&offset=0&limit=500
 */
async function getTableRows(siteUrl, apiKey, table, offset = 0, limit = 500) {
  const res = await axios.get(`${siteUrl}/wp-json/vibepress/v1/sql-dump`, {
    params: { table, offset, limit },
    headers: { "X-Vibepress-Key": apiKey },
    timeout: TIMEOUT,
  });
  return res.data;
}

/**
 * Dump toàn bộ 1 table bằng cách tự động phân trang cho đến hết.
 */
async function dumpFullTable(siteUrl, apiKey, table, limit = 500) {
  const rows = [];
  let offset = 0;
  let schema = null;
  let total = null;

  while (true) {
    const data = await getTableRows(siteUrl, apiKey, table, offset, limit);

    if (total === null) total = data.total;
    if (schema === null) schema = data.schema ?? null;

    rows.push(...(data.rows ?? []));

    if (!data.has_more) break;
    offset += limit;
  }

  return { table, total, schema, rows };
}

/**
 * Dump toàn bộ database theo flow tối ưu:
 * - Tables nhỏ (≤ SMALL_TABLE_THRESHOLD rows): 1 request /full
 * - Tables lớn: phân trang 500 rows/lần
 *
 * onTable callback được gọi sau mỗi table hoàn thành —
 * cho phép caller xử lý/lưu từng table ngay thay vì chờ hết.
 *
 * @param {string}   siteUrl
 * @param {string}   apiKey
 * @param {Function} onTable  async (tableData) => void  — optional
 */
async function dumpAllTables(siteUrl, apiKey, onTable = null) {
  const SMALL_TABLE_THRESHOLD = 2000;
  const PAGE_LIMIT = 500;

  const { tables } = await getTables(siteUrl, apiKey);
  const results = [];

  for (const { name, rows: rowCount, schema } of tables) {
    let tableData;

    if (rowCount <= SMALL_TABLE_THRESHOLD) {
      // Nhỏ → 1 request lấy hết
      const data = await getTableRows(siteUrl, apiKey, name, 0, rowCount || PAGE_LIMIT);
      tableData = { table: name, total: rowCount, schema, rows: data.rows ?? [] };
    } else {
      // Lớn → phân trang
      const rows = [];
      let offset = 0;
      while (true) {
        const data = await getTableRows(siteUrl, apiKey, name, offset, PAGE_LIMIT);
        rows.push(...(data.rows ?? []));
        if (!data.has_more) break;
        offset += PAGE_LIMIT;
      }
      tableData = { table: name, total: rowCount, schema, rows };
    }

    if (onTable) await onTable(tableData);
    results.push(tableData);
  }

  return results;
}

/**
 * Convert 1 table dump sang SQL string (CREATE TABLE + INSERT INTO).
 */
function tableDataToSql(tableData) {
  const { table, schema, rows } = tableData;
  const lines = [];

  lines.push(`-- -------------------------------------------------------`);
  lines.push(`-- Table: ${table}`);
  lines.push(`-- -------------------------------------------------------`);

  if (schema) {
    lines.push(`DROP TABLE IF EXISTS \`${table}\`;`);
    lines.push(schema + ';');
    lines.push('');
  }

  if (!rows || rows.length === 0) return lines.join('\n');

  const columns = Object.keys(rows[0]);
  const colList = columns.map((c) => `\`${c}\``).join(', ');

  // Chia INSERT thành batch 100 rows để tránh câu lệnh quá dài
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const values = batch.map((row) => {
      const vals = columns.map((col) => {
        const v = row[col];
        if (v === null || v === undefined) return 'NULL';
        if (typeof v === 'number') return v;
        // Escape single quotes và backslashes
        return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
      });
      return `(${vals.join(', ')})`;
    });
    lines.push(`INSERT INTO \`${table}\` (${colList}) VALUES`);
    lines.push(values.join(',\n') + ';');
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * Convert toàn bộ dump sang SQL file string.
 */
function dumpToSql(tables) {
  const header = [
    '-- Vibepress SQL Dump',
    `-- Generated: ${new Date().toISOString()}`,
    '--',
    'SET FOREIGN_KEY_CHECKS=0;',
    '',
  ].join('\n');

  const footer = '\nSET FOREIGN_KEY_CHECKS=1;\n';

  const body = tables.map(tableDataToSql).join('\n');
  return header + body + footer;
}

module.exports = { getTables, getTableRows, dumpFullTable, dumpAllTables, dumpToSql };
