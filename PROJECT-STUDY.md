# OllaMan 3.7.5 package study

Independent web implementation: **Spark Ollama Manager 1.1.0, developed by Solomon.**

Inspected 2026-10-10 without installing or executing the package. The supplied Debian package is an AMD64 desktop build and cannot run natively on DGX Spark ARM64. A browser service must replace its Tauri/native runtime.

## Package evidence

- File: `upload/OllaMan_3.7.5_amd64.deb` (11,257,488 bytes).
- SHA-256: `c849c04036d5dd56546357886f679dc40d81c0c2dff83db13bcc78067cfbb895`.
- Control: package `olla-man`, version `3.7.5`, architecture `amd64`, installed size 34,032 KiB, maintainer `you`, description `A Tauri App`.
- Declared dependencies: `libayatana-appindicator3-1`, `libwebkit2gtk-4.1-0`, `libgtk-3-0`.
- Contents: `/usr/bin/ollaman`, desktop launcher, and three PNG icons. No source project, separate web server, or license file is bundled.
- Executable: x86-64 ELF PIE, dynamically linked, unstripped; build ID `6c247a1dbda9baa701897804f88f4e6dda5cbb31`.
- App identifier: `com.jaeger.ollaman.app`; updater URL: `https://dl.ollaman.com/updates/latest.json`.

## Architecture evidence from compiled bundle

The static ELF includes Brotli-compressed JavaScript and CSS in Tauri embedded assets. They were recovered from asset pointers in the ELF relocation table and decompressed using system libbrotlidec. Files are intermediate inspection material only: JavaScript (4,847,951 bytes) and CSS (137,394 bytes). Do not ship these as the user's new product.

Frontend dependencies evidenced by embedded code: React, Ant Design, Lobe UI, Zustand, i18next, Prism syntax highlighting, Tailwind-generated classes. The desktop runtime uses Tauri 2, Rust HTTP transport, native dialogs/filesystem, tray/autostart/updater plugins, config stores, and SQLite. Chat uses `sqlite:chat.db`, enables WAL, and stores agents, agent sessions, session messages, session folders, model usage, and capability cache.

The Ollama client defaults to `http://127.0.0.1:11434`, supports request/response JSON and NDJSON streaming with cancellation, and exposes `/api/tags`, `/show`, `/copy`, `/delete`, `/pull`, `/push`, `/create`, `/generate`, `/chat`, `/embed`, `/embeddings` (deprecated), `/ps`, and `/version`. Native commands include `fetch_request`, `fetch_stream_request`, `cancel_stream_request`, `upload_blob_request`, device fingerprinting, and agent-mode read/write/edit/bash/skills operations. Token speed derives from `eval_count / (eval_duration / 1e9)`.

Online Ollama catalog uses the official `/search` and `/library/` pages; Hugging Face catalog uses public `/api/models` and `/api/models/{repo}/tree/main` plus repository README/file URLs. Mirror defaults include huggingface.co and hf-mirror.com. License APIs are on ollaman.com: `/api/license/activate`, `/validate`, `/deactivate`.

## Feature matrix

| Area | Observed product capability | Web implementation implication | Evidence |
|---|---|---|---|
| Dashboard | Installed count, disk totals, running models, quantization, loaded memory, expiration, unload | Use tags/ps; label Spark unified memory accurately | [Running models](https://ollaman.com/docs/features/running-models) + compiled client |
| Local models | Search/filter/sort, details, capabilities, deletion including batch, copies, registry push | Use tags/show/delete/copy/push; confirm destructive actions | [Changelog](https://ollaman.com/changelog) + client |
| Registry discovery | Search official catalog and install a named model/tag | Server-side catalog fetch and pull jobs | [Features](https://ollaman.com/docs/features) + compiled catalog |
| Downloads | Concurrent jobs, progress, speed/ETA, cancellation, exact model entry | Durable background job state and NDJSON consumption | [Homepage](https://ollaman.com/) + compiled pull stream |
| Hugging Face GGUF | Search, variants, file/license metadata, mirrors, references and file URL import | Hugging Face API and validated model references | [GGUF docs](https://ollaman.com/docs/features/huggingface-gguf) |
| Local GGUF | Select/upload raw GGUF, create model, cancellation, progress | Stream uploaded file into Ollama blob then create | [Import guide](https://ollaman.com/docs/features/local-gguf-import) + native upload command |
| Model Factory | Base model, name, system prompt, temperature/top-p/top-k, preset templates | Create API with base/model params; retain full model metadata | [Factory guide](https://ollaman.com/docs/features/model-factory) |
| Chat | Streaming, Markdown/code, reasoning, images/text attachments, live HTML preview | NDJSON chat; safe rendering and sandbox preview; persist conversations | [Homepage](https://ollaman.com/) + compiled chat/database |
| Agent presets | Name/icon/description/model/system prompt/params; agent-specific histories | Editable assistant profiles persisted on DGX | [Agents guide](https://ollaman.com/docs/features/agents) |
| Autonomous Agent Mode | Read/write/edit files, shell, skills; per-agent working directory, approval and timeout | Separate advanced feature; explicit scope/sandbox needed before enabling remote shell execution | [Agent Mode](https://ollaman.com/docs/features/agent-mode) + native commands |
| Benchmarking | Response tokens, time, tokens/s, performance card | Derive from Ollama done chunk; show benchmark records | [Token speed guide](https://ollaman.com/docs/features/token-speed) |
| Servers | Multi-server selection, version/health/latency, none/basic/bearer/custom auth | Store credentials server-side and authorize server changes | [Multi-server guide](https://ollaman.com/docs/features/multi-server) |
| Desktop extras | Tray, autostart, native update, native file pickers, English/Chinese, light/dark | Replace autostart with systemd and navigation with browser responsive UI | Compiled plugins and changelog |

## Independent web implementation and MCP extension

The implementation replaces the x86 desktop runtime with an architecture-independent Node.js service and a responsive browser interface. It retains the core Ollama management workflows: model listing/details/copy/delete/unload, durable downloads, local GGUF import, custom models, streaming chat/history, multiple private Ollama endpoints and benchmarks. The implementation's feature coverage and limitations are documented in [README.md](README.md) and [VERIFICATION.md](VERIFICATION.md); this is not a full parity claim or an official OllaMan port.

Version 1.1.0 adds MCP support requested for Solomon's manager. The manager acts as a client for separately installed local stdio servers or Streamable HTTP endpoints. It discovers tools, shows their schemas, tests connections, and allows selected connections in tool-capable Ollama chats. Each proposed tool call requires an explicit decision before execution; its result is returned to Ollama and retained in the conversation. It does not provide built-in autonomous shell/filesystem tools, install third-party MCP servers, or expose its own MCP server endpoint.

MCP is an independent extension to this web application. The package study did not establish a corresponding MCP implementation in the supplied original product, so the added capability is not attributed to OllaMan. MCP credentials are kept in protected server-side state and withheld from connection API readback. A configured stdio server executes as the manager's nonroot service account; approved operations can use whatever access that server has. Remote tools and cloud-backed models can send data outside the Spark. See the MCP usage guide for connection configuration, approval behavior and supported transport scope.

## Licensing / scope

The linked public repository is [jae-jae/ollaman-releases](https://github.com/jae-jae/ollaman-releases). Its visible tree contains README.md and image.png, not application source. No redistribution/open-source grant for OllaMan itself was found in the supplied package or visible repository. Third-party MIT notices refer to embedded dependencies and do not grant rights to OllaMan's entire application. Website footer states All Rights Reserved and the [terms](https://ollaman.com/terms) reserve original product content/features. Use the product as a functional reference and build an independently implemented manager against Ollama's documented public APIs. Do not remove or bypass its licensing checks or claim an official port.

The package metadata confirms 3.7.5; the fetched public changelog currently ends at 3.7.4 (2026-08-18). Distinguish exact package evidence from broader current upstream documentation. Neither a browser distribution nor an ARM64 source build was observed.

