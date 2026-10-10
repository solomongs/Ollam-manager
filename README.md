# Spark Ollama Manager

**Developed by Solomon. Version 1.2.0.**

[Release v1.2.0](https://github.com/solomongs/Ollam-manager/releases/tag/v1.2.0) · [All releases](https://github.com/solomongs/Ollam-manager/releases)

No paid licence, subscription or activation key is required to run this application.

A private Ollama and MCP manager with a browser interface, a Windows desktop wrapper, and an ARM64 installer for NVIDIA DGX Spark. The DGX service uses Node.js built-ins and starts through systemd; it needs no desktop session. The standalone backend needs Node.js 22 or newer, while release installers supply their own application runtime. Existing Ollama installations and model storage remain separate from the manager.

This is an independently implemented manager, informed by a study of the supplied OllaMan 3.7.5 AMD64 desktop package. It does not redistribute OllaMan's compiled frontend or native executable. See [PROJECT-STUDY.md](PROJECT-STUDY.md) for package evidence, observed features and scope differences. The code in this project is MIT licensed.

## Choose your installation

| Platform / workflow | Distribution | Guide |
|---|---|---|
| Windows desktop | Download `.exe`: [x64](https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/Spark-Ollama-Manager-1.2.0-windows-x64-setup.exe) / [ARM64](https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/Spark-Ollama-Manager-1.2.0-windows-arm64-setup.exe) | [Windows setup](docs/WINDOWS.md) |
| DGX Spark, DGX OS / Ubuntu ARM64 | Download [ARM64 `.deb`](https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/spark-ollama-manager_1.2.0_arm64.deb) | [DGX package setup](docs/DGX-PACKAGE.md) |
| Browser backend on Windows / Linux / macOS | Git source checkout with Node.js 22+ | [Run from source](#run-from-source-on-windows-linux-or-macos) |
| DGX source deployment | Source folder plus `install.sh` | [Source install below](#install-on-the-dgx) |
| Linux container | Multi-architecture image in GitHub Packages / GHCR | [Container setup](docs/CONTAINER.md) |

The project repository is [solomongs/Ollam-manager](https://github.com/solomongs/Ollam-manager). **Release v1.2.0 is published** with both Windows installers, the DGX package, a [source ZIP](https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/Spark-Ollama-Manager-1.2.0-source.zip) and [SHA256SUMS](https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/SHA256SUMS). The Linux AMD64/ARM64 container is also published on the repository's [Packages page](https://github.com/solomongs/Ollam-manager/pkgs/container/ollam-manager) as `ghcr.io/solomongs/ollam-manager:1.2.0` and `:latest`; it is Public and anonymous pulling was verified. GitHub Packages hosts the container, while Releases stores the `.exe` and `.deb` downloads. See [release publishing](docs/RELEASING.md) for the process and package visibility.

Native x64/ARM64 Windows installer smoke checks and ARM64 Ubuntu package lifecycle checks passed before publication. See [VERIFICATION.md](VERIFICATION.md) for the job evidence and the remaining checks on the user's physical DGX, GPU inference and private access URL. Windows installers are unsigned.

## Included workflows

- Dashboard with Ollama connectivity, installed/running models and host statistics.
- Model details, named model pulls, copy, delete and unload.
- Background jobs with progress, cancellation, retry and restart recovery.
- Custom models from an installed base and local GGUF imports.
- Streaming chat, conversation history, supported-model image input and token metrics.
- Benchmark jobs and multiple private Ollama server endpoints.
- MCP connections over local stdio or Streamable HTTP, tool discovery and connection tests.
- Optional MCP tools in chat with approval for every proposed tool call.
- Editable application title/subtitle, responsive navigation and installable PWA shell.
- Version/update information with fixed GitHub links and a guarded Git source updater.

The manager has one administrator password. Custom assistant instructions and model bookmarks use browser-local storage; conversations, jobs, Ollama/MCP connections, and branding are saved on the manager host. It does not provide OllaMan's online catalog scraper, Hugging Face search, built-in autonomous filesystem/shell agent, registry push or commercial license activation. Private Ollama endpoints use unauthenticated Ollama HTTP APIs; Basic/Bearer authenticated Ollama proxy endpoints are outside this version's scope. MCP HTTP connections separately support an optional bearer token. The PWA caches the interface shell; inference and management actions require a connection to the running manager.

## Run from source on Windows, Linux or macOS

With **Node.js 22+** and **Git** installed, run these commands in PowerShell or a terminal:

```bash
git clone https://github.com/solomongs/Ollam-manager.git
cd Ollam-manager
node server.mjs
```

No npm dependency installation is needed for this browser backend. Keep the terminal running and open `http://127.0.0.1:42010` on that computer. The console prints the protected first-login password file path; read `data/first-login.txt` with `Get-Content .\data\first-login.txt` in PowerShell or `cat data/first-login.txt` on Linux/macOS, then sign in. Ollama runs separately, at the default `http://127.0.0.1:11434` or an existing private endpoint added in Settings. The interface opens even when Ollama is offline.

Stop the source app with Ctrl+C. Chats, credentials and jobs remain in `data`; stopping the backend interrupts active work. Update a clean Git checkout with `node scripts/update.mjs --check`, then `node scripts/update.mjs`, and restart it. The updater verifies the fixed project origin and allows fast-forward updates only. See [updates below](#operations-updates-and-removal).

The ARM64/systemd `install.sh` is specifically for a DGX service installation; it is not required for this generic source workflow. It intentionally rejects Windows, macOS and x86 Linux. A Windows desktop installation uses the `.exe` guide instead of this terminal-hosted workflow.

## Phone and tablet access

Open the running manager's private HTTPS URL in your phone/tablet browser. With the DGX Tailscale setup below, the device must be connected to your permitted tailnet; `127.0.0.1` on a phone refers to the phone, so use the DGX's actual printed URL. Sign in with the manager password and use the responsive interface.

Use the browser's **Add to Home Screen** or **Install app** action when available to open the manager as a PWA. Remote PWA installation needs a secure HTTPS origin. Its cached shell can open offline, but model operations, chat and MCP tools require the manager/Ollama connection. A Windows desktop wrapper is local to that computer; installing it alone does not create a phone-accessible URL.

## MCP tools in chat

MCP (Model Context Protocol) lets an Ollama model request tools supplied by a separate MCP server, such as a data lookup or an application integration. The manager is an MCP client; it does not itself expose an MCP server endpoint. Install or run the MCP server separately, following that server's own documentation. No third-party MCP server is bundled or automatically installed.

1. Open **MCP connections** and add a connection. Choose **stdio** for a program running on the manager host, or **Streamable HTTP** for an MCP endpoint. Check **Enable this connection** when you want it available in Chat.
2. Save it and select **Test connection**. The manager initializes the MCP connection and discovers its tools. **View tools** shows the descriptions and argument schemas before use.
3. In Chat, choose an Ollama model that supports tool calling, open **Choose MCP**, and select the enabled connections for that conversation. Tools start off; selecting a connection is an explicit opt-in.
4. Send your message. If the model proposes a tool call, inspect its server, tool name and arguments. Select **Approve tool call** or **Deny tool call**. Every proposed call requires a separate decision, even after you approved an earlier call.
5. An approved call runs on its configured MCP server. Its result is returned to Ollama so the model can continue its reply. Denials and failures are also reported to the model and shown in the conversation.

Your selected model must support Ollama tool calling. Some models may ignore tools or produce invalid arguments; selecting a connection does not add tool capability to a model. The connection test checks the MCP handshake and tool discovery, without executing a discovered tool; for stdio it starts your configured server program. Turning a connection off prevents it from being selected for tool use. A pending decision expires after five minutes; closing or stopping the stream cancels the wait rather than approving it.

### Local stdio configuration

Use an absolute executable path, a JSON array of arguments, a JSON object of environment variables, and an optional absolute working directory. Commands are launched directly, without a shell. For example, after you have separately installed a compatible MCP server in `/opt/mcp/example`, its settings could look like this:

```json
{
  "name": "Example local tools",
  "transport": "stdio",
  "enabled": true,
  "command": "/opt/spark-ollama-manager/runtime/node",
  "args": ["/opt/mcp/example/server.mjs"],
  "env": {},
  "cwd": "/opt/mcp/example"
}
```

`/opt/mcp/example/server.mjs` is an illustrative path, not a bundled server or an installation command. Replace it with your installed server's entry point and its required arguments. The program must speak MCP on stdout; diagnostic output belongs on stderr. Supply server-specific credentials in the environment field when needed, without putting secrets in command arguments.

On the installed DGX service, the process runs as `spark-ollama`, with the same systemd restrictions as the manager. It cannot see `/home` or `/root`, does not have sudo privileges, and cannot use your interactive shell's nvm setup. Keep server code under a readable directory such as `/opt/mcp`; put any writable server data under the manager's protected state directory. Grant only the file access the server needs. A configured stdio program is real code executed on the DGX; the manager does not add a separate sandbox around that program. Stdio tools are unavailable if the manager is started as root.

### Streamable HTTP configuration

Use the server's MCP endpoint, rather than a web homepage. For example, for a separately running local server:

```json
{
  "name": "Example HTTP tools",
  "transport": "http",
  "enabled": true,
  "url": "http://127.0.0.1:8080/mcp"
}
```

This example is a placeholder; nothing in the manager starts a server on port 8080. The configured endpoint must support MCP Streamable HTTP with JSON or SSE responses. Public endpoints require HTTPS; HTTP is limited to private or loopback addresses. Use a direct URL without query strings, fragments, embedded credentials or redirects. Metadata/link-local/reserved addresses are blocked. An optional bearer token is sent in the Authorization header. OAuth login, the legacy separate HTTP+SSE transport, resource browsing, and MCP prompt templates are outside this version's scope. Text and structured tool results are returned as text; image/audio results become descriptive markers rather than attachments.

The client advertises MCP revision `2025-11-25` and accepts server negotiation to `2025-06-18`, `2025-03-26` or `2024-11-05`. It does not claim support for later draft revisions. Response sizes, tool catalogs and concurrent subprocesses are bounded; a connection error can therefore mean an incompatible protocol or an exceeded limit rather than an Ollama failure.

Tokens and stdio environment values stay in manager state. DGX/Linux state files use mode 0600; Windows stores them under the current user's application profile. The connection API never returns their saved values or fills them back into the edit form. Blank secret fields preserve an existing secret; the explicit clear action removes it. The interface can show whether a token exists and the names of configured environment keys. It does not show their saved values. A third-party tool may itself return sensitive data; tool results are saved with the conversation and sent to the selected Ollama host.

MCP extends the connection boundary: approved arguments go to the selected MCP server, and its results return to the configured Ollama server. A stdio server can also make its own network requests. Local model inference remains on the selected Ollama host; cloud-backed Ollama models and remote MCP servers may transmit data outside your local host. Review the selected server and the visible arguments before approving a call. Tool output is treated as data and displayed as text; it is not browser-executed HTML.

## Install on the DGX

This section describes installation from source. The [ARM64 `.deb` workflow](docs/DGX-PACKAGE.md) includes its own runtime and uses the package manager instead.

Run these commands on the DGX itself, or through an existing SSH connection to it. The source repository is [solomongs/Ollam-manager](https://github.com/solomongs/Ollam-manager); the application files are at the repository root.

Clone and install with Git:

```bash
git clone https://github.com/solomongs/Ollam-manager.git
cd Ollam-manager
bash install.sh --check
sudo bash install.sh
```

If you downloaded the project ZIP instead, extract it, open a terminal in the folder containing `install.sh`, and run:

```bash
bash install.sh --check
sudo bash install.sh
```

The read-only check verifies Linux ARM64, an existing ARM64 Node.js >=22, systemd, the project files and port 42010. It makes no changes. An x86 machine is intentionally rejected by the DGX installer. This source-script workflow does not install Node, Ollama or GPU drivers automatically.

If Node is available through your interactive shell's nvm/Pinokio installation but sudo cannot find it, use its absolute binary path:

```bash
node_path="$(command -v node)"
bash install.sh --check --node "$node_path"
sudo bash install.sh --node "$node_path"
```

The installer copies that existing Node executable to its own root-owned runtime so the service does not depend on interactive shell startup or access to a user home folder. It verifies startup before completing installation. Keep the Node runtime updated by rerunning the installer with your updated, trusted Node binary.

The app binds to `127.0.0.1:42010`. The existing Ollama address remains `http://127.0.0.1:11434`. If Ollama is stopped, the interface starts and reports that it is offline. The installer does not change Ollama's service, host setting, model directory or GPU configuration.

If Tailscale is connected, the installer reads the DGX's actual DNS name and adds a private HTTPS route on unused port 9443. It prints the resulting URL, for example `https://your-dgx.your-tailnet.ts.net:9443`. Existing Tailscale routes, including port 443, are preserved. A busy or unfamiliar port/configuration is left untouched; the local manager still installs. The installer reports separately whether an HTTPS health check succeeded from the DGX.

To select another unused private HTTPS port:

```bash
sudo bash install.sh --https-port 9444
```

Reruns must use the same HTTPS port recorded by the previous installation. To install without adding any Tailscale route:

```bash
sudo bash install.sh --no-tailscale
```

## Log in

On the first start, the backend creates a random password. Read it only from the DGX terminal:

```bash
sudo cat /var/lib/spark-ollama-manager/first-login.txt
```

Open the printed private URL from your laptop or phone, sign in and use the dashboard. That device must be connected to the same Tailscale network and permitted by its access policy. This URL is private to that network; it is not a public Internet service.

Set a new password using the hidden terminal prompt:

```bash
sudo -u spark-ollama /opt/spark-ollama-manager/runtime/node /opt/spark-ollama-manager/scripts/password.mjs --data-dir /var/lib/spark-ollama-manager
sudo systemctl restart spark-ollama-manager.service
```

The password helper removes the initial plaintext password file after a reset. To generate a fresh random password into the protected local file instead:

```bash
sudo -u spark-ollama /opt/spark-ollama-manager/runtime/node /opt/spark-ollama-manager/scripts/password.mjs --data-dir /var/lib/spark-ollama-manager --generate
sudo systemctl restart spark-ollama-manager.service
sudo cat /var/lib/spark-ollama-manager/first-login.txt
```

## If private HTTPS is not ready

If Tailscale asks you to enable HTTPS, open the exact enable link printed by its CLI and then rerun the installer. Never use `tailscale serve reset` for this app. Inspect existing routes with:

```bash
sudo tailscale status
sudo tailscale serve status --json
```

For immediate access through SSH, run this on your laptop, replacing the account and DGX Tailscale IP/name with your actual values:

```bash
ssh -N -L 42010:127.0.0.1:42010 your-dgx-user@your-dgx-tailnet-name
```

Keep that terminal open and visit `http://127.0.0.1:42010` on the laptop. For a fresh installation, `--no-tailscale` selects this localhost workflow. If an existing installation already has a `PUBLIC_ORIGIN` HTTPS setting, use its HTTPS URL; switching to an SSH-only workflow requires removing that line from the environment file and restarting the service.

Remote deployment requires an actual SSH/device connection. Building this package and running tests in another workspace does not install it on your DGX or prove that its private URL is reachable.

## Local GGUF models

The interface lists `.gguf` files inside the configured import roots. It rejects paths outside those roots and symlink escapes. Copy an existing GGUF into the default protected folder, using the real path and filename:

```bash
sudo install -o spark-ollama -g spark-ollama -m 0600 /absolute/path/to/model.gguf /var/lib/spark-ollama-manager/imports/model.gguf
```

Then choose it in the import screen and supply a model name. The backend streams the file into Ollama's blob API and creates the model. It does not rename or delete your source GGUF. Imports need sufficient disk space for the source file and Ollama's model storage.

To use another root, put files in an accessible location such as `/srv/gguf`, grant the `spark-ollama` service account read/traverse permission, set `IMPORT_ROOTS=/srv/gguf` in the environment file and restart the service. Multiple roots are separated by colons. The systemd service hides `/home` and `/root`; use a protected directory outside those locations.

## Configuration and storage

| Item | Location / default |
|---|---|
| Application and copied Node executable | `/opt/spark-ollama-manager` |
| Protected state, password hash and conversations | `/var/lib/spark-ollama-manager` |
| Default GGUF import folder | `/var/lib/spark-ollama-manager/imports` |
| Writable MCP server working directory | `/var/lib/spark-ollama-manager/mcp-workspaces` |
| Service configuration | `/etc/spark-ollama-manager.env` |
| Service unit | `/etc/systemd/system/spark-ollama-manager.service` |
| Previous code/configuration backups | `/opt/spark-ollama-manager-backups` |
| Local interface | `http://127.0.0.1:42010` |
| Existing Ollama API | `http://127.0.0.1:11434` |

The environment file is root-owned with mode 0600. Installed code is root-owned; the dedicated `spark-ollama` user can write only to its state directory. The state directory has mode 0700 and credential/state files use mode 0600. The service does not run as root.

Supported environment keys are `HOST`, `PORT`, `DATA_DIR`, `OLLAMA_URL`, `IMPORT_ROOTS`, optional `PUBLIC_ORIGIN`, and the installer-controlled `SPARK_INSTALLATION_MODE` used for update instructions. Keep the installed service's host, port, state directory and installation mode at their installer defaults; its unit and Tailscale target depend on those paths. Edit `OLLAMA_URL` if your existing local Ollama API uses a different private address. `PUBLIC_ORIGIN` records the exact browser origin of the private HTTPS URL for request validation. The admin's branding settings and server list are edited inside the app and stored separately in protected state.

Security includes scrypt password hashes, expiring cookie sessions, CSRF tokens, origin validation, request limits, fixed/private Ollama server destinations, and root-owned application code. MCP stdio executes administrator-configured programs directly without shell interpolation; tool operations require individual approvals. GPU statistics use a fixed `nvidia-smi` invocation when available; the manager delegates inference and model lifecycle work to Ollama.

DGX Spark uses shared system/GPU memory. Host available RAM and GPU-reported allocation are different measurements of the same physical memory system; they must not be added together or presented as separate pools. A model fitting on disk does not establish that it will fit in memory. Other running services, context size and parallel inference affect available capacity. The manager reports observations and Ollama failures; it does not reserve GPU memory or guarantee a model's capacity.

## MCP server deployment

Since version 1.1, `mcp-client.mjs` is part of the required installation manifest. The ARM64 preflight refuses an incomplete release before modifying an existing installation. Upgrading keeps the protected state directory, existing password hash, conversations and MCP configuration; it replaces application code separately. The standalone backend still requires no third-party npm packages; desktop build tooling is separate.

MCP servers are configured in the interface. A stdio server runs as the same unprivileged `spark-ollama` account as the manager, using its configured command and separate argument list. Install your chosen server and its required runtime first; the manager does not download a package on your behalf. Use absolute executable/script paths outside user home folders, such as `/usr/bin/python3`, `/opt/spark-ollama-manager/runtime/node` and a server script under `/opt/spark-mcp-tools`. The script and its dependencies must support Linux ARM64 and be readable/executable by `spark-ollama`.

Keep custom MCP server code outside `/opt/spark-ollama-manager`, because updates replace that application folder. Root-owned code under `/opt/spark-mcp-tools` survives manager updates. The default writable working directory is `/var/lib/spark-ollama-manager/mcp-workspaces`; create per-server subdirectories there when a server needs files or caches:

```bash
sudo install -d -o root -g root -m 0755 /opt/spark-mcp-tools
sudo install -d -o spark-ollama -g spark-ollama -m 0700 /var/lib/spark-ollama-manager/mcp-workspaces/my-server
```

After installing a real MCP server, configure its absolute command, arguments and working directory in the app. Supplying separate arguments avoids shell interpolation. Runtime executables must work without sourcing your shell profile or relying on nvm/Pinokio paths inside `/home`.

The systemd sandbox applies to the manager and its stdio children: they cannot gain root privileges, `/home` and `/root` are hidden, the installed system is read-only, and persistent writes are limited to `/var/lib/spark-ollama-manager`. `/tmp` is private temporary storage. Do not disable these protections to make a server reach a home folder; put its code in an accessible read-only location and its working files under the protected state directory. A configured stdio server is trusted code under the manager's service account and can access that account's state. Enable servers according to the data and tools you intend to make available.

An HTTP MCP server runs at its own endpoint; the manager's local process sandbox does not constrain that remote server. Configure its endpoint/authentication in the app rather than exposing an unauthenticated management endpoint to the public Internet. Existing Tailscale routing and the Ollama service remain unchanged by MCP configuration.

## Operations, updates and removal

```bash
sudo systemctl status spark-ollama-manager.service --no-pager
sudo journalctl -u spark-ollama-manager.service -n 80 --no-pager
curl --fail http://127.0.0.1:42010/api/health
```

To update, extract the new project folder and rerun the installer. It backs up the previous code and environment/unit configuration, preserves credentials/conversations/imports/MCP state and working directories, and restores the old application/configuration if the new service fails its local health check. Backups intentionally contain no duplicate model files. Review or remove old backup folders yourself when appropriate.

The **Settings → Updates** panel shows the installed version, installation type and project links. **Check latest release** requests release information from GitHub only when selected. The interface displays/copies the applicable update instructions; it does not execute terminal commands or grant a browser shell.

For a Git source checkout, run the guarded updater from its repository root:

```bash
node scripts/update.mjs --check
node scripts/update.mjs
```

The updater requires Node.js 22+ and Git, is restricted to this project's origin and `main` branch, requires a clean working tree, and accepts a fast-forward update only. It refuses to overwrite ignored local files, discard changes or activate a newly fetched DGX service automatically. These commands also work from a source checkout in Windows PowerShell with Node/Git available. After reviewing the update, restart a source app; on the DGX run `sudo bash install.sh` to activate the service code. A ZIP extraction or installed `.deb` is not a Git checkout; use the next release package or source archive instead. Never run Git updates inside `/opt/spark-ollama-manager`. Windows release installations update by installing a newer `.exe`; `.deb` installations update with the newer `.deb`; container installations pull and recreate the image while keeping the state volume. See the platform guides for exact commands.

To stop/remove the manager while preserving state and all Ollama models:

```bash
sudo bash /opt/spark-ollama-manager/uninstall.sh
```

Removal disables the manager service, removes its installed code/configuration and removes only an unchanged manager-owned Tailscale route. If that route was changed or cannot be inspected, removal stops and explains what to inspect. State, MCP configuration/workspaces, imports, service account and code backups remain so reinstalling can reuse them. Separately installed MCP code under `/opt/spark-mcp-tools` remains as well. No automatic purge of user data or models is provided.

## Development verification

The backend/unit checks need Node >=22 and no third-party npm dependencies. Native desktop and package builds use the additional tooling in their platform guides:

```bash
npm test
bash -n install.sh uninstall.sh
```

Deployment tests cover unknown Tailscale configuration, port conflicts, exact route ownership, unrelated route preservation, validated connected DNS names, safe environment rewriting, the non-mutating preflight, mandatory MCP module validation, staging without user state, and matching release health checks. Backend/browser test evidence and any remaining deployment limits should accompany the delivered package. Tests on an x86 workspace establish application behavior and ARM-safe packaging; the first actual DGX installation must still pass its ARM64/systemd/local/HTTPS health checks.

See [VERIFICATION.md](VERIFICATION.md) for the completed checks, test screenshots, release coverage, and pending DGX installation.
