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

export const PRODUCT_FIELDS = [
  ...POST_FIELDS,
  'price',
  'buttonText',
  'buttonUrl',
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
export const PRODUCT_INTERFACE = `interface Product { id: number; title: string; content: string; excerpt: string; slug: string; type: string; status: string; date: string; author: string; authorSlug: string; categories: string[]; categorySlugs: string[]; tags: string[]; featuredImage: string | null; price: string; buttonText: string; buttonUrl: string; }`;
export const PAGE_INTERFACE = `interface Page { id: number; title: string; content: string; slug: string; parentId: number; menuOrder: number; template: string; featuredImage: string | null; }`;
export const SITE_INFO_INTERFACE = `interface SiteInfo { siteUrl: string; siteName: string; blogDescription: string; logoUrl: string | null; adminEmail: string; language: string; }`;
export const MENU_ITEM_INTERFACE = `interface MenuItem { id: number; title: string; url: string; order: number; parentId: number; target: string | null; }`;
export const MENU_INTERFACE = `interface Menu { name: string; slug: string; location: string | null; items: MenuItem[]; }`;
export const POST_TYPE_SUMMARY_INTERFACE = `interface PostTypeSummary { postType: string; count: number; taxonomies: string[]; }`;
export const TERM_INTERFACE = `interface Term { id: number; name: string; slug: string; description: string; count: number; parentId: number; }`;
export const COMMENT_INTERFACE = `interface Comment { id: number; author: string; date: string; content: string; parentId: number; userId: number; }`;
export const COMMENT_SUBMISSION_INTERFACE = `interface CommentSubmission extends Comment { moderationStatus: 'approved' | 'pending' | 'spam' | 'trash'; }`;
export const FOOTER_COLUMN_INTERFACE = `interface FooterColumn { heading: string; links: Array<{ label: string; url: string }>; }`;
export const RUNTIME_PAGE_SOURCE_INTERFACE = `interface RuntimePageSource { kind: 'page-post-content' | 'template' | 'template-chain'; template: string; slug: string; sourceSummary?: string; }`;
export const RUNTIME_PAGE_SUPPORT_INTERFACE = `interface RuntimePageSupport { safeForRuntime: boolean; unsupportedBlocks: string[]; }`;
export const RUNTIME_PAGE_SUBTREE_BINDING_INTERFACE = `interface RuntimePageSubtreeBinding { nodeId: string; blockName: string; renderer: string; preserveWrapper: boolean; preserveChildrenOrder: boolean; childCount?: number; sectionId?: string; sectionDebugKey?: string; }`;
export const RUNTIME_PAGE_SECTION_INTERFACE = `interface RuntimePageSection { id?: string; type: string; debugKey?: string; sectionKey?: string; sourceNodeId?: string; blockName?: string; title?: string; subtitle?: string; body?: string; imageSrc?: string; imageAlt?: string; columns?: number; cards?: Array<Record<string, unknown>>; items?: Array<Record<string, unknown>>; slides?: Array<Record<string, unknown>>; tabs?: Array<Record<string, unknown>>; layout?: Record<string, unknown>; style?: Record<string, unknown>; children?: RuntimePageSection[]; }`;
export const RUNTIME_PAGE_PLAN_INTERFACE = `interface RuntimePagePlan { version: 1 | 2; mode: 'block-centric' | 'hybrid' | 'page-content'; fidelity: 'strict-structure' | 'best-effort'; layoutFamily?: string; source: RuntimePageSource; support: RuntimePageSupport; dataNeeds: string[]; sections: RuntimePageSection[]; blockTree: Array<Record<string, unknown>>; subtreeBindings?: RuntimePageSubtreeBinding[]; overrides?: Record<string, unknown>; }`;
export const RUNTIME_PAGE_RESPONSE_INTERFACE = `interface RuntimePageResponse { page: Page; runtimePlan: RuntimePagePlan; }`;

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
- \`GET /api/pages/:slug\` → Page (dedicated page-detail path)
- \`GET /api/runtime/pages/:slug\` → RuntimePageResponse (runtime-page path only when planner opts in)
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
- Product from \`/api/post-types/product/*\`: ${formatFieldList(PRODUCT_FIELDS)}
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
- \`post.content\` and \`page.content\` are normalized HTML strings: WordPress asset URLs are rewritten, Gutenberg comments are stripped, and common dynamic blocks are rendered to HTML where possible. Page/detail components must render canonical body content through structured JSX (for example \`renderRichTextChildren(...)\`), not \`dangerouslySetInnerHTML\`.
- Products fetched from \`/api/post-types/product/*\` use flat fields; render \`product.price\`, \`product.buttonText\`, and \`product.buttonUrl\` directly.
- Paginated post-list endpoints return flat \`Post[]\` plus WP-style response headers: \`X-WP-Total\`, \`X-WP-TotalPages\`, \`X-WP-CurrentPage\`, \`X-WP-PerPage\`.
- Use \`post.authorSlug\` for author archive links; \`post.author\` is display text only.
- Use \`post.categorySlugs[index]\` with \`post.categories[index]\` for category archive links when \`/category/:slug\` is available.
- \`menus[].items[].parentId\` is always a number; top-level menu items use \`0\`.
- Use \`menu.items[].target\` when rendering anchors; when it is \`"_blank"\`, also set \`rel="noopener noreferrer"\`.
- Comments use \`comment.author\`, not \`comment.author_name\` or avatar fields.
- If a comment form exists, submit via \`POST /api/comments\` and poll \`/api/comments/submissions\` for moderation status.`;
}

export function buildExperimentalRuntimePageContractNote(): string {
  return `## Runtime page contract — planner-gated

Use this only when the planner/generator explicitly opts into the runtime-rendered page path for a component.

### Proposed endpoint
- \`GET /api/runtime/pages/:slug\` → RuntimePageResponse

### Interfaces
- ${PAGE_INTERFACE}
- ${RUNTIME_PAGE_SOURCE_INTERFACE}
- ${RUNTIME_PAGE_SUPPORT_INTERFACE}
- ${RUNTIME_PAGE_SUBTREE_BINDING_INTERFACE}
- ${RUNTIME_PAGE_SECTION_INTERFACE}
- ${RUNTIME_PAGE_PLAN_INTERFACE}
- ${RUNTIME_PAGE_RESPONSE_INTERFACE}

### Contract intent
- \`runtimePlan.blockTree\` is the structural source of truth for wrapper order, nesting, columns, and section placement.
- \`runtimePlan.sections\` is an overlay for behavior/data-rich regions such as tabs, accordion, carousel, card-grid, modal, and prose clusters.
- \`runtimePlan.subtreeBindings[].sectionDebugKey\` links a structural subtree to a semantic section overlay when hybrid rendering is required.
- \`runtimePlan.support.safeForRuntime = false\` means the page should stay on a dedicated per-page component path instead of generic runtime rendering.
- Unsupported plugin blocks must be surfaced via \`runtimePlan.support.unsupportedBlocks\`; do NOT silently flatten them into generic prose.`;
}

/**
 * Generic REST safety rule that does not depend on knowing specific variables.
 * Safe to inject into any fix-agent or repair prompt.
 */
export const FLAT_REST_SAFETY_RULE =
  '## Flat REST data contract — MANDATORY\n' +
  '- This project uses flat REST objects, NOT GraphQL/WordPress rendered wrappers.\n' +
  '- NEVER write `.node`, `.nodes`, `.edges`, `.rendered`, `.items.nodes`, or similar nested accessors.\n' +
  '- Field access must be direct: `post.title`, `item.url`, `menu.items` — never `post.title.rendered` or `menu.items.nodes`.';

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
      '- `post.content` is normalized HTML, but detail components must render it through structured JSX such as `renderRichTextChildren(post.content ?? "", "post-content")` instead of `dangerouslySetInnerHTML`.',
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

  if (availableVariables.includes('`product: Product | null`')) {
    lines.push(
      `- \`product\` fields: ${formatFieldList(PRODUCT_FIELDS)}.`,
      '- Valid examples: `product.title`, `product.price`, `product.buttonText`, `product.buttonUrl`, `product.featuredImage`.',
      '- Invalid examples: `product.price.rendered`, `product.node.title`, `product.button.url`.',
    );
  }

  if (availableVariables.includes('`products: Product[]`')) {
    lines.push(
      `- Inside \`products.map(product => ...)\`, \`product\` uses fields: ${formatFieldList(PRODUCT_FIELDS)}.`,
      '- Pagination helpers available alongside `products`: `currentPage: number`, `totalPages: number`, `updatePage(nextPage: number): void`.',
      '- Valid examples inside loops: `product.price`, `product.buttonUrl`, `product.buttonText`, `product.categories[0]`.',
    );
  }

  if (availableVariables.includes('`page: Page | null`')) {
    lines.push(
      `- \`page\` fields: ${formatFieldList(PAGE_FRONTEND_FIELDS)}.`,
      '- Valid examples: `page.featuredImage`, `page.parentId`, `page.template`.',
      '- `page.content` is normalized HTML, but page components must render it through structured JSX such as `renderRichTextChildren(page.content ?? "", "page-content")` instead of `dangerouslySetInnerHTML`.',
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
