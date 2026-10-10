# Spark Ollama Manager 1.2.0 API contract

Version 1.2.0. Developed by Solomon.

Node.js >=22, built-in modules only. All API responses JSON except NDJSON streams.
Errors: `{error: "plain message"}` with appropriate non-2xx status.
Cookie sessions; all mutating API calls require `X-CSRF-Token` from session/login response. Same-origin Origin enforcement. No token in URL.

- GET /api/session -> `{authenticated, csrf?, branding:{title,subtitle,developedBy}}`
- POST /api/login `{password}` -> `{authenticated:true,csrf}`
- POST /api/logout -> `{ok:true}`
- GET /api/state -> `{settings:{title,subtitle},servers:[{id,name,url}],activeServerId,mcpServers:[sanitized connection],jobs:[...],chats:[{id,title,serverId,model,updatedAt}]}`
- POST /api/settings `{title,subtitle}` -> settings
- POST /api/servers `{id?,name,url}` -> server (http/https private/loopback only; saved fixed target)
- DELETE /api/servers/:id -> ok (default server cannot be deleted)
- POST /api/active-server `{id}` -> ok
- GET /api/status?serverId=... -> `{online,version?,error?,models:[],running:[],system:{hostname,platform,arch,uptime,totalMemory,freeMemory,load,disks?,gpus:[]}}` status errors yield online false
- POST /api/show `{serverId,model}` -> Ollama show JSON
- POST /api/copy `{serverId,source,destination}` -> ok
- POST /api/delete `{serverId,model}` -> ok
- POST /api/unload `{serverId,model}` -> ok
- POST /api/jobs `{serverId,type:'pull'|'create'|'import'|'benchmark',model,from?,system?,parameters?,template?,quantize?,path?,prompt?}` -> `{id,...}` 202
- GET /api/jobs -> jobs list. job fields `{id,type,model,serverId,status:'queued'|'running'|'completed'|'failed'|'cancelled'|'interrupted',message,completed?,total?,createdAt,updatedAt,result?,error?}`
- POST /api/jobs/:id/cancel -> job
- POST /api/jobs/:id/retry -> new job (same validated input)
- GET /api/import-files -> `{roots:[],files:[{path,name,size}]}` only `.gguf` in configured import root, no symlink escapes
- GET /api/chats/:id -> full chat `{id,title,serverId,model,messages:[{role,content,thinking?,tool_calls?,tool_name?}],mcpServerIds?:[],toolEvents?:[],updatedAt}`
- DELETE /api/chats/:id -> ok
- POST /api/chat `{chatId?,serverId,model,message,images?:[base64],system?,options?:{temperature,num_ctx},keep_alive?,mcpServerIds?:[]}` -> NDJSON chunks `{chatId}`, `{message:{role,content?,thinking?},done?,eval_count?,eval_duration?}` and final `{saved:true,chatId}`. Backend persists successful history; stream abort persists partial safely. MCP connections are opt-in; omit `mcpServerIds` or supply an empty array for ordinary chat. Up to eight enabled connections can be selected. Each proposed MCP tool call waits for a separate authenticated approval before execution.
- POST /api/chat/:chatId/tool-decision `{callId,approved:boolean}` -> `{ok:true}`. Requires the same session that opened the active chat stream and its CSRF token. The call must still be pending; approval is specific to one call, not to all tools in a conversation.
- GET /api/health -> unauthenticated `{ok:true,version,developedBy}`

## Update metadata

- GET /api/updates -> authenticated, read-only update metadata. Does not contact GitHub unless a cached check already exists.
- GET /api/updates?check=1 -> checks the fixed official GitHub Releases API, returning the same response shape. Results, including unavailable results, are cached in memory for five minutes; concurrent checks share one request.

```json
{
  "installedVersion": "1.2.0",
  "platform": "linux",
  "arch": "arm64",
  "installationMode": "deb",
  "repositoryUrl": "https://github.com/solomongs/Ollam-manager",
  "sourceUrl": "https://github.com/solomongs/Ollam-manager/archive/refs/heads/main.zip",
  "releasesUrl": "https://github.com/solomongs/Ollam-manager/releases",
  "releaseApiUrl": "https://api.github.com/repos/solomongs/Ollam-manager/releases/latest",
  "packages": {
    "windows": {
      "url": "https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/Spark-Ollama-Manager-1.2.0-windows-x64-setup.exe",
      "label": "Windows installer (x64)",
      "x64Url": "https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/Spark-Ollama-Manager-1.2.0-windows-x64-setup.exe",
      "x64Label": "Windows installer (x64)",
      "arm64Url": "https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/Spark-Ollama-Manager-1.2.0-windows-arm64-setup.exe",
      "arm64Label": "Windows installer (ARM64)"
    },
    "dgx": {
      "url": "https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/spark-ollama-manager_1.2.0_arm64.deb",
      "label": "DGX Spark package (ARM64)"
    },
    "source": {
      "url": "https://github.com/solomongs/Ollam-manager/archive/refs/tags/v1.2.0.zip",
      "label": "Source archive (1.2.0)"
    }
  },
  "update": {
    "command": "sudo apt install ./spark-ollama-manager_1.2.0_arm64.deb",
    "gitCommand": "node scripts/update.mjs --check\nnode scripts/update.mjs",
    "instructions": "Download the official DGX ARM64 package, run the command from its download folder, and reopen the manager. The package keeps settings and model files separate from application code."
  },
  "latest": { "status": "not-checked" }
}
```

`platform` and `arch` describe the manager host. `SPARK_INSTALLATION_MODE` accepts `desktop`, `deb`, `dgx`, `service`, `source` or `container`, defaulting to `source`; the embedded desktop runtime sets `desktop` explicitly. A Windows ARM64 desktop uses the ARM64 URL as its main Windows download, while both Windows architecture URLs remain available. `latest.status` is `not-checked`, `current`, `available` or `unavailable`; a completed check adds `checkedAt`, a valid stable release adds `version`, and an unavailable check adds `error`. Version comparison uses numeric stable semantic-version components. Download URLs advance only for a newer release; an older remote release never recommends a downgrade.

Only `check=1` is accepted; unknown or duplicate query parameters return HTTP 400. The release check always uses the literal `https://api.github.com/repos/solomongs/Ollam-manager/releases/latest`, validates and pins public DNS addresses, requires normal TLS verification, refuses redirects, limits its JSON response to 512 KiB and stops after five seconds. Server shutdown cancels pending checks. GitHub response URLs and asset URLs are ignored: package links are constructed from the fixed official repository, validated version and known filenames. Offline, unpublished or invalid release metadata produces `latest.status:"unavailable"` while retaining usable local metadata and instructions.

The endpoint writes no application files and executes no commands. There is no POST update/download/install endpoint. `update.command`, `gitCommand` and `instructions` are copyable guidance: package users install a downloaded newer package, source users run `scripts/update.mjs` from a clean official Git checkout and restart/redeploy, and container users pull/recreate the official image while retaining their persistent volume. Desktop and container modes can return an empty `command` with platform-specific instructions. `gitCommand` always runs the guarded source updater's check followed by update; it verifies the official origin and refuses to overwrite ignored local credentials or state. It applies to a source checkout only; it is not an updater for an installed `.exe` or `.deb`.

## MCP connection endpoints

- GET /api/mcp/servers -> sanitized saved connection list.
- POST /api/mcp/servers `{id?,name,transport:'http'|'stdio',enabled,url?,bearerToken?,command?,args?:[],env?:{},cwd?}` -> sanitized saved connection. Supplying `id` updates that connection. HTTP requires an MCP endpoint URL; stdio requires an absolute executable path, optional JSON argument array/environment object, and optional absolute working directory. Windows commands must be regular `.exe` files; scripts are arguments to an executable such as Node or Python. POSIX commands require execute permission. No shell interpolation is performed.
- DELETE /api/mcp/servers/:id -> `{ok:true}`.
- POST /api/mcp/servers/:id/test -> `{ok,serverInfo,protocolVersion,tools:[]}`. Initializes and discovers tools; it does not call a discovered tool.
- GET /api/mcp/servers/:id/tools -> `{tools:[]}`. Tool records contain names, descriptions and JSON input schemas returned by the MCP server.

Connection responses contain no saved bearer token or environment values. Public fields include `hasToken:boolean` and `envKeys:[]`, alongside the nonsecret connection fields. Omit `bearerToken`/`env` when updating to preserve them; use `bearerToken:""`/`env:{}` to clear them. Credentials reside in protected mode-0600 state files, not in browser storage or URL query strings. Programs can receive configured secrets through their environment. Administrators should keep secrets out of visible command arguments.

Supported transports are local stdio and Streamable HTTP with JSON/SSE responses and optional bearer authentication. The client advertises revision `2025-11-25`, accepting negotiation to `2025-06-18`, `2025-03-26` or `2024-11-05`; later draft revisions are not supported. OAuth authorization, legacy separate HTTP+SSE endpoints, resource browsing, prompt templates, and exposing the manager itself as an MCP server are not implemented. Stdio launch is refused when the manager runs as root. Installed DGX stdio processes run as the manager service account and inherit its systemd filesystem restrictions. Windows desktop stdio processes run as the desktop user, receive a limited set of essential Windows profile/system/temp environment variables plus explicitly configured values, and are closed with bounded, best-effort process-tree cleanup without a shell. Cancelling an approved tool request cannot undo side effects that already occurred.

HTTP targets must be direct URLs without query strings, fragments or embedded credentials; redirects are refused. Public targets require HTTPS, while private/loopback targets can use HTTP. DNS addresses are validated and pinned for each request; metadata, link-local and reserved targets are blocked. Transport limits include 256 KiB JSON request/configuration size, 2 MiB JSON/SSE response size, 500 tools across at most 20 catalog pages, and at most four simultaneous stdio processes. Stdio args and environment each allow at most 64 entries. Connection tests/discovery use a 15-second request timeout; MCP operations during chat use 30 seconds. At most 32 connections can be saved. Updates/deletion are refused while an active chat uses that connection.

Interrupted POST SSE responses can be resumed through GET using their event ID, with at most two retries. An expired HTTP session fails the current operation; the next connection operation can initialize a new session. Tool calls are not automatically replayed after session expiry.

## MCP chat events

The `/api/chat` stream adds these events when connections were selected:

```json
{"toolCall":{"id":"call-id","serverId":"connection-id","serverName":"Example","name":"lookup","arguments":{"query":"example"},"status":"pending"}}
{"toolResult":{"id":"call-id","name":"lookup","status":"completed","content":"tool output as text","isError":false}}
```

`toolResult.status` can be `completed`, `denied` or `failed`. The server/tool/arguments shown by the approval event identify the exact pending call. A five-minute decision timeout counts as denial; disconnection cancels the wait and chat stream. There is no automatic approval. Approved calls return their result to Ollama as tool messages before the next model round. Denials and failures also become tool results so the model can respond. Tool-capable models are required; ordinary chat remains available without MCP.

Saved chats include their selected `mcpServerIds` and `toolEvents`, with fields `{id,serverId,serverName,name,functionName?,arguments,status,content?,isError?,createdAt,completedAt?}`. Saved event statuses also include `pending`, `running` and `cancelled`; disconnection or service restart cancels unfinished calls without replaying them. Assistant history retains `tool_calls` with manager-generated function aliases, followed by `role:'tool'` messages with `tool_name`/text `content`. History views do not approve old calls.

Chat limits are eight selected connections, 128 tools across those connections, eight model/tool rounds, 16 calls per response and eight calls in one round. Tool schema data is limited to 1 MiB, arguments to 64 KiB, and the text result retained/returned to Ollama to 256 KiB. Text and structured result content are supported; image/audio results become descriptive text markers rather than a multimodal result attachment. Only connection configuration secrets are withheld from direct configuration readback; a third-party tool can itself return sensitive content, which is retained with the chat and sent to the selected Ollama host.

Static: /index.html /app.js /style.css /manifest.webmanifest /sw.js /icon.svg; CSP self-only, no external assets. Service worker caches shell only, never API or authentication.
State in DATA_DIR (default ./data), atomic writes, files mode 0600. Jobs serial queue; streaming pulls survive tab close. Abort cancels remote request, does not delete partial model blobs. On restart running/queued jobs marked interrupted. GGUF files streamed to Ollama blobs after hashing; no model path deletion. Password generated on first launch, stored first-login.txt 0600, hashed with scrypt; password changing CLI via scripts/password.mjs. GPU statistics use fixed nvidia-smi with timeout; stdio MCP uses a separately configured executable/argument array without a shell. No npm dependencies.
