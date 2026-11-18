#!/usr/bin/env bash
# Starts pi with the router preinstalled.
#
# The settings file is written only when it does not exist yet, so anything you
# change inside the state volume survives image rebuilds. Credentials are never
# written here: they arrive as environment variables from `docker run -e`.
set -euo pipefail

AGENT_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
SETTINGS="$AGENT_DIR/settings.json"

mkdir -p "$AGENT_DIR" "${PI_ROUTER_STATE_DIR:-$HOME/.pi/router-state}"

# Written to a temporary file and renamed into place: a container stopped
# mid-write used to leave a truncated settings.json that later starts treated as
# complete.
if [ ! -f "$SETTINGS" ]; then
  cat > "$SETTINGS.tmp" <<'JSON'
{
  "packages": ["/opt/router"],
  "defaultProvider": "dynamic",
  "defaultModel": "dynamic",
  "defaultThinkingLevel": "high",
  "theme": "dark"
}
JSON
  mv "$SETTINGS.tmp" "$SETTINGS"
  echo "entrypoint: wrote first-run settings to $SETTINGS"
fi

# Say which provider keys are present, never their values. The list is the one
# run.sh forwards (provider-vars.txt), so a key cannot arrive unreported.
PROVIDER_VARS_FILE=/usr/local/bin/provider-vars.txt
present=()
while IFS= read -r var; do
  case "$var" in ''|'#'*) continue ;; esac
  if [ -n "${!var:-}" ]; then present+=("$var"); fi
done < "$PROVIDER_VARS_FILE"
if [ "${#present[@]}" -eq 0 ]; then
  echo "entrypoint: no provider key in the environment — pi starts, but no cloud model can answer."
  echo "            pass one with: docker run -e OPENROUTER_API_KEY ..."
else
  echo "entrypoint: provider keys present: ${present[*]}"
fi

# Test release: seed the user config into the state volume. It cannot be
# bind-mounted at its final path — the store replaces the file atomically, and a
# file that is itself a mount point cannot be renamed over (EBUSY).
SEED=/seed/router-config.user.json
SEED_TARGET="$AGENT_DIR/router-config.user.json"
if [ -f "$SEED" ] && [ ! -f "$SEED_TARGET" ]; then
  # Same reason as the settings file: an interrupted copy must not look complete.
  cp "$SEED" "$SEED_TARGET.tmp"
  mv "$SEED_TARGET.tmp" "$SEED_TARGET"
  echo "entrypoint: seeded $SEED_TARGET (writes land there; your host file is untouched)"
elif [ -e "$SEED" ] && [ ! -f "$SEED" ] && [ ! -f "$SEED_TARGET" ]; then
  # Docker creates an empty directory when a bind-mount source path is not
  # shared (e.g. /tmp on some setups). Say so instead of starting with defaults.
  echo "entrypoint: WARNING: $SEED is not a file — the bind-mount source was not shared;" >&2
  echo "entrypoint: starting without your config (mount a path under \$HOME)" >&2
fi

# Test release: the assets are mounted, so serve them for the staged manifest.
if [ -d /assets ]; then
  echo "entrypoint: starting the test asset server on 127.0.0.1:8899 for /assets"
  node /usr/local/bin/asset-server.mjs /assets 8899 &
fi

if [ -f /opt/router/BUILD-INFO ]; then
  echo "entrypoint: router build — $(tr '\n' ' ' < /opt/router/BUILD-INFO)"
fi

exec "$@"
