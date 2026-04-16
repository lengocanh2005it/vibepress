const http = require('http');
const crypto = require('crypto');

const AI_PIPELINE_HOST = process.env.AI_PIPELINE_HOST || 'localhost';

function pickDeterministicPort(jobId, salt, base, span) {
  const hash = crypto.createHash('sha1').update(`${salt}:${jobId}`).digest('hex');
  const offset = parseInt(hash.slice(0, 8), 16) % span;
  return base + offset;
}

function pickApiPort(jobId) {
  return pickDeterministicPort(jobId, 'api', 3700, 200);
}

function forwardRequest(req, res, hostname, port, targetPath) {
  const options = {
    hostname,
    port,
    path: targetPath,
    method: req.method,
    headers: { ...req.headers, host: `${hostname}:${port}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).send('Preview server is not responding.');
  });

  req.pipe(proxyReq, { end: true });
}

/**
 * Middleware: intercept /api/ calls from preview pages via Referer header.
 * Port tính deterministic từ pipelineId — không cần registry.
 */
function proxyApiIfFromPreview(req, res, next) {
  const referer = req.headers.referer || req.headers.referrer || '';
  const match = referer.match(/\/preview\/([^/]+)\//);
  if (!match) return next();

  const pipelineId = match[1];
  const apiPort = pickApiPort(pipelineId);
  return forwardRequest(req, res, AI_PIPELINE_HOST, apiPort, req.originalUrl);
}

module.exports = { proxyApiIfFromPreview };
