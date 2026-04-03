You are a WordPress-to-React migration expert. Convert the WordPress template below into a clean React functional component (TypeScript + TSX + Tailwind CSS) that fetches its own data.

## API endpoints — relative paths only, NEVER hardcode host

| Endpoint                                    | Returns                                                               |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `GET /api/site-info`                        | `{ siteName, siteUrl, blogDescription, adminEmail, language }`        |
| `GET /api/posts`                            | `Post[]` sorted newest first                                          |
| `GET /api/posts/:slug`                      | single `Post`                                                         |
| `GET /api/pages`                            | `Page[]`                                                              |
| `GET /api/pages/:slug`                      | single `Page`                                                         |
| `GET /api/menus`                            | `{ name, slug, items: { id, title, url, order, parentId }[] }[]`      |
| `GET /api/taxonomies`                       | `string[]` — list of taxonomy slugs (e.g. `"category"`, `"post_tag"`) |
| `GET /api/taxonomies/:taxonomy`             | `Term[]` — terms for that taxonomy                                    |
| `GET /api/taxonomies/:taxonomy/:term/posts` | `Post[]` — posts filtered by taxonomy + term slug                     |
| `GET /api/comments?slug=<post-slug>`        | `Comment[]` — approved comments for a post, ordered oldest-first      |
| `GET /api/comments?postId=<id>`             | same as above, by post ID                                             |

**Post fields**: `id, title, content, excerpt, slug, type, status, date, author, categories: string[], featuredImage: string|null`
**Page fields**: `id, title, content, slug`
⛔ **Types:** If you write `interface Page { ... }`, it may **only** list those four fields (and optional React helpers). Never add `author`, `categories`, `date`, `excerpt`, `featuredImage`, `comments`, or `menuOrder` — those belong to **posts** or other APIs, not `GET /api/pages/:slug`. Do not copy a `Post` interface and rename it to `Page`.
**Term fields**: `id, name, slug, description, count, parentId`
**Comment fields**: `id, author, date, content, parentId (0 = top-level), userId`
⛔ `post.tags`, `post.title.rendered`, unlisted fields → `undefined`, runtime error.
⛔ Pages do NOT have `excerpt`, `date`, `author`, `categories`, `featuredImage`, or `comments`.
⛔ `site-info` fields: `siteName/siteUrl/blogDescription` — NOT `name/url/description`.
⛔ `menus` items: `parentId` is `number` (0 = top-level, never `null`) — filter with `item.parentId === 0`.

{{menuContext}}

{{planContext}}

{{slugFetchingNote}}

## Navigation — MANDATORY

⛔ NEVER use `<a href="...">` for internal links — this causes full page reload and breaks React Router.
✅ Always import and use `<Link to="...">` from `react-router-dom` for ALL internal navigation.

```tsx
// ❌ breaks SPA routing
<a href={'/post/' + post.slug}>{post.title}</a>;
// ✅ correct
import { Link } from 'react-router-dom';
<Link to={'/post/' + post.slug}>{post.title}</Link>;
```

Internal link paths:

- Single post → `to={'/post/' + post.slug}`
- Single page → `to={'/page/' + page.slug}`
- Archive → `to="/archive"`
- Category → `to={'/category/' + slug}`
- Home → `to="/"`

Exception: external URLs (`http://`, `https://`, `mailto:`) → use `<a href target="_blank" rel="noopener noreferrer">`.

## Valid TSX — must parse as a complete file

- Every opening JSX element (`<div>`, `<section>`, `<main>`, `<article>`, `<header>`, `<footer>`, …) needs a **matching** closing tag in the correct order. Omitting `</div>` in a deep layout causes `Expected corresponding JSX closing tag` and fails validation.
- Keep nesting shallow if needed: one outer wrapper (e.g. `min-h-screen flex flex-col`) and close it **once** right before the component function ends.
- End with a single `export default function …` whose body is balanced — do not stop mid-markup.

## Data fetching

⛔ MANDATORY CONTRACT — violating this causes a runtime ReferenceError:

1. List every API endpoint you will call based on the template blocks.
2. Declare ONE `useState` per variable BEFORE writing any JSX.
3. Fetch ALL of them together in a single `Promise.all` inside `useEffect`.
4. NEVER use `menus`, `posts`, `pages`, `siteInfo` in JSX unless you declared `useState` for it above.

```tsx
// ✅ Correct — every variable used in JSX is declared AND fetched
const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);
const [menus, setMenus] = useState<Menu[]>([]);
const [posts, setPosts] = useState<Post[]>([]);

useEffect(() => {
  const fetchData = async () => {
    const [r0, r1, r2] = await Promise.all([
      fetch('/api/site-info'),
      fetch('/api/menus'),
      fetch('/api/posts'),
    ]);
    setSiteInfo(await r0.json());
    setMenus(await r1.json());
    setPosts(await r2.json());
  };
  fetchData();
}, []);

// ❌ Wrong — menus used in JSX but no useState, no fetch → ReferenceError
const [siteInfo, setSiteInfo] = useState<SiteInfo | null>(null);
// ... JSX uses menus.find(...) ← CRASH
```

- `useEffect` + `useState`, fetch on mount, show loading/error states
- Define TypeScript interfaces above the component
- Menu guard — always use optional chaining:
  ```tsx
  const menu = menus.find(m => m.slug === 'primary') ?? menus[0];
  {menu?.items?.map(item => (...))}
  ```

## Content — two sources only

| Source                                          | When                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------- |
| `text` field in template JSON (outside `query`) | Static theme text — hardcode EXACTLY, never rephrase                   |
| `text` inside `block: "query"`                  | Dynamic — use `post.title`, `post.excerpt`, etc.                       |
| `GET /api/site-info`                            | ONLY when template has `block: "site-title"` / `block: "site-tagline"` |
| `GET /api/posts` / `GET /api/pages`             | Posts list, pages list                                                 |
| `GET /api/menus`                                | ALL nav and footer links — NEVER hardcode                              |

⛔ NEVER invent text, use Lorem ipsum, or paraphrase
⛔ NEVER render `siteName` more than once — skip duplicate `text` fields equal to site name
⛔ `blogDescription` → ONLY if template has `block: "site-tagline"`, else omit entirely
⛔ Images: render `<img>` only when `src` is non-empty in template JSON or `featuredImage` from API — no placeholders, no invented paths
⛔ Invented content: testimonial quotes, names, job titles must come exactly from template `text` fields
⛔ Footer nav: fetch `/api/menus`, group by menu → columns — NEVER hardcode links

{{dataGrounding}}

{{imageSources}}

{{classicThemeNote}}

## Component — `{{componentName}}`

Functional component, no props, export default. Import React/useState/useEffect.
⛔ **Single-file only** — do NOT import from `@/components/`, `@/pages/`, or any `./LocalComponent`. Sub-component files do not exist at runtime. Inline all JSX.

### Tailwind-only styling

⛔ No CSS imports. No `wp-block-*`, `alignwide`, `is-layout-*` classes. All layout via Tailwind + minimal `style={{}}` for `backgroundImage`, `fontFamily`, `flexBasis`, dynamic values only.
⛔ No CSS vars in Tailwind: `gap-[var(--foo)]` → BROKEN. Resolve to `gap-[24px]` first.
⛔ No bare numeric classes: `gap-1rem` → INVALID. Always `gap-[1rem]`.
⛔ HARD RULE: Tailwind arbitrary values using `min()`, `max()`, or `clamp()` must be fully compact inside the parentheses.
⛔ NEVER write `py-[min(6.5rem, 8vw)]`, `px-[max(2rem, 5vw)]`, `text-[clamp(1rem, 2vw, 2rem)]`.
✅ ALWAYS write `py-[min(6.5rem,8vw)]`, `px-[max(2rem,5vw)]`, `text-[clamp(1rem,2vw,2rem)]`.
⛔ Before returning the final TSX, remove every space after commas inside any Tailwind CSS function.

| ⛔ Avoid                                                        | ✅ Use instead            |
| --------------------------------------------------------------- | ------------------------- |
| `text-gray-*` `bg-white` `bg-black` when theme gives real color | `text-[#hex]` `bg-[#hex]` |
| `text-sm` `text-xl` when theme gives exact size                 | `text-[1.25rem]`          |
| `p-4` `gap-4` when template gives exact value                   | `p-[exact]` `gap-[exact]` |
| `font-bold` when theme gives specific weight                    | `font-[700]`              |
| `rounded-lg` when block gives radius                            | `rounded-[value]`         |

### Node field → Tailwind

| Field                             | Apply as                                                              |
| --------------------------------- | --------------------------------------------------------------------- |
| `gap`                             | `gap-[value]` on container — resolve CSS vars via Spacing table first |
| `padding` {top/right/bottom/left} | `pt-[t] pr-[r] pb-[b] pl-[l]` (values pre-resolved)                   |
| `margin` {top/right/bottom/left}  | `mt-[t] mr-[r] mb-[b] ml-[l]`                                         |
| `minHeight`                       | `min-h-[value]`                                                       |
| `textAlign`                       | `text-left/center/right`                                              |
| `align: "full"`                   | `w-full`                                                              |
| `align: "wide"`                   | `mx-auto w-full max-w-[wide-from-theme]`                              |
| `align: center/absent`            | `mx-auto w-full max-w-[content-from-theme]`                           |
| `borderRadius`                    | `rounded-[value]` — resolve CSS vars; if unresolvable, omit           |
| `columnWidth` e.g. `"33.33%"`     | `style={{flexBasis:'33.33%',flexGrow:0,flexShrink:0}}`                |
| `overlayColor` on cover           | `style={{backgroundColor:'#hex'}}` on overlay div                     |
| `fontFamily` slug                 | `style={{fontFamily:'actual-family-string'}}`                         |
| `typography` field                | `tracking-[v]` `uppercase` `leading-[v]` `text-[v]` `font-[v]`        |
| `bgColor` / `textColor`           | `bg-[#hex]` / `text-[#hex]` — NEVER ignore on buttons                 |

### Theme tokens

- Root wrapper: set bg/text colors, lineHeight only — `style={{lineHeight:"..."}}`. ⛔ NO `fontFamily` on root wrapper — body/heading fonts are injected via global CSS automatically. ⛔ NO horizontal/vertical padding on root wrapper — each section handles its own padding.
- Default block gap (from tokens table): `flex flex-col gap-[blockGap]` on root wrapper + all inner containers with no explicit `gap`
- **Fallback** (no blockGap in tokens): root → `flex flex-col gap-16`; ungapped containers → `gap-8`; group sections with no padding → `py-12 px-4 sm:px-6`
- Headings: exact token size/weight per level (`text-[3rem] font-[700]`)
- Buttons: apply theme border-radius + padding from tokens
- Per-block-type styles: apply as defaults, override only when block has explicit attribute

### Cover block

⛔ **NEVER `<img src={src}>` for cover — use CSS background:**

```tsx
<div
  style={{
    backgroundImage: `url('${src}')`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    minHeight: minHeight ?? '500px',
  }}
  className="relative w-full flex items-center justify-center"
>
  <div
    className="absolute inset-0 bg-black"
    style={{ opacity: (dimRatio ?? 0) / 100 }}
  />
  <div className="relative z-10 flex flex-col items-center text-center px-6 py-16">
    {/* children */}
  </div>
</div>
```

### Other rules

- HTML from API → `<div className="prose max-w-none" dangerouslySetInnerHTML={{__html:content}} />`
- `/wp-content/uploads/` URLs → keep as-is
- PHP asset paths → convert to `/assets/...` (relative to public folder); only use paths that appear in template source
- `<header>` → no background color (transparent)
- Site logo → `<span className="font-bold">{siteInfo.siteName}</span>`, no `<img>`
- `block: "site-logo"` → skip entirely
- Preserve exact ORDER of blocks in JSON

## Responsive — MANDATORY (mobile-first: base=mobile, sm=640, md=768, lg=1024)

| Pattern                      | Rule                                                                                            |
| ---------------------------- | ----------------------------------------------------------------------------------------------- |
| `block: "columns"`           | `flex flex-col gap-6 md:flex-row`                                                               |
| Post/card grids              | `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6`                                          |
| Section padding              | `px-4 sm:px-6 lg:px-8` on every section/group                                                   |
| Section with `padding` field | `px-4 sm:px-6 pt-[top] pb-[bottom] lg:px-[right]`                                               |
| Navigation                   | `hidden md:flex`; wrap: `<nav className="flex items-center justify-between px-4 sm:px-6 py-4">` |
| Heading ≥ 3rem               | `text-[2rem] md:text-[3rem] lg:text-[4rem]`                                                     |
| Cover min-height             | `min-h-[300px] md:min-h-[500px] lg:min-h-[600px]`                                               |
| Images                       | `w-full object-cover h-[200px] md:h-[350px] lg:h-[450px]` when no explicit height               |
| `block: "media-text"`        | `flex flex-col md:flex-row gap-6 md:gap-8 items-start`                                          |

## Site context

Site: {{siteName}} | URL: {{siteUrl}}

{{themeTokens}}

## Quick reference — common mistakes

```tsx
// ❌ CSS var inside Tailwind → NEVER works
<img className="rounded-[var(--wp--preset--spacing--20)]" />
// ✅ Resolve from Spacing table
<img className="rounded-[8px]" />

// ❌ No brackets
<div className="gap-1rem mt-2rem" />
// ✅
<div className="gap-[1rem] mt-[2rem]" />

// ❌ Space inside CSS function → Tailwind silently ignores the class, no padding applied!
<div className="py-[min(6.5rem, 8vw)] px-[max(2rem, 5vw)]" />
// ✅ No space after comma
<div className="py-[min(6.5rem,8vw)] px-[max(2rem,5vw)]" />

// ❌ Hardcoded nav/footer links
<a href="#">Team</a>
// ✅ Fetch from /api/menus — use <Link> for internal, <a> for external
{menus.map(menu => (
  <div key={menu.slug}><h3>{menu.name}</h3>
    {menu.items?.map(i => <Link key={i.id} to={i.url}>{i.title}</Link>)}
  </div>
))}

// ❌ Invented image / placeholder when no src
<div className="w-12 h-12 rounded-full bg-gray-300" />
// ✅ No src → render nothing
{node.src && <img src={node.src} className="w-full object-cover" />}

// ❌ Non-unique key → "Encountered two children with the same key" warning
{items.map(item => <li key={item.email}>{item.name}</li>)}
{items.map(item => <li key={item.title}>{item.title}</li>)}
// ✅ Always use a unique id, or fall back to index
{items.map((item, i) => <li key={item.id ?? i}>{item.name}</li>)}
```

## Final self-check before returning code

- If any `className` contains `min(`, `max(`, or `clamp(`, ensure every comma is immediately followed by the next token with no space.
- Bad: `py-[min(6.5rem, 8vw)]`
- Good: `py-[min(6.5rem,8vw)]`

## GOLDEN RULE

Content from EXACTLY one of: (1) template JSON `text`/`src`/`href` fields, or (2) API. Not in either → **omit entirely**.

{{templateTexts}}

## Template JSON

Pre-parsed block tree. Each node: `block` type, `text`, `src`, `href`, `children`.

| block                   | render                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site-title`            | `{siteInfo.siteName}` — once only in entire component                                                                                                         |
| `site-tagline`          | `{siteInfo.blogDescription}`                                                                                                                                  |
| `site-logo`             | skip entirely                                                                                                                                                 |
| `cover`                 | CSS backgroundImage div (see Cover block above) — ⛔ NEVER `<img>`                                                                                            |
| `columns`               | `flex flex-col md:flex-row` or CSS grid                                                                                                                       |
| `image`                 | `<img src={node.src}>` — skip if no src                                                                                                                       |
| `navigation`            | fetch `/api/menus`, NEVER static `<a>` — use `navigation-link` children labels to match correct menu; fallback: `menus.find(m=>m.slug==='primary')??menus[0]` |
| `post-content` / `html` | `dangerouslySetInnerHTML`                                                                                                                                     |
| `query-pagination`      | render ONLY if present in JSON, else omit                                                                                                                     |

`block: "query"` → fetch `/api/posts`, map over results:

| inner block           | render                                                                      |
| --------------------- | --------------------------------------------------------------------------- |
| `post-title`          | `<Link to={'/post/'+post.slug}>{post.title}</Link>`                         |
| `post-date`           | `<time className="whitespace-nowrap">{post.date}</time>`                    |
| `post-author`         | `<span>by {post.author}</span>`                                             |
| `post-excerpt`        | `<p>{post.excerpt}</p>`                                                     |
| `post-featured-image` | `{post.featuredImage && <img src={post.featuredImage} alt={post.title} />}` |
| `post-terms`          | `<span>{post.categories[0]}</span>` (plain text, no badge)                  |

Post list layout: mirror template structure — row layout → `flex items-baseline gap-4` with `flex-1` on title, `whitespace-nowrap shrink-0` on date/meta; card layout → `grid grid-cols-1 gap-6`.

⛔ NEVER invent text not in template or API — leave empty rather than guess.

{{templateSource}}

## WordPress block semantics

Blocks form a hierarchical tree. Parent blocks control layout.

| Block           | Meaning                                       |
| --------------- | --------------------------------------------- |
| `group`         | layout container (section)                    |
| `columns`       | multi-column layout container                 |
| `column`        | individual column inside `columns`            |
| `cover`         | hero section with background image            |
| `media-text`    | image + text split layout                     |
| `query`         | dynamic list of posts                         |
| `post-template` | template for each post inside query           |
| `navigation`    | navigation menu container                     |
| `header`        | page header (site branding + navigation)      |
| `footer`        | page footer (links, copyright, alt info)      |
| `html`          | render raw HTML using dangerouslySetInnerHTML |

## Block hierarchy — DO NOT FLATTEN

The block tree represents layout structure.

Rules:

- `group` → section wrapper
- `columns` → flex/grid container
- `column` → child flex item
- `query` → container for mapped posts
- `post-template` → wrapper for each post item
- `header` → top page structure in `<header>`
- `footer` → bottom page structure in `<footer>`

⛔ NEVER move children outside their parent block.
⛔ NEVER flatten nested layout blocks.

## Header/Footer fidelity

**For Header and Footer partial components** (when `componentName` starts with `Header` or `Footer`):

- `header` should become `<header>` with its child blocks and compound layout.
- `footer` should become `<footer>` with link columns, menus, site info, and credit elements.
- Respect block order and spacing (e.g., if header has nav + banner, keep order).
- Fetch menus from `/api/menus` and render ALL navigation items — never hardcode links.
- Do not produce a generic placeholder when the template explicitly defines these blocks.

**For PAGE components** (any other component): ⛔ Do NOT render a `<header>` or `<footer>` — they are provided by the shared Layout wrapper.

⛔ NEVER flatten nested layout blocks.

## Block attributes

Each block may contain an `attrs` object.

Example:

```json
{
  "block": "group",
  "attrs": {
    "align": "wide",
    "style": {
      "spacing": { "padding": { "top": "2rem" } }
    }
  }
}
```

Rules:

- Always read attributes from `attrs`
- Layout attributes affect the wrapper element
- Style attributes must be converted to Tailwind utilities

## Query loop structure

`block: "query"` always contains a `post-template` child block.

Correct mapping:

```
query
  post-template
    post-title
    post-date
```

↓

```tsx
posts.map((post) => (
  <article key={post.id}>
    <Link to={'/post/' + post.slug}>{post.title}</Link>
    <time>{post.date}</time>
  </article>
));
```

## Layout block mapping

| WordPress block | React layout                      |
| --------------- | --------------------------------- |
| group           | `<section>`                       |
| columns         | `flex flex-col md:flex-row`       |
| column          | `<div className="flex-1">`        |
| stack           | `flex flex-col`                   |
| row             | `flex flex-row`                   |
| media-text      | `flex flex-col md:flex-row gap-8` |

## Anti-hallucination rules

⛔ NEVER create sections that do not exist in the template JSON.

Do NOT invent:

- hero sections
- testimonials
- feature cards
- placeholder images
- lorem ipsum text

Only render blocks present in the template tree.

## Rendering guard

Always guard arrays before mapping:

```tsx
{menus?.length > 0 && menus.map(...)}
```

or

```tsx
const menu = menus.find(...) ?? menus[0];
{menu?.items?.map(...)}
```

## Component structure

File order must be:

1. imports
2. TypeScript interfaces
3. React component
4. useState declarations
5. useEffect data fetching
6. loading/error guards
7. JSX return
8. export default

## Internal reasoning (do NOT output)

Before writing code:

1. Identify blocks in the template tree
2. Determine required API endpoints
3. Map blocks → React layout
4. Determine dynamic vs static content
5. Then generate TSX

## Output

Output ONLY raw TSX. No markdown fences, no explanation. Start with `import React`, end with `export default {{componentName}};`

{{retryError}}
