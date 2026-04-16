const http = require('http');

// Hostname của ai_pipeline container — dùng service name trong Docker network
const AI_PIPELINE_HOST = process.env.AI_PIPELINE_HOST || 'localhost';

// pipelineId → { vitePort, apiPort }
const registry = new Map();

function forwardRequest(req, res, hostname, port, targetPath) {
  const options = {
    hostname,
    port,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `${hostname}:${port}`,
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', () => {
    res.status(502).send('Preview server is not responding.');
  });

  req.pipe(proxyReq, { end: true });
}

/**
 * POST /api/preview/register
 * Body: { pipelineId: string, port: number, apiPort: number }
 */
function registerPreview(req, res) {
  const { pipelineId, port, apiPort } = req.body;
  if (!pipelineId || !port) {
    return res.status(400).json({ error: 'pipelineId and port are required' });
  }
  registry.set(String(pipelineId), { vitePort: Number(port), apiPort: Number(apiPort) });
  console.log(`[preview] registered: ${pipelineId} → vite:${port}, api:${apiPort}`);
  res.json({ ok: true, pipelineId, port, apiPort });
}

/**
 * DELETE /api/preview/:pipelineId
 */
function unregisterPreview(req, res) {
  const { pipelineId } = req.params;
  registry.delete(pipelineId);
  console.log(`[preview] unregistered: ${pipelineId}`);
  res.json({ ok: true });
}

/**
 * GET /preview/:pipelineId/*
 * - /preview/{id}/api/... → Express backend (strip prefix)
 * - /preview/{id}/...     → Vite dev server (full path)
 */
function proxyPreview(req, res) {
  const { pipelineId } = req.params;
  const registration = registry.get(pipelineId);

  if (!registration) {
    return res.status(404).send(`Preview "${pipelineId}" not found or has expired.`);
  }

  const { vitePort, apiPort } = registration;
  const apiPrefix = `/preview/${pipelineId}/api`;

  if (req.originalUrl.startsWith(apiPrefix) && apiPort) {
    // Route API calls to Express backend, strip /preview/{id}
    const targetPath = req.originalUrl.replace(`/preview/${pipelineId}`, '');
    return forwardRequest(req, res, AI_PIPELINE_HOST, apiPort, targetPath);
  }

  // Route everything else to Vite with full path
  return forwardRequest(req, res, AI_PIPELINE_HOST, vitePort, req.originalUrl);
}

module.exports = { registerPreview, unregisterPreview, proxyPreview };
