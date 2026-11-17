#!/usr/bin/env bash
# Packs the router from the working tree into the Docker build context, then
# builds the image. Run from anywhere:
#
#   sandbox/pi-router/build-context.sh               # pack + docker build -t pi-router
#   sandbox/pi-router/build-context.sh --pack        # pack only
#   sandbox/pi-router/build-context.sh --laya-test   # test-release variant (see run.sh)
#
# npm pack runs the build (prepack), so dist/ is fresh. The tarball is what
# `npm publish` would ship, so the container runs the package as shipped — not
# the source tree with dev files around it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
CONTEXT="$HERE/context"

rm -rf "$CONTEXT"
mkdir -p "$CONTEXT"

# --loglevel=silent keeps stdout to the bare filename; the packed file lands in
# CONTEXT via --pack-destination, so the repository itself gains no artifact.
name="$(cd "$REPO" && npm pack --loglevel=silent --pack-destination "$CONTEXT" | tail -n 1)"
mv "$CONTEXT/$name" "$CONTEXT/router.tgz"
echo "packed: $CONTEXT/router.tgz ($(du -h "$CONTEXT/router.tgz" | cut -f1))"

if [ "${1:-}" = "--pack" ]; then
  exit 0
fi

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

docker build \
  --build-arg "GIT_SHA=$sha" \
  --build-arg "BUILT_AT=$built" \
  --build-arg "LAYA_TEST_BASE_URL=$base_url" \
  -t "$image" "$HERE"
echo "image: $image (commit $sha, built $built)${base_url:+, Laya test release}"
