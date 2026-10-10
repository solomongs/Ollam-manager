FROM node:22.23.3-bookworm-slim

LABEL org.opencontainers.image.title="Spark Ollama Manager" \
      org.opencontainers.image.description="Ollama and MCP manager, developed by Solomon" \
      org.opencontainers.image.source="https://github.com/solomongs/Ollam-manager" \
      org.opencontainers.image.licenses="MIT"

RUN groupadd --gid 10001 spark && useradd --uid 10001 --gid 10001 --no-create-home spark \
    && mkdir -p /app /data/imports /data/mcp-workspaces \
    && chown -R 10001:10001 /data
WORKDIR /app
COPY --chown=root:root server.mjs mcp-client.mjs package.json ./
COPY --chown=root:root public/ ./public/
COPY --chown=root:root scripts/password.mjs ./scripts/password.mjs
USER 10001:10001
ENV HOST=0.0.0.0 PORT=42010 DATA_DIR=/data \
    OLLAMA_URL=http://host.docker.internal:11434 IMPORT_ROOTS=/data/imports \
    SPARK_INSTALLATION_MODE=container
EXPOSE 42010
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:42010/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]
