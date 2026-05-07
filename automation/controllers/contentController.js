"use strict";

const { compareAllContent } = require("../services/contentCompareService");

async function compareContent(req, res) {
  const { wpBaseUrl, reactBaseUrl } = req.body || {};

  if (!wpBaseUrl || !reactBaseUrl) {
    return res.status(400).json({
      success: false,
      code: "INVALID_REQUEST",
      message: "wpBaseUrl and reactBaseUrl are required",
    });
  }

  try {
    const result = await compareAllContent(wpBaseUrl, reactBaseUrl);
    return res.status(200).json({ success: true, result });
  } catch (error) {
    return res.status(500).json({
      success: false,
      code: "CONTENT_COMPARE_FAILED",
      message: error.message || "Failed to compare content",
    });
  }
}

module.exports = { compareContent };
