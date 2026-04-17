"use strict";

const axios = require("axios");

const { stripHtml, normalizeContent, normalizeBaseUrl } = require("./textUtils");

const DEFAULT_TIMEOUT = 10000;

// ─── INTERNAL HELPERS ────────────────────────────────────────────────────────

function normalizeReactItem(item, type) {
  return {
    type,
    id:          item.id,
    slug:        item.slug,
    titleText:   stripHtml(item.title ?? ""),
    contentText: normalizeContent(item.content ?? ""),
    date:        item.date ?? null,
    categories:  Array.isArray(item.categories) ? item.categories : [],
  };
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

/**
 * Lấy toàn bộ posts + pages từ React backend, trả về mảng đã normalize
 *
 * @param {string} baseUrl  - e.g. "http://localhost:3100"
 */
function resolveDockerUrl(url) {
  const base = normalizeBaseUrl(url);
  if (process.env.AI_PIPELINE_HOST) {
    return base.replace(/(?:localhost|127\.0\.0\.1)/, 'host.docker.internal');
  }
  return base;
}

async function fetchAllReactContent(baseUrl) {
  const base = resolveDockerUrl(baseUrl);

  const [posts, pages] = await Promise.all([
    axios.get(`${base}/api/posts`, { timeout: DEFAULT_TIMEOUT })
      .then((r) => Array.isArray(r.data) ? r.data : [])
      .catch((e) => { console.warn(`⚠️  React fetchPosts failed: ${e.message}`); return []; }),
    axios.get(`${base}/api/pages`, { timeout: DEFAULT_TIMEOUT })
      .then((r) => Array.isArray(r.data) ? r.data : [])
      .catch((e) => { console.warn(`⚠️  React fetchPages failed: ${e.message}`); return []; }),
  ]);

  const normalized = [
    ...posts.map((p) => normalizeReactItem(p, "post")),
    ...pages.map((p) => normalizeReactItem(p, "page")),
  ];

  console.log(`✅ React API: ${posts.length} posts + ${pages.length} pages = ${normalized.length} items`);
  return normalized;
}

module.exports = { fetchAllReactContent };
