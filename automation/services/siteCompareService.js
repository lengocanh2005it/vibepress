"use strict";

const fs   = require("fs");
const path = require("path");

const { compareMultiplePages } = require("./visualService");
const { compareAllContent }    = require("./contentCompareService");

const ARTIFACTS_DIR = path.join(__dirname, "..", "artifacts");

/**
 * Chạy song song visual compare + content compare rồi gộp vào 1 report.json
 *
 * @param {object}        opts
 * @param {string}        opts.wpBaseUrl       - WP frontend URL (dùng cho visual)
 * @param {object|string} opts.dbInfoOrSiteId  - dbInfo object hoặc siteId (dùng cho content)
 * @param {string}        opts.reactFeUrl      - React frontend URL (dùng cho visual)
 * @param {string}        opts.reactBeUrl      - React backend URL (dùng cho content)
 * @param {string[]}      [opts.postTypes]     - giới hạn post types
 * @param {boolean}       [opts.fullPage]
 * @param {number}        [opts.viewportWidth]
 * @param {number}        [opts.viewportHeight]
 */
async function compareSite({
  wpBaseUrl,
  dbInfoOrSiteId,
  reactFeUrl,
  reactBeUrl,
  postTypes,
  fullPage = true,
  viewportWidth = 1440,
  viewportHeight = 900,
}) {
  console.log("🚀 Starting full site comparison...\n");
  console.log(`   WP FE:      ${wpBaseUrl}`);
  console.log(`   React FE:   ${reactFeUrl}`);
  console.log(`   React BE:   ${reactBeUrl}\n`);

  const [visualResult, contentResult] = await Promise.allSettled([
    compareMultiplePages({ wpBaseUrl, reactBaseUrl: reactFeUrl, fullPage, viewportWidth, viewportHeight }),
    compareAllContent(dbInfoOrSiteId, reactBeUrl, { postTypes }),
  ]);

  const visual  = visualResult.status  === "fulfilled" ? visualResult.value  : { error: visualResult.reason?.message };
  const content = contentResult.status === "fulfilled" ? contentResult.value : { error: contentResult.reason?.message };

  // ─── Merge pages theo URL/slug ──────────────────────────────────────────────
  // Visual pages dùng wpUrl, content pages dùng slug → merge bằng slug
  const visualPages  = visual.pages  ?? [];
  const contentPages = content.pages ?? [];

  const contentBySlug = new Map(
    contentPages.map((p) => [p.slug, p])
  );

  // Với mỗi visual page, tìm content page tương ứng theo slug từ wpUrl
  const mergedPages = visualPages.map((vp) => {
    // compareWebVisuals trả về urlA/urlB; compareMultiplePages spread ...result nên field là urlA
    const wpUrl = vp.wpUrl ?? vp.urlA ?? null;
    const slug = wpUrl
      ? wpUrl.replace(/\/+$/, "").split("/").pop()
      : null;
    const cp = slug ? contentBySlug.get(slug) : null;
    return {
      url:     wpUrl,
      slug,
      type:    vp.type ?? cp?.type ?? "page",
      visual: cp ? {
        accuracy:      vp.accuracy ?? null,
        diffPct:       vp.diffPercentage ?? null,
        status:        vp.status ?? null,
        artifacts:     vp.artifacts ?? null,
        error:         vp.error ?? null,
      } : { accuracy: vp.accuracy ?? null, diffPct: vp.diffPercentage ?? null, status: vp.status ?? null, artifacts: vp.artifacts ?? null, error: vp.error ?? null },
      content: cp ? {
        status:        cp.status,
        scores:        cp.scores,
        issues:        cp.issues,
        wp:            cp.wp,
        react:         cp.react,
      } : null,
    };
  });

  // Content pages không có visual (slug không xuất hiện trong visual)
  const visualSlugs = new Set(mergedPages.map((p) => p.slug).filter(Boolean));
  for (const cp of contentPages) {
    if (!visualSlugs.has(cp.slug)) {
      mergedPages.push({
        url:     null,
        slug:    cp.slug,
        type:    cp.type,
        visual:  null,
        content: {
          status: cp.status,
          scores: cp.scores,
          issues: cp.issues,
          wp:     cp.wp,
          react:  cp.react,
        },
      });
    }
  }

  // ─── Summary tổng hợp ───────────────────────────────────────────────────────
  const summary = {
    visual:  visual.summary  ?? null,
    content: content.summary ?? null,
    overall: {
      visualAvgAccuracy:  visual.summary?.avgAccuracy  ?? null,
      contentAvgOverall:  content.summary?.avgOverall  ?? null,
      visualPassRate:     visual.summary?.passRate     ?? null,
      contentPassRate:    content.summary?.passRate    ?? null,
    },
    errors: {
      visual:  visual.error  ?? null,
      content: content.error ?? null,
    },
  };

  // ─── Ghi report ─────────────────────────────────────────────────────────────
  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  const reportPath = path.join(ARTIFACTS_DIR, `report-${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ summary, pages: mergedPages }, null, 2));

  console.log("\n═══════════════════════════════════");
  console.log("📊 FULL SITE REPORT");
  console.log("═══════════════════════════════════");
  if (summary.overall.visualAvgAccuracy !== null)
    console.log(`Visual avg accuracy : ${summary.overall.visualAvgAccuracy}%`);
  if (summary.overall.contentAvgOverall !== null)
    console.log(`Content avg overall : ${summary.overall.contentAvgOverall}%`);
  console.log(`Report : ${reportPath}`);

  return { summary, pages: mergedPages, reportPath };
}

module.exports = { compareSite };
