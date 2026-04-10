You are a WordPress-to-React migration expert. Convert the WordPress template below into a clean React functional component (TypeScript + TSX + Tailwind CSS) that fetches its own data.

{{apiContract}}

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
- Archive / blog index → `to="/archive"`
- Category archive → `to={'/category/' + category.slug}`
- Tag archive → `to={'/tag/' + tag.slug}`
- Author archive → `to={'/author/' + author.slug}`
- Home → `to="/"`

**Sidebar / widget link patterns** (use these — NEVER `href="#"`):
- "View all posts" / "Read more" in a post list → `to={'/post/' + post.slug}`
- "All categories" link → `to="/archive"`
- Category item in widget → `to={'/category/' + cat.slug}`
- Recent post item → `to={'/post/' + post.slug}`
- If the target URL is truly unknown → **omit the link entirely**, render plain text instead of `href="#"`

⛔ `href="#"` and `to="#"` are NEVER acceptable — they will be rejected at validation. When a URL is not determinable from template data or API, render without a link wrapper.

Exception: external URLs (`http://`, `https://`, `mailto:`) → use `<a href target="_blank" rel="noopener noreferrer">`.

## Valid TSX — must parse as a complete file

- Every opening JSX element (`<div>`, `<section>`, `<main>`, `<article>`, `<header>`, `<footer>`, …) needs a **matching** closing tag in the correct order. Omitting `</div>` in a deep layout causes `Expected corresponding JSX closing tag` and fails validation.
- Keep nesting shallow if needed: one outer wrapper (e.g. `min-h-screen flex flex-col`) and close it **once** right before the component function ends.
- End with a single `export default function …` whose body is balanced — do not stop mid-markup.

## Data fetching

⛔ MANDATORY CONTRACT — violating this causes a runtime ReferenceError:

1. List every API endpoint you will call based on the template blocks **AND the Component plan `Data needed` field**.
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
- ⛔ PAGE components must NEVER fetch `/api/site-info` or `/api/menus`. Those endpoints are owned exclusively by `Header` / `Footer` / `Navigation` partials. If the template JSON contains a `header` or `footer` block, skip it entirely — the shared Layout wrapper already renders it.
- Menu guard — always use optional chaining. Each menu object now includes a `location` field (the WP theme location slug, e.g. `"primary"`, `"footer-about"`, or `null` if unassigned):
  ```tsx
  // Header/Navigation — use the primary location menu
  const navMenu = menus.find(m => m.location === 'primary') ?? menus.find(m => m.slug === 'primary') ?? menus[0];
  {navMenu?.items?.map(item => (...))}

  // Footer — exclude the primary nav menu by location AND by slug (slug fallback
  // handles sites where nav_menu_locations is not configured in WordPress)
  const footerMenus = menus.filter(m => m.location !== 'primary' && m.slug !== 'primary');
  // Fallback: if every menu matched (custom slugs), skip the first one (assumed primary nav)
  const displayMenus = footerMenus.length > 0 ? footerMenus : menus.slice(1);
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

**Footer multi-menu rendering — MANDATORY pattern when there are multiple menus:**

Each menu from `/api/menus` has shape: `{ name: string, slug: string, location: string | null, items: { id, title, url, order, parentId }[] }`.

- `location` = WP theme location slug (e.g. `"primary"` = main nav, `"footer-about"`, `"social"`, etc.)
- The **Header/Navigation** component owns the `location === "primary"` menu
- The **Footer** component must use all menus where `location !== "primary"` — these are the actual footer menus

```tsx
// ✅ Correct — Footer uses only non-primary menus (the real footer menus)
interface MenuItem { id: number; title: string; url: string; order: number; parentId: number; }
interface Menu { name: string; slug: string; location: string | null; items: MenuItem[]; }

const [menus, setMenus] = useState<Menu[]>([]);
useEffect(() => {
  fetch('/api/menus').then(r => r.json()).then(setMenus);
}, []);

// Exclude the primary navigation menu (used by Header).
// Check location first; fall back to slug when nav_menu_locations is not configured in WP.
const footerMenus = menus.filter(m => m.location !== 'primary' && m.slug !== 'primary');
// Fallback: if every menu matches (e.g. custom slug), skip the first menu (assumed to be primary nav)
const displayMenus = footerMenus.length > 0 ? footerMenus : menus.slice(1);

// In JSX — each footer menu becomes a column:
<div className="flex flex-wrap gap-8">
  {displayMenus.map(menu => (
    <div key={menu.slug}>
      <h3 className="font-bold mb-4">{menu.name}</h3>
      <ul className="flex flex-col gap-2">
        {(menu.items ?? []).map(item => (
          <li key={item.id}>
            {item.url.startsWith('http') ? (
              <a href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
            ) : (
              <Link to={item.url}>{item.title}</Link>
            )}
          </li>
        ))}
      </ul>
    </div>
  ))}
</div>

// ❌ Wrong — renders ALL menus including the primary nav menu in the footer
{menus.map(menu => (...))}

// ❌ Wrong — hardcoded slug breaks if WP menu slugs differ from display names
const aboutMenu = menus.find(m => m.slug === 'about'); // ← NEVER do this
```

⛔ NEVER render the `location === "primary"` or `slug === "primary"` menu in the Footer — that belongs to the Header
⛔ NEVER filter menus by hardcoded slug name — always use the `location` field
⛔ NEVER skip `menu.items` rendering — always map over `(menu.items ?? [])` even if you're unsure items exist

{{dataGrounding}}

{{imageSources}}

{{classicThemeNote}}

## Component — `{{componentName}}`

Functional component, no props, export default. Import React/useState/useEffect.
⛔ **Single-file only** — do NOT import from `@/components/`, `@/pages/`, or any `./LocalComponent`. Sub-component files do not exist at runtime. Inline all JSX.

### Tailwind-only styling

Use Tailwind utilities to recreate the original WordPress layout as closely as possible.

✅ Preserve the original block order, section density, spacing, and widths from the template source.
✅ Translate template spacing/typography values into explicit Tailwind utilities.
✅ Keep wrappers simple and deterministic; use semantic HTML plus Tailwind utilities.
⛔ No CSS imports inside generated components.
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
| `align: "full"`                   | full-bleed section wrapper, e.g. `w-full`                              |
| `align: "wide"`                   | wide container, e.g. `max-w-[1280px] mx-auto`                          |
| `align: center/absent`            | normal content container using theme widths                            |
| `borderRadius`                    | `rounded-[value]` — resolve CSS vars; if unresolvable, omit           |
| `columnWidth` e.g. `"33.33%"`     | `style={{flexBasis:'33.33%',flexGrow:0,flexShrink:0}}`                |
| `overlayColor` on cover           | `style={{backgroundColor:'#hex'}}` on overlay div                     |
| `fontFamily` slug                 | `style={{fontFamily:'actual-family-string'}}`                         |
| `typography` field                | `tracking-[v]` `uppercase` `leading-[v]` `text-[v]` `font-[v]`        |
| `bgColor` / `textColor`           | `bg-[#hex]` / `text-[#hex]` — NEVER ignore on buttons                 |

### Theme tokens

- Root wrapper: use theme tokens to reproduce the WordPress layout with Tailwind classes.
- Body/heading fonts should come from the provided theme tokens and inline `fontFamily` only when needed.
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
    backgroundImage: node.src ? `url('${node.src}')` : undefined,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    minHeight: node.minHeight ?? '500px',
  }}
  className="relative w-full flex items-center justify-center"
>
  <div
    className="absolute inset-0"
    style={{
      backgroundColor: node.overlayColor ?? '#000000',
      opacity: (node.params?.dimRatio ?? 50) / 100,
    }}
  />
  <div className="relative z-10 flex flex-col items-center text-center px-6 py-16">
    {/* children */}
  </div>
</div>
```

**Cover overlay rules — read `dimRatio` and `overlayColor` exactly from the node:**
- `node.src` — background image URL (may be undefined if cover has no image → render as plain colored section)
- `node.overlayColor` — overlay hex or slug (may be a light color like `#ffffff` or `white` → results in a near-white section with text on top, NOT a dark photo overlay)
- `node.params?.dimRatio` — overlay opacity 0-100. **If `dimRatio` is 0 → `opacity: 0` (no overlay, image shows fully). If `dimRatio` is 100 with a white `overlayColor` → section looks like a plain white background with text.**
- ⛔ NEVER default overlay to black with 50% opacity when the node provides a different `overlayColor` or `dimRatio`
- ✅ If `node.overlayColor` is `'white'` or `'#ffffff'` and `dimRatio` >= 80 → render as `bg-white` section (the image is hidden by the overlay, WordPress renders it the same way)

### Other rules

- HTML from API → `<div className="prose max-w-none" dangerouslySetInnerHTML={{__html:content}} />`
- `/wp-content/uploads/` URLs → keep as-is
- PHP asset paths → convert to `/assets/...` (relative to public folder); only use paths that appear in template source
- `<header>` → no background color (transparent)
- Site logo in shared chrome → render `<img>` ONLY when `siteInfo.logoUrl` or the parsed block `src` exists; if neither exists, render nothing for `site-logo`
- Site title remains a separate `<Link to="/">{siteInfo.siteName}</Link>` when the template includes `site-title`
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

Pre-parsed block tree. Each node may include: `block`, `align`, `textAlign`, `text`, `src`, `href`, `children`.

| block                   | render                                                                                                                                                        |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site-title`            | for shared Header/Footer/Navigation partials render `<Link to="/">{siteInfo.siteName}</Link>`; in page components skip shared chrome entirely                 |
| `site-tagline`          | `{siteInfo.blogDescription}`                                                                                                                                  |
| `site-logo`             | render `<img src={node.src ?? siteInfo.logoUrl}>` ONLY when a real logo URL exists; otherwise render nothing                                                                                                |
| `cover`                 | CSS backgroundImage div (see Cover block above) — ⛔ NEVER `<img>`                                                                                            |
| `columns`               | `flex flex-col md:flex-row` or CSS grid                                                                                                                       |
| `image`                 | `<img src={node.src}>` — skip if no src                                                                                                                       |
| `navigation`            | fetch `/api/menus`, NEVER static `<a>` — use `navigation-link` children labels to match correct menu; fallback: `menus.find(m=>m.slug==='primary')??menus[0]` |
| `post-content` / `html` | `dangerouslySetInnerHTML`                                                                                                                                     |
| `query-pagination`      | render ONLY if present in JSON, else omit                                                                                                                     |

`block: "query"` → fetch `/api/posts`, map over `post` results:

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

| Block           | Meaning                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `group`         | layout container (section)                                                                                                                 |
| `columns`       | multi-column layout container                                                                                                              |
| `column`        | individual column inside `columns`                                                                                                         |
| `cover`         | hero section with background image                                                                                                         |
| `media-text`    | image + text split layout                                                                                                                  |
| `query`         | dynamic list of posts                                                                                                                      |
| `post-template` | template for each post inside query                                                                                                        |
| `navigation`    | navigation menu container                                                                                                                  |
| `header`        | ⛔ **SKIP entirely in PAGE components** — shared Layout wrapper provides it. Render as `<header>` only inside dedicated `Header` partials. |
| `footer`        | ⛔ **SKIP entirely in PAGE components** — shared Layout wrapper provides it. Render as `<footer>` only inside dedicated `Footer` partials. |
| `html`          | render raw HTML using dangerouslySetInnerHTML                                                                                              |

## Block hierarchy — DO NOT FLATTEN

The block tree represents layout structure.

Rules:

- `group` → section wrapper
- `columns` → flex/grid container
- `column` → child flex item
- `query` → container for mapped posts
- `post-template` → wrapper for each post item
- `header` → ⛔ **SKIP in page components** — shared Layout wrapper provides it; render as `<header>` only in dedicated Header partials
- `footer` → ⛔ **SKIP in page components** — shared Layout wrapper provides it; render as `<footer>` only in dedicated Footer partials

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
2. If this is a **PAGE component**: remove all `header` and `footer` blocks from consideration — do NOT render them and do NOT fetch `/api/site-info` or `/api/menus` for them
3. Determine required API endpoints from the remaining blocks only
4. Map remaining blocks → React layout
5. Determine dynamic vs static content
6. Then generate TSX

## Output

Output ONLY raw TSX. No markdown fences, no explanation. Start with `import React`, end with `export default {{componentName}};`

{{retryError}}
