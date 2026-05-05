import type express from 'express';

export function registerPageRoutes(input: {
  app: express.Express;
  getConn: () => Promise<any>;
  getPrefix: (conn: any) => Promise<string>;
  serializePage: (conn: any, prefix: string, row: any) => Promise<any>;
  buildRuntimePlanFromPageRow: (row: any) => Record<string, any>;
}) {
  const { app, getConn, getPrefix, serializePage, buildRuntimePlanFromPageRow } =
    input;

  const buildPageSelectSql = (prefix: string, whereClause: string) => `SELECT p.ID, p.post_title, p.post_content, p.post_name, p.post_parent, p.menu_order,
              COALESCE(pm.meta_value, '') AS template,
              img.guid AS featured_image
       FROM \`${prefix}posts\` p
       LEFT JOIN \`${prefix}postmeta\` pm ON pm.post_id = p.ID AND pm.meta_key = '_wp_page_template'
       LEFT JOIN \`${prefix}postmeta\` thumb ON thumb.post_id = p.ID AND thumb.meta_key = '_thumbnail_id'
       LEFT JOIN \`${prefix}posts\` img ON img.ID = thumb.meta_value AND img.post_type = 'attachment'
       WHERE p.post_type = 'page' AND p.post_status = 'publish' ${whereClause}`;

  app.get('/api/runtime/pages/:slug', async (req, res) => {
    const conn = await getConn();
    try {
      const prefix = await getPrefix(conn);
      const [rows] = await conn.query(
        buildPageSelectSql(prefix, `AND p.post_name = ? LIMIT 1`),
        [req.params.slug],
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const row = rows[0];
      res.json({
        page: await serializePage(conn, prefix, row),
        runtimePlan: buildRuntimePlanFromPageRow(row),
      });
    } finally {
      await conn.end();
    }
  });

  app.get('/api/pages/:slug', async (req, res) => {
    const conn = await getConn();
    try {
      const prefix = await getPrefix(conn);
      const [rows] = await conn.query(
        buildPageSelectSql(prefix, `AND p.post_name = ? LIMIT 1`),
        [req.params.slug],
      );
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      res.json(await serializePage(conn, prefix, rows[0]));
    } finally {
      await conn.end();
    }
  });

  app.get('/api/pages', async (_req, res) => {
    const conn = await getConn();
    try {
      const prefix = await getPrefix(conn);
      const [rows] = await conn.query(buildPageSelectSql(prefix, ''));
      const pages = [];
      for (const row of rows) {
        pages.push(await serializePage(conn, prefix, row));
      }
      res.json(pages);
    } finally {
      await conn.end();
    }
  });
}
