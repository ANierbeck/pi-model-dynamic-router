#!/usr/bin/env bash
# Packs the router from the working tree into a Docker build context, then
# builds the image. Run from anywhere:
#
#   sandbox/pi-router/build-context.sh               # pack + docker build -t pi-router
#   sandbox/pi-router/build-context.sh --pack        # pack only
#   sandbox/pi-router/build-context.sh --laya-test   # test-release variant (see run.sh)
#
# npm pack runs the build (prepack), so dist/ is fresh. The tarball is what
# `npm publish` would ship, so the container runs the package as shipped — not
# the source tree with dev files around it.
#
# The context is a fresh temporary directory per run: two overlapping builds used
# to share `sandbox/pi-router/context`, so one could pack into the directory the
# other was building and hand docker a half-written tarball.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CONTEXT="$(mktemp -d "${TMPDIR:-/tmp}/pi-router-context.XXXXXX")"
trap 'rm -rf "$CONTEXT"' EXIT

# --loglevel=silent keeps stdout to the bare filename; the packed file lands in
# CONTEXT via --pack-destination, so the repository itself gains no artifact.
name="$(cd "$REPO" && npm pack --loglevel=silent --pack-destination "$CONTEXT" | tail -n 1)"
mv "$CONTEXT/$name" "$CONTEXT/router.tgz"
echo "packed: $CONTEXT/router.tgz ($(du -h "$CONTEXT/router.tgz" | cut -f1))"

if [ "${1:-}" = "--pack" ]; then
  exit 0
fi

# Everything the Dockerfile COPYs has to be in the context.
cp "$HERE/Dockerfile" "$HERE/asset-server.mjs" "$HERE/entrypoint.sh" "$HERE/provider-vars.txt" "$CONTEXT/"

sha="$(cd "$REPO" && git rev-parse --short HEAD)"
if [ -n "$(cd "$REPO" && git status --porcelain)" ]; then
  sha="$sha-dirty"
fi
built="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

image=pi-router
base_url=""
if [ "${1:-}" = "--laya-test" ]; then
  # A separate tag on purpose: the staged manifest must never end up in the
  # image you would hand to someone else.
  image=pi-router:laya-test
  base_url=http://127.0.0.1:8899/
fi

# The image user gets the ids of the account running this script: a
# bind-mounted workspace belongs to that account (see Dockerfile, PI_UID).
docker build \
  --build-arg "GIT_SHA=$sha" \
  --build-arg "BUILT_AT=$built" \
  --build-arg "LAYA_TEST_BASE_URL=$base_url" \
  --build-arg "PI_UID=$(id -u)" \
  --build-arg "PI_GID=$(id -g)" \
  -t "$image" -f "$CONTEXT/Dockerfile" "$CONTEXT"
echo "image: $image (commit $sha, built $built, uid $(id -u):$(id -g))${base_url:+, Laya test release}"
