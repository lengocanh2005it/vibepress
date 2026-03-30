"use strict";

const axios = require("axios");

const DEFAULT_TIMEOUT = 10000;

// ─── HELPERS ────────────────────────────────────────────────────────────────

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// React backend trả về raw post_content từ DB → có Gutenberg block comments
function stripGutenbergComments(raw) {
  return String(raw || "")
    .replace(/<!--\s*wp:[^>]*-->/g, "")
    .replace(/<!--\s*\/wp:[^>]*-->/g, "")
    .trim();
}

function normalizeContent(raw) {
  return stripHtml(stripGutenbergComments(raw));
}

// ─── FETCHERS ────────────────────────────────────────────────────────────────

async function fetchPosts(baseUrl) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/posts`;
  const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT });
  return Array.isArray(res.data) ? res.data : [];
}

async function fetchPages(baseUrl) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/pages`;
  const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT });
  return Array.isArray(res.data) ? res.data : [];
}

async function fetchPostBySlug(baseUrl, slug) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/posts/${encodeURIComponent(slug)}`;
  const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT });
  return res.data ?? null;
}

async function fetchPageBySlug(baseUrl, slug) {
  const url = `${normalizeBaseUrl(baseUrl)}/api/pages/${encodeURIComponent(slug)}`;
  const res = await axios.get(url, { timeout: DEFAULT_TIMEOUT });
  return res.data ?? null;
}

// ─── NORMALIZE ───────────────────────────────────────────────────────────────

/**
 * Chuẩn hóa raw React backend item về cùng shape với wpApiService.normalizeWpItem
 * để 2 phía có thể so sánh trực tiếp
 */
function normalizeReactItem(item) {
  return {
    id:           item.id,
    slug:         item.slug,
    link:         null, // React backend không trả về link
    title:        item.title ?? "",
    titleText:    stripHtml(item.title ?? ""),
    contentHtml:  item.content ?? "",
    contentText:  normalizeContent(item.content ?? ""),
    excerptHtml:  item.excerpt ?? "",
    excerptText:  normalizeContent(item.excerpt ?? ""),
    date:         item.date ?? null,
    modified:     null, // React backend không trả về modified
    categories:   Array.isArray(item.categories) ? item.categories : [],
    tags:         [],   // React backend không trả về tags
    meta:         {},
  };
}

// ─── MAIN ENTRY ──────────────────────────────────────────────────────────────

/**
 * Lấy toàn bộ posts + pages từ React backend, trả về mảng đã normalize
 *
 * @param {string} baseUrl  - e.g. "http://localhost:3100"
 * @returns {Promise<Array>}
 */
async function fetchAllReactContent(baseUrl) {
  const [posts, pages] = await Promise.all([
    fetchPosts(baseUrl).catch((e) => {
      console.warn(`⚠️  React fetchPosts failed: ${e.message}`);
      return [];
    }),
    fetchPages(baseUrl).catch((e) => {
      console.warn(`⚠️  React fetchPages failed: ${e.message}`);
      return [];
    }),
  ]);

  const normalized = [
    ...posts.map((p) => ({ type: "post", ...normalizeReactItem(p) })),
    ...pages.map((p) => ({ type: "page", ...normalizeReactItem(p) })),
  ];

  console.log(
    `✅ React API: ${posts.length} posts + ${pages.length} pages = ${normalized.length} items`
  );

  return normalized;
}

module.exports = {
  fetchAllReactContent,
  fetchPostBySlug,
  fetchPageBySlug,
  normalizeReactItem,
};
