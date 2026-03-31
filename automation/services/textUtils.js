"use strict";

function stripHtml(html) {
  return String(html || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function stripGutenbergComments(raw) {
  return String(raw || "")
    .replace(/<!--\s*wp:[^>]*-->/g, "")
    .replace(/<!--\s*\/wp:[^>]*-->/g, "")
    .trim();
}

function normalizeContent(raw) {
  return stripHtml(stripGutenbergComments(raw));
}

function normalizeBaseUrl(url) {
  return String(url || "").replace(/\/+$/, "");
}

module.exports = { stripHtml, stripGutenbergComments, normalizeContent, normalizeBaseUrl };
