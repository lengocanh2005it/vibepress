const path = require('path');
const fse = require('fs-extra');
const { chromium } = require('playwright');
const { UPLOAD_ROOT } = require('../config/constants');
const { uploadCaptureAsset, uploadImageFromBase64 } = require('../services/imageUploadService');
const { query } = require('../db/mysql');
const { buildPublicUrl, resolvePublicBaseUrl } = require('../utils/publicUrl');

const CAPTURES_DIR = path.join(UPLOAD_ROOT, 'captures');
fse.ensureDirSync(CAPTURES_DIR);

function resolveCaptureTargetUrl(req, pageUrl, proxyUrl) {
  const normalizedProxyUrl =
    typeof proxyUrl === 'string' ? proxyUrl.trim() : '';

  if (normalizedProxyUrl) {
    try {
      return new URL(normalizedProxyUrl).toString();
    } catch {
      try {
        return new URL(normalizedProxyUrl, resolvePublicBaseUrl(req)).toString();
      } catch {
        // Fall back to the raw WordPress page when the proxy URL is malformed.
      }
    }
  }

  return pageUrl;
}

async function stabilizePageForCapture(page) {
  try {
    await page.waitForLoadState('networkidle', { timeout: 5000 });
  } catch {
    // Some pages keep background requests alive; continue with best-effort stabilization.
  }

  await page.addStyleTag({
    content: `
      html {
        scroll-behavior: auto !important;
      }

      *, *::before, *::after {
        animation: none !important;
        transition: none !important;
        caret-color: transparent !important;
      }

      .wow,
      .animated,
      [class*="animate__"],
      [class*="fadeIn"],
      [class*="slideIn"],
      [class*="zoomIn"] {
        animation: none !important;
        transition: none !important;
        transform: none !important;
        opacity: 1 !important;
        visibility: visible !important;
      }
    `,
  });

  await page.evaluate(async () => {
    try {
      if (document.fonts?.ready) {
        await document.fonts.ready;
      }
    } catch {
      // Ignore font readiness failures.
    }

    await new Promise((resolve) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(resolve);
      });
    });
  });

  await page.waitForTimeout(150);
}

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
  // Prefer the proxied preview URL so the saved screenshot matches the iframe
  // the user selected inside the editor.
  const targetUrl = resolveCaptureTargetUrl(req, pageUrl, proxyUrl);
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
    await stabilizePageForCapture(page);

    if (scrollX > 0 || scrollY > 0) {
      await page.evaluate(
        ({ x, y }) => window.scrollTo(x, y),
        { x: scrollX, y: scrollY },
      );
      await stabilizePageForCapture(page);
    }

    const clipX = Math.max(0, Math.round(x));
    const clipY = Math.max(0, Math.round(y));
    if (clipX >= viewportWidth || clipY >= viewportHeight) {
      return res.status(400).json({
        success: false,
        error: 'Capture rectangle is outside the visible viewport',
      });
    }
    const clipWidth = Math.min(
      Math.max(1, Math.round(width)),
      Math.max(1, viewportWidth - clipX),
    );
    const clipHeight = Math.min(
      Math.max(1, Math.round(height)),
      Math.max(1, viewportHeight - clipY),
    );

    if (clipWidth <= 0 || clipHeight <= 0) {
      return res.status(400).json({
        success: false,
        error: 'Capture rectangle is outside the visible viewport',
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

    const localPublicUrl = buildPublicUrl(req, `/captures/${filename}`);
    const asset = await uploadCaptureAsset(filePath, filename, localPublicUrl, {
      width: clipWidth,
      height: clipHeight,
    });

    return res.status(200).json({
      success: true,
      filePath: `/captures/${filename}`,
      fileName: filename,
      comment: comment ?? '',
      pageUrl,
      asset,
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  } finally {
    if (context) await context.close();
    if (browser) await browser.close();
  }
}

async function saveCapture(req, res) {
  const { siteId, captureData } = req.body ?? {};

  if (!siteId || !captureData) {
    return res.status(400).json({ success: false, error: 'siteId and captureData are required' });
  }

  try {
    await query(
      `INSERT INTO captures (
        id, site_id,
        file_path, file_name,
        asset,
        comment, page_url, iframe_src, captured_at,
        viewport,
        page,
        selection, geometry
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        captureData.id,
        siteId,
        captureData.filePath   ?? null,
        captureData.fileName   ?? null,
        captureData.asset      ? JSON.stringify(captureData.asset)      : null,
        captureData.comment    ?? null,
        captureData.pageUrl    ?? null,
        captureData.iframeSrc  ?? null,
        captureData.capturedAt ? new Date(captureData.capturedAt) : new Date(),
        captureData.viewport   ? JSON.stringify(captureData.viewport)   : null,
        captureData.page       ? JSON.stringify(captureData.page)       : null,
        captureData.selection  ? JSON.stringify(captureData.selection)  : null,
        captureData.geometry   ? JSON.stringify(captureData.geometry)   : null,
      ],
    );

    return res.status(201).json({ success: true, id: captureData.id });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

// -------------------------------------------------------
// DELETE /api/captures/:siteId
// Xoá toàn bộ capture thuộc về một site
// -------------------------------------------------------
async function deleteCapturesBySite(req, res) {
  const { siteId } = req.params;

  if (!siteId) {
    return res.status(400).json({ success: false, error: 'siteId is required' });
  }

  try {
    const result = await query(
      'DELETE FROM captures WHERE site_id = ?',
      [siteId],
    );

    return res.status(200).json({ success: true, deleted: result.affectedRows });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}

async function getCapturesBySite(req, res) {
  const { siteId } = req.params;

  if (!siteId) {
    return res.status(400).json({ success: false, error: 'siteId is required' });
  }

  try {
    const captures = await query(
      'SELECT * FROM captures WHERE site_id = ?',
      [siteId]
    );
    return res.status(200).json({ success: true, captures });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}


async function uploadImage(req, res) {
  const { data, fileName, mimeType } = req.body ?? {};
  if (!data) return res.status(400).json({ message: 'data (base64) is required' });
  if (!fileName) return res.status(400).json({ message: 'fileName is required' });
  if (!mimeType) return res.status(400).json({ message: 'mimeType is required' });
  try {
    const result = await uploadImageFromBase64(data, fileName, mimeType);
    return res.json(result);
  } catch (err) {
    return res.status(500).json({ message: err instanceof Error ? err.message : String(err) });
  }
}

module.exports = { captureRegion, saveCapture, deleteCapturesBySite, getCapturesBySite, uploadImage };
