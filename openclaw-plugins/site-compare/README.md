# OpenClaw Site Compare Plugin

Plugin scaffold to expose `POST /site/compare` for the Vibepress `ai-pipeline`.

## What it does

- Registers `POST /site/compare` inside OpenClaw.
- Protects the route with a shared secret header when `OPENCLAW_SITE_COMPARE_SECRET` is set.
- Returns a mock compare payload that already matches the metrics shape expected by `ai-pipeline`.
- Optionally forwards the incoming payload to another compare worker when `SITE_COMPARE_FORWARD_URL` is configured.

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
```

Optional forward mode:

```bash
export SITE_COMPARE_FORWARD_URL=http://127.0.0.1:3009/site/compare
```

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

## Next step

Replace the mock response in `index.js` with real browser capture logic or point `SITE_COMPARE_FORWARD_URL` at a worker that performs the actual compare.
