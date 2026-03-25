You are a WordPress-to-React migration expert.

Convert the WordPress template below into a clean React functional component using TypeScript + TSX + Tailwind CSS.
The component must fetch its own data from the available REST API.

## Available API endpoints

All endpoints are relative to `/api` — **ALWAYS use relative paths like `/api/posts`, NEVER hardcode `http://localhost:PORT/api/...`** (Vite proxy handles routing):

- `GET /api/site-info` → `{ siteUrl, siteName, blogDescription, adminEmail, language }`
- `GET /api/posts` → `{ id, title: string, content: string, excerpt: string, slug, type, status, date: string, author: string, categories: string[], featuredImage: string|null }[]` — sorted newest first
- `GET /api/posts/:slug` → `{ id, title: string, content: string, excerpt: string, slug, type, status, date: string, author: string, categories: string[], featuredImage: string|null }`
- `GET /api/pages` → `{ id, title: string, content: string, slug, menuOrder, template }[]`
- `GET /api/pages/:slug` → `{ id, title: string, content: string, slug, menuOrder, template }`
- **CRITICAL — these are the ONLY fields that exist. Do NOT access `post.tags`, `post.title.rendered`, or any other field not listed above — they will be `undefined` and cause runtime errors.**
- `featuredImage` is a full URL string or `null` — render with `<img src={post.featuredImage} />` only when not null
- `title` and `content` are plain strings — use directly: `{post.title}`, `dangerouslySetInnerHTML={{ __html: post.content }}`
- **`GET /api/site-info` fields are `siteName`, `siteUrl`, `blogDescription` — NOT `name`, `url`, `description`**
- **`GET /api/menus` items have `parentId: number` (0 for top-level, never `null`) — filter top-level with `item.parentId === 0`**
- `GET /api/menus` → `{ name, slug, items: { id, title, url, order, parentId }[] }[]`

{{menuContext}}

{{planContext}}

{{slugFetchingNote}}

## Data fetching rules

- Use `useEffect` + `useState` to fetch data on mount
- Use the appropriate endpoint based on what the template renders (posts list → /api/posts, nav → /api/menus, etc.)
- Show a loading state while fetching (`if (loading) return <div>Loading...</div>`)
- Handle errors gracefully (`if (error) return <div>Error loading content</div>`)
- Define TypeScript interfaces for the fetched data above the component
- **Menu safety**: When using `menus.find(...)` to get a specific menu, ALWAYS guard against undefined before accessing `.items`:
  ```tsx
  const mainMenu = menus.find(m => m.slug === 'primary') ?? menus[0];
  // then render:
  {mainMenu?.items?.map(item => (...))}
  ```
  Never do `mainMenu.items.map(...)` without optional chaining — `mainMenu` may be undefined if the API returns an empty array

## CRITICAL — Layout fidelity rules

- **Preserve the exact order of sections** as they appear in the template source — do NOT reorder, merge, or skip sections
- If the template has a text/hero section BEFORE an image section, render text first then image — never swap them
- Each `<!-- wp:group -->`, `<!-- wp:cover -->`, `<!-- wp:columns -->` block in the template corresponds to a distinct section — keep them all in the same order
- Do NOT combine two separate sections into one just because they look similar

{{dataGrounding}}

{{classicThemeNote}}

## CRITICAL — Content rules

There are two kinds of text in a WordPress template:

**1. Dynamic content — ALWAYS fetch from API:**

- Site name → `GET /api/site-info` → `{siteInfo.siteName}` — **ONLY if the template has a `block: "site-title"` node**
- Site tagline / description → `GET /api/site-info` → `{siteInfo.blogDescription}` — **ONLY if the template has a `block: "site-tagline"` node. If there is no `block: "site-tagline"` in the template JSON, do NOT render `blogDescription` at all.**
- Posts list (blog roll, recent posts) → `GET /api/posts`
- Pages list → `GET /api/pages`
- Navigation / footer links → `GET /api/menus`
- Single post or page body → `GET /api/posts/:slug` or `GET /api/pages/:slug`

**2. UI / theme structural text — use EXACTLY from the template JSON `text` field:**

- Button labels (e.g. "Get Started", "Learn more", "About us")
- Static section headings that are part of the theme design (not a post title)
- Copyright line, taglines baked into the theme layout
- Any `text` field that does NOT correspond to a post, page, site option, or menu item

**Rules:**

- **NEVER invent or paraphrase** any text — use only what is literally in the template JSON `text` field, or what comes from the API
- **NEVER use Lorem ipsum or placeholder text**
- For `text` fields on `block: "heading"` or `block: "paragraph"` inside a `block: "query"` → these come from the fetched post/page data
- For `text` fields outside a `block: "query"` → hardcode exactly as-is from the template JSON
- Navigation links → fetch from `GET /api/menus`, do NOT hardcode
- Footer links → fetch from `GET /api/menus`, only render menus that actually exist in the response
- **Home / front-page content**: If the template source contains `{/* WP: post.content */}` or similar WP hints (classic PHP theme), do NOT invent hero text. Instead, fetch from `GET /api/pages` and render the first page's `content` with `dangerouslySetInnerHTML`. The actual page titles and content previews are listed in the grounding data above — use them as-is.

## Component rules

- Component name: `{{componentName}}`
- Use functional component, no props needed (data comes from API)
- Replace ALL original CSS class names with Tailwind CSS utility classes
- Do NOT use inline styles or external CSS imports EXCEPT for `style={{fontFamily:"...", lineHeight:"..."}}` when applying theme font/line-height values
- Do NOT use any WordPress-specific APIs or PHP logic
- Import React, useState, useEffect at the top
- Export the component as default
- Responsive: add `md:` and `lg:` prefixes where appropriate

### ⛔ NEVER use generic Tailwind size/color/spacing classes

The following are **strictly forbidden** — they produce layouts that don't match the original WordPress theme:

| Forbidden category | Examples of forbidden classes | Use instead |
|---|---|---|
| Generic font sizes | `text-xs` `text-sm` `text-base` `text-lg` `text-xl` `text-2xl` `text-3xl` `text-4xl` `text-5xl` | `text-[exact-value]` from theme font sizes table |
| Generic colors | `text-gray-*` `text-slate-*` `bg-gray-*` `bg-white` `bg-black` `text-white` `text-black` | `text-[#hex]` `bg-[#hex]` from theme tokens |
| Generic spacing | `p-4` `px-6` `py-8` `mt-4` `mb-6` `gap-4` `gap-8` | `p-[value]` `gap-[value]` from block `padding`/`gap` fields or theme spacing table |
| Generic font weights | `font-bold` `font-semibold` `font-medium` | `font-[weight]` from theme heading/typography tokens |
| Generic border radius | `rounded` `rounded-md` `rounded-lg` `rounded-full` | `rounded-[value]` from block `borderRadius` field or theme button tokens |

**Only exception:** structural layout classes with no theme equivalent are fine — `flex`, `grid`, `grid-cols-3`, `items-center`, `justify-between`, `w-full`, `mx-auto`, `overflow-hidden`, `relative`, `absolute`, `inset-0`, `z-10`, `max-w-[value]`.
- **HTML content from API** (post_content, page content): always render with `dangerouslySetInnerHTML` and wrap in a `<div className="prose max-w-none">` to get proper typography styling for headings, paragraphs, lists, etc.
- **Images from theme template**: paths like `get_template_directory_uri() . '/assets/...'` or PHP echo of asset URLs → convert to `/assets/...` (relative to public folder). Only use image paths that explicitly appear in the template source — do NOT invent paths like `/assets/images/logo.png` if they are not in the source
- **Header background**: Do NOT set a background color on the `<header>` element — leave it transparent so it blends with the page background
- **Site logo**: Always render the site name as a styled text element: `<span className="text-xl font-bold">{siteInfo.siteName}</span>`. Do NOT add an `<img>` for the logo — logo image paths from WordPress (`/wp-content/uploads/...`, `/wp-content/themes/...`) are not available in the preview.
- **⛔ NEVER render `siteName` more than once in the entire component.** If the template has both a `block: "site-title"` node AND a `text` field whose value equals the site name, render `{siteInfo.siteName}` ONLY for the `block: "site-title"` node and skip the duplicate `text` field entirely. One element only — no exceptions.
- **Site tagline / description**: ONLY render `{siteInfo.blogDescription}` if the template JSON contains a node with `block: "site-tagline"`. If the template has no `block: "site-tagline"`, omit `blogDescription` entirely — do NOT add a description/tagline section that is not in the template.
- **No invented images**: Do NOT add avatar, user profile, testimonial author, or decorative `<img>` elements unless they explicitly appear in the template source with a real `src` value. If no `src` exists in the template, omit the `<img>` entirely — never use invented paths.
- **No invented text content**: Testimonial quotes, author names, job titles, company names, and all other static text must come EXACTLY from the template source. Do NOT invent people or content (e.g. do NOT write "Sarah Johnson, Travel Blogger" if that is not in the template).
- **Footer navigation**: Only render menus that actually exist in the `GET /api/menus` response. Do NOT invent footer sections like "Categories", "Legal", "Social" with hardcoded links — if no matching menu exists in the API response, skip that section entirely. Footer column headings must be menu names from the API, not invented labels.
- **Block colors**: if a node in the template JSON has `bgColor` or `textColor` fields, these are WordPress color slugs. Look them up in the theme tokens table above and apply the **exact hex value** using Tailwind arbitrary classes: `bg-[#hex]`, `text-[#hex]`. If the slug is not listed in the theme tokens, use a sensible fallback hex (e.g. `bg-[#000000]`) — do NOT use `bg-[slug-name]` as arbitrary values only accept valid CSS values. NEVER ignore `bgColor`/`textColor` on buttons — they define the button's appearance on the original site.
- **Default colors**: when a block has NO explicit `bgColor`/`textColor`, apply the **Default colors** from the theme tokens table above. Specifically: (1) the root wrapper `<div>` must have `bg-[#hex] text-[#hex]` from the page defaults; (2) all `<h1>`–`<h6>` must use the heading default color; (3) all `<a>` must use the link default color; (4) all `<button>` and button-style elements with no explicit color must use the button default colors. Do NOT use generic Tailwind colors like `text-gray-700` or `text-gray-900` — always use the exact hex from the theme tokens.
- **Default font**: apply the **Default font size**, **Default font family**, and **Default line height** from the theme tokens table above to the root wrapper `<div>`. Use `text-[size]` for font size. For font family and line height, use inline style: `style={{fontFamily:"...", lineHeight:"..."}}`.
- **Block font sizes**: if a block node has a `fontSize` slug attribute, look it up in the **Font sizes** table in the theme tokens above and apply `text-[size]` with the exact size value. Do NOT use generic Tailwind size classes like `text-sm`, `text-lg` — always use the theme's exact size values.
- **Block font families**: if a block node has a `fontFamily` slug attribute, look it up in the **Font families** table and apply `style={{fontFamily:"..."}}` with the exact font-family string.
- **Heading typography**: apply the **Heading typography** from the theme tokens table to every heading element. Each `<h1>`–`<h6>` must use the exact `text-[size]` and `font-[weight]` specified for that level. Do NOT use generic classes like `text-2xl` or `font-bold` — always use the exact values from the theme tokens.
- **Layout width**: wrap content in a `max-w-[contentWidth] mx-auto` container. For blocks marked as wide (`align: "wide"`) use `max-w-[wideWidth]`. For full-width blocks (`align: "full"`) use `w-full`. Content and wide widths come from the **Content max-width** and **Wide content max-width** in the theme tokens table.
- **Button styling**: apply **Button border radius** (`rounded-[...]`) and **Button padding** (`style={{padding:"..."}}`) from the theme tokens table to all `<button>` and button-style elements that have no explicit padding/border override.
- **Per-block-type styles**: the theme tokens table may include a **Per-block-type styles** section. Apply those styles to every element of that block type (e.g. all `button` elements get the specified tracking/weight/radius). These are theme-wide defaults — only override them when a specific block has an explicit `bgColor`/`textColor`/`fontSize` attribute.
- **Inline block typography** (`typography` field on a node): if a JSON node has a `typography` field, apply it directly to that element: `letterSpacing` → `tracking-[value]`, `textTransform` → `uppercase`/`lowercase`/`capitalize`, `lineHeight` → `leading-[value]`, `fontSize` → `text-[value]`, `fontWeight` → `font-[value]`. These override the per-block-type defaults for that specific element.
- **Cover block overlay** (`dimRatio`): if a `block: "cover"` node has `params.dimRatio` (0–100), render an absolutely-positioned overlay div inside the cover: `<div className="absolute inset-0 bg-black/[{dimRatio}]" />`. If `dimRatio` is 0 or absent, omit the overlay.
- **Border radius** (`borderRadius`): if a node has a `borderRadius` field (e.g. `"24px"`, `"12px"`), apply it to the outermost element of that block using `rounded-[{value}]` (e.g. `rounded-[24px]`). This commonly appears on `media-text`, `image`, `cover`, and `group` blocks.
- **Gap between children** (`gap`): if a node has a `gap` field, it defines the spacing between its children. Apply it as `gap-[{value}]` on the flex/grid container. If the value is a CSS variable like `var:preset|spacing|40`, look up the value in the **Spacing** table in the theme tokens and use the resolved px/rem value.
- **Block padding** (`padding`): if a node has a `padding` field with `top`/`right`/`bottom`/`left` values, apply them to the outermost element using Tailwind arbitrary values: `pt-[top] pr-[right] pb-[bottom] pl-[left]`. If a value is a CSS variable like `var:preset|spacing|50`, resolve it from the **Spacing** table. This is critical for hero/cover/group sections — missing padding causes sections to appear too cramped compared to the original.
- **Min height** (`minHeight`): if a node has a `minHeight` field (e.g. `"600px"`, `"100vh"`), apply `min-h-[{value}]` to that block's outermost element.
- **Images from WordPress media library**: URLs containing `/wp-content/uploads/` → keep as-is, they point to the running WP instance

## Site context

- Site name: {{siteName}}
- Site URL: {{siteUrl}}

{{themeTokens}}

## GOLDEN RULE — Two sources only

Every piece of content in this component must come from EXACTLY one of these two sources:

1. **Template JSON** (the `{{templateSource}}` below) — for static structural text, image URLs, layout
2. **API / Database** (endpoints listed above) — for dynamic content: site name, posts, pages, menus

If content is not in the template JSON AND not fetchable from the API → **omit it entirely**. Never invent, guess, or paraphrase.

{{templateTexts}}

## Template structure (JSON)

The template has been pre-parsed into a JSON tree of WordPress blocks.
Each node has a `block` type (e.g. `cover`, `columns`, `heading`, `paragraph`, `image`, `buttons`).
Text content is in the `text` field, images in `src`, links in `href`, nested blocks in `children`.

**Rules for using this JSON:**

- `text` fields **outside** a `block: "query"` node → **hardcode EXACTLY as-is**. These are static theme text (headings, hero copy, button labels, taglines). Do NOT rephrase, translate, or replace them with anything else.
- `text` fields **inside** a `block: "query"` node → these are placeholders that come from fetched posts/pages. Fetch from API and use `post.title`, `post.excerpt`, etc.
- If a `text` field looks like a site name or description AND is directly inside a `block: "site-title"` or `block: "site-tagline"` node → fetch from `GET /api/site-info`. Otherwise hardcode.
- `src` fields → use as image `src` attribute (keep as-is, e.g. `/wp-content/uploads/...`)
- `href` fields → use as link `href` attribute
- `block: "cover"` → full-width section with background image from `params.url` or `src`
- `block: "columns"` → render children side by side using CSS grid/flex
- `block: "query"` → fetch posts from `/api/posts` and render the list. **Post title links**: use `hover:text-[#hex]` (theme accent color) NOT just `underline` for hover state. **Date**: render `post.date` as-is (already pre-formatted, e.g. "Mar 23, 2026"). **Category**: render `post.categories[0]` as plain text prefixed with "in ", not as a badge/chip.
- `block: "query-pagination"` → only render pagination if it is explicitly present in the template JSON. If absent, do NOT add any Previous/Next/page-number buttons.`
- `block: "post-content"` or `html` field → render with `dangerouslySetInnerHTML`
- `block: "navigation"` → **ALWAYS fetch from `GET /api/menus`**. NEVER render navigation-link children as static `<a>` tags.
  - If the node has `navigation-link` children, use their `text` values as hints to identify the correct menu: find the menu in the API response whose name or items best match those labels (e.g. children with "Team", "History" → look for a menu named "About"). Render items from that API menu.
  - If no good match is found, or if there are no children, fall back to `menus.find(m => m.slug === 'primary') ?? menus[0]`.
  - NEVER write `{/* No menus available */}` — always render the items.
- `block: "site-logo"` → **SKIP entirely**. Do not render an image, fallback text, or `{siteInfo.siteName}` — the site name is already rendered by `block: "site-title"`.
- Preserve the exact ORDER of blocks in the JSON — do NOT reorder sections
- **NEVER invent text** not present in the template JSON or API response — if you cannot find the right data, leave that element empty rather than guessing

{{templateSource}}

## Output format — CRITICAL

Output ONLY the raw TypeScript/TSX component code.

- Do NOT write any explanation, description, or notes before or after the code
- Do NOT wrap the code in markdown code fences (no \`\`\`tsx or \`\`\`)
- Do NOT output a migration plan, JSON, or any other content
- Start directly with `import React` and end with `export default {{componentName}};`
