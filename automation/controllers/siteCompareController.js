"use strict";

const { compareSite } = require("../services/siteCompareService");

async function compareSiteHandler(req, res) {
  const {
    wpBaseUrl,
    siteId,
    dbInfo,
    reactFeUrl,
    reactBeUrl,
    postTypes,
    fullPage,
    viewportWidth,
    viewportHeight,
  } = req.body || {};

  if (!wpBaseUrl || !reactFeUrl || !reactBeUrl) {
    return res.status(400).json({
      success: false,
      code: "INVALID_REQUEST",
      message: "wpBaseUrl, reactFeUrl and reactBeUrl are required",
    });
  }

  // dbInfo object > siteId string > fallback lấy site đầu tiên trong db.json
  const dbInfoOrSiteId = dbInfo ?? siteId ?? null;

  try {
    const result = await compareSite({
      wpBaseUrl,
      dbInfoOrSiteId,
      reactFeUrl,
      reactBeUrl,
      postTypes:      Array.isArray(postTypes) ? postTypes : undefined,
      fullPage:       fullPage !== false,
      viewportWidth:  viewportWidth  ? Number(viewportWidth)  : 1440,
      viewportHeight: viewportHeight ? Number(viewportHeight) : 900,
    });
    return res.status(200).json({ success: true, result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: "SITE_COMPARE_FAILED",
      message: error.message || "Failed to compare site",
    });
  }
}

module.exports = { compareSiteHandler };
