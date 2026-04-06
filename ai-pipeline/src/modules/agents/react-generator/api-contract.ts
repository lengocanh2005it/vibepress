export const API_CONTRACT_SOURCE_PATH = 'templates/express-server/index.ts';

export const SITE_INFO_FIELDS = [
  'siteUrl',
  'siteName',
  'blogDescription',
  'adminEmail',
  'language',
] as const;

export const POST_FIELDS = [
  'id',
  'title',
  'content',
  'excerpt',
  'slug',
  'type',
  'status',
  'date',
  'author',
  'categories',
  'featuredImage',
] as const;

export const PAGE_BACKEND_FIELDS = [
  'id',
  'title',
  'content',
  'slug',
  'menuOrder',
  'template',
] as const;

export const PAGE_FRONTEND_FIELDS = [
  'id',
  'title',
  'content',
  'slug',
] as const;

export const MENU_ITEM_FIELDS = [
  'id',
  'title',
  'url',
  'order',
  'parentId',
] as const;

export const MENU_FIELDS = ['name', 'slug', 'items'] as const;

export const TERM_FIELDS = [
  'id',
  'name',
  'slug',
  'description',
  'count',
  'parentId',
] as const;

export const COMMENT_FIELDS = [
  'id',
  'author',
  'date',
  'content',
  'parentId',
  'userId',
] as const;

export const COMMENT_SUBMISSION_FIELDS = [
  ...COMMENT_FIELDS,
  'moderationStatus',
] as const;

export const PRODUCT_FIELDS = [
  'id',
  'title',
  'content',
  'excerpt',
  'slug',
  'status',
  'date',
  'sku',
  'price',
  'regularPrice',
  'salePrice',
  'featuredImage',
  'categories',
] as const;

export const POST_INTERFACE = `interface Post { id: number; title: string; content: string; excerpt: string; slug: string; type: string; status: string; date: string; author: string; categories: string[]; featuredImage: string | null; }`;
export const PAGE_INTERFACE = `interface Page { id: number; title: string; content: string; slug: string; }`;
export const SITE_INFO_INTERFACE = `interface SiteInfo { siteUrl: string; siteName: string; blogDescription: string; adminEmail: string; language: string; }`;
export const MENU_ITEM_INTERFACE = `interface MenuItem { id: number; title: string; url: string; order: number; parentId: number; }`;
export const MENU_INTERFACE = `interface Menu { name: string; slug: string; items: MenuItem[]; }`;
export const TERM_INTERFACE = `interface Term { id: number; name: string; slug: string; description: string; count: number; parentId: number; }`;
export const COMMENT_INTERFACE = `interface Comment { id: number; author: string; date: string; content: string; parentId: number; userId: number; }`;
export const COMMENT_SUBMISSION_INTERFACE = `interface CommentSubmission extends Comment { moderationStatus: 'approved' | 'pending' | 'spam' | 'trash'; }`;
export const PRODUCT_INTERFACE = `interface Product { id: number; title: string; content: string; excerpt: string; slug: string; status: string; date: string; sku: string; price: string | null; regularPrice: string | null; salePrice: string | null; featuredImage: string | null; categories: string[]; }`;

function formatFieldList(fields: readonly string[]): string {
  return fields.map((field) => `\`${field}\``).join(', ');
}

export function buildCanonicalApiContractNote(): string {
  return `## Canonical API contract — generated from \`${API_CONTRACT_SOURCE_PATH}\`

Use ONLY this runtime data shape. WordPress template structure is for layout fidelity only; it does NOT define React runtime field names.

### Endpoints
- \`GET /api/site-info\` → SiteInfo
- \`GET /api/posts\` → Post[]
- \`GET /api/posts/:slug\` → Post
- \`GET /api/pages\` → backend returns ${formatFieldList(PAGE_BACKEND_FIELDS)}, but React components must use ONLY ${formatFieldList(PAGE_FRONTEND_FIELDS)}
- \`GET /api/pages/:slug\` → same Page rule as above
- \`GET /api/menus\` → Menu[]
- \`GET /api/taxonomies\` → string[]
- \`GET /api/taxonomies/:taxonomy\` → Term[]
- \`GET /api/taxonomies/:taxonomy/:term/posts\` → post previews for that term
- \`GET /api/comments?slug=<post-slug>\` or \`?postId=<id>\` → Comment[]
- \`GET /api/comments/submissions?...&clientToken=...\` → CommentSubmission[]
- \`POST /api/comments\` → creates a moderated comment submission
- \`GET /api/products\` → Product[]
- \`GET /api/products/:slug\` → Product

### Entity fields
- SiteInfo: ${formatFieldList(SITE_INFO_FIELDS)}
- Post: ${formatFieldList(POST_FIELDS)}
- Page for React usage: ${formatFieldList(PAGE_FRONTEND_FIELDS)}
- Menu: ${formatFieldList(MENU_FIELDS)}
- MenuItem: ${formatFieldList(MENU_ITEM_FIELDS)}
- Term: ${formatFieldList(TERM_FIELDS)}
- Comment: ${formatFieldList(COMMENT_FIELDS)}
- CommentSubmission: ${formatFieldList(COMMENT_SUBMISSION_FIELDS)}
- Product: ${formatFieldList(PRODUCT_FIELDS)}

### Non-negotiable constraints
- Do NOT invent GraphQL or WordPress wrapper fields such as \`.node\`, \`.nodes\`, \`.edges\`, or \`.rendered\`.
- Do NOT rename \`siteInfo.siteName/siteUrl/blogDescription\` into \`name/url/description\`.
- Do NOT add post-only fields to \`Page\`. Even though the backend includes \`menuOrder\` and \`template\`, the React pipeline contract keeps Page limited to ${formatFieldList(PAGE_FRONTEND_FIELDS)}.
- \`menus[].items[].parentId\` is always a number; top-level menu items use \`0\`.
- Comments use \`comment.author\`, not \`comment.author_name\` or avatar fields.
- If a comment form exists, submit via \`POST /api/comments\` and poll \`/api/comments/submissions\` for moderation status.`;
}

export function buildFlatRestSchemaNote(availableVariables: string): string {
  const lines: string[] = [
    '## Flat REST data shapes — MANDATORY',
    `- Canonical source: \`${API_CONTRACT_SOURCE_PATH}\``,
    '- This project uses flat REST objects, NOT GraphQL/WordPress rendered wrappers.',
    '- NEVER write `.node`, `.nodes`, `.edges`, `.rendered`, `.items.nodes`, or similar nested accessors unless that variable is explicitly declared in the frame.',
  ];

  if (availableVariables.includes('`post: Post | null`')) {
    lines.push(
      `- \`post\` fields: ${formatFieldList(POST_FIELDS)}.`,
      '- `post.title`, `post.excerpt`, `post.author`, `post.content`, `post.date` are plain strings.',
      '- `post.categories` is `string[]`.',
      '- Valid examples: `post.title`, `post.excerpt`, `post.categories[0]`.',
      '- Invalid examples: `post.title.node`, `post.excerpt.rendered`, `post.categories.nodes`.',
    );
  }

  if (availableVariables.includes('`posts: Post[]`')) {
    lines.push(
      `- Inside \`posts.map(post => ...)\`, \`post\` uses fields: ${formatFieldList(POST_FIELDS)}.`,
      '- Invalid examples inside loops: `post.title.node`, `post.categories.nodes`, `node.title.rendered`.',
    );
  }

  if (availableVariables.includes('`page: Page | null`')) {
    lines.push(
      `- \`page\` only has: ${formatFieldList(PAGE_FRONTEND_FIELDS)}.`,
      '- Invalid examples: `page.title.rendered`, `page.author`, `page.featuredImage`, `page.menuOrder`, `page.template`.',
    );
  }

  if (availableVariables.includes('`pages: Page[]`')) {
    lines.push(
      `- Inside \`pages.map(page => ...)\`, use only ${formatFieldList(PAGE_FRONTEND_FIELDS)}.`,
    );
  }

  if (availableVariables.includes('`menus: Menu[]`')) {
    lines.push(
      `- \`menus\` is \`Menu[]\`; each \`menu\` has ${formatFieldList(MENU_FIELDS)}.`,
      `- Each \`item\` has flat fields: ${formatFieldList(MENU_ITEM_FIELDS)}.`,
      '- Valid examples: `menu.items.map(item => item.title)`, `item.parentId === 0`.',
      '- Invalid examples: `menu.items.nodes`, `item.node.title`, `menu.node.slug`.',
    );
  }

  if (availableVariables.includes('`siteInfo: SiteInfo | null`')) {
    lines.push(
      `- \`siteInfo\` fields: ${formatFieldList(SITE_INFO_FIELDS)}.`,
      '- `siteInfo.siteName`, `siteInfo.siteUrl`, `siteInfo.blogDescription` are plain strings.',
    );
  }

  if (availableVariables.includes('`comments: Comment[]`')) {
    lines.push(
      `- \`comment\` fields: ${formatFieldList(COMMENT_FIELDS)}.`,
      '- `comment.author`, `comment.date`, `comment.content` are plain strings; `comment.parentId` is a number.',
    );
  }

  return lines.join('\n');
}
