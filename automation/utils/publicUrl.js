const { AUTOMATION_PUBLIC_BASE_URL, PORT } = require("../config/constants");

function normalizeBaseUrl(value) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function readForwardedHeader(req, headerName) {
  const raw = req?.headers?.[headerName];
  if (Array.isArray(raw)) {
    return String(raw[0] || "")
      .split(",")[0]
      .trim();
  }
  return String(raw || "")
    .split(",")[0]
    .trim();
}

function resolveRequestOrigin(req) {
  const forwardedProto = readForwardedHeader(req, "x-forwarded-proto");
  const forwardedHost = readForwardedHeader(req, "x-forwarded-host");
  const host = forwardedHost || req?.get?.("host") || req?.headers?.host || "";
  const protocol =
    forwardedProto ||
    req?.protocol ||
    (host && /localhost|127\.0\.0\.1/i.test(host) ? "http" : "https");

  if (!host) {
    return `http://localhost:${PORT}`;
  }

  return normalizeBaseUrl(`${protocol}://${host}`);
}

function resolvePublicBaseUrl(req) {
  return AUTOMATION_PUBLIC_BASE_URL || resolveRequestOrigin(req);
}

function buildPublicUrl(req, pathname) {
  const baseUrl = resolvePublicBaseUrl(req);
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${baseUrl}${normalizedPath}`;
}

function buildPublicUrlFromBase(baseUrl, pathname) {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl) || `http://localhost:${PORT}`;
  const normalizedPath = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${normalizedBaseUrl}${normalizedPath}`;
}

module.exports = {
  buildPublicUrl,
  buildPublicUrlFromBase,
  resolvePublicBaseUrl,
};
