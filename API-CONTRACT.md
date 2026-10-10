# Spark Ollama Manager API contract

Version 1.1.0. Developed by Solomon.

Node.js >=22, built-in modules only. All API responses JSON except NDJSON streams.
Errors: `{error: "plain message"}` with appropriate non-2xx status.
Cookie sessions; all mutating API calls require `X-CSRF-Token` from session/login response. Same-origin Origin enforcement. No token in URL.

- GET /api/session -> `{authenticated, csrf?, branding:{title,subtitle}}`
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
- GET /api/health -> unauthenticated `{ok:true,version}`

## MCP connection endpoints

- GET /api/mcp/servers -> sanitized saved connection list.
- POST /api/mcp/servers `{id?,name,transport:'http'|'stdio',enabled,url?,bearerToken?,command?,args?:[],env?:{},cwd?}` -> sanitized saved connection. Supplying `id` updates that connection. HTTP requires an MCP endpoint URL; stdio requires an absolute executable path, optional JSON argument array/environment object, and optional absolute working directory. No shell interpolation is performed.
- DELETE /api/mcp/servers/:id -> `{ok:true}`.
- POST /api/mcp/servers/:id/test -> `{ok,serverInfo,protocolVersion,tools:[]}`. Initializes and discovers tools; it does not call a discovered tool.
- GET /api/mcp/servers/:id/tools -> `{tools:[]}`. Tool records contain names, descriptions and JSON input schemas returned by the MCP server.

Connection responses contain no saved bearer token or environment values. Public fields include `hasToken:boolean` and `envKeys:[]`, alongside the nonsecret connection fields. Omit `bearerToken`/`env` when updating to preserve them; use `bearerToken:""`/`env:{}` to clear them. Credentials reside in protected mode-0600 state files, not in browser storage or URL query strings. Programs can receive configured secrets through their environment. Administrators should keep secrets out of visible command arguments.

Supported transports are local stdio and Streamable HTTP with JSON/SSE responses and optional bearer authentication. The client advertises revision `2025-11-25`, accepting negotiation to `2025-06-18`, `2025-03-26` or `2024-11-05`; later draft revisions are not supported. OAuth authorization, legacy separate HTTP+SSE endpoints, resource browsing, prompt templates, and exposing the manager itself as an MCP server are not implemented. Stdio launch is refused when the manager runs as root. Installed stdio processes run as the manager service account and inherit its systemd filesystem restrictions.

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
