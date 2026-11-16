# Release rehearsal container (plan docs/plans/2026-11-16-release-rehearsal.md, D2).
#
# Standalone on purpose: Node plus this repository, nothing from the maintainer's
# machine. It answers the question the host cannot — does the delivery work on
# Linux, where the ONNX binding is a different file and `npm ci` takes the other
# code path (onnxruntime-node's install script has a linux/x64 branch that does
# not exist on macOS).
#
#   docker build -t router-rehearsal rehearsal/
#   docker run --rm -v "$PWD":/repo:ro -v "$HOME/.laya-ft/artifacts/r2-1.0.0/release":/assets:ro \
#     router-rehearsal --assets /assets
#
# The repository is mounted read-only and copied inside: `npm pack` runs the
# build, which writes dist/.
FROM node:22.19.0-bookworm-slim

# git: `npm pack` reads the repository; ca-certificates: npm and the rehearsal's
# loopback fetch. Nothing else — the image is the smallest thing that can run it.
RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# The rehearsal runs as a normal user, so a bug in it cannot write outside /work.
# WORKDIR would create /work as root, and the entrypoint copies the repository into it.
RUN useradd -m -s /bin/bash agent && mkdir -p /work && chown agent:agent /work
WORKDIR /work
USER agent

COPY --chown=agent:agent entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["--help"]
