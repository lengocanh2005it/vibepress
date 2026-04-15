const http = require('http');

// pipelineId → port (in-memory, reset khi server restart)
const registry = new Map();

/**
 * POST /api/preview/register
 * Body: { pipelineId: string, port: number }
 * AI pipeline gọi endpoint này khi preview sẵn sàng.
 */
function registerPreview(req, res) {
  const { pipelineId, port } = req.body;
  if (!pipelineId || !port) {
    return res.status(400).json({ error: 'pipelineId and port are required' });
  }
  registry.set(String(pipelineId), Number(port));
  console.log(`[preview] registered: ${pipelineId} → port ${port}`);
  res.json({ ok: true, pipelineId, port });
}

/**
 * DELETE /api/preview/:pipelineId
 * Xoá khỏi registry khi pipeline kết thúc.
 */
function unregisterPreview(req, res) {
  const { pipelineId } = req.params;
  registry.delete(pipelineId);
  console.log(`[preview] unregistered: ${pipelineId}`);
  res.json({ ok: true });
}

/**
 * GET /preview/:pipelineId/*
 * Nginx forward vào đây, proxy tới Vite dev server đúng port.
 */
function proxyPreview(req, res) {
  const { pipelineId } = req.params;
  const port = registry.get(pipelineId);

  if (!port) {
    return res.status(404).send(`Preview "${pipelineId}" not found or has expired.`);
  }

  // Strip /preview/:pipelineId khỏi path để forward đúng
  const targetPath = req.originalUrl.replace(`/preview/${pipelineId}`, '') || '/';

  const options = {
    hostname: 'localhost',
    port,
    path: targetPath,
    method: req.method,
    headers: {
      ...req.headers,
      host: `localhost:${port}`,
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

module.exports = { registerPreview, unregisterPreview, proxyPreview };
