# Pi with the model router, in a container (plain Docker, see README.md).
#
# Pi is pinned to the version the repository is developed against
# (devDependency @earendil-works/pi-coding-agent). The router is installed from
# a tarball that scripts/build-router-tarball.sh packs from the working tree, so
# the image contains exactly the code you are looking at — never a published
# version.
#
# No credential is baked into the image. Provider keys are passed at run time
# with `docker run -e <PROVIDER>_API_KEY`, and the agent home is a named volume,
# not the host's ~/.pi/agent (see README.md, "What the container can see").
FROM node:22.19.0-bookworm-slim

ARG PI_VERSION=1.5.2
# The commit the image was built from, so a container under test can name itself.
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
# Test builds only: stage the shipped manifest as a published release served from
# this base URL, so /router laya install can be exercised before the real release
# exists. Empty (the default) leaves the shipped manifest untouched.
ARG LAYA_TEST_BASE_URL=

RUN apt-get update \
    && apt-get install -y --no-install-recommends bash ca-certificates curl git ripgrep \
    && rm -rf /var/lib/apt/lists/*

# Pi itself. --ignore-scripts: nothing in the install needs a build step here.
RUN npm install -g --ignore-scripts "@earendil-works/pi-coding-agent@${PI_VERSION}" \
    && npm cache clean --force

# The router, unpacked from the tarball. It has no runtime dependencies, so no
# npm install is needed beside it. Root-owned on purpose: the agent user can
# read the code but cannot change it. Generated state goes to the state volume.
COPY context/router.tgz /tmp/router.tgz
RUN mkdir -p /opt/router \
    && tar -xzf /tmp/router.tgz -C /opt/router --strip-components=1 \
    && rm /tmp/router.tgz \
    && printf 'commit %s\nbuilt  %s\npi     %s\n' "$GIT_SHA" "$BUILT_AT" "$PI_VERSION" > /opt/router/BUILD-INFO

# Test-release staging: `published: true` and a local base URL, exactly the two
# fields scripts/release-rehearsal.ts stages. Nothing else about the payload changes.
RUN if [ -n "$LAYA_TEST_BASE_URL" ]; then \
      node -e 'const fs=require("fs");const p="/opt/router/laya-models/manifest.json"; \
        const m=JSON.parse(fs.readFileSync(p,"utf8")); \
        for (const x of m.models) { x.published = true; x.base_url = process.env.LAYA_TEST_BASE_URL; } \
        fs.writeFileSync(p, JSON.stringify(m, null, 2) + "\n");' \
      && printf 'laya    TEST RELEASE staged at %s\n' "$LAYA_TEST_BASE_URL" >> /opt/router/BUILD-INFO; \
    fi

COPY --chown=root:root asset-server.mjs /usr/local/bin/asset-server.mjs

# Unprivileged user. Pi and the router run as this user, so a misbehaving tool
# call cannot write outside the workspace and the two volumes.
RUN useradd -m -s /bin/bash pi \
    && mkdir -p /home/pi/.pi/agent /home/pi/.pi/router-state /workspace \
    && chown -R pi:pi /home/pi /workspace

COPY --chown=root:root entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER pi
ENV HOME=/home/pi \
    PI_CODING_AGENT_DIR=/home/pi/.pi/agent \
    PI_ROUTER_STATE_DIR=/home/pi/.pi/router-state \
    PI_SKIP_VERSION_CHECK=1
WORKDIR /workspace

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["pi"]
