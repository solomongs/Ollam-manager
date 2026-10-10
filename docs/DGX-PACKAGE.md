# DGX Spark ARM64 package setup

Spark Ollama Manager 1.2.0. Developed by Solomon. Target: NVIDIA DGX Spark running DGX OS / Ubuntu 24.04 ARM64 with systemd.

## Install the release package

Download [spark-ollama-manager_1.2.0_arm64.deb](https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/spark-ollama-manager_1.2.0_arm64.deb) and [SHA256SUMS](https://github.com/solomongs/Ollam-manager/releases/download/v1.2.0/SHA256SUMS) from [Release v1.2.0](https://github.com/solomongs/Ollam-manager/releases/tag/v1.2.0). On the DGX, verify the package hash against its release entry:

```bash
sha256sum spark-ollama-manager_1.2.0_arm64.deb
sudo apt install ./spark-ollama-manager_1.2.0_arm64.deb
```

Run these commands on the DGX itself or through an existing SSH connection to it. The package includes an ARM64 Node.js runtime, so the package workflow does not require a separately installed Node binary. Ubuntu's package manager resolves the package's system dependencies. The package is intentionally ARM64; do not install it on an x86 computer.

Ollama and NVIDIA GPU drivers remain separate. The manager uses the existing Ollama API at `http://127.0.0.1:11434`, preserves its models/configuration, and reports an offline state if Ollama is stopped. It does not install or upgrade Ollama, Node outside its own runtime, or GPU drivers.

Installation creates the dedicated nonroot `spark-ollama` service account and starts the manager through systemd. Its loopback interface is `http://127.0.0.1:42010`. Code is under `/opt/spark-ollama-manager`, protected state under `/var/lib/spark-ollama-manager`, and configuration under `/etc/spark-ollama-manager.env`. See the [full configuration table](../README.md#configuration-and-storage).

## Sign in and reach it remotely

Read the first-login password from the DGX terminal:

```bash
sudo cat /var/lib/spark-ollama-manager/first-login.txt
```

The desktop launcher opens the saved manager URL: private Tailscale HTTPS when configured, otherwise loopback. To print that URL without opening a browser, run `spark-ollama-manager-open --print-url`. For access from your other devices, use the actual private Tailscale URL printed by the installer when its route is configured, or the [SSH tunnel workflow](../README.md#if-private-https-is-not-ready). A private Tailscale URL requires a connected client permitted by your tailnet access policy. No public Internet exposure is enabled by default.

Verify the service locally:

```bash
sudo systemctl status spark-ollama-manager.service --no-pager
curl --fail http://127.0.0.1:42010/api/health
```

A local health response establishes that the manager is running; it does not establish that Ollama inference or your remote URL is working. The real DGX hardware and private HTTPS connection must still be checked after installation. See [VERIFICATION.md](../VERIFICATION.md) for evidence from this release.

## Models and MCP

Model files remain managed by Ollama. Local GGUF imports use `/var/lib/spark-ollama-manager/imports`; follow the [GGUF guide](../README.md#local-gguf-models) to copy files with the service account's ownership.

MCP configuration is retained in the same protected state. Install stdio server code separately under a readable location such as `/opt/spark-mcp-tools`, use absolute runtime/script paths, and put writable working data under `/var/lib/spark-ollama-manager/mcp-workspaces`. Stdio children inherit the nonroot service's filesystem restrictions. An HTTP server runs at its own configured endpoint. See [MCP deployment](../README.md#mcp-server-deployment) and [tool approvals](../README.md#mcp-tools-in-chat).

## Upgrade and remove

Download and verify the next ARM64 `.deb`, then install that filename with `sudo apt install ./<new-package>.deb`. The package upgrade replaces application code/runtime while preserving manager credentials, chats, MCP configuration/workspaces and imports. Back up protected state when its contents are important to you. Do not run `git pull` inside `/opt/spark-ollama-manager`; it is an installed application folder, not a source checkout.

Use the package manager to remove a `.deb` installation:

```bash
sudo apt remove spark-ollama-manager
```

Removal stops the manager and preserves its state/imports and Ollama's models. Package purge also preserves manager data; there is no automatic erase of conversations, credentials or models. Use the source `uninstall.sh` only for a source-script installation, rather than removing files behind the package manager.

## Build the package from source

The package builder runs on Linux with Node.js 22+, `dpkg-deb`, `tar` and xz extraction available. An x86 Linux build host can create the ARM64 package; it does not execute the bundled ARM64 runtime. From the source root:

```bash
node packaging/build-deb.mjs --check
node packaging/build-deb.mjs
```

The builder downloads the pinned official ARM64 Node archive, verifies its fixed SHA-256 before extraction, checks the executable's AArch64 ELF architecture, and writes the `.deb`, a checksum sidecar and provenance JSON under `dist`. A build success establishes package creation, not native DGX execution. The release workflow separately installs/tests it on ARM64 Ubuntu before publication.
