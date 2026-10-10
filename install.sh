#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

APP=/opt/spark-ollama-manager
DATA=/var/lib/spark-ollama-manager
ENV_FILE=/etc/spark-ollama-manager.env
UNIT_FILE=/etc/systemd/system/spark-ollama-manager.service
MARKER=/etc/spark-ollama-manager-tailscale.json
SERVICE=spark-ollama-manager.service
SERVICE_USER=spark-ollama
PROXY=http://127.0.0.1:42010
HTTPS_PORT=9443
CHECK_ONLY=0
USE_TAILSCALE=1
SOURCE_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)
HELPER=$SOURCE_DIR/deploy/deployment.mjs
STAGE=
BACKUP=
CHANGED=0
SUCCESS=0
WAS_ACTIVE=0
WAS_ENABLED=0
TS_CREATED=0
TS_HOST=
TS_URL=
NODE_BIN=${NODE_BIN:-}
TS_HTTPS_VERIFIED=0

say() { printf '%s\n' "$*"; }
die() { say "ERROR: $*" >&2; exit 1; }
usage() {
  cat <<'TEXT'
Usage: sudo bash install.sh [--no-tailscale] [--https-port 9443]
       bash install.sh --check

--check          Read-only ARM64 / Node / source / systemd preflight.
--no-tailscale   Install localhost service without adding a Tailscale route.
--https-port N   Use an unused private HTTPS port (1024–65535; default 9443).
--node PATH      Use an existing ARM64 Node binary (for sudo/nvm setups).
--help          Show this help.

Requires DGX OS / Ubuntu ARM64, an existing Node.js >=22 and systemd.
Does not install or modify Ollama, its service, GPU software or model files.
TEXT
}
while (($#)); do
  case "$1" in
    --check) CHECK_ONLY=1; shift ;;
    --no-tailscale) USE_TAILSCALE=0; shift ;;
    --https-port) (($# >= 2)) || die '--https-port needs a value'; HTTPS_PORT=$2; shift 2 ;;
    --node) (($# >= 2)) || die '--node needs a path'; NODE_BIN=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) die "Unknown option: $1" ;;
  esac
done
[[ $HTTPS_PORT =~ ^[0-9]{4,5}$ ]] && ((10#$HTTPS_PORT >= 1024 && 10#$HTTPS_PORT <= 65535)) || die 'HTTPS port must be 1024–65535.'
HTTPS_PORT=$((10#$HTTPS_PORT))

# All checks before this point and in --check mode are read-only.
ARCH=$(uname -m)
[[ $ARCH == aarch64 || $ARCH == arm64 ]] || die "This installer targets Linux ARM64; this machine is $ARCH. Nothing changed."
[[ $(uname -s) == Linux ]] || die 'Linux is required.'
for command in curl systemctl journalctl install useradd runuser getent id readlink find cp mv chmod chown flock timeout ss mktemp date rm; do
  command -v "$command" >/dev/null || die "Missing prerequisite: $command. Nothing changed."
done
if [[ -z $NODE_BIN ]]; then command -v node >/dev/null || die 'Node.js was not found. Use --node /absolute/path/to/node. Nothing changed.'; fi
NODE=$(readlink -f -- "${NODE_BIN:-$(command -v node)}")
[[ -f $NODE && -x $NODE ]] || die 'Node.js executable was not found.'
"$NODE" -e 'if (Number(process.versions.node.split(".")[0]) < 22 || process.arch !== "arm64") process.exit(1)' || die 'Node.js >=22 for ARM64 is required. Nothing changed.'
[[ -d /run/systemd/system ]] || die 'A running systemd host is required. Nothing changed.'
[[ -f $HELPER && ! -L $HELPER ]] || die 'Source is incomplete: deploy/deployment.mjs. Nothing changed.'
SOURCE_VERSION=$("$NODE" "$HELPER" source-check "$SOURCE_DIR") || die 'Release source verification failed. Nothing changed.'
for path in "$APP" "$DATA" "$ENV_FILE" "$UNIT_FILE" "$MARKER"; do
  [[ ! -L $path ]] || die "Refusing a symbolic link at managed path $path. Nothing changed."
done
if getent passwd "$SERVICE_USER" >/dev/null; then
  ACCOUNT=$(getent passwd "$SERVICE_USER")
  IFS=: read -r _ _ ACCOUNT_UID _ _ ACCOUNT_HOME ACCOUNT_SHELL <<< "$ACCOUNT"
  [[ $ACCOUNT_UID != 0 && $ACCOUNT_HOME == "$DATA" && $ACCOUNT_SHELL == */nologin ]] || die 'The spark-ollama account already exists with a different purpose. Nothing changed.'
  getent group "$SERVICE_USER" >/dev/null || die 'Existing spark-ollama service group was not found. Nothing changed.'
fi
if systemctl is-active --quiet "$SERVICE"; then
  WAS_ACTIVE=1
elif [[ -n $(ss -lntH '( sport = :42010 )') ]]; then
  die 'Port 42010 is already used by another process. Nothing changed.'
fi
if systemctl is-enabled --quiet "$SERVICE" 2>/dev/null; then WAS_ENABLED=1; fi
if [[ -e $UNIT_FILE ]] && ! [[ -d $APP && -f $APP/server.mjs ]]; then
  die 'A service with this name exists without the managed application. Nothing changed.'
fi
say "Preflight passed: Spark Ollama Manager $SOURCE_VERSION; Linux $ARCH; Node $("$NODE" --version); localhost port 42010; systemd available."
if curl --silent --show-error --fail --max-time 3 http://127.0.0.1:11434/api/version >/dev/null 2>&1; then
  say 'Existing Ollama responds on 127.0.0.1:11434.'
else
  say 'Ollama is currently unavailable on 127.0.0.1:11434. Manager can still start and report its status.'
fi
if ((CHECK_ONLY)); then
  say 'Read-only check finished; no files, services, routes or models changed.'
  exit 0
fi
((EUID == 0)) || die 'Run installation with sudo. --check does not need sudo.'
if ((USE_TAILSCALE)) && [[ -f $MARKER ]]; then
  EXISTING_PORT=$("$NODE" "$HELPER" marker-port "$MARKER")
  [[ $EXISTING_PORT == "$HTTPS_PORT" ]] || die "This manager already owns HTTPS port $EXISTING_PORT. Rerun with --https-port $EXISTING_PORT, or uninstall it before changing ports. Nothing changed."
fi

exec 9>/run/lock/spark-ollama-manager-install.lock
flock -n 9 || die 'Another manager installation or removal is in progress.'

route_state() {
  local result_file=$1
  timeout 15 tailscale serve status --json > "$result_file" 2>/dev/null || return 1
  "$NODE" "$HELPER" serve-status "$result_file" "$HTTPS_PORT" "$PROXY" "$TS_HOST"
}
restore_file() {
  local name=$1 destination=$2
  if [[ -f $BACKUP/$name ]]; then cp -p -- "$BACKUP/$name" "$destination"; else rm -f -- "$destination"; fi
}
cleanup() {
  local code=$?
  trap - EXIT
  if ((CHANGED && !SUCCESS)); then
    say 'Installation failed; restoring the previous application and service configuration.' >&2
    systemctl stop "$SERVICE" >/dev/null 2>&1 || true
    # Disable the newly installed unit while its definition still exists.
    if ((!WAS_ENABLED)); then systemctl disable "$SERVICE" >/dev/null 2>&1 || true; fi
    if ((TS_CREATED)) && command -v tailscale >/dev/null; then
      if [[ $(route_state "$BACKUP/rollback-serve.json" 2>/dev/null || true) == matching ]]; then
        timeout 20 tailscale serve --bg --https="$HTTPS_PORT" off >/dev/null 2>&1 || true
      fi
    fi
    if [[ -d $APP ]]; then mv -- "$APP" "$BACKUP/failed-app" || true; fi
    if [[ -d $BACKUP/app ]]; then mv -- "$BACKUP/app" "$APP" || true; fi
    restore_file env "$ENV_FILE"
    restore_file unit "$UNIT_FILE"
    restore_file tailscale-marker "$MARKER"
    systemctl daemon-reload >/dev/null 2>&1 || true
    if ((WAS_ENABLED)); then systemctl enable "$SERVICE" >/dev/null 2>&1 || true; else systemctl disable "$SERVICE" >/dev/null 2>&1 || true; fi
    if ((WAS_ACTIVE)); then systemctl start "$SERVICE" >/dev/null 2>&1 || true; fi
    say "State and models were preserved. Diagnostic/failed code folder: $BACKUP" >&2
  fi
  if [[ -n $STAGE && -d $STAGE ]]; then rm -rf -- "$STAGE"; fi
  exit "$code"
}
trap cleanup EXIT

install -d -m 0755 /opt
STAGE=$(mktemp -d /opt/.spark-ollama-manager-stage.XXXXXX)
"$NODE" "$HELPER" stage-source "$SOURCE_DIR" "$STAGE" >/dev/null
# Keep the service independent of interactive shell/nvm permissions.
install -d -m 0755 "$STAGE/runtime"
install -m 0755 "$NODE" "$STAGE/runtime/node"
find "$STAGE" -type d -exec chmod 0755 {} +
find "$STAGE" -type f ! -path "$STAGE/runtime/node" -exec chmod 0644 {} +
chmod 0755 "$STAGE/install.sh" "$STAGE/uninstall.sh"
chown -R root:root "$STAGE"
"$STAGE/runtime/node" --check "$STAGE/server.mjs"
"$STAGE/runtime/node" --check "$STAGE/mcp-client.mjs"

if ! getent passwd "$SERVICE_USER" >/dev/null; then
  useradd --system --user-group --home-dir "$DATA" --shell /usr/sbin/nologin "$SERVICE_USER"
fi
runuser -u "$SERVICE_USER" -- "$STAGE/runtime/node" --check "$STAGE/server.mjs" || die 'Copied Node runtime is not executable by the dedicated service account.'
[[ ! -L $DATA/imports ]] || die 'Refusing a symbolic link at the managed imports folder.'
[[ ! -L $DATA/mcp-workspaces ]] || die 'Refusing a symbolic link at the managed MCP workspace folder.'
install -d -o "$SERVICE_USER" -g "$SERVICE_USER" -m 0700 "$DATA" "$DATA/imports" "$DATA/mcp-workspaces"
if [[ -n $(find "$DATA" -maxdepth 1 -type f ! -user "$SERVICE_USER" -print -quit) ]]; then
  die 'Existing state files belong to another user. Resolve ownership explicitly before installation.'
fi

install -d -m 0700 /opt/spark-ollama-manager-backups
BACKUP=$(mktemp -d /opt/spark-ollama-manager-backups/install-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX)
[[ ! -f $ENV_FILE ]] || cp -p -- "$ENV_FILE" "$BACKUP/env"
[[ ! -f $UNIT_FILE ]] || cp -p -- "$UNIT_FILE" "$BACKUP/unit"
[[ ! -f $MARKER ]] || cp -p -- "$MARKER" "$BACKUP/tailscale-marker"
CHANGED=1
systemctl stop "$SERVICE" >/dev/null 2>&1 || true
if [[ -d $APP ]]; then mv -- "$APP" "$BACKUP/app"; fi
mv -- "$STAGE" "$APP"
STAGE=
HELPER=$APP/deploy/deployment.mjs

ORIGIN=
if [[ -f $ENV_FILE ]]; then ORIGIN=$("$NODE" "$HELPER" env-origin "$ENV_FILE"); fi
if ((USE_TAILSCALE)) && command -v tailscale >/dev/null; then
  if timeout 15 tailscale status --json > "$BACKUP/tailscale-status.json" 2>/dev/null && TS_HOST=$("$NODE" "$HELPER" dns "$BACKUP/tailscale-status.json" 2>/dev/null); then
    ROUTE=$(route_state "$BACKUP/tailscale-before.json" 2>/dev/null || true)
    if [[ $ROUTE == matching && -f $MARKER ]] && "$NODE" "$HELPER" marker-match "$MARKER" "$TS_HOST" "$HTTPS_PORT" "$PROXY"; then
      TS_URL=https://$TS_HOST:$HTTPS_PORT
      ORIGIN=$TS_URL
      say "Reusing the manager's existing private Tailscale HTTPS route: $TS_URL"
    elif [[ $ROUTE != free ]]; then
      say "Tailscale port $HTTPS_PORT is in use or its configuration is unknown; existing routes are unchanged."
      USE_TAILSCALE=0
    fi
  else
    say 'Tailscale is unavailable or disconnected. Installing the localhost service only.'
    USE_TAILSCALE=0
  fi
else
  USE_TAILSCALE=0
fi

ENV_INPUT=-
[[ ! -f $ENV_FILE ]] || ENV_INPUT=$ENV_FILE
"$NODE" "$HELPER" env-write "$ENV_INPUT" "$BACKUP/new-env" "$ORIGIN"
install -o root -g root -m 0600 "$BACKUP/new-env" "$ENV_FILE"
install -o root -g root -m 0644 "$APP/deploy/spark-ollama-manager.service" "$UNIT_FILE"
systemctl daemon-reload
systemctl enable "$SERVICE" >/dev/null
systemctl start "$SERVICE"

healthy() {
  local attempt
  for attempt in {1..20}; do
    if curl --silent --show-error --fail --max-time 2 "$PROXY/api/health" | "$NODE" "$HELPER" health-check "$SOURCE_VERSION" >/dev/null 2>&1; then
      return 0
    fi
    systemctl is-active --quiet "$SERVICE" || break
    sleep 1
  done
  return 1
}
healthy || { journalctl -u "$SERVICE" -n 30 --no-pager >&2; die 'Manager failed its startup health check.'; }

if ((USE_TAILSCALE)) && [[ -z $TS_URL ]]; then
  if [[ $(route_state "$BACKUP/tailscale-final-preflight.json" 2>/dev/null || true) != free ]]; then
    say 'Tailscale configuration changed during installation; it was left unchanged. Rerun after resolving the port conflict.'
    USE_TAILSCALE=0
  fi
fi
if ((USE_TAILSCALE)) && [[ -z $TS_URL ]]; then
  say "Adding a private Tailscale HTTPS route on port $HTTPS_PORT."
  # No reset, Funnel, replacement of existing handlers, or modification of port 443.
  if ! timeout 30 tailscale serve --bg --https="$HTTPS_PORT" "$PROXY"; then
    say 'Tailscale could not complete HTTPS setup. If it printed an enable-HTTPS link, open that link, then rerun this installer.'
  fi
  if [[ $(route_state "$BACKUP/tailscale-after.json" 2>/dev/null || true) == matching ]]; then
    TS_CREATED=1
    TS_URL=https://$TS_HOST:$HTTPS_PORT
    "$NODE" "$HELPER" marker-write "$MARKER" "$TS_HOST" "$HTTPS_PORT" "$PROXY"
    chown root:root "$MARKER"
    chmod 0600 "$MARKER"
    "$NODE" "$HELPER" env-write "$ENV_FILE" "$BACKUP/https-env" "$TS_URL"
    install -o root -g root -m 0600 "$BACKUP/https-env" "$ENV_FILE"
    systemctl restart "$SERVICE"
    healthy || die 'Manager failed after setting its HTTPS origin.'
  else
    say 'The manager is healthy locally. No working private HTTPS URL was detected.'
  fi
fi
SUCCESS=1
if [[ -n $TS_URL ]] && curl --silent --show-error --fail --max-time 10 "$TS_URL/api/health" > "$BACKUP/https-health.json" 2>/dev/null; then
  if "$NODE" "$HELPER" health-check "$SOURCE_VERSION" "$BACKUP/https-health.json"; then
    TS_HTTPS_VERIFIED=1
  fi
fi
say ''
say "Spark Ollama Manager $SOURCE_VERSION installed and healthy."
if [[ -n $TS_URL ]]; then
  say "Private URL: $TS_URL"
  if ((TS_HTTPS_VERIFIED)); then say 'HTTPS health check passed from this DGX.'; else say 'HTTPS route is configured; its TLS health check could not be verified from this host.'; fi
  say 'Open this URL from a device signed into the same Tailscale network and permitted by its access policy.'
else
  say 'Local URL on the DGX: http://127.0.0.1:42010'
  say 'For remote access, use the SSH tunnel or Tailscale instructions in README.md.'
fi
if [[ -f $DATA/first-login.txt ]]; then
  say 'Read the initial login password locally: sudo cat /var/lib/spark-ollama-manager/first-login.txt'
fi
say 'Password reset: sudo -u spark-ollama /opt/spark-ollama-manager/runtime/node /opt/spark-ollama-manager/scripts/password.mjs --data-dir /var/lib/spark-ollama-manager'
say "Previous code/configuration backup: $BACKUP"
say 'Ollama service, existing model files and GPU configuration were unchanged.'
