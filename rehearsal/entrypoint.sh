#!/usr/bin/env bash
# Copies the mounted repository into the writable work dir (the mount is read-only,
# and `npm pack` runs the build), then runs the release rehearsal.
#
#   docker run --rm -v "$PWD":/repo:ro -v <release dir>:/assets:ro router-rehearsal --assets /assets
set -euo pipefail

if [ "${1:-}" = "--help" ]; then
  cat <<'USAGE'
usage: docker run --rm -v "$PWD":/repo:ro -v <release dir>:/assets:ro router-rehearsal [options]

  Everything after the image name goes to scripts/release-rehearsal.ts.
  --assets <dir>   the release directory (mount it at /assets)
  --skip-runtime   do not install the ONNX runtime
  --no-serve       stop before /health and /classify

The container prints its Node and platform first, because that is the point of
running it here.
USAGE
  exit 0
fi

echo "rehearsal container: node $(node --version), $(node -p 'process.platform + "/" + process.arch')"

if [ ! -d /repo ]; then
  echo "the repository is not mounted at /repo (use -v \"\$PWD\":/repo:ro)" >&2
  exit 2
fi

# A copy, not a mount: the build writes dist/, and the host tree must stay untouched.
# node_modules and the worktrees stay behind — the host's binaries are for another
# platform (esbuild: Exec format error) and the worktrees are gigabytes.
rm -rf /work/repo
mkdir -p /work/repo
tar -C /repo \
  --exclude=./node_modules --exclude=./laya-sidecar/node_modules \
  --exclude=./.git --exclude=./.worktrees --exclude=./coverage --exclude=./dist \
  -cf - . | tar -C /work/repo -xf -
cd /work/repo

# The container's own dependencies, from the committed lockfile: this is also the
# only place the Linux install of the toolchain is exercised.
echo "installing dependencies in the container (npm ci)"
npm ci --no-audit --no-fund

exec node scripts/release-rehearsal.ts "$@"
