"use strict";

const { compareSite } = require("../services/siteCompareService");
const { resolvePublicBaseUrl } = require("../utils/publicUrl");

async function compareSiteHandler(req, res) {
  const {
    wpBaseUrl,
    reactFeUrl,
    reactBeUrl,
    fullPage,
    viewportWidth,
    viewportHeight,
  } = req.body || {};

  const missingFields = [
    !wpBaseUrl ? "wpBaseUrl" : null,
    !reactFeUrl ? "reactFeUrl" : null,
    !reactBeUrl ? "reactBeUrl" : null,
  ].filter(Boolean);

  if (missingFields.length > 0) {
    return res.status(400).json({
      success: false,
      code: "INVALID_REQUEST",
      message: `Missing required field(s): ${missingFields.join(", ")}`,
    });
  }

  try {
    const result = await compareSite({
      wpBaseUrl,
      reactFeUrl,
      reactBeUrl,
      artifactBaseUrl: resolvePublicBaseUrl(req),
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
