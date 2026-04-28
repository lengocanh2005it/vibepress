import { definePluginEntry } from 'openclaw/plugin-sdk/plugin-entry';

function json(response, statusCode, body) {
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(body));
}

async function readRequestJson(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  return raw ? JSON.parse(raw) : {};
}

function normalizeBaseUrl(value) {
  return typeof value === 'string' ? value.trim().replace(/\/$/, '') : '';
}

function buildMockCompareResult(payload) {
  const routeEntries = Array.isArray(payload.routeEntries) ? payload.routeEntries : [];
  const pages = routeEntries.map((entry, index) => {
    const route =
      entry && typeof entry === 'object' && typeof entry.path === 'string'
        ? entry.path
        : index === 0
          ? '/'
          : `/route-${index + 1}`;

    return {
      route,
      componentHint:
        entry && typeof entry === 'object' && typeof entry.componentName === 'string'
          ? entry.componentName
          : undefined,
      repairPriority: 'low',
      visual: {
        status: 'PENDING',
        accuracy: 100,
        diffPct: 0,
        regions: [],
      },
      content: {
        status: 'PENDING',
      },
    };
  });

  return {
    provider: 'openclaw',
    result: {
      urlA: payload.wpBaseUrl,
      urlB: payload.reactFeUrl,
      diffPercentage: 0,
      differentPixels: 0,
      totalPixels: 0,
      summary: {
        overall: {
          visualAvgAccuracy: 100,
          visualPassRate: 1,
          contentAvgOverall: 1,
          diffPercentage: 0,
          differentPixels: 0,
          totalPixels: 0,
        },
      },
      artifacts: {
        provider: 'openclaw',
        mode: payload.mode ?? 'baseline',
        note: 'Mock compare result from scaffolded OpenClaw plugin. Replace with real browser compare logic.',
      },
      pages,
    },
  };
}

async function forwardComparePayload(forwardUrl, secret, payload) {
  const headers = {
    'content-type': 'application/json',
  };

  if (secret) {
    headers['x-site-compare-secret'] = secret;
  }

  const response = await fetch(forwardUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }

  if (!response.ok) {
    const reason =
      parsed && typeof parsed === 'object' && typeof parsed.error === 'string'
        ? parsed.error
        : `Forward compare failed with HTTP ${response.status}`;
    throw new Error(reason);
  }

  return parsed;
}

export default definePluginEntry({
  id: 'site-compare',
  name: 'Site Compare',
  description: 'Expose POST /site/compare for Vibepress ai-pipeline.',
  register(api) {
    api.registerHttpRoute({
      path: '/site/compare',
      match: 'exact',
      auth: 'plugin',
      handler: async (request, response) => {
        if (request.method !== 'POST') {
          json(response, 405, {
            error: 'Method not allowed',
          });
          return true;
        }

        const secret = process.env.OPENCLAW_SITE_COMPARE_SECRET?.trim() ?? '';
        const incomingSecret =
          request.headers['x-site-compare-secret'] ??
          request.headers['x-openclaw-site-compare-secret'] ??
          request.headers.authorization;
        const normalizedIncomingSecret = Array.isArray(incomingSecret)
          ? incomingSecret[0]
          : incomingSecret;

        if (
          secret &&
          `${normalizedIncomingSecret ?? ''}`.trim() !== secret
        ) {
          json(response, 401, {
            error: 'Unauthorized',
          });
          return true;
        }

        try {
          const payload = await readRequestJson(request);
          payload.wpBaseUrl = normalizeBaseUrl(payload.wpBaseUrl);
          payload.reactFeUrl = normalizeBaseUrl(payload.reactFeUrl);
          payload.reactBeUrl = normalizeBaseUrl(payload.reactBeUrl);

          const forwardUrl = process.env.SITE_COMPARE_FORWARD_URL?.trim();
          if (forwardUrl) {
            const forwarded = await forwardComparePayload(
              forwardUrl,
              secret,
              payload,
            );
            json(response, 200, forwarded);
            return true;
          }

          json(response, 200, buildMockCompareResult(payload));
          return true;
        } catch (error) {
          json(response, 500, {
            error:
              error instanceof Error ? error.message : String(error),
          });
          return true;
        }
      },
    });
  },
});
