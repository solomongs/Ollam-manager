# Release publishing

The fixed project is [solomongs/Ollam-manager](https://github.com/solomongs/Ollam-manager). Developed by Solomon. The workflow definition is `.github/workflows/release.yml`.

## Where downloads appear

| Distribution | Destination |
|---|---|
| Windows x64 / ARM64 `.exe` installers | [GitHub Releases](https://github.com/solomongs/Ollam-manager/releases/latest) |
| DGX ARM64 `.deb` installer | GitHub Releases |
| Source ZIP and `SHA256SUMS` | GitHub Releases |
| Linux AMD64 / ARM64 container image | [GitHub Packages / GHCR](https://github.com/solomongs/Ollam-manager/pkgs/container/ollam-manager) |

This uses GitHub's native distribution formats: Releases hosts downloadable binaries, and the Container registry hosts OCI/Docker images. See [GitHub Packages supported formats](https://docs.github.com/en/packages/learn-github-packages/introduction-to-github-packages) and the [Container registry documentation](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry).

## Build and publication flow

On a pull request, a push to `main`, or manual workflow dispatch, the workflow runs application/deployment tests and browser checks. Windows jobs build per-user x64 and ARM64 NSIS installers, silently install them on the matching runner, and smoke-test the packaged desktop application. The ARM64 Ubuntu job builds/installs the `.deb`, checks service health, exercises upgrade/state preservation, and removes it while checking retained data.

Publishing is limited to the fixed repository's `main` branch and a package version that does not already have a corresponding `v<version>` release. Once all prerequisite jobs pass, the release job uploads installers, a source archive and checksums, then creates that version's release. The container job subsequently publishes matching version and `latest` tags for Linux AMD64 and ARM64.

Version 1.2.0 asset names are:

```text
Spark-Ollama-Manager-1.2.0-windows-x64-setup.exe
Spark-Ollama-Manager-1.2.0-windows-arm64-setup.exe
spark-ollama-manager_1.2.0_arm64.deb
Spark-Ollama-Manager-1.2.0-source.zip
SHA256SUMS
```

For a new release, update the application/desktop version metadata consistently, commit the completed changes to `main`, and inspect the [Actions results](https://github.com/solomongs/Ollam-manager/actions). Successful source tests alone do not establish successful Windows or DGX packaging. A runner's installation/smoke check is evidence for that environment; it does not verify NVIDIA DGX hardware inference or a user's private access URL. Windows binaries are unsigned until a publisher-signing configuration is explicitly supplied and verified.

The workflow uses the repository-scoped `GITHUB_TOKEN`, with `contents:write` only for the release job and `packages:write` for the container job. Repository/organization policy must permit those operations and the required runner types. A failed job does not create its missing download. If the container job fails after the release was created, rerun the failed job and verify its published image rather than treating the installer release as evidence of a container publication.

## Make the container available to everyone

A newly published GHCR package can initially be private. After first publication, the repository/package owner must open the package's settings and change its visibility to **Public** if it is to be anonymously downloadable. The workflow checks an anonymous pull and reports whether this step remains necessary; it does not bypass the owner's package visibility controls.

After changing visibility, confirm an unauthenticated pull from a clean environment:

```bash
docker pull ghcr.io/solomongs/ollam-manager:1.2.0
```

Public visibility and a successful anonymous pull establish container availability. Also check that all expected installer/source assets and `SHA256SUMS` are attached to the release. The Windows/DGX installation guides point to Releases; the container guide points to Packages. Do not advertise an asset as downloadable until that corresponding publication is visible and verified.
