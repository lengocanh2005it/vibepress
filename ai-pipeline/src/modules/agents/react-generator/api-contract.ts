export const API_CONTRACT_SOURCE_PATH = 'templates/express-server/index.ts';

export const SITE_INFO_FIELDS = [
  'siteUrl',
  'siteName',
  'blogDescription',
  'logoUrl',
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
  'authorSlug',
  'categories',
  'categorySlugs',
  'tags',
  'featuredImage',
] as const;

export const PAGE_BACKEND_FIELDS = [
  'id',
  'title',
  'content',
  'slug',
  'parentId',
  'menuOrder',
  'template',
  'featuredImage',
] as const;

export const PAGE_FRONTEND_FIELDS = [
  'id',
  'title',
  'content',
  'slug',
  'parentId',
  'menuOrder',
  'template',
  'featuredImage',
] as const;

export const MENU_ITEM_FIELDS = [
  'id',
  'title',
  'url',
  'order',
  'parentId',
  'target',
] as const;

export const MENU_FIELDS = ['name', 'slug', 'location', 'items'] as const;
export const POST_TYPE_SUMMARY_FIELDS = [
  'postType',
  'count',
  'taxonomies',
] as const;

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

export const POST_INTERFACE = `interface Post { id: number; title: string; content: string; excerpt: string; slug: string; type: string; status: string; date: string; author: string; authorSlug: string; categories: string[]; categorySlugs: string[]; tags: string[]; featuredImage: string | null; }`;
export const PAGE_INTERFACE = `interface Page { id: number; title: string; content: string; slug: string; parentId: number; menuOrder: number; template: string; featuredImage: string | null; }`;
export const SITE_INFO_INTERFACE = `interface SiteInfo { siteUrl: string; siteName: string; blogDescription: string; logoUrl: string | null; adminEmail: string; language: string; }`;
export const MENU_ITEM_INTERFACE = `interface MenuItem { id: number; title: string; url: string; order: number; parentId: number; target: string | null; }`;
export const MENU_INTERFACE = `interface Menu { name: string; slug: string; location: string | null; items: MenuItem[]; }`;
export const POST_TYPE_SUMMARY_INTERFACE = `interface PostTypeSummary { postType: string; count: number; taxonomies: string[]; }`;
export const TERM_INTERFACE = `interface Term { id: number; name: string; slug: string; description: string; count: number; parentId: number; }`;
export const COMMENT_INTERFACE = `interface Comment { id: number; author: string; date: string; content: string; parentId: number; userId: number; }`;
export const COMMENT_SUBMISSION_INTERFACE = `interface CommentSubmission extends Comment { moderationStatus: 'approved' | 'pending' | 'spam' | 'trash'; }`;
export const FOOTER_COLUMN_INTERFACE = `interface FooterColumn { heading: string; links: Array<{ label: string; url: string }>; }`;

function formatFieldList(fields: readonly string[]): string {
  return fields.map((field) => `\`${field}\``).join(', ');
}

export function buildCanonicalApiContractNote(): string {
  return `## Canonical API contract — generated from \`${API_CONTRACT_SOURCE_PATH}\`

Use ONLY this runtime data shape. WordPress template structure is for layout fidelity only; it does NOT define React runtime field names.

### Endpoints
- \`GET /api/site-info\` → SiteInfo
- \`GET /api/posts\` → Post[] (optional \`?author=<nicename>\`, \`?type=<post-type|all>\`, \`?page=<n>\`, \`?perPage=<n>\`)
- \`GET /api/posts/:slug\` → Post (optional \`?type=<post-type|all>\`)
- \`GET /api/pages\` → Page[]
- \`GET /api/pages/:slug\` → Page
- \`GET /api/post-types\` → PostTypeSummary[]
- \`GET /api/post-types/:postType/posts\` → Post[] (supports \`?page=<n>\`, \`?perPage=<n>\`)
- \`GET /api/post-types/:postType/:slug\` → Post
- \`GET /api/menus\` → Menu[]
- \`GET /api/taxonomies\` → string[]
- \`GET /api/taxonomies/:taxonomy\` → Term[]
- \`GET /api/taxonomies/:taxonomy/:term/posts\` → post previews for that term (supports \`?page=<n>\`, \`?perPage=<n>\`)
- \`GET /api/comments?slug=<post-slug>\` or \`?postId=<id>\` → Comment[]
- \`GET /api/comments/submissions?...&clientToken=...\` → CommentSubmission[]
- \`GET /api/footer-links\` → FooterColumn[] (parsed from wp_template_part footer blocks)
- \`POST /api/comments\` → creates a moderated comment submission

### Entity fields
- SiteInfo: ${formatFieldList(SITE_INFO_FIELDS)}
- Post: ${formatFieldList(POST_FIELDS)}
- Page for React usage: ${formatFieldList(PAGE_FRONTEND_FIELDS)}
- Menu: ${formatFieldList(MENU_FIELDS)}
- MenuItem: ${formatFieldList(MENU_ITEM_FIELDS)}
- PostTypeSummary: ${formatFieldList(POST_TYPE_SUMMARY_FIELDS)}
- Term: ${formatFieldList(TERM_FIELDS)}
- Comment: ${formatFieldList(COMMENT_FIELDS)}
- CommentSubmission: ${formatFieldList(COMMENT_SUBMISSION_FIELDS)}

### Non-negotiable constraints
- Do NOT invent GraphQL or WordPress wrapper fields such as \`.node\`, \`.nodes\`, \`.edges\`, or \`.rendered\`.
- Do NOT rename \`siteInfo.siteName/siteUrl/blogDescription\` into \`name/url/description\`.
- Pages may use ${formatFieldList(PAGE_FRONTEND_FIELDS)}, but still must NOT use post-only fields such as \`author\`, \`categories\`, \`tags\`, \`date\`, \`excerpt\`, or comments.
- \`post.content\` and \`page.content\` are normalized HTML strings: WordPress asset URLs are rewritten, Gutenberg comments are stripped, and common dynamic blocks are rendered to HTML where possible.
- Paginated post-list endpoints return flat \`Post[]\` plus WP-style response headers: \`X-WP-Total\`, \`X-WP-TotalPages\`, \`X-WP-CurrentPage\`, \`X-WP-PerPage\`.
- Use \`post.authorSlug\` for author archive links; \`post.author\` is display text only.
- Use \`post.categorySlugs[index]\` with \`post.categories[index]\` for category archive links when \`/category/:slug\` is available.
- \`menus[].items[].parentId\` is always a number; top-level menu items use \`0\`.
- Use \`menu.items[].target\` when rendering anchors; when it is \`"_blank"\`, also set \`rel="noopener noreferrer"\`.
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
      '- `post.title`, `post.excerpt`, `post.author`, `post.authorSlug`, `post.content`, `post.date` are plain strings.',
      '- `post.content` is already normalized HTML suitable for `dangerouslySetInnerHTML`.',
      '- `post.categories`, `post.categorySlugs`, and `post.tags` are `string[]`.',
      '- Valid examples: `post.title`, `post.authorSlug`, `post.excerpt`, `post.categories[0]`, `post.categorySlugs[0]`, `post.tags[0]`.',
      '- Invalid examples: `post.title.node`, `post.excerpt.rendered`, `post.author.slug`, `post.categories.nodes`, `post.categorySlugs.nodes`, `post.tags.nodes`.',
    );
  }

  if (availableVariables.includes('`posts: Post[]`')) {
    lines.push(
      `- Inside \`posts.map(post => ...)\`, \`post\` uses fields: ${formatFieldList(POST_FIELDS)}.`,
      '- Pagination helpers available alongside `posts`: `currentPage: number`, `totalPages: number`, `updatePage(nextPage: number): void`.',
      '- Use `currentPage` and `totalPages` to render pagination UI; call `updatePage(nextPage)` to change pages.',
      '- Invalid examples inside loops: `post.title.node`, `post.categories.nodes`, `node.title.rendered`.',
    );
  }

  if (availableVariables.includes('`page: Page | null`')) {
    lines.push(
      `- \`page\` fields: ${formatFieldList(PAGE_FRONTEND_FIELDS)}.`,
      '- Valid examples: `page.featuredImage`, `page.parentId`, `page.template`.',
      '- `page.content` is already normalized HTML suitable for `dangerouslySetInnerHTML`.',
      '- Invalid examples: `page.title.rendered`, `page.author`, `page.categories`, `page.tags`, `page.date`, `page.excerpt`.',
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
      '- Valid examples: `menu.items.map(item => item.title)`, `item.parentId === 0`, `item.target === "_blank"`.',
      '- Invalid examples: `menu.items.nodes`, `item.node.title`, `menu.node.slug`.',
    );
  }

  if (availableVariables.includes('`siteInfo: SiteInfo | null`')) {
    lines.push(
      `- \`siteInfo\` fields: ${formatFieldList(SITE_INFO_FIELDS)}.`,
      '- `siteInfo.siteName`, `siteInfo.siteUrl`, `siteInfo.blogDescription` are plain strings; `siteInfo.logoUrl` is `string | null`.',
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
