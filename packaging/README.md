# DGX ARM64 package and source updates

The Debian package installs the private web manager and a bundled Node.js ARM64 runtime. It does not install Ollama, replace NVIDIA drivers or modify existing models. Its desktop menu shortcut opens the configured local/private URL in a browser.

## Build

Build on Linux with Node.js >=22, GNU tar and `dpkg-deb`; an x86 Linux build host can produce this ARM64 package without running the bundled executable.

```bash
node packaging/build-deb.mjs --check
node packaging/build-deb.mjs --output-dir dist
```

The builder downloads Node 22.23.3 from its fixed official HTTPS URL. Its pinned SHA256 is verified before extraction, and the executable must be a Linux AArch64 ELF. The pin and authoritative checksum page are recorded in `node-runtime.json`. Node's license is included both beside the bundled runtime and in the package documentation directory. No npm packages are installed for the web manager.

For an offline build using an already downloaded official archive, the same pinned checksum is still enforced:

```bash
node packaging/build-deb.mjs --node-archive /absolute/path/node-v22.23.3-linux-arm64.tar.xz --output-dir dist
```

Outputs are `spark-ollama-manager_<version>_arm64.deb`, its `.sha256` file and `.provenance.json`. Provenance records the Node pin and build-host architecture; building on x86 does not claim an ARM64 execution test.

## Install and upgrade on DGX Spark

```bash
sudo apt install ./spark-ollama-manager_1.2.0_arm64.deb
spark-ollama-manager-open --print-url
```

The package depends on the normal DGX OS / Ubuntu system tools and C/C++ runtime libraries. Its Node runtime is included, so a separate Node installation is unnecessary. A running systemd host and Linux ARM64 are required. The service listens on `127.0.0.1:42010`, uses a dedicated `spark-ollama` account, and keeps state in `/var/lib/spark-ollama-manager`. The existing Ollama API stays at its configured address, default `127.0.0.1:11434`.

The package's immutable bundle lives in `/usr/lib/spark-ollama-manager-bundle`. The active application is copied to `/opt/spark-ollama-manager`; this separation lets its installer back up and restore the previous working code if startup fails during a package upgrade. Debian package unpacking does not replace files under the running application's feet. State, credentials, imports and MCP workspaces are preserved.

When Tailscale is connected, installation can add the manager's private HTTPS route on an unused port 9443. Existing routes are preserved, and a manager's previously selected custom HTTPS port is reused. The installer reports its local/HTTPS health checks. The menu shortcut reads the nonsecret root-owned URL file `/etc/spark-ollama-manager.url`; password and other protected configuration files are not made readable to desktop users.

Install the next `.deb` with the same `apt install ./filename.deb` command. Remove it with:

```bash
sudo apt remove spark-ollama-manager
```

Both removal and purge preserve user state, credentials, imports, MCP workspaces, backups, the service account and all Ollama models. Only an unchanged manager-owned Tailscale route is removed. If that route cannot be inspected or was changed, removal stops for review. A source installation explicitly activated after a package install is not removed by the package's mode-gated removal script.

## Manual Git source updates: Windows, Linux and DGX

This updater is for a source checkout of [solomongs/Ollam-manager](https://github.com/solomongs/Ollam-manager). It requires Node >=22 and Git. Installed `.exe`, `.deb` and packaged desktop apps should use the next released installer instead.

From the checkout:

```bash
node scripts/update.mjs --check
node scripts/update.mjs
```

On Windows, the same commands work in PowerShell or Command Prompt when Node and Git are on PATH. `--repo` selects an existing checkout root; `--git` selects an explicit Git executable; `--json` emits machine-readable results.

The updater validates the fixed repository origin, requires a clean `main` branch, refuses source URL rewriting and fetches the literal HTTPS repository URL. Updates use fast-forward only, disable hooks and submodule recursion, and refuse to overwrite ignored local files. No reset, stash, elevation, package installation or browser-provided shell command is used. `--check` uses `ls-remote`; it changes neither working files nor fetched objects.

Updating a checkout does not replace a running installation. Restart a source app after updating. For the DGX service installed from source, activate the new checkout code with:

```bash
sudo bash install.sh
```

This activation preserves state and performs the same rollback/health checks as initial installation. The packaged DGX service instead follows the `.deb` upgrade path.
