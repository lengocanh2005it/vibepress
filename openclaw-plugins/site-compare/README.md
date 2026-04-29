# OpenClaw Site Compare Plugin

Plugin scaffold to expose `POST /site/compare` for the Vibepress `ai-pipeline`.

## What it does

- Registers `POST /site/compare` inside OpenClaw.
- Protects the route with a shared secret header when `OPENCLAW_SITE_COMPARE_SECRET` is set.
- Requires `SITE_COMPARE_FORWARD_URL` and forwards the incoming payload to a real compare worker.
- Fails fast if the worker is not configured instead of silently returning mock metrics.

## Files

- `index.js`: plugin entry and HTTP route registration
- `openclaw.plugin.json`: plugin metadata
- `.env.example`: environment variables for the plugin runtime

## Install on the VM

Copy this folder to the VM, then install it into OpenClaw from the VM shell.

Example:

```bash
cd /path/to/openclaw-plugins/site-compare
openclaw plugins install .
openclaw gateway restart
```

## Suggested plugin env on the VM

```bash
export OPENCLAW_SITE_COMPARE_SECRET=replace-me
export SITE_COMPARE_FORWARD_URL=http://127.0.0.1:5000/api/site/compare
```
This forward target should point at the real Vibepress compare worker. In this
workspace that worker already exists in `automation` and exposes
`POST /api/site/compare`.

Without `SITE_COMPARE_FORWARD_URL`, `POST /site/compare` now returns `500`
instead of a fake success payload.

## Test the route

```bash
curl -X POST http://localhost:18789/site/compare \
  -H "Content-Type: application/json" \
  -H "x-site-compare-secret: replace-me" \
  -d '{
    "siteId": "demo-site",
    "jobId": "demo-job",
    "mode": "baseline",
    "wpBaseUrl": "http://192.168.1.20:8000",
    "reactFeUrl": "http://192.168.1.20:5469/preview/demo-job",
    "reactBeUrl": "http://192.168.1.20:5470",
    "routeEntries": [
      { "path": "/", "componentName": "Home" }
    ]
  }'
```

## Connect `ai-pipeline`

In `ai-pipeline/.env`:

```env
SITE_COMPARE_PROVIDER=hybrid
SITE_COMPARE_FALLBACK_PROVIDER=automation
OPENCLAW_URL=http://<VM_IP>:18789
OPENCLAW_COMPARE_PATH=/site/compare
OPENCLAW_API_KEY=replace-me
OPENCLAW_API_KEY_HEADER=x-site-compare-secret
OPENCLAW_API_KEY_PREFIX=
```

Important:

- `OPENCLAW_URL` must point to the OpenClaw gateway base, not the interactive
  chat page URL. Use `http://localhost:18789`, not
  `http://localhost:18789/chat?session=main`.
- If you accidentally pass the chat URL, the updated `ai-pipeline` provider now
  normalizes it back to the gateway origin automatically.

## Next step

The shortest path to a real integration is:

1. `ai-pipeline` calls OpenClaw `POST /site/compare`
2. OpenClaw plugin authenticates the request
3. Plugin forwards the payload to `automation` at
   `http://127.0.0.1:5000/api/site/compare`
4. `automation` opens WordPress + React, compares them, and returns metrics
5. Plugin returns that metrics payload back to `ai-pipeline`

That means the `site_compare` step is already integrated at the pipeline layer;
the OpenClaw plugin is now just a secured gateway that hands work to the real
compare worker.
