# Windows desktop setup

Spark Ollama Manager 1.2.0. Developed by Solomon. No paid application licence or activation key is required.

## Download and install

The release CI targets Windows 11 x64 and ARM64. Use the matching assets on the project's [GitHub Releases page](https://github.com/solomongs/Ollam-manager/releases/latest):

| Windows architecture | Installer |
|---|---|
| Intel/AMD x64 | `Spark-Ollama-Manager-1.2.0-windows-x64-setup.exe` |
| Windows ARM64 | `Spark-Ollama-Manager-1.2.0-windows-arm64-setup.exe` |

Check **Settings → System → About → System type** to choose the architecture. Download the matching installer and the release's `SHA256SUMS`. For example, in PowerShell from the download folder:

```powershell
Get-FileHash .\Spark-Ollama-Manager-1.2.0-windows-x64-setup.exe -Algorithm SHA256
```

Compare the printed hash with that filename's entry in `SHA256SUMS`. Run the installer, complete its per-user setup, then open **Spark Ollama Manager** from the Start menu. Administrator elevation is not required for the default per-user installation. The desktop runtime is included; installing Node.js separately is unnecessary to run the manager.

Windows binaries are unsigned: a publisher certificate has not been configured. Windows may show an unknown-publisher/reputation warning or block execution according to its security policy. Download from this repository and verify the release hash; do not disable Windows security controls to bypass a block. See [Microsoft's explanation of SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation).

Release files appear only after the corresponding build/publication succeeds. Packaging definitions or CI build output do not establish that an installation has been exercised on your Windows hardware. [VERIFICATION.md](../VERIFICATION.md) records the actual checks.

## First launch and Ollama

The desktop app starts its own manager backend on `127.0.0.1` and opens it in a desktop window. The first launch chooses an available local port, saves it in the application profile, and reuses that origin on later launches so browser preferences persist. It does not expose that backend on your LAN. The first launch shows the generated administrator password; reopen it through **Application → Initial administrator password…**, then sign in. The manager uses the same password/session controls as the web service.

Ollama is a separate installation. With Ollama running on this Windows computer, the manager connects to `http://127.0.0.1:11434`. If Ollama is unavailable, the interface opens and reports it as offline. The manager does not install Ollama, GPU drivers, or models automatically. You can instead add an existing private Ollama server in Settings and select it in the interface; that server must already be reachable from Windows. A server setting expects an Ollama API address, not the DGX manager's web URL. To use an already installed DGX manager without changing Ollama networking, open that manager's private URL in your Windows browser.

The app has no Windows service, tray daemon or automatic-start registration. Closing its window or choosing Quit stops the backend and its MCP child processes. Downloads/jobs cannot continue while the desktop app is closed; unfinished persisted jobs become interrupted and can be retried after reopening. A separately installed DGX service continues running independently when a client browser closes.

## Persistent files and GGUF imports

| Data | Default location |
|---|---|
| Desktop application profile | `%APPDATA%\Spark Ollama Manager` |
| Manager state, chats and credentials | `%APPDATA%\Spark Ollama Manager\data` |
| Local GGUF import root | `%APPDATA%\Spark Ollama Manager\imports` |

Chats, jobs, credentials and connections persist in these folders. Model bookmarks and assistant presets use the desktop renderer's persistent browser storage. `desktop-runtime.json` in the application profile records the saved loopback port. If another program occupies that port, close the conflicting program and retry; the manager reports the conflict rather than silently changing its origin. Deleting that runtime file manually chooses a new port/origin and will make the previous origin's browser-local preferences unavailable, so preserve it during upgrades.

Use **Application → Open data folder** or **Application → Open GGUF import folder** to find these locations. Copy a GGUF file to the imports folder and choose it in Model Studio's import workflow. Importing sends the file to the selected Ollama server and does not remove your source file. Keep enough disk space on both the source computer and the selected Ollama host.

MCP Streamable HTTP connections work through the same MCP connections page. A stdio MCP server runs on this Windows computer, under your Windows account. Install that server and its runtime separately. Supply an absolute executable path, a JSON argument array and an accessible absolute working directory. For example:

```json
{
  "command": "C:\\Program Files\\nodejs\\node.exe",
  "args": ["C:\\mcp\\example\\server.mjs"],
  "cwd": "C:\\mcp\\example",
  "env": {}
}
```

These are example paths, not bundled MCP programs. JSON uses doubled backslashes for Windows paths; the executable-path field itself accepts the normal single-backslash path. Do not use the desktop app's `.exe` as an ordinary Node interpreter. Each chat tool call still requires approval. See the [MCP guide](../README.md#mcp-tools-in-chat).

## Update or uninstall

Open **Settings → Updates**, select **Check latest release**, then use the project's release link, or choose **Help → Download app update…**. Close the desktop app and run the newer installer for the same architecture. State is separate from installed application files and is preserved across upgrades. Back up your application profile before an upgrade when its conversations or connection settings are important to you.

Git source updates apply to a source checkout; they cannot update files inside an installed desktop executable. If you develop from Git, run the guarded updater from a clean checkout and rebuild the desktop installer. The installed Windows app updates through a newer `.exe`.

Uninstall through Windows **Settings → Apps → Installed apps**. The uninstall keeps the application profile, imported GGUF files and manager state so reinstalling can reuse them. It does not uninstall Ollama or delete Ollama models. Remove the profile manually only when you intend to erase your manager data.

## Build from source

With Node.js 22+, Git and the platform's desktop build prerequisites available, run from the project root:

```bash
npm --prefix desktop ci
npm --prefix desktop run build -- --win --x64
```

Use `--arm64` instead of `--x64` for the ARM64 installer. Installer files appear under `desktop/dist`. On a matching Windows system, smoke-test the installed executable:

```powershell
node desktop/smoke-packaged.mjs 'C:\absolute\install\path\Spark Ollama Manager.exe'
```

This checks packaged backend health/version/authentication and renderer isolation. It does not download a model or establish real inference. The release workflow performs these build/install/smoke steps on matching Windows runners before publishing an installer.
