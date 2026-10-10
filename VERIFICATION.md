# Verification and deployment status — 10 October 2026

## Result

Version **1.1.0**, developed by Solomon, is built and tested with MCP tool support. Installation on the user's DGX Spark has **not** been performed: Desktop Commander Remote reported no connected devices. No live DGX URL or actual GPU inference result is asserted.

The source uses Node.js built-in modules and architecture-independent HTML/CSS/JavaScript. The installer requires an existing ARM64 Node.js 22+ binary on DGX OS/Ubuntu with systemd. ARM64 installation and actual Ollama/GPU compatibility still require verification on the Spark.

## Checks completed

- **37 automated checks passed, zero failed, two skipped** (39 total): 10 existing manager integration checks, nine MCP backend checks, eight MCP client checks and 10 deployment checks. Existing coverage includes authentication/permissions, CSRF/origin, private Ollama destinations, model APIs, background jobs, exact-byte GGUF imports, streaming chat/restart recovery and Tailscale ownership. New coverage verifies MCP HTTP JSON/SSE and event resumption, protocol/session headers, tool discovery/pagination, URL/DNS/redirect limits, secret redaction, config transport changes, exact-session one-use approvals, denial/expiry, fragmented tool calls, cancellation and complete multi-tool restart history, execution limits, shutdown of discovery, source staging and matching-release startup health.
- Two actual stdio subprocess lifecycle tests are skipped because the test environment maps only UID 0 and cannot spawn a nonroot child. Stdio configuration and the production refusal to execute as root pass; real stdio launch, protocol exchange and cleanup remain to be verified under the DGX service account. The tests are included and automatically run in a suitable native/nonroot environment.
- Browser checks passed in Chromium using deterministic **mock Ollama and MCP** services: login, all nine pages, search, model inspection/copy, download, custom model creation, local GGUF import, benchmark results, streaming chat and saved chat reload, MCP connection creation/editing/testing/discovery/enable controls, hidden saved credentials, explicit approval and denial, saved tool history reopened on mobile, editable branding, and shell cache exclusion of API responses.
- Desktop layout checked at 1440px; mobile navigation/layout checked at 360px, 390px, 430px and 768px. No horizontal document overflow or browser console/page errors were found. Desktop and mobile screenshots were visually inspected.
- JavaScript parsing and shell syntax checks passed. The installer correctly refused this x86 test workspace without changing managed system paths.

Screenshots produced during verification show the test environment and fixture model data. They do not show a running DGX installation. Regenerate them locally with `SCREENSHOT_DIR` in the browser check below; generated PNGs are omitted from the source repository. The test GGUF is a fixture accepted by the mock API; a real GGUF has not been imported on the Spark.

## Functional coverage

| Workflow | Delivered behavior |
|---|---|
| Overview | Ollama connectivity, installed/loaded models, real host RAM/load/uptime/disk API data and nullable NVIDIA telemetry |
| Models | Search/sort, details, copy, confirmed delete and unload |
| Discover | Official catalog links, model reference download, editable browser-local bookmarks |
| Downloads | Server-side persistent serial queue, progress, cancellation, retry, restart interruption recovery |
| Model Studio | Create from an installed base with system prompt/template/parameters, or import GGUF from configured server folders |
| Chat | Streaming response/reasoning, saved conversations, stop, supported image/text attachments, export, browser-local assistant instructions, optional MCP tool rounds with per-call approval |
| MCP connections | Local stdio and Streamable HTTP tools client, discovery/test, optional bearer/env credentials, enabled connections selected per chat, explicit approval/denial and durable tool activity |
| Benchmark | Measured token throughput from Ollama response durations; results saved as jobs |
| Settings | Private server connections, server switching, editable workspace branding, PWA guidance |
| Deployment | Dedicated service account, protected persistent state, startup service, backup/rollback, private Tailscale HTTPS route and retained-data uninstall |

This release does not implement a scraped online model catalog, Hugging Face catalog search, registry push, arbitrary browser GGUF uploads, advanced Markdown/HTML previews, a built-in autonomous shell/filesystem agent, authenticated upstream Ollama proxy credentials, or commercial license features. It provides an MCP tools client; it does not expose the manager as an MCP server or implement legacy separate HTTP+SSE endpoints, OAuth, resources, prompts, sampling or elicitation. Pulling a named model/reference is delegated to the installed Ollama service and requires that service's own network access and model support. Browser presets/bookmarks are local to that browser; DGX chats/jobs/Ollama and MCP connection settings/branding are persisted on the server.

## Next action on the Spark

Connect the Spark's remote device session, then run the installer described in README.md. Verify the actual CPU architecture, Node version, existing Ollama endpoint, service startup, and printed HTTPS URL. Log in from a laptop/phone on the same tailnet and check an existing model before selecting new downloads. Test a real trusted stdio MCP server under the installed nonroot service and an actual tool-capable Ollama model. No example hostname or historic IP is a verified live URL.

## Reproduce tests

Core checks need Node 22+ only:

```bash
npm test
bash -n install.sh uninstall.sh
```

The optional `tests/browser-smoke.mjs` needs Playwright and an available Chromium executable. It starts and stops its own mock Ollama, MCP server and manager instance in temporary directories. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` and a JSON array in `PLAYWRIGHT_CHROMIUM_ARGS` can select an existing browser runtime; `SCREENSHOT_DIR` chooses an optional output folder. No browser runtime is required by the production manager or included in this package.
