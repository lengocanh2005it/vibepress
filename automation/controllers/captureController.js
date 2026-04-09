const path = require('path');
const fse = require('fs-extra');
const { chromium } = require('playwright');
const { UPLOAD_ROOT } = require('../config/constants');

const CAPTURES_DIR = path.join(UPLOAD_ROOT, 'captures');
fse.ensureDirSync(CAPTURES_DIR);

// -------------------------------------------------------
// POST /api/wp/capture
// Body: { pageUrl, proxyUrl, rect: { x, y, width, height }, comment, viewport }
// Trả về: { filePath, comment }
// -------------------------------------------------------
async function captureRegion(req, res) {
  const { pageUrl, proxyUrl, rect, comment, viewport } = req.body ?? {};

  if (!pageUrl || !rect) {
    return res.status(400).json({ success: false, error: 'pageUrl and rect are required' });
  }

  const { x, y, width, height } = rect;
  if (!width || !height) {
    return res.status(400).json({ success: false, error: 'rect must have width and height' });
  }

  const filename = `capture-${Date.now()}.png`;
  const filePath = path.join(CAPTURES_DIR, filename);
  const requestHost = req.get('host');
  const baseUrl = `${req.protocol}://${requestHost}`;
  const targetUrl = proxyUrl
    ? new URL(proxyUrl, baseUrl).toString()
    : pageUrl;
  const viewportWidth = Math.max(
    1,
    Math.round(Number(viewport?.width) || 1280),
  );
  const viewportHeight = Math.max(
    1,
    Math.round(Number(viewport?.height) || 900),
  );
  const scrollX = Math.max(0, Math.round(Number(viewport?.scrollX) || 0));
  const scrollY = Math.max(0, Math.round(Number(viewport?.scrollY) || 0));
  const dpr = Math.max(1, Number(viewport?.dpr) || 1);

  let browser;
  let context;
  try {
    browser = await chromium.launch();
    context = await browser.newContext({
      viewport: { width: viewportWidth, height: viewportHeight },
      deviceScaleFactor: dpr,
    });
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'load', timeout: 60000 });

    if (scrollX > 0 || scrollY > 0) {
      await page.evaluate(
        ({ x, y }) => window.scrollTo(x, y),
        { x: scrollX, y: scrollY },
      );
      await page.waitForTimeout(150);
    }

    const pageBounds = await page.evaluate(() => ({
      width: Math.max(
        document.documentElement.scrollWidth,
        document.body?.scrollWidth ?? 0,
      ),
      height: Math.max(
        document.documentElement.scrollHeight,
        document.body?.scrollHeight ?? 0,
      ),
    }));

    const clipX = Math.max(0, Math.round(x + scrollX));
    const clipY = Math.max(0, Math.round(y + scrollY));
    if (clipX >= pageBounds.width || clipY >= pageBounds.height) {
      return res.status(400).json({
        success: false,
        error: 'Capture rectangle is outside the rendered page bounds',
      });
    }
    const clipWidth = Math.min(
      Math.max(1, Math.round(width)),
      Math.max(1, pageBounds.width - clipX),
    );
    const clipHeight = Math.min(
      Math.max(1, Math.round(height)),
      Math.max(1, pageBounds.height - clipY),
    );

    if (clipWidth <= 0 || clipHeight <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Capture rectangle is outside the rendered page bounds',
      });
    }

    await page.screenshot({
      path: filePath,
      clip: {
        x: clipX,
        y: clipY,
        width: clipWidth,
        height: clipHeight,
      },
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
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

module.exports = { captureRegion };
