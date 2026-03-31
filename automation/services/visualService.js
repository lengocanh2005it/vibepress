"use strict";

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const PNG = require("pngjs").PNG;
const axios = require("axios");
const xml2js = require("xml2js");

const { PORT } = require("../config/constants");
const { normalizeBaseUrl } = require("./textUtils");

const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts");

// ─── CONFIG ────────────────────────────────────────────────────────────────

// page: lấy hết (số lớn); còn lại sample 1 đại diện mỗi type.
// Bất kỳ type nào không có trong đây → DEFAULT_TYPE_LIMIT.
const DEFAULT_TYPE_LIMIT = 1;
const SAMPLE_LIMITS = {
  homepage: 1,
  post:     1,
  page:     9999,
  category: 1,
  tag:      1,
};

// ─── UTILS ─────────────────────────────────────────────────────────────────

async function getPixelmatch() {
  const mod = await import("pixelmatch");
  return mod.default;
}

function sanitizeName(input) {
  return (
    String(input || "site")
      .replace(/https?:\/\//gi, "")
      .replace(/[^a-z0-9.-]+/gi, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "site"
  );
}

function normalizeComparableUrl(input) {
  try {
    const parsed = new URL(String(input || ""));
    parsed.hash = "";
    parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
    return parsed.toString();
  } catch {
    return String(input || "").trim();
  }
}

function isSameTargetUrl(a, b) {
  return normalizeComparableUrl(a) === normalizeComparableUrl(b);
}

function isNavigationInterruptedError(err) {
  return /interrupted by another navigation/i.test(String(err?.message || ""));
}

async function gotoWithFallback(page, url) {
  // For localhost Vite SPAs, networkidle never resolves (HMR WebSocket stays open).
  // Use domcontentloaded for localhost, networkidle only for real remote sites.
  const isLocalhost = /^https?:\/\/localhost(:\d+)?/i.test(url);

  const attempts = isLocalhost
    ? [
        { waitUntil: "domcontentloaded", timeout: 30000 },
        { waitUntil: "load", timeout: 60000 },
      ]
    : [
        { waitUntil: "networkidle", timeout: 30000 },
        { waitUntil: "domcontentloaded", timeout: 45000 },
        { waitUntil: "load", timeout: 60000 },
      ];

  let lastError = null;
  for (const attempt of attempts) {
    try {
      await page.goto(url, attempt);
      return attempt.waitUntil;
    } catch (err) {
      // If browser/app has already navigated to the same target, treat it as success.
      if (isNavigationInterruptedError(err)) {
        try {
          await page.waitForURL(
            (current) => isSameTargetUrl(current.href, url),
            { timeout: 10000 },
          );
          await page
            .waitForLoadState("domcontentloaded", { timeout: 10000 })
            .catch(() => {});
          return `${attempt.waitUntil}-recovered`;
        } catch {
          if (isSameTargetUrl(page.url(), url)) {
            await page
              .waitForLoadState("domcontentloaded", { timeout: 10000 })
              .catch(() => {});
            return `${attempt.waitUntil}-recovered`;
          }
        }
      }
      lastError = err;
      try {
        await page.goto("about:blank", { timeout: 5000 });
      } catch {
        // ignore
      }
    }
  }
  throw lastError;
}

async function runInteractions(page, interactions = []) {
  for (const step of interactions) {
    switch (step.action) {
      case "click":
        await page.locator(step.selector).first().click({ timeout: 8000 });
        await page.waitForTimeout(step.waitAfter ?? 500);
        break;
      case "hover":
        await page.locator(step.selector).first().hover({ timeout: 8000 });
        await page.waitForTimeout(step.waitAfter ?? 300);
        break;
      case "wait":
        await page.waitForTimeout(step.ms ?? 500);
        break;
      default:
        break;
    }
  }
}

async function captureScreenshot(
  page,
  url,
  filePath,
  fullPage,
  interactions = [],
) {
  let navigationMode = "reused";
  if (!isSameTargetUrl(page.url(), url)) {
    navigationMode = await gotoWithFallback(page, url);
  } else {
    await page
      .waitForLoadState("domcontentloaded", { timeout: 10000 })
      .catch(() => {});
  }
  await page.waitForTimeout(1200);
  await runInteractions(page, interactions);
  await page.screenshot({ path: filePath, fullPage });
  return navigationMode;
}

async function captureDomStructure(page) {
  return page.evaluate(() => {
    const freq = {};
    document.querySelectorAll("*").forEach((el) => {
      const tag = el.tagName.toLowerCase();
      freq[tag] = (freq[tag] || 0) + 1;
    });
    return freq;
  });
}

function compareDomStructure(freqA, freqB) {
  const allTags = new Set([...Object.keys(freqA), ...Object.keys(freqB)]);
  let intersection = 0;
  let union = 0;
  for (const tag of allTags) {
    const a = freqA[tag] || 0;
    const b = freqB[tag] || 0;
    intersection += Math.min(a, b);
    union += Math.max(a, b);
  }
  const similarity = union > 0 ? intersection / union : 1;
  const tagDiffs = {};
  for (const tag of allTags) {
    const a = freqA[tag] || 0;
    const b = freqB[tag] || 0;
    if (a !== b) tagDiffs[tag] = { urlA: a, urlB: b, delta: b - a };
  }
  return {
    similarityScore: Number((similarity * 100).toFixed(2)),
    totalTagsA: Object.values(freqA).reduce((s, v) => s + v, 0),
    totalTagsB: Object.values(freqB).reduce((s, v) => s + v, 0),
    tagDiffs,
  };
}

function cropToSize(image, width, height) {
  const cropped = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = (image.width * y + x) << 2;
      const dst = (width * y + x) << 2;
      cropped.data[dst] = image.data[src];
      cropped.data[dst + 1] = image.data[src + 1];
      cropped.data[dst + 2] = image.data[src + 2];
      cropped.data[dst + 3] = image.data[src + 3];
    }
  }
  return cropped;
}


function mapWpUrlToReactUrl(wpUrl, wpBaseUrl, reactBaseUrl) {
  const safeWpUrl = String(wpUrl || "").trim();
  if (!safeWpUrl) return null;

  try {
    const wp = new URL(safeWpUrl);
    const wpBase = new URL(normalizeBaseUrl(wpBaseUrl));
    const reactBase = new URL(normalizeBaseUrl(reactBaseUrl));

    if (wp.origin !== wpBase.origin) {
      return null;
    }

    const mapped = new URL(wp.pathname + wp.search + wp.hash, reactBase);
    return mapped.toString();
  } catch {
    return null;
  }
}

// ─── URL DISCOVERY ─────────────────────────────────────────────────────────

/**
 * Trích xuất post type / taxonomy từ URL của sitemap con WP:
 *   wp-sitemap-posts-{post_type}-{page}.xml   → post_type
 *   wp-sitemap-taxonomies-{taxonomy}-{page}.xml → taxonomy
 * Trả về null nếu không match (Yoast/Rank Math dùng format khác → fallback inferPageType)
 */
function inferTypeFromSitemapUrl(sitemapUrl) {
  const m = sitemapUrl.match(/wp-sitemap-(?:posts|taxonomies)-([^-]+(?:_[^-]+)*)-\d+\.xml/);
  return m ? m[1] : null;
}

/**
 * Infer page type từ URL trang (chỉ dùng khi không lấy được type từ sitemap URL)
 */
function inferPageType(url, baseUrl = "") {
  const p = url.replace(baseUrl, "");
  if (p === "/" || p === "") return "homepage";
  if (/\/category\//i.test(p))  return "category";
  if (/\/tag\//i.test(p))       return "tag";
  if (/\/\d{4}\/\d{2}\//i.test(p))             return "post";
  if (/\/(blog|news|posts?)\//i.test(p))        return "post";
  return "page";
}

/**
 * Parse một sitemap.xml đơn, trả về mảng { loc, type }
 * typeHint: nếu biết type từ URL sitemap thì dùng luôn, không cần đoán
 */
async function parseSingleSitemap(sitemapUrl, baseUrl, typeHint = null) {
  const res = await axios.get(sitemapUrl, { timeout: 8000 });
  const parsed = await xml2js.parseStringPromise(res.data);
  if (!parsed.urlset?.url) return [];
  return parsed.urlset.url.map((u) => ({
    loc:  u.loc[0],
    type: typeHint ?? inferPageType(u.loc[0], baseUrl),
  }));
}

/**
 * Discover URLs từ sitemap.xml (có hỗ trợ sitemap index)
 * Return null nếu không tìm thấy sitemap nào
 */
async function discoverFromSitemap(baseUrl) {
  const candidates = [
    `${baseUrl}/wp-sitemap.xml`,      // WP 5.5+ built-in
    `${baseUrl}/sitemap_index.xml`,   // Yoast / Rank Math
  ];
  console.log("Thử tìm sitemap tại:", candidates.join(", "));
  for (const sitemapUrl of candidates) {
    try {
      const res = await axios.get(sitemapUrl, { timeout: 8000 });
      const parsed = await xml2js.parseStringPromise(res.data);

      // Sitemap index → nhiều sitemap con
      if (parsed.sitemapindex?.sitemap) {
        const childUrls = parsed.sitemapindex.sitemap.map((s) => s.loc[0]);
        const all = [];
        for (const child of childUrls) {
          // Lấy type từ URL sitemap con (e.g. wp-sitemap-posts-product-1.xml → "product")
          const typeHint = inferTypeFromSitemapUrl(child);
          const items = await parseSingleSitemap(child, baseUrl, typeHint);
          all.push(...items);
          if (typeHint) {
            console.log(`   sitemap [${typeHint}]: ${items.length} URLs`);
          }
        }
        console.log(`✅ Sitemap index: ${all.length} URLs total`);
        return all;
      }

      // Single sitemap (không có index)
      if (parsed.urlset?.url) {
        const items = parsed.urlset.url.map((u) => ({
          loc:  u.loc[0],
          type: inferPageType(u.loc[0], baseUrl),
        }));
        console.log(`✅ Sitemap: ${items.length} URLs`);
        return items;
      }
    } catch {
      // Thử candidate tiếp
    }
  }

  return null; // không có sitemap
}

/**
 * Discover URLs từ WP REST API — fallback khi không có sitemap.
 * Tự động discover TẤT CẢ post types và taxonomies đã đăng ký,
 * không hardcode theo plugin cụ thể.
 */
async function discoverFromRestApi(baseUrl) {
  const urls = [{ loc: baseUrl, type: "homepage" }];
  const base = `${baseUrl}/wp-json`;

  // Post types WP internal — không có URL frontend, truy cập trả về 404
  const WP_INTERNAL_TYPES = new Set([
    "wp_template", "wp_template_part", "wp_global_styles",
    "wp_navigation", "wp_block", "wp_font_family", "wp_font_face",
    "attachment", "revision", "nav_menu_item",
  ]);

  // 1. Lấy danh sách tất cả post types public từ WP
  try {
    const typesRes = await axios.get(`${base}/wp/v2/types`, { timeout: 8000 });
    const postTypes = Object.values(typesRes.data || {}).filter(
      (t) => t.rest_base && t.viewable !== false && !WP_INTERNAL_TYPES.has(t.slug)
    );
    for (const pt of postTypes) {
      try {
        const res = await axios.get(
          `${base}/wp/v2/${pt.rest_base}?per_page=100&status=publish`,
          { timeout: 8000 }
        );
        const items = (Array.isArray(res.data) ? res.data : [])
          .map((item) => ({ loc: item?.link ?? null, type: pt.slug, slug: item?.slug }))
          .filter((item) => Boolean(item.loc));
        if (items.length) {
          urls.push(...items);
          console.log(`✅ REST [post_type=${pt.slug}]: ${items.length} items`);
        }
      } catch { /* post type không có REST hoặc không có bài nào */ }
    }
  } catch (e) {
    console.warn(`⚠️  Không lấy được danh sách post types: ${e.message}`);
  }

  // 2. Lấy danh sách tất cả taxonomies public từ WP
  try {
    const taxRes = await axios.get(`${base}/wp/v2/taxonomies`, { timeout: 8000 });
    const taxonomies = Object.values(taxRes.data || {}).filter((t) => t.rest_base);
    for (const tax of taxonomies) {
      try {
        const res = await axios.get(
          `${base}/wp/v2/${tax.rest_base}?per_page=100&hide_empty=true`,
          { timeout: 8000 }
        );
        const items = (Array.isArray(res.data) ? res.data : [])
          .map((item) => ({ loc: item?.link ?? null, type: tax.slug, slug: item?.slug }))
          .filter((item) => Boolean(item.loc));
        if (items.length) {
          urls.push(...items);
          console.log(`✅ REST [taxonomy=${tax.slug}]: ${items.length} items`);
        }
      } catch { /* taxonomy không public hoặc không có term nào */ }
    }
  } catch (e) {
    console.warn(`⚠️  Không lấy được danh sách taxonomies: ${e.message}`);
  }

  return urls;
}

/**
 * Smart sampling: chọn đại diện theo từng page type
 * thay vì so sánh toàn bộ
 */
function smartSample(allUrls, limits = SAMPLE_LIMITS) {
  const groups = {};
  for (const url of allUrls) {
    if (!url?.loc) continue;
    const t = url.type || "page";
    if (!groups[t]) groups[t] = [];
    groups[t].push(url);
  }

  const sampled = [];
  for (const [type, items] of Object.entries(groups)) {
    const limit = limits[type] ?? DEFAULT_TYPE_LIMIT;
    const taken = items.slice(0, limit);
    sampled.push(...taken);
    console.log(`   ${type.padEnd(10)} ${taken.length}/${items.length} trang`);
  }

  console.log(`\n🎯 Sẽ so sánh: ${sampled.length} trang\n`);
  return sampled;
}

// ─── CORE COMPARE (giữ nguyên logic gốc) ───────────────────────────────────

async function compareWebVisuals({
  urlA,
  urlB,
  fullPage = true,
  viewportWidth = 1440,
  viewportHeight = 900,
  interactions = [],
}) {
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });

  const runId = Date.now();
  const nameA = sanitizeName(urlA);
  const nameB = sanitizeName(urlB);
  const imageAPath = path.join(ARTIFACTS_DIR, `${runId}-${nameA}.png`);
  const imageBPath = path.join(ARTIFACTS_DIR, `${runId}-${nameB}.png`);
  const diffPath = path.join(ARTIFACTS_DIR, `${runId}-diff.png`);

  const browser = await chromium.launch();
  let navigationModeA = "unknown";
  let navigationModeB = "unknown";
  let domFreqA = {};
  let domFreqB = {};

  try {
    const page = await browser.newPage({
      viewport: {
        width: Number(viewportWidth),
        height: Number(viewportHeight),
      },
    });
    navigationModeA = await captureScreenshot(
      page,
      urlA,
      imageAPath,
      Boolean(fullPage),
      interactions,
    );
    domFreqA = await captureDomStructure(page);
    navigationModeB = await captureScreenshot(
      page,
      urlB,
      imageBPath,
      Boolean(fullPage),
      interactions,
    );
    domFreqB = await captureDomStructure(page);
  } finally {
    await browser.close();
  }

  const imageA = PNG.sync.read(fs.readFileSync(imageAPath));
  const imageB = PNG.sync.read(fs.readFileSync(imageBPath));
  const width = Math.min(imageA.width, imageB.width);
  const height = Math.min(imageA.height, imageB.height);

  const normA = cropToSize(imageA, width, height);
  const normB = cropToSize(imageB, width, height);
  const diffImage = new PNG({ width, height });

  const pixelmatch = await getPixelmatch();
  const differentPixels = pixelmatch(
    normA.data,
    normB.data,
    diffImage.data,
    width,
    height,
    {
      threshold: 0.1,
    },
  );

  fs.writeFileSync(diffPath, PNG.sync.write(diffImage));

  const totalPixels = width * height;
  const diffPct = totalPixels > 0 ? (differentPixels / totalPixels) * 100 : 0;

  const domComparison = compareDomStructure(domFreqA, domFreqB);

  return {
    urlA,
    urlB,
    diffPercentage: Number(diffPct.toFixed(4)),
    differentPixels,
    totalPixels,
    resolutionUsed: { width, height },
    navigationModes: { urlA: navigationModeA, urlB: navigationModeB },
    artifacts: {
      imageA: `http://localhost:${PORT}/artifacts/${path.basename(imageAPath)}`,
      imageB: `http://localhost:${PORT}/artifacts/${path.basename(imageBPath)}`,
      diff: `http://localhost:${PORT}/artifacts/${path.basename(diffPath)}`,
    },
    domComparison,
    artifacts: { imageA: imageAPath, imageB: imageBPath, diff: diffPath },
  };
}

// ─── MULTI-URL ENTRY POINT ─────────────────────────────────────────────────

/**
 * So sánh nhiều trang tự động:
 *   1. Discover URLs từ wpBaseUrl (sitemap → REST API fallback)
 *   2. Smart sample theo page type
 *   3. Map mỗi WP URL → React URL rồi chạy compareWebVisuals
 *   4. Trả về report tổng hợp
 *
 * @param {object} opts
 * @param {string} opts.wpBaseUrl       - e.g. "https://my-wp-site.com"
 * @param {string} opts.reactBaseUrl    - e.g. "https://my-react-site.com"
 * @param {object} [opts.sampleLimits]  - override SAMPLE_LIMITS nếu muốn
 * @param {boolean} [opts.fullPage]
 * @param {number}  [opts.viewportWidth]
 * @param {number}  [opts.viewportHeight]
 */
async function compareMultiplePages({
  wpBaseUrl,
  reactBaseUrl,
  sampleLimits = SAMPLE_LIMITS,
  fullPage = true,
  viewportWidth = 1440,
  viewportHeight = 900,
}) {
  // 1. Discover
  console.log("🔍 Discovering URLs...");
  const allUrls =
    (await discoverFromSitemap(wpBaseUrl)) ||
    (await discoverFromRestApi(wpBaseUrl));

  if (!allUrls?.length) {
    throw new Error(
      "Không tìm thấy URL nào. Kiểm tra sitemap hoặc WP REST API.",
    );
  }

  // 2. Sample
  console.log("📋 Smart sampling:");
  const sampled = smartSample(allUrls, sampleLimits);

  // 3. Compare từng cặp
  const results = [];
  const normalizedWpBase = normalizeBaseUrl(wpBaseUrl);
  const normalizedReactBase = normalizeBaseUrl(reactBaseUrl);

  for (const urlItem of sampled) {
    const wpUrl = urlItem?.loc;
    const reactUrl = mapWpUrlToReactUrl(
      wpUrl,
      normalizedWpBase,
      normalizedReactBase,
    );

    if (!wpUrl || !reactUrl) {
      const reason = !wpUrl
        ? "Missing wpUrl (loc) from discovery source"
        : `Cannot map WP URL to React base: ${wpUrl}`;
      console.warn(`   ❌ SKIP: ${reason}\n`);
      results.push({
        type: urlItem?.type || "page",
        wpUrl,
        reactUrl: null,
        error: reason,
      });
      continue;
    }

    console.log(`📸 [${urlItem.type}] ${wpUrl}`);
    try {
      const result = await compareWebVisuals({
        urlA: wpUrl,
        urlB: reactUrl,
        fullPage,
        viewportWidth,
        viewportHeight,
      });

      const accuracy = 100 - result.diffPercentage;
      const status = accuracy >= 90 ? "✅ PASS" : "⚠️  FAIL";
      console.log(`   ${status} — accuracy: ${accuracy.toFixed(2)}%\n`);

      results.push({ type: urlItem.type, accuracy, status, ...result });
    } catch (err) {
      console.warn(`   ❌ ERROR: ${err.message}\n`);
      results.push({ type: urlItem.type, wpUrl, reactUrl, error: err.message });
    }
  }

  // 4. Summary
  const valid = results.filter((r) => r.accuracy !== undefined);
  const passed = valid.filter((r) => r.accuracy >= 90).length;
  const avgAcc =
    valid.reduce((s, r) => s + r.accuracy, 0) / (valid.length || 1);

  const summary = {
    totalCompared: valid.length,
    passed,
    failed: valid.length - passed,
    passRate: Number(((passed / (valid.length || 1)) * 100).toFixed(1)),
    avgAccuracy: Number(avgAcc.toFixed(2)),
  };

  // Ghi report ra file
  const reportPath = path.join(ARTIFACTS_DIR, `report-${Date.now()}.json`);
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(
    reportPath,
    JSON.stringify({ summary, pages: results }, null, 2),
  );

  console.log("═══════════════════════════════════");
  console.log("📊 VISUAL METRIC REPORT");
  console.log("═══════════════════════════════════");
  console.log(`Total   : ${summary.totalCompared} pages`);
  console.log(`Pass    : ${summary.passed}`);
  console.log(`Fail    : ${summary.failed}`);
  console.log(`Rate    : ${summary.passRate}%`);
  console.log(`Avg acc : ${summary.avgAccuracy}%`);
  console.log(`Report  : ${reportPath}`);

  return { summary, pages: results, reportPath };
}

// ─── EXPORTS ────────────────────────────────────────────────────────────────

module.exports = {
  compareWebVisuals, // dùng để so sánh 1 cặp URL (API cũ, giữ nguyên)
  compareMultiplePages, // dùng để so sánh toàn site tự động
};
