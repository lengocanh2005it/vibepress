import { All, Controller, Param, Req, Res } from '@nestjs/common';
import { createHash } from 'crypto';
import * as http from 'http';
import { Request, Response } from 'express';

function pickDeterministicPort(
  jobId: string,
  salt: string,
  base: number,
  span: number,
): number {
  const hash = createHash('sha1').update(`${salt}:${jobId}`).digest('hex');
  const offset = parseInt(hash.slice(0, 8), 16) % span;
  return base + offset;
}

function pickVitePort(jobId: string): number {
  return pickDeterministicPort(jobId, 'vite', 5300, 200);
}

function pickApiPort(jobId: string): number {
  return pickDeterministicPort(jobId, 'api', 3700, 200);
}

function forwardRequest(
  req: Request,
  res: Response,
  host: string,
  port: number,
  path: string,
): void {
  const options: http.RequestOptions = {
    hostname: host,
    port,
    path,
    method: req.method,
    headers: { ...req.headers, host: `${host}:${port}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode!, proxyRes.headers as Record<string, string>);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on('error', () => {
    if (!res.headersSent) res.status(502).send('Preview server is not responding.');
  });

  (req as any).pipe(proxyReq, { end: true });
}

@Controller()
export class PreviewProxyController {
  /**
   * Proxy /preview/:pipelineId/* → Vite dev server
   * /preview/:pipelineId/api/* → Express backend (strip prefix)
   */
  @All(['/preview/:pipelineId', '/preview/:pipelineId/*splat'])
  handlePreview(
    @Param('pipelineId') pipelineId: string,
    @Req() req: Request,
    @Res() res: Response,
  ): void {
    const vitePort = pickVitePort(pipelineId);
    const apiPort = pickApiPort(pipelineId);
    const apiPrefix = `/preview/${pipelineId}/api`;

    if (req.originalUrl.startsWith(apiPrefix)) {
      const targetPath = req.originalUrl.replace(`/preview/${pipelineId}`, '');
      return forwardRequest(req, res, 'localhost', apiPort, targetPath);
    }

    return forwardRequest(req, res, 'localhost', vitePort, req.originalUrl);
  }

  /**
   * Proxy /assets/images/* → Vite dev server của preview tương ứng (via Referer)
   */
  @All(['/assets/images', '/assets/images/*splat'])
  handleAssets(@Req() req: Request, @Res() res: Response): void {
    const referer = (req.headers.referer || req.headers.referrer || '') as string;
    const match = referer.match(/\/preview\/([^/]+)\//);

    if (!match) {
      res.status(404).send('Not found');
      return;
    }

    const pipelineId = match[1];
    const vitePort = pickVitePort(pipelineId);
    const targetPath = `/preview/${pipelineId}${req.originalUrl}`;
    return forwardRequest(req, res, 'localhost', vitePort, targetPath);
  }
}
