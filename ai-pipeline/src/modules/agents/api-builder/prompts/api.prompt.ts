import { DbContentResult } from '../../db-content/db-content.service.js';

export function buildApiPrompt(
  content: DbContentResult,
  dbName: string,
): string {
  return `You are an Express.js expert.

Generate a complete Express server in TypeScript that serves WordPress content for a React frontend preview app.

## Rules
- Use Express with TypeScript
- Use \`mysql2/promise\` to connect to MySQL
- Read DB credentials from \`.env\` via \`dotenv\` (process.env.DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME)
- Auto-detect table prefix by querying \`information_schema.tables\` for a table ending in \`options\`
- Listen on port from \`process.env.API_PORT\` or default \`3100\`
- Add CORS middleware (\`res.header('Access-Control-Allow-Origin', '*')\`)
- Return ONLY pure TypeScript code — no explanation, no markdown fences

## Database
- DB name: \`${dbName}\`

## Required endpoints
- GET /api/site-info   → { siteUrl, siteName, blogDescription, adminEmail, language }
- GET /api/posts       → array of { id, title, content, excerpt, slug, type, status }
- GET /api/posts/:slug → single post by slug
- GET /api/pages       → array of { id, title, content, slug, menuOrder, template }
- GET /api/menus       → array of { name, slug, items: [{ id, title, url, order, parentId }] }

## Site info
- Site: ${content.siteInfo.siteName} (${content.siteInfo.siteUrl})
- Pages: ${content.pages.length}, Posts: ${content.posts.length}, Menus: ${content.menus.length}`;
}
