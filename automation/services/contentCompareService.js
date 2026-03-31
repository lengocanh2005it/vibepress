"use strict";

const { fetchAllWpContent }     = require("./wpDbService");
const { fetchAllReactContent }  = require("./reactApiService");

// ─── SIMILARITY ──────────────────────────────────────────────────────────────

/**
 * Jaccard similarity trên tập từ (word set)
 * Đủ để phát hiện mất nội dung lớn, không cần NLP
 */
function jaccardSimilarity(textA, textB) {
  const tokenize = (t) =>
    new Set(
      String(t || "")
        .toLowerCase()
        .split(/\s+/)
        .filter(Boolean)
    );

  const setA = tokenize(textA);
  const setB = tokenize(textB);

  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;

  let intersection = 0;
  for (const word of setA) {
    if (setB.has(word)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return intersection / union;
}

function score(sim) {
  return Number((sim * 100).toFixed(2));
}

// ─── COMPARE PAIR ────────────────────────────────────────────────────────────

function compareItems(wpItem, reactItem) {
  const titleSim   = jaccardSimilarity(wpItem.titleText,   reactItem.titleText);
  const contentSim = jaccardSimilarity(wpItem.contentText, reactItem.contentText);

  const overallSim = titleSim * 0.25 + contentSim * 0.75;
  const passed     = overallSim >= 0.85;

  const issues = [];
  if (titleSim   < 0.9)  issues.push(`title mismatch (${score(titleSim)}%)`);
  if (contentSim < 0.85) issues.push(`content mismatch (${score(contentSim)}%)`);

  return {
    slug:   wpItem.slug,
    type:   wpItem.type,
    status: passed ? "PASS" : "FAIL",
    scores: {
      title:   score(titleSim),
      content: score(contentSim),
      overall: score(overallSim),
    },
    issues,
    wp:    { title: wpItem.titleText,    contentPreview: wpItem.contentText.slice(0, 300) },
    react: { title: reactItem.titleText, contentPreview: reactItem.contentText.slice(0, 300) },
  };
}

// ─── MAIN ENTRY ──────────────────────────────────────────────────────────────

/**
 * So sánh toàn bộ nội dung WP (DB) vs React backend (API)
 *
 * @param {object|string} dbInfoOrSiteId  - dbInfo object hoặc siteId từ db.json
 * @param {string}        reactBeUrl      - e.g. "http://localhost:3100"
 * @param {object}        [opts]
 * @param {string[]}      [opts.postTypes] - giới hạn post types, mặc định lấy hết
 */
async function compareAllContent(dbInfoOrSiteId, reactBeUrl, { postTypes } = {}) {
  console.log("🔍 Fetching content from both sources...");

  const [wpItems, reactItems] = await Promise.all([
    fetchAllWpContent(dbInfoOrSiteId, { postTypes }),
    fetchAllReactContent(reactBeUrl),
  ]);

  // Index React items theo slug để lookup O(1)
  const reactBySlug = new Map(reactItems.map((r) => [r.slug, r]));

  const results = [];

  for (const wpItem of wpItems) {
    const reactItem = reactBySlug.get(wpItem.slug);

    if (!reactItem) {
      results.push({
        slug:   wpItem.slug,
        type:   wpItem.type,
        status: "MISSING",
        scores: { title: 0, content: 0, overall: 0 },
        issues: [`Not found in React backend`],
        wp:     { title: wpItem.titleText, contentPreview: wpItem.contentText.slice(0, 300) },
        react:  null,
      });
      console.warn(`   ❌ MISSING [${wpItem.type}] ${wpItem.slug}`);
      continue;
    }

    const result = compareItems(wpItem, reactItem);
    results.push(result);

    const icon = result.status === "PASS" ? "✅" : "⚠️ ";
    console.log(
      `   ${icon} [${result.type}] ${result.slug} — overall: ${result.scores.overall}%`
    );
    if (result.issues.length) {
      result.issues.forEach((i) => console.log(`      • ${i}`));
    }
  }

  // Summary
  // MISSING items được tính điểm 0 vào avgOverall để phản ánh đúng tình trạng thiếu nội dung
  const passed  = results.filter((r) => r.status === "PASS").length;
  const failed  = results.filter((r) => r.status === "FAIL").length;
  const missing = results.filter((r) => r.status === "MISSING").length;
  const avgOverall =
    results.reduce((s, r) => s + (r.scores.overall ?? 0), 0) / (results.length || 1);

  const summary = {
    total:      results.length,
    passed,
    failed,
    missing,
    passRate:   Number(((passed / (results.length || 1)) * 100).toFixed(1)),
    avgOverall: Number(avgOverall.toFixed(2)),
  };

  console.log("\n═══════════════════════════════════");
  console.log("📊 CONTENT COMPARE REPORT");
  console.log("═══════════════════════════════════");
  console.log(`Total   : ${summary.total}`);
  console.log(`Pass    : ${summary.passed}`);
  console.log(`Fail    : ${summary.failed}`);
  console.log(`Missing : ${summary.missing}`);
  console.log(`Rate    : ${summary.passRate}%`);
  console.log(`Avg     : ${summary.avgOverall}%`);

  return { summary, pages: results };
}

module.exports = { compareAllContent };
