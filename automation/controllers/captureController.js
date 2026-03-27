const path = require('path');
const fse = require('fs-extra');
const { chromium } = require('playwright');
const { UPLOAD_ROOT } = require('../config/constants');

const CAPTURES_DIR = path.join(UPLOAD_ROOT, 'captures');
fse.ensureDirSync(CAPTURES_DIR);

// -------------------------------------------------------
// POST /api/wp/capture
// Body: { pageUrl, rect: { x, y, width, height }, comment }
// Trả về: { filePath, comment }
// -------------------------------------------------------
async function captureRegion(req, res) {
  const { pageUrl, rect, comment } = req.body ?? {};

  if (!pageUrl || !rect) {
    return res.status(400).json({ success: false, error: 'pageUrl and rect are required' });
  }

  const { x, y, width, height } = rect;
  if (!width || !height) {
    return res.status(400).json({ success: false, error: 'rect must have width and height' });
  }

  const filename = `capture-${Date.now()}.png`;
  const filePath = path.join(CAPTURES_DIR, filename);

  let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.goto(pageUrl, { waitUntil: 'networkidle', timeout: 15000 });

    await page.screenshot({
      path: filePath,
      clip: { x, y, width, height },
    });

    return res.status(200).json({
      success: true,
      filePath: `/captures/${filename}`,
      comment: comment ?? '',
      pageUrl,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    if (browser) await browser.close();
  }
}

module.exports = { captureRegion };
