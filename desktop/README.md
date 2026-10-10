# Windows desktop build

This Electron wrapper runs the existing manager backend on IPv4 loopback and opens the workspace in a sandboxed desktop window. Ollama is installed separately. No renderer Node integration, preload, or privileged IPC bridge is exposed.

Install build dependencies with Node.js 22 or newer:

```sh
npm --prefix desktop ci
npm --prefix desktop test
npm --prefix desktop run build -- --win --x64
npm --prefix desktop run build -- --win --arm64
```

Build on Windows using the matching architecture. The pinned versions are Electron 44.7.0 and electron-builder 26.15.3. The backend, its public assets, and password reset script are copied to `resources/app`; wrapper code is packed in `resources/app.asar`. Runtime dependencies are supplied by Electron.

The unsigned per-user NSIS installers are named:

- `Spark-Ollama-Manager-1.2.0-windows-x64-setup.exe`
- `Spark-Ollama-Manager-1.2.0-windows-arm64-setup.exe`

Installation does not request elevation, create a service, enable startup, or launch automatically after setup. Uninstall preserves `%APPDATA%\Spark Ollama Manager`. The normal executable name is `Spark Ollama Manager.exe`.

The data folder contains administrator credentials, configured MCP secrets, jobs, and chats. GGUF files can be copied into the sibling `imports` folder through **Application → Open GGUF import folder**. The generated password is shown on first launch and can be viewed again through **Application → Initial administrator password…**. Copying it to the clipboard requires clicking the copy button.

The first launch selects an available loopback port and saves it in `desktop-runtime.json`. Later launches reuse that origin with a persistent Electron profile so bookmarks and assistant presets survive restarts. If the saved port is occupied, startup stops with repair instructions. Removing the runtime settings file chooses a new origin; browser preferences remain associated with the old origin. Closing the window stops the backend and cancels active jobs and tool processes.

The packaged smoke test launches the real app twice with a temporary profile. It checks backend health/version/authentication, renderer isolation, stable origin, and persistent browser storage:

```sh
node desktop/smoke-packaged.mjs "C:\absolute\path\Spark Ollama Manager.exe"
```

The underlying CI flags are `--desktop-smoke-test --smoke-output=<absolute-json-path> --smoke-user-data=<absolute-temp-directory>`. They never use the normal profile when invoked through the harness. Test the unpacked executable and the installed executable on each Windows architecture before publishing.

Release and library links open the system browser only for the fixed project repository and official Ollama pages. Updating a packaged desktop app uses its installer; Git updates change a source checkout.
