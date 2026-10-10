# Container setup

Spark Ollama Manager 1.2.0. Developed by Solomon. The container runs the manager; Ollama inference runs on the configured Ollama server. The manager image does not include Ollama, model weights or NVIDIA drivers.

## Image and persistent state

The release workflow publishes `ghcr.io/solomongs/ollam-manager:1.2.0` and `:latest` for Linux AMD64 and ARM64, after the release prerequisites pass. See the project's [Packages page](https://github.com/solomongs/Ollam-manager/pkgs/container/ollam-manager). An image is downloadable only after publication succeeds. The package owner must set its visibility to **Public** for anonymous pulls; see the [publishing guide](RELEASING.md). This guide's version tag is deliberate so an upgrade is explicit.

The image runs as nonroot UID/GID `10001`, keeps all persistent manager state under `/data`, and listens on container port `42010`. Use a named volume so password hashes, conversations, jobs, MCP settings and imports survive container replacement. A new empty named volume inherits the image's prepared `/data` ownership. A pre-existing bind mount must separately grant UID/GID `10001` appropriate access; do not mount your Ollama model directory as manager state.

## DGX / Linux with existing loopback Ollama

On Linux, host networking lets the manager reach the existing loopback Ollama API without changing Ollama's bind address. Run only one manager on port 42010; stop an existing native manager or choose a separate port before starting another installation.

```bash
docker volume create spark-ollama-data
docker pull ghcr.io/solomongs/ollam-manager:1.2.0
docker run -d --name spark-ollama-manager --restart unless-stopped \
  --network host \
  -e HOST=127.0.0.1 \
  -e OLLAMA_URL=http://127.0.0.1:11434 \
  -v spark-ollama-data:/data \
  ghcr.io/solomongs/ollam-manager:1.2.0
```

Open `http://127.0.0.1:42010` on the host. For remote access, use an existing private reverse proxy or the [SSH tunnel workflow](../README.md#if-private-https-is-not-ready). The container does not configure Tailscale routes or expose a public URL automatically. When using a private HTTPS reverse proxy, configure `PUBLIC_ORIGIN` to the exact browser origin and recreate the container with that environment value.

## Bridge networking / Docker Desktop

With bridge networking, bind the published manager port to host loopback:

```bash
docker run -d --name spark-ollama-manager --restart unless-stopped \
  -p 127.0.0.1:42010:42010 \
  --add-host host.docker.internal:host-gateway \
  -v spark-ollama-data:/data \
  ghcr.io/solomongs/ollam-manager:1.2.0
```

The default `OLLAMA_URL` is `http://host.docker.internal:11434`. Host loopback and container loopback are different addresses: an Ollama server listening only on host `127.0.0.1` may be unreachable through the host gateway. Use the Linux host-network recipe above when you want to preserve that binding. For Docker Desktop or a separate Ollama container/server, supply an `OLLAMA_URL` that is actually reachable from the manager container. Make any Ollama networking change deliberately and restrict access to trusted clients; the manager does not change it for you.

The manager validates Ollama endpoints as private/loopback destinations. If your deployment uses an internal container hostname, it must resolve to a permitted address. Container health can succeed while Ollama remains offline.

## Login, imports and tools

Read the generated first-login password:

```bash
docker exec spark-ollama-manager cat /data/first-login.txt
```

Use that password at the loopback/private manager URL. The password remains server-side; the container API applies the same session, origin and CSRF controls as the native service.

To generate a replacement password into the protected file and expire existing sessions through a restart:

```bash
docker exec spark-ollama-manager node scripts/password.mjs --data-dir /data --generate
docker restart spark-ollama-manager
docker exec spark-ollama-manager cat /data/first-login.txt
```

The default import root is `/data/imports`. For example, copy a GGUF file into it, ensuring the nonroot account owns the file:

```bash
docker cp /absolute/path/model.gguf spark-ollama-manager:/data/imports/model.gguf
docker exec --user 0 spark-ollama-manager chown 10001:10001 /data/imports/model.gguf
docker exec --user 0 spark-ollama-manager chmod 600 /data/imports/model.gguf
```

These commands copy a source file; the manager then streams it to the selected Ollama server through its import workflow. Neither the manager nor container removal deletes Ollama model files.

HTTP MCP servers can be configured at reachable endpoints. A stdio MCP server executes inside this container, not on the DGX host or your Windows desktop. Its executable and dependencies must therefore be installed in or mounted into the container, compatible with the image's architecture, and accessible to UID `10001`. The base manager image includes only its application runtime; it does not download/install MCP servers. Use separate read-only server code and `/data` working directories as appropriate. Every requested tool call still requires approval.

System statistics come from the container's view of the host. The standard image does not contain `nvidia-smi`, so GPU telemetry may be unavailable even when host Ollama uses a GPU. Ollama inference does not require GPU devices to be passed into this manager container.

## Update and stop

Pull the next explicit version, stop/remove the old container, then rerun the matching launch recipe using the same state volume and your existing environment/network settings:

```bash
docker pull ghcr.io/solomongs/ollam-manager:1.2.0
docker stop spark-ollama-manager
docker rm spark-ollama-manager
```

The version shown is an example; replace it with the newer published tag during an upgrade. Recreate the container before using the interface again. Removing the container preserves `spark-ollama-data`; do not delete that volume unless you intend to erase manager state/imports. Git updates apply to source checkouts, not to files inside a running container image.
