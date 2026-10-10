#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP=/opt/spark-ollama-manager
DATA=/var/lib/spark-ollama-manager
ENV_FILE=/etc/spark-ollama-manager.env
UNIT_FILE=/etc/systemd/system/spark-ollama-manager.service
MARKER=/etc/spark-ollama-manager-tailscale.json
SERVICE=spark-ollama-manager.service

if [[ ${1:-} == --help || ${1:-} == -h ]]; then
  printf '%s\n' 'Usage: sudo bash uninstall.sh' 'Stops/removes the manager service and installed code. Keeps credentials, chat state, imports, backups, service account and all Ollama models.'
  exit 0
fi
(($# == 0)) || { printf '%s\n' 'Unsupported argument. Removal always preserves state and models.' >&2; exit 1; }
((EUID == 0)) || { printf '%s\n' 'Run with sudo.' >&2; exit 1; }
for path in "$APP" "$DATA" "$ENV_FILE" "$UNIT_FILE" "$MARKER"; do
  [[ ! -L $path ]] || { printf 'Refusing managed symbolic link: %s\n' "$path" >&2; exit 1; }
done
exec 9>/run/lock/spark-ollama-manager-install.lock
flock -n 9 || { printf '%s\n' 'An installation/removal is already running.' >&2; exit 1; }
if [[ -f $UNIT_FILE && $(< "$UNIT_FILE") != *'ExecStart=/opt/spark-ollama-manager/runtime/node /opt/spark-ollama-manager/server.mjs'* ]]; then
  printf '%s\n' 'The service definition changed; refusing to remove an unrelated service.' >&2
  exit 1
fi
if [[ -f $MARKER ]]; then
  [[ -x $APP/runtime/node && -f $APP/deploy/deployment.mjs ]] && command -v tailscale >/dev/null || { printf '%s\n' 'Cannot inspect the tracked Tailscale route. Restore its CLI/application helper and retry; nothing removed.' >&2; exit 1; }
  TEMP=$(mktemp /run/spark-ollama-manager-remove.XXXXXX)
  trap 'rm -f -- "$TEMP"' EXIT
  # Read the root-owned marker as JSON; never source or evaluate file contents.
  IFS=$'\t' read -r HOST PORT TARGET < <("$APP/runtime/node" --input-type=module -e 'import{readFileSync}from"node:fs";const m=JSON.parse(readFileSync(process.argv[1],"utf8"));if(!/^[a-z0-9.-]+\.ts\.net$/.test(m.hostname)||!Number.isInteger(m.port)||m.port<1024||m.port>65535||m.target!=="http://127.0.0.1:42010")process.exit(1);console.log(`${m.hostname}\t${m.port}\t${m.target}`)' "$MARKER")
  timeout 15 tailscale serve status --json > "$TEMP" 2>/dev/null || { printf '%s\n' 'Could not inspect the tracked Tailscale route; nothing removed. Retry with Tailscale running.' >&2; exit 1; }
  ROUTE=$("$APP/runtime/node" "$APP/deploy/deployment.mjs" serve-status "$TEMP" "$PORT" "$TARGET" "$HOST")
  if [[ $ROUTE == matching ]]; then
    timeout 20 tailscale serve --bg --https="$PORT" off || { printf '%s\n' 'Could not remove the manager HTTPS route. Stop here and retry so no route is left pointing at deleted code.' >&2; exit 1; }
  elif [[ $ROUTE != free ]]; then
    printf '%s\n' 'The tracked HTTPS route changed; nothing removed. Inspect that port and remove/reassign the manager handler explicitly before retrying.' >&2
    exit 1
  fi
fi
systemctl disable --now "$SERVICE" >/dev/null 2>&1 || true
rm -f -- "$UNIT_FILE" "$ENV_FILE" "$MARKER"
systemctl daemon-reload
systemctl reset-failed "$SERVICE" >/dev/null 2>&1 || true
if [[ -d $APP ]]; then rm -rf -- "$APP"; fi
printf '%s\n' 'Spark Ollama Manager removed.' "State/credentials/imports remain in $DATA. Reinstalling reuses them." 'Ollama, its models, the service account and installation backups were preserved.'
