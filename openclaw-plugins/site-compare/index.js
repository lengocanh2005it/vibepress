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
          if (!forwardUrl) {
            json(response, 500, {
              error:
                'SITE_COMPARE_FORWARD_URL is not configured. OpenClaw site-compare mock mode has been removed; configure a real compare worker.',
            });
            return true;
          }

          const forwarded = await forwardComparePayload(
            forwardUrl,
            secret,
            payload,
          );
          json(response, 200, forwarded);
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
