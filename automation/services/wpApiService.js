"use strict";

const axios = require("axios");

const { stripHtml, normalizeContent, normalizeBaseUrl } = require("./textUtils");

const DEFAULT_TIMEOUT = 10000;
const DEFAULT_PER_PAGE = 100;
const MAX_PAGES = 20;

function normalizeWpItem(item, type) {
  return {
    type,
    id: item.id,
    slug: item.slug,
    titleText: stripHtml(item.title?.rendered ?? item.title ?? ""),
    contentText: normalizeContent(item.content?.rendered ?? item.content ?? ""),
    date: item.date ?? null,
    categories: Array.isArray(item.categories) ? item.categories : [],
  };
}

async function fetchWpCollection(baseUrl, resource) {
  const base = normalizeBaseUrl(baseUrl);
  const items = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await axios.get(`${base}/wp-json/wp/v2/${resource}`, {
      timeout: DEFAULT_TIMEOUT,
      params: {
        per_page: DEFAULT_PER_PAGE,
        page,
        status: "publish",
      },
    });

    const batch = Array.isArray(response.data) ? response.data : [];
    items.push(...batch);

    const totalPages = Number(response.headers["x-wp-totalpages"] || 1);
    if (page >= totalPages || batch.length < DEFAULT_PER_PAGE) {
      break;
    }
  }

  return items;
}

async function fetchAllWpContent(baseUrl) {
  const [posts, pages] = await Promise.all([
    fetchWpCollection(baseUrl, "posts").catch((error) => {
      console.warn(`⚠️  WP fetchPosts failed: ${error.message}`);
      return [];
    }),
    fetchWpCollection(baseUrl, "pages").catch((error) => {
      console.warn(`⚠️  WP fetchPages failed: ${error.message}`);
      return [];
    }),
  ]);

  const normalized = [
    ...posts.map((post) => normalizeWpItem(post, "post")),
    ...pages.map((page) => normalizeWpItem(page, "page")),
  ];

  console.log(
    `✅ WP API: ${posts.length} posts + ${pages.length} pages = ${normalized.length} items`,
  );
  return normalized;
}

module.exports = { fetchAllWpContent };
