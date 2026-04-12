import { DbContentResult } from '../../db-content/db-content.service.js';

// CPTs already handled by the static Express template — skip to avoid duplicates
const TEMPLATE_COVERED_TYPES = new Set<string>([]);

export function buildCptRoutesPrompt(
  content: Pick<DbContentResult, 'customPostTypes'>,
): string {
  const { customPostTypes } = content;

  const newCpts = customPostTypes.filter(
    (c) => !TEMPLATE_COVERED_TYPES.has(c.postType),
  );

  const cptBlock = newCpts
    .map((cpt) => {
      const plural = cpt.postType.endsWith('s')
        ? cpt.postType
        : `${cpt.postType}s`;
      const taxLines =
        cpt.taxonomies.length > 0
          ? `  Taxonomies: ${cpt.taxonomies.join(', ')} → add GET /api/${plural}/taxonomy/:taxonomy`
          : '';
      return [
        `- post_type: "${cpt.postType}" (${cpt.count} records) → plural route key: "${plural}"`,
        taxLines,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n');

  return `You are an Express.js expert extending an existing Express server.

The server already has: getConn(), getPrefix(conn), formatDate() helpers and routes for
/api/site-info, /api/posts, /api/posts/:slug, /api/pages, /api/pages/:slug,
/api/menus, /api/taxonomies, /api/taxonomies/:taxonomy,
/api/taxonomies/:taxonomy/:term/posts,
 /api/comments GET (?postId= or ?slug=), /api/comments/submissions GET (?postId= or ?slug=, clientToken),
 and /api/comments POST (body: author, email, content, website?, slug?, postId?, parentId?, clientToken).

## Your task
Generate ONLY the additional app.get() route handlers below — no imports, no app setup,
no app.listen(). The code will be injected directly before app.listen().

## Rules
- Use the existing getConn() and getPrefix(conn) helpers (already declared above).
  getPrefix is async and REQUIRES a live MySQL connection: \`const prefix = await getPrefix(conn)\` INSIDE each handler after \`const conn = await getConn()\`.
- NEVER call getPrefix() with no arguments. NEVER write \`app.get(getPrefix() + '...')\`, \`app.get(getPrefix() + "/...")\`, or put getPrefix() in the route path — that runs at module load time, conn is undefined, and the server crashes.
- Route paths MUST be string literals only. Compute \`prefix\` inside the handler for SQL table names.
- Query WordPress tables with the dynamic prefix: \`\${prefix}posts\`, \`\${prefix}options\`, etc. Do not hardcode \`wp_\` unless you are certain the site uses the default prefix.
- Use try/finally with await conn.end() for every handler
- Primary migration scope is core WordPress content. Do NOT generate plugin APIs, WooCommerce APIs, admin/debug endpoints, or plugin-slug-derived routes.
- The static template ALREADY provides generic CPT detail/list coverage via \`/api/post-types/:postType/posts\` and \`/api/post-types/:postType/:slug\`. Do NOT generate duplicate list/detail routes unless the custom post type truly needs an extra route that the generic template cannot represent.
- If a custom post type is plugin-owned, commerce-oriented, or not clearly required by the approved frontend contract, generate no extra routes for it.
- NEVER return raw SQL rows from \`posts\` + \`postmeta\` joins where one post appears multiple times. One API item must represent exactly one post record.
- If you must return CPT records, normalize them to the same shape family as the existing post endpoints (stable JSON objects, not raw MySQL rows).
- Prefer generating only missing taxonomy/helper routes for the CPT, not a parallel second API surface.
- Return ONLY route handler code — no markdown fences, no explanation

## Custom post types to generate routes for
${cptBlock || '(none)'}`;
}
