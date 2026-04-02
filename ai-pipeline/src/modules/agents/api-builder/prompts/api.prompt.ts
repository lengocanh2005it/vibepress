import { DbContentResult } from '../../db-content/db-content.service.js';

// CPTs already handled by the static template — skip to avoid duplicate routes
const TEMPLATE_COVERED_TYPES = new Set(['product']);

export function buildCptRoutesPrompt(content: DbContentResult): string {
  const { capabilities, customPostTypes, detectedPlugins } = content;

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

  const hasAcf = detectedPlugins.some((p) => p.slug === 'acf');
  const hasYoast = detectedPlugins.some((p) => p.slug === 'yoast');
  const hasCf7 = detectedPlugins.some((p) => p.slug === 'contact-form-7');

  const pluginRoutes: string[] = [];
  if (hasAcf) {
    pluginRoutes.push(
      '- ACF → GET /api/posts/:id/fields\n' +
      '  Query wp_postmeta WHERE post_id = ? AND meta_key NOT LIKE "\\_%"\n' +
      '  Return flat object { [meta_key]: meta_value }',
    );
  }
  if (hasYoast) {
    pluginRoutes.push(
      '- Yoast SEO → GET /api/seo?slug=<post-slug>\n' +
      '  JOIN wp_posts + wp_postmeta WHERE post_name = slug\n' +
      '  meta_keys: _yoast_wpseo_title, _yoast_wpseo_metadesc, _yoast_wpseo_canonical\n' +
      '  Return { title, metaDescription, canonical }',
    );
  }
  if (hasCf7) {
    pluginRoutes.push(
      '- Contact Form 7 → GET /api/forms\n' +
      '  Query wp_posts WHERE post_type = "wpcf7_contact_form" AND post_status = "publish"\n' +
      '  Return { id, title, slug }[]',
    );
  }

  return `You are an Express.js expert extending an existing Express server.

The server already has: getConn(), getPrefix(), formatDate() helpers and routes for
/api/site-info, /api/posts, /api/posts/:slug, /api/pages, /api/pages/:slug,
/api/menus, /api/products, /api/products/:slug, /api/product-categories,
/api/store/capabilities, /api/taxonomies, /api/taxonomies/:taxonomy,
/api/taxonomies/:taxonomy/:term/posts, /api/comments (GET ?postId= or ?slug=).

## Your task
Generate ONLY the additional app.get() route handlers below — no imports, no app setup,
no app.listen(). The code will be injected directly before app.listen().

## Rules
- Use the existing getConn() and getPrefix() helpers (already declared above)
- Use try/finally with conn.end() for every handler
- JOIN \`postmeta\` to enrich fields where the active plugins suggest extra meta keys
  (e.g. The Events Calendar → _EventStartDate, _EventEndDate; LearnDash → _price, _course_points)
- Return ONLY route handler code — no markdown fences, no explanation

## Active plugins (use as hints for postmeta field names)
${capabilities.activePluginSlugs.join(', ') || '(none)'}

## Detected plugin capabilities
${detectedPlugins.map((plugin) => `- ${plugin.slug} (${plugin.confidence}) → ${plugin.capabilities.join(', ') || '(none)'}`).join('\n') || '(none)'}
${pluginRoutes.length > 0 ? `
## Plugin-specific routes to generate
${pluginRoutes.join('\n')}
` : ''}
## Custom post types to generate routes for
${cptBlock || '(none)'}`;
}
