"use strict";

const axios = require("axios");

const DEFAULT_TIMEOUT = 10000;
const DEFAULT_PER_PAGE = 100;

// ─── HELPERS ────────────────────────────────────────────────────────────────

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function wpJson(baseUrl, path) {
  return `${normalizeBaseUrl(baseUrl)}/wp-json${path}`;
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ─── FETCHERS ────────────────────────────────────────────────────────────────

/**
 * Lấy danh sách posts (đầy đủ content)
 */
async function fetchPosts(baseUrl, { perPage = DEFAULT_PER_PAGE } = {}) {
  const url = wpJson(
    baseUrl,
    `/wp/v2/posts?per_page=${perPage}&status=publish&_fields=id,slug,link,title,content,excerpt,date,modified,categories,tags,meta`
  );
  const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT });
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Lấy danh sách pages (đầy đủ content)
 */
async function fetchPages(baseUrl, { perPage = DEFAULT_PER_PAGE } = {}) {
  const url = wpJson(
    baseUrl,
    `/wp/v2/pages?per_page=${perPage}&status=publish&_fields=id,slug,link,title,content,excerpt,date,modified,meta`
  );
  const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT });
  return Array.isArray(res.data) ? res.data : [];
}

/**
 * Lấy 1 post theo ID
 */
async function fetchPostById(baseUrl, id) {
  const url = wpJson(baseUrl, `/wp/v2/posts/${id}`);
  const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT });
  return res.data;
}

/**
 * Lấy 1 post theo slug
 */
async function fetchPostBySlug(baseUrl, slug) {
  const url = wpJson(
    baseUrl,
    `/wp/v2/posts?slug=${encodeURIComponent(slug)}&_fields=id,slug,link,title,content,excerpt,date,modified,categories,tags,meta`
  );
  const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT });
  const items = Array.isArray(res.data) ? res.data : [];
  return items[0] ?? null;
}

/**
 * Lấy 1 page theo slug
 */
async function fetchPageBySlug(baseUrl, slug) {
  const url = wpJson(
    baseUrl,
    `/wp/v2/pages?slug=${encodeURIComponent(slug)}&_fields=id,slug,link,title,content,excerpt,date,modified,meta`
  );
  const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT });
  const items = Array.isArray(res.data) ? res.data : [];
  return items[0] ?? null;
}

// ─── NORMALIZE ───────────────────────────────────────────────────────────────

/**
 * Chuẩn hóa raw WP item thành shape dùng để so sánh
 */
function normalizeWpItem(item) {
  return {
    id:           item.id,
    slug:         item.slug,
    link:         item.link,
    title:        item.title?.rendered ?? "",
    titleText:    stripHtml(item.title?.rendered ?? ""),
    contentHtml:  item.content?.rendered ?? "",
    contentText:  stripHtml(item.content?.rendered ?? ""),
    excerptHtml:  item.excerpt?.rendered ?? "",
    excerptText:  stripHtml(item.excerpt?.rendered ?? ""),
    date:         item.date,
    modified:     item.modified,
    categories:   item.categories ?? [],
    tags:         item.tags ?? [],
    meta:         item.meta ?? {},
  };
}

// ─── MAIN ENTRY ──────────────────────────────────────────────────────────────

/**
 * Lấy toàn bộ posts + pages từ WP, trả về mảng đã normalize
 *
 * @param {string} baseUrl  - e.g. "http://localhost:8000"
 * @returns {Promise<Array>}
 */
async function fetchAllWpContent(baseUrl) {
  const [posts, pages] = await Promise.all([
    fetchPosts(baseUrl).catch((e) => {
      console.warn(`⚠️  fetchPosts failed: ${e.message}`);
      return [];
    }),
    fetchPages(baseUrl).catch((e) => {
      console.warn(`⚠️  fetchPages failed: ${e.message}`);
      return [];
    }),
  ]);

  const normalized = [
    ...posts.map((p) => ({ type: "post", ...normalizeWpItem(p) })),
    ...pages.map((p) => ({ type: "page", ...normalizeWpItem(p) })),
  ];

  console.log(
    `✅ WP API: ${posts.length} posts + ${pages.length} pages = ${normalized.length} items`
  );

  return normalized;
}

module.exports = {
  fetchAllWpContent,
  fetchPostById,
  fetchPostBySlug,
  fetchPageBySlug,
  normalizeWpItem,
};
