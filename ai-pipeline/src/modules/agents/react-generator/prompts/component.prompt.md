You are a WordPress-to-React migration expert. Convert the WordPress template below into a clean React functional component (TypeScript + TSX + Tailwind CSS) that fetches its own data.

{{apiContract}}

{{menuContext}}

{{planContext}}

{{slugFetchingNote}}

## Hard Contract

- Use ONLY the API endpoints explicitly allowed in the plan/context above.
- Render ONLY sections and data justified by the source template or approved visual plan.
- This is a migration, not a redesign: preserve the original WordPress structure, spacing density, and visual hierarchy.
- Do NOT fetch extra list/helper endpoints "just in case". If an endpoint is not approved, do not call it.
- Do NOT invent hero blocks, utility sidebars, promo widgets, fallback link groups, or placeholder content.
- Preserve approved section boundaries exactly. If the approved plan has separate top-level sections for text and for a later image/media block, keep them as separate top-level JSX wrappers.
- Do NOT pull an image from a later approved section up beside an earlier heading/paragraph/CTA block.
- `flex-row`, split hero, and side-by-side text/image layouts are allowed only when the approved section itself is a real `media-text` section or a `hero` whose approved layout is already `split`.

## Navigation — MANDATORY

⛔ NEVER use `<a href="...">` for internal links — this causes full page reload and breaks React Router.
✅ Always import and use `<Link to="...">` from `react-router-dom` for ALL internal navigation.
⛔ ONLY create internal links for routes explicitly approved by the frontend/app contract in the prompt context above. If a route is not approved, render plain text instead of guessing a path.

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
- Home → `to="/"`
- Category archive → when the app contract/known routes include `/category/:slug`, use `to={'/category/' + slug}`
- Author archive routes may exist in the app contract. In ordinary post meta/listings, author names should link to `/author/${post.authorSlug}` when that route is approved and `post.authorSlug` exists.
- Archive / taxonomy links → use them ONLY when those routes are explicitly approved in the contract/context above
- Use `post.author` as display text. Plain-text author is only acceptable when it is the actual heading/title content, such as an `h1` for an author/archive/detail page title.
- If `/category/:slug` is approved, category names in post meta/listings may link to that route using `post.categorySlugs[index]`; if the matching slug is unavailable, render plain text instead of guessing

⛔ **CRITICAL — route check before every author/category link:**

```tsx
// ❌ WRONG — if /author/:slug is NOT in the known app routes list above, NEVER write this
<Link to={`/author/${post.authorSlug}`}>{post.author}</Link>

// ✅ CORRECT — /author/:slug not in known routes → render plain text, no Link
<span>{post.author}</span>

// ❌ WRONG — if /category/:slug is NOT in the known app routes list above, NEVER write this
<Link to={`/category/${post.categorySlugs?.[0]}`}>{post.categories?.[0]}</Link>

// ✅ CORRECT — /category/:slug not in known routes → render plain text, no Link
<span>{post.categories?.[0]}</span>
```

Check the "known app routes" list in the contract above **before writing any author or category Link**. If the route is absent, output `<span>` only.

**Sidebar / widget link patterns** (use these — NEVER `href="#"`):

- "View all posts" / "Read more" in a post list → `to={'/post/' + post.slug}`
- Category/archive widget links → when `/category/:slug` is approved, use `to={'/category/' + term.slug}` or `to={'/category/' + post.categorySlugs[index]}` from known data; otherwise render plain text
- Author meta links → when `/author/:slug` is approved and the label is part of a meta row/listing rather than the main heading/title, use `to={'/author/' + post.authorSlug}`.
- Recent post item → `to={'/post/' + post.slug}`
- If the target URL is truly unknown → **omit the link entirely**, render plain text instead of `href="#"`

⛔ `href="#"` and `to="#"` are NEVER acceptable — they will be rejected at validation. When a URL is not determinable from template data or API, render without a link wrapper.

Exception: external URLs (`http://`, `https://`, `mailto:`) → use `<a href target="_blank" rel="noopener noreferrer">`.

## Archive Alias Contract

- The `Archive` component is a WordPress archive fallback. Even when the canonical plan route is `/archive`, it must also serve alias routes such as `/category/:slug`, `/author/:slug`, and `/tag/:slug`.
- For this archive fallback, import/use `useLocation` and `useParams` to detect which alias route is active. Do NOT treat it as a plain static `/archive` page.
- Category archive hero/title must include the literal prefix `Category:` followed by the resolved term label, for example `Category: Uncategorized`.
- Author archive hero/title must include the literal prefix `Author:`.
- Tag archive hero/title must include the literal prefix `Tag:`.
- Only the plain `/archive` route may render a generic `Archive` title.
- Category routes must fetch the category-filtered archive endpoint, not the full `/api/posts` list.
- Author routes must fetch the author-filtered archive endpoint, not the full `/api/posts` list without filters.

## Valid TSX — must parse as a complete file

- Every opening JSX element (`<div>`, `<section>`, `<main>`, `<article>`, `<header>`, `<footer>`, …) needs a **matching** closing tag in the correct order. Omitting `</div>` in a deep layout causes `Expected corresponding JSX closing tag` and fails validation.
- Keep nesting shallow if needed: one outer wrapper (e.g. `min-h-screen flex flex-col`) and close it **once** right before the component function ends.
- End with a single `export default function …` whose body is balanced — do not stop mid-markup.

## Data fetching

⛔ MANDATORY CONTRACT — violating this causes a runtime ReferenceError:

1. List every API endpoint you will call based on the template blocks **AND the Component plan `Data needed` field**.
   Those endpoints must be a subset of the explicitly allowed endpoints in the plan/context above.
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
| `GET /api/footer-links`                         | Footer link columns from WordPress template part — shape: `{ heading: string; links: { label: string; url: string }[] }[]` |

⛔ NEVER invent text, use Lorem ipsum, or paraphrase
⛔ NEVER render `siteName` more than once — skip duplicate `text` fields equal to site name
⛔ `blogDescription` → ONLY if template has `block: "site-tagline"`, else omit entirely
⛔ Images: render `<img>` only when `src` is non-empty in template JSON or `featuredImage` from API — no placeholders, no invented paths
⛔ Invented content: testimonial quotes, names, job titles must come exactly from template `text` fields
⛔ Footer nav: ALWAYS fetch `/api/footer-links` for footer columns. You may also fetch `/api/menus`, but only to read non-primary footer/social groups. If those menu groups are absent, fall back to `/api/footer-links` columns — NEVER hardcode links

**Footer multi-menu rendering — MANDATORY pattern:**

Each menu from `/api/menus` has shape: `{ name: string, slug: string, location: string | null, items: { id, title, url, order, parentId }[] }`.
Each column from `/api/footer-links` has shape: `{ heading: string; links: { label: string; url: string }[] }`.

- `location` = WP theme location slug (e.g. `"primary"` = main nav, `"footer-about"`, `"social"`, etc.)
- The **Header/Navigation** component owns the `location === "primary"` menu
- The **Footer** component must always fetch `/api/footer-links`
- The **Footer** component may also fetch `/api/menus` in the same `Promise.all`, but only to read non-primary footer/social groups
- Render priority: non-primary menus from `/api/menus` first; if none, use `/api/footer-links` columns; if neither, render nothing
- `item.url` from `/api/menus` is already canonical. Use `<Link to={item.url}>` directly — never prefix it.

```tsx
// ✅ Correct — footer-links is mandatory, menus are optional enrichment
interface MenuItem { id: number; title: string; url: string; order: number; parentId: number; }
interface Menu { name: string; slug: string; location: string | null; items: MenuItem[]; }
interface FooterColumn { heading: string; links: { label: string; url: string }[]; }

const [menus, setMenus] = useState<Menu[]>([]);
const [footerColumns, setFooterColumns] = useState<FooterColumn[]>([]);

useEffect(() => {
  Promise.all([fetch('/api/menus'), fetch('/api/footer-links')])
    .then(([r1, r2]) => Promise.all([r1.json(), r2.json()]))
    .then(([menusData, colsData]) => {
      setMenus(menusData);
      setFooterColumns(Array.isArray(colsData) ? colsData : []);
    });
}, []);

// Exclude primary nav menu
const footerMenus = menus.filter(m => m.location !== 'primary' && m.slug !== 'primary');
const displayMenus = footerMenus.length > 0 ? footerMenus : menus.slice(1);

// In JSX — menus first, footer-links as fallback:
{displayMenus.length > 0 ? (
  <div className="flex flex-wrap gap-8">
    {displayMenus.map(menu => (
      <div key={menu.slug}>
        <h3 className="font-bold mb-4">{menu.name}</h3>
        <nav className="flex flex-col gap-2">
          {(menu.items ?? []).map(item => (
            item.url.startsWith('http') ? (
              <a key={item.id} href={item.url} target="_blank" rel="noopener noreferrer">{item.title}</a>
            ) : (
              <Link key={item.id} to={item.url}>{item.title}</Link>
            )
          ))}
        </nav>
      </div>
    ))}
  </div>
) : footerColumns.length > 0 ? (
  <div className="flex flex-wrap gap-8">
    {footerColumns.map(col => (
      <div key={col.heading}>
        <h3 className="font-bold mb-4">{col.heading}</h3>
        <nav className="flex flex-col gap-2">
          {col.links.map(link => (
            link.url.startsWith('http') ? (
              <a key={link.label} href={link.url} target="_blank" rel="noopener noreferrer">{link.label}</a>
            ) : (
              <Link key={link.label} to={link.url}>{link.label}</Link>
            )
          ))}
        </nav>
      </div>
    ))}
  </div>
) : null}

// ❌ Wrong — renders ALL menus including the primary nav menu in the footer
{menus.map(menu => (...))}

// ❌ Wrong — hardcoded slug breaks if WP menu slugs differ from display names
const aboutMenu = menus.find(m => m.slug === 'about'); // ← NEVER do this

// ❌ Wrong — hardcoded fallback columns when API returns empty
{displayMenus.length === 0 && <div><h3>About</h3><span>Team</span></div>}
```

⛔ NEVER render the `location === "primary"` or `slug === "primary"` menu in the Footer — that belongs to the Header
⛔ NEVER choose menus by arbitrary content slugs like `about`, `company`, `resources`, `links`. Use `location` first; `slug === "primary"` is allowed only as a fallback when `location` is missing.
⛔ NEVER skip `menu.items` rendering — always map over `(menu.items ?? [])` even if you're unsure items exist
⛔ NEVER hardcode footer columns/links as fallback — if both APIs return empty, render nothing

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
| `align: "full"`                   | full-bleed section wrapper, e.g. `w-full`                             |
| `align: "wide"`                   | wide container, e.g. `max-w-[1280px] mx-auto`                         |
| `align: center/absent`            | normal content container using theme widths                           |
| `borderRadius`                    | `rounded-[value]` — resolve CSS vars; if unresolvable, omit           |
| `columnWidth` e.g. `"33.33%"`     | `style={{flexBasis:'33.33%',flexGrow:0,flexShrink:0}}`                |
| `overlayColor` on cover           | `style={{backgroundColor:'#hex'}}` on overlay div                     |
| `fontFamily` slug                 | `style={{fontFamily:'actual-family-string'}}` only when that node/block explicitly overrides inherited theme font |
| `typography` field                | `tracking-[v]` `uppercase` `leading-[v]` `text-[v]` `font-[v]`        |
| `bgColor` / `textColor`           | `bg-[#hex]` / `text-[#hex]` — NEVER ignore on buttons                 |

### Theme tokens

- Root wrapper: use theme tokens to reproduce the WordPress layout with Tailwind classes.
- Body/heading fonts should come from the provided theme tokens and inherited global CSS first. Do NOT add inline `fontFamily` on the page root or every section by default.
- Inline `fontFamily` is only for blocks/nodes that explicitly override the inherited theme font.
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
- WordPress upload/media URLs should use the local preview asset path exactly as provided (`/assets/...` or `/assets/images/...`). Do NOT rewrite them back to remote WordPress URLs.
- PHP asset paths → convert to `/assets/...` (relative to public folder); only use paths that appear in template source
- `<header>` → no background color (transparent)
- Site logo in shared chrome → render `<img>` ONLY when `siteInfo.logoUrl` or the parsed block `src` exists; if neither exists, render nothing for `site-logo`
- Brand in shared chrome → when the template includes `site-logo` and/or `site-title`, wrap the entire visible brand cluster in ONE home link. Do NOT leave the logo outside that link.
  - **Header**: logo and site name are side-by-side → `<Link to="/" className="flex items-center gap-3">{logo}{siteInfo.siteName}</Link>`
  - **Footer**: logo and site name are stacked vertically (logo above, name below) → `<Link to="/" className="flex flex-col gap-2 w-fit">{logo}<span>{siteInfo.siteName}</span></Link>`
  - Always follow the block order in the template JSON — if logo block comes before site-title block, logo renders first (top/left).
- Preserve exact ORDER of blocks in JSON

## Responsive — MANDATORY (mobile-first: base=mobile, sm=640, md=768, lg=1024)

| Pattern                      | Rule                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `block: "columns"`           | `flex flex-col gap-6 md:flex-row`                                                                                                                                       |
| Post/card grids              | `grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-6`                                                                                                                  |
| Section padding              | `px-4 sm:px-6 lg:px-8` on every section/group                                                                                                                           |
| Section with `padding` field | `px-4 sm:px-6 pt-[top] pb-[bottom] lg:px-[right]`                                                                                                                       |
| Navigation                   | `hidden md:flex`; wrap: `<nav className="flex items-center justify-between px-4 sm:px-6 py-4">`                                                                         |
| Heading ≥ 3rem               | `text-[2rem] md:text-[3rem] lg:text-[4rem]`                                                                                                                             |
| Cover min-height             | `min-h-[300px] md:min-h-[500px] lg:min-h-[600px]`                                                                                                                       |
| Images                       | `w-full object-cover h-[200px] md:h-[350px] lg:h-[450px]` only for decorative crops; for important screenshots/product composites prefer `w-full h-auto object-contain` |
| `block: "media-text"`        | `flex flex-col md:flex-row gap-6 md:gap-8 items-start`                                                                                                                  |

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

// ❌ Crop a real UI/screenshot image with fixed-height object-cover
<img src={node.src} className="w-full object-cover h-[200px] md:h-[350px] lg:h-[450px]" />
// ✅ Preserve the full screenshot/product composite unless the source is clearly cropped
<img src={node.src} className="w-full h-auto object-contain" />

// ❌ Missing customClassNames — hover animation won't fire
<img src={node.src} className="w-full h-auto object-contain vp-generated-image" />
// ✅ Image: customClassNames on <img> alongside vp-generated-image
<img src={node.src} className="w-full h-auto object-contain vp-generated-image vp-hover-lift" />

// ❌ Missing customClassNames on link
<Link to={item.url} className="vp-generated-link">{item.title}</Link>
// ✅ Link: customClassNames on <Link> or <a> alongside vp-generated-link
<Link to={item.url} className="vp-generated-link vp-hover-underline">{item.title}</Link>

// ❌ Missing customClassNames on card wrapper
<article className="rounded-lg p-4">{/* card content */}</article>
// ✅ Card: customClassNames on outermost card element
<article className="rounded-lg p-4 vp-hover-lift">{/* card content */}</article>

// ❌ Non-unique key → "Encountered two children with the same key" warning
{items.map(item => <li key={item.email}>{item.name}</li>)}
{items.map(item => <li key={item.title}>{item.title}</li>)}
// ✅ Always use a unique id, or fall back to index
{items.map((item, i) => <li key={item.id ?? i}>{item.name}</li>)}

// ❌ BROKEN JSX — nested extra braces around a JSX expression create an invalid object literal
{post.categories?.[0] && (
  {post.categories[0] && (<span>{post.categories[0]}</span>)}
)}
{post.author && (
  {post.author && (<span>{post.author}</span>)}
)}
// ✅ Single conditional — no extra brace layer around JSX
{post.categories?.[0] && <span>{post.categories[0]}</span>}
{post.author && <span>{post.author}</span>}
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

| block                   | render                                                                                                                                                                                                               |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `site-title`            | for shared Header/Footer/Navigation partials render it inside the brand home link; if `site-logo` is also present, both logo + title belong inside the SAME `<Link to="/">...</Link>`                                |
| `site-tagline`          | `{siteInfo.blogDescription}`                                                                                                                                                                                         |
| `site-logo`             | render `<img src={node.src ?? siteInfo.logoUrl}>` ONLY when a real logo URL exists; if `site-title` is also rendered, place the logo inside the same home link wrapper as the title                                  |
| `cover`                 | CSS backgroundImage div (see Cover block above) — ⛔ NEVER `<img>`                                                                                                                                                   |
| `columns`               | `flex flex-col md:flex-row` or CSS grid                                                                                                                                                                              |
| `image`                 | `<img src={node.src}>` — skip if no src                                                                                                                                                                              |
| `navigation`            | fetch `/api/menus`, NEVER static `<a>` — use `navigation-link` children labels to match the correct menu; fallback: `menus.find(m => m.location === 'primary') ?? menus.find(m => m.slug === 'primary') ?? menus[0]` |
| `post-content` / `html` | `dangerouslySetInnerHTML`                                                                                                                                                                                            |
| `query-pagination`      | render ONLY if present in JSON, else omit                                                                                                                                                                            |

`block: "query"` → fetch `/api/posts`, map over `post` results:

| inner block           | render                                                                                                                                                                                                             |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `post-title`          | `<Link to={'/post/'+post.slug} className="hover:underline underline-offset-4">{post.title}</Link>`                                                                                                                 |
| `post-date`           | `<time className="whitespace-nowrap">{post.date}</time>`                                                                                                                                                           |
| `post-author`         | `{post.author && (post.authorSlug ? <Link to={'/author/' + post.authorSlug} className="hover:underline underline-offset-4">by {post.author}</Link> : <span>by {post.author}</span>)}`                              |
| `post-excerpt`        | `<p>{post.excerpt}</p>`                                                                                                                                                                                            |
| `post-featured-image` | `{post.featuredImage && <img src={post.featuredImage} alt={post.title} />}`                                                                                                                                        |
| `post-terms`          | `{post.categories[0] && (post.categorySlugs[0] ? <Link to={'/category/' + post.categorySlugs[0]} className="hover:underline underline-offset-4">{post.categories[0]}</Link> : <span>{post.categories[0]}</span>)}` |

Post list layout: mirror template structure — row layout → `flex items-baseline gap-4` with `flex-1` on title, `whitespace-nowrap shrink-0` on date/meta; card layout → `grid grid-cols-1 gap-6`.

Use the explicit ternary form above for author/category meta. Do not wrap JSX branches in extra braces like `{cond && ({...})}` because that often leads to invalid TSX such as `"," expected`.

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
- Header/Nav should fetch menus from `/api/menus` and render navigation items — never hardcode links.
- Footer should always fetch `/api/footer-links`; `/api/menus` is optional and only for non-primary footer/social groups.
- Do not produce a generic placeholder when the template explicitly defines these blocks.

**For PAGE components** (any other component): ⛔ Do NOT render a `<header>` or `<footer>` — they are provided by the shared Layout wrapper.

⛔ NEVER flatten nested layout blocks.

## Block attributes

Each block may contain an `attrs` object.
Some nodes may also contain `customClassNames`.

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
- If a node includes `customClassNames`, preserve those classes on the equivalent JSX element:
  - For **container/card nodes** (group, cover, columns, or any repeating item wrapper): apply to the **outermost wrapper element** — not to a child heading, image, or text.
  - For **image nodes** (`block: "image"`): apply directly on the `<img>` element alongside `vp-generated-image`. Example: `customClassNames: ["vp-hover-lift"]` → `<img className="vp-generated-image vp-hover-lift ..." />`.
  - For **button nodes**: apply on the `<button>` or `<a>` element alongside `vp-generated-button`. Example: `customClassNames: ["vp-hover-shadow"]` → `<button className="vp-generated-button vp-hover-shadow ..." />`.
  - For **link / navigation-link nodes**: apply on the `<Link>` or `<a>` element alongside `vp-generated-link`. Example: `customClassNames: ["vp-hover-underline"]` → `<Link className="vp-generated-link vp-hover-underline ..." />`.
  - For **card / repeating item wrappers** (post cards, testimonial cards, feature cards): apply on the outermost `<article>` or `<div>` of each card alongside any bridge class. Example: `customClassNames: ["vp-hover-lift"]` → `<article className="vp-hover-lift ..." />`.
  - These classes drive precise CSS interaction bridges (e.g., hover translate, lift, zoom, shadow) that are pre-generated in `index.css`. **Missing them = no animation.**
- **NEVER remove `vp-generated-button`, `vp-generated-image`, or `vp-generated-link` classes** from any element. These are injected by the pipeline's interaction bridge and power hover/focus/transition CSS. If you receive code containing these classes, keep them exactly as-is.
- **NEVER use WordPress block style classes** (`is-style-rounded`, `is-style-default`, `is-style-outline`, etc.) as styling — these have no CSS definition in the React app and silently do nothing. Convert them to Tailwind:
  - `is-style-rounded` on image → `rounded-[min(1.5rem,2vw)]`
  - `is-style-outline` on button → `border border-current bg-transparent` (keep `vp-generated-button` alongside)
- **Card bridge classes**: if the theme tokens list a `card (.some-class)` interaction bridge, that exact class name MUST appear on the outermost `<div>` or `<article>` of each repeated card/item — never implement the effect with Tailwind `hover:` utilities or `onMouseEnter` when the CSS class is already provided.
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
- heading-only sections (e.g. `<section><h2>About</h2></section>` with no real content)

Only render blocks present in the template tree.

⛔ **NEVER generate a section whose only content is a bare heading word like "About", "About Us", "Overview", "Introduction", or any other generic label** without real data-driven content beneath it. If a section plan has a label but no actual content nodes (no paragraphs, no images, no list items, no data), **omit the section entirely**. A heading with no body is always a hallucination artifact.

⛔ **CRITICAL — `post-content` / `page-content` double-render prevention:**

When the template contains a `post-content` or `html` block that is rendered via `dangerouslySetInnerHTML`, ALL child content (headings, paragraphs, images, buttons) inside that block is already included in `item.content`. Do NOT also render those child blocks as separate JSX elements outside `dangerouslySetInnerHTML`.

```tsx
// ❌ WRONG — "About" heading is already inside item.content from dangerouslySetInnerHTML
<div dangerouslySetInnerHTML={{ __html: item.content }} />
<section>
  <h2>About</h2>  {/* ← hallucinated duplicate */}
</section>

// ✅ CORRECT — render page content ONCE via dangerouslySetInnerHTML, nothing else
<div className="prose max-w-none" dangerouslySetInnerHTML={{ __html: item.content }} />
```

If the template JSON has individual heading/paragraph/image nodes inside a `post-content` or `page-content` section, treat them as metadata for understanding structure only — do NOT render them as separate JSX blocks.

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
