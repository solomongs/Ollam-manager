# Verification and deployment status — 10 October 2026

## Result

Version **1.2.0**, developed by Solomon, adds Windows desktop packaging, a DGX ARM64 `.deb`, version/update information, a guarded Git source updater and container/release automation to the existing Ollama/MCP manager. Local application/browser checks are recorded below. Windows installer builds, native ARM64 package installation and registry publication require their corresponding release CI results; prepared definitions are not proof of completed distribution.

Installation on the user's DGX Spark has **not** been performed: Desktop Commander Remote reported no connected devices. No live DGX URL or actual GPU inference result is asserted. Windows GUI installation on the user's computer is also unverified. Windows installers are unsigned.

The backend uses Node.js built-in modules and architecture-independent HTML/CSS/JavaScript. The Windows wrapper/build tooling uses Electron and electron-builder. The source-script installer requires an existing ARM64 Node.js 22+ binary on DGX OS/Ubuntu with systemd; the `.deb` distribution bundles its own ARM64 runtime. The container includes its runtime and runs as nonroot. Real DGX hardware and actual Ollama/GPU compatibility still require verification on the Spark.

## Checks completed

- The complete local suite passed **66 checks with zero failures and two sandbox skips (68 total)**. Coverage includes authentication/permissions, CSRF/origin, private Ollama destinations, model APIs, background jobs, exact-byte GGUF imports, streaming chat/restart recovery and Tailscale ownership. MCP coverage includes HTTP JSON/SSE and event resumption, protocol/session headers, tool discovery/pagination, URL/DNS/redirect limits, secret redaction, config transport changes, exact-session one-use approvals, denial/expiry, fragmented tool calls, cancellation and complete multi-tool restart history, execution limits, shutdown of discovery, source staging and matching-release startup health. Distribution checks cover the pinned runtime checksum and ARM64 ELF, package metadata, guarded Git origins/fast-forward behavior, refusal to overwrite ignored credential state, desktop state/origin persistence and renderer isolation.
- Two actual stdio subprocess lifecycle tests are skipped because the test environment maps only UID 0 and cannot spawn a nonroot child. Stdio configuration and the production refusal to execute as root pass; real stdio launch, protocol exchange and cleanup remain to be verified under the DGX service account. The tests are included and automatically run in a suitable native/nonroot environment.
- Browser checks passed in Chromium using deterministic **mock Ollama and MCP** services: login, all nine pages, search, model inspection/copy, download, custom model creation, local GGUF import, benchmark results, streaming chat and saved chat reload, MCP connection creation/editing/testing/discovery/enable controls, hidden saved credentials, explicit approval and denial, saved tool history reopened on mobile, editable branding, update/version information, and shell cache exclusion of API responses.
- Desktop layout checked at 1440px; mobile navigation/layout checked at 360px, 390px, 430px and 768px. No horizontal document overflow or browser console/page errors were found. Desktop and mobile screenshots were visually inspected.
- JavaScript parsing and shell syntax checks passed. The installer correctly refused this x86 test workspace without changing managed system paths.

## Distribution checks still pending

The release workflow defines native Windows x64/ARM64 installer build/install/smoke jobs, ARM64 Ubuntu `.deb` build/install/upgrade/removal checks, and a nonroot container startup/login check followed by multi-architecture publication. Their successful CI results must be checked before claiming those release artifacts have been built or published. The workflow uploads `.exe`/`.deb`/source/checksums to GitHub Releases and publishes the container to GHCR. Anonymous container access additionally depends on public package visibility.

The local workspace is not a Windows system or DGX Spark. Unit tests with mocks do not establish native GUI installation, ARM64 package installation, real MCP stdio execution, NVIDIA telemetry/inference, remote Tailscale access or a successful public download. A signing certificate is not configured; no signed-Windows claim is made.

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
| Settings | Private server connections, server switching, editable workspace branding, PWA guidance, installed version and explicit GitHub release check/update instructions |
| Deployment | Dedicated service account, protected persistent state, startup service, backup/rollback, private Tailscale HTTPS route and retained-data uninstall |
| Windows desktop | Isolated Electron window, private loopback backend, initial-password/folder menus and state retained separately from installer files; native build/install requires CI evidence |
| ARM64 package | Bundled-runtime `.deb` definition and local desktop launcher; native install/upgrade/removal requires CI evidence |
| Source updates | Fixed project/main-branch Git check and fast-forward-only update of clean source checkouts; service activation remains explicit |
| Container | Nonroot manager image definition with protected state volume and multi-architecture publishing workflow; no bundled Ollama/models/drivers |

This release does not implement a scraped online model catalog, Hugging Face catalog search, registry push, arbitrary browser GGUF uploads, advanced Markdown/HTML previews, a built-in autonomous shell/filesystem agent, authenticated upstream Ollama proxy credentials, or commercial license features. It provides an MCP tools client; it does not expose the manager as an MCP server or implement legacy separate HTTP+SSE endpoints, OAuth, resource browsing, prompt templates, sampling or elicitation. Pulling a named model/reference is delegated to the selected Ollama service and requires that service's own network access and model support. Browser presets/bookmarks are local to their browser origin; the Windows wrapper preserves its loopback port/origin and renderer profile across launches. Chats/jobs/Ollama and MCP connection settings/branding persist on the manager host. Closing the Windows desktop app stops its backend, while a DGX service remains independent of its client browser.

## Next action on the Spark

Connect the Spark's remote device session, then install the ARM64 release package or run the source installer described in README.md. Verify the actual CPU architecture, bundled/source Node runtime, existing Ollama endpoint, service startup, and actual HTTPS URL. Log in from a laptop/phone on the same tailnet and check an existing model before selecting new downloads. Test a real trusted stdio MCP server under the installed nonroot service and an actual tool-capable Ollama model. No example hostname or historic IP is a verified live URL.

## Reproduce tests

Backend, deployment, updater and desktop unit checks need Node 22+; native installer builds additionally require their platform/build dependencies:

```bash
npm test
bash -n install.sh uninstall.sh
```

The optional `tests/browser-smoke.mjs` needs Playwright and an available Chromium executable. It starts and stops its own mock Ollama, MCP server and manager instance in temporary directories. `PLAYWRIGHT_CHROMIUM_EXECUTABLE` and a JSON array in `PLAYWRIGHT_CHROMIUM_ARGS` can select an existing browser runtime; `SCREENSHOT_DIR` chooses an optional output folder. The backend/DGX service does not require a browser runtime; the Windows desktop wrapper includes Electron's runtime.

Native desktop build and smoke commands are documented in [WINDOWS.md](docs/WINDOWS.md); publication gates and package visibility are documented in [RELEASING.md](docs/RELEASING.md).
