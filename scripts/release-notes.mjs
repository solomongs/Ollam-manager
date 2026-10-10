import { readFileSync, writeFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
const text = `Spark Ollama Manager ${version}, developed by Solomon.

Download the Windows x64 Setup.exe, the Windows ARM64 Setup.exe for Windows on ARM, or the ARM64 .deb for NVIDIA DGX Spark running Ubuntu 24.04/DGX OS. Windows 11 is the supported desktop target. The installers include their application runtime; install Ollama separately. Source ZIP and SHA256SUMS are also attached.

This release includes model management, streaming chat, MCP connections with per-call approval, desktop access, and a safe Git source update command. No activation key or paid application license is required. Individual model and MCP service terms still apply.

Installation and updates: https://github.com/solomongs/Ollam-manager/blob/main/README.md
Container package: https://github.com/solomongs/Ollam-manager/pkgs/container/ollam-manager

Windows binaries are unsigned; a publisher signing certificate has not been configured. Only download from this repository and verify SHA256SUMS. Back up your application data before upgrading.
`;
writeFileSync(process.argv[2] || 'release-notes.md', text);
