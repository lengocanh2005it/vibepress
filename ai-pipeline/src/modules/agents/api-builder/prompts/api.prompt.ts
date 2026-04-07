import { DbContentResult } from '../../db-content/db-content.service.js';

// CPTs and plugins already handled by the static Express template — skip to avoid duplicates
const TEMPLATE_COVERED_TYPES = new Set<string>([]);
const TEMPLATE_COVERED_PLUGINS = new Set<string>([]);

// Specific SQL instructions for well-known plugins
const KNOWN_PLUGIN_INSTRUCTIONS: Record<string, string> = {
  acf: [
    '- ACF → GET /api/posts/:id/fields',
    '  Query wp_postmeta WHERE post_id = ? AND meta_key NOT LIKE "\\_%"',
    '  Return flat object { [meta_key]: meta_value }',
  ].join('\n'),
  yoast: [
    '- Yoast SEO → GET /api/seo?slug=<post-slug>',
    '  JOIN wp_posts + wp_postmeta WHERE post_name = slug',
    '  meta_keys: _yoast_wpseo_title, _yoast_wpseo_metadesc, _yoast_wpseo_canonical',
    '  Return { title, metaDescription, canonical }',
  ].join('\n'),
  'contact-form-7': [
    '- Contact Form 7 → GET /api/forms',
    '  Query wp_posts WHERE post_type = "wpcf7_contact_form" AND post_status = "publish"',
    '  Return { id, title, slug }[]',
  ].join('\n'),
};

export function buildCptRoutesPrompt(content: DbContentResult): string {
  const { capabilities, customPostTypes, detectedPlugins, discovery } = content;

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

  // All detected plugins except those already in the static template
  const pluginsToHandle = detectedPlugins.filter(
    (p) => !TEMPLATE_COVERED_PLUGINS.has(p.slug) && p.confidence !== 'low',
  );

  const pluginRoutesBlock = pluginsToHandle
    .map((p) => {
      if (KNOWN_PLUGIN_INSTRUCTIONS[p.slug]) {
        return KNOWN_PLUGIN_INSTRUCTIONS[p.slug];
      }
      // Unknown / less common plugin — give AI the evidence and let it reason
      const evidenceLines = p.evidence
        .map(
          (e) =>
            `    ${e.source}: ${e.match}${e.detail ? ` (${e.detail})` : ''} [${e.confidence}]`,
        )
        .join('\n');
      return [
        `- ${p.slug} (active plugin)`,
        `  capabilities: ${p.capabilities.join(', ') || '(infer from slug name and evidence)'}`,
        evidenceLines ? `  evidence:\n${evidenceLines}` : '',
        `  → Use the plugin slug and evidence signals to infer what data it stores.`,
        `  → Generate appropriate GET /api/... route(s) that expose that data via wp_posts / wp_postmeta / wp_options.`,
        `  → Use your knowledge of common WordPress plugins when the slug is recognisable (e.g. the-events-calendar, learndash, buddypress, ninja-forms, gravity-forms, wpml).`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n\n');

  // Summary context — helps AI associate meta keys / shortcodes with unknown plugins
  const contextParts: string[] = [];
  if (discovery?.pluginOptionKeys?.length > 0) {
    contextParts.push(
      `Available wp_options plugin keys: ${discovery.pluginOptionKeys.join(', ')}`,
    );
  }
  if (discovery?.topShortcodes?.length > 0) {
    contextParts.push(
      `Active shortcodes found in content: ${discovery.topShortcodes.join(', ')}`,
    );
  }
  if (discovery?.topBlockTypes?.length > 0) {
    contextParts.push(
      `Active block types in posts: ${discovery.topBlockTypes.join(', ')}`,
    );
  }
  if (discovery?.restNamespaces?.length > 0) {
    contextParts.push(
      `WordPress REST namespaces: ${discovery.restNamespaces.join(', ')}`,
    );
  }
  const contextBlock = contextParts.join('\n');

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
- Route paths MUST be string literals only, e.g. \`app.get('/api/my-plugin/status', async ...)\`. Compute \`prefix\` inside the handler for SQL table names.
- Query WordPress tables with the dynamic prefix: \`\${prefix}posts\`, \`\${prefix}options\`, etc. Do not hardcode \`wp_\` unless you are certain the site uses the default prefix.
- Use try/finally with await conn.end() for every handler
- JOIN \`postmeta\` to enrich fields where the active plugins suggest extra meta keys
  (e.g. The Events Calendar → _EventStartDate, _EventEndDate; LearnDash → _price, _course_points)
- Return ONLY route handler code — no markdown fences, no explanation

## Active plugins (all installed on this site)
${capabilities.activePluginSlugs.join(', ') || '(none)'}

## Detected plugin capabilities
${detectedPlugins.map((p) => `- ${p.slug} (${p.confidence}) → ${p.capabilities.join(', ') || '(none)'}`).join('\n') || '(none)'}
${contextBlock ? `\n## Site data context (use to infer plugin data fields)\n${contextBlock}` : ''}
${pluginRoutesBlock ? `\n## Plugin-specific routes to generate\n${pluginRoutesBlock}` : ''}
## Custom post types to generate routes for
${cptBlock || '(none)'}`;
}
