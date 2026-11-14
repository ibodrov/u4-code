# Build context contains only the fork's CLI archive and these runtime helpers.
ARG NODE_IMAGE=node:24.14.0-bookworm-slim
ARG JAVA_IMAGE=eclipse-temurin:25-jdk
FROM ${JAVA_IMAGE} AS java
FROM ${NODE_IMAGE} AS tools
USER root
RUN apt-get update && apt-get install -y --no-install-recommends git bash ca-certificates tar curl build-essential python3 unzip libatomic1 && rm -rf /var/lib/apt/lists/*
COPY --from=java /opt/java/openjdk /opt/java/openjdk
ENV JAVA_HOME=/opt/java/openjdk PATH=/opt/java/openjdk/bin:/usr/local/bin:/usr/bin:/bin
RUN mkdir -p /opt/u4 /workspace /cache /provider /state /build /run/u4-build && chown 1000:1000 /workspace /cache /provider /state /build /run/u4-build
COPY build-worker.mjs build-snapshot.mjs workspace.mjs prepare-volume.mjs entrypoint.mjs /opt/u4/
COPY build-supervisor.c /opt/u4/
RUN cc -O2 -Wall -Wextra -Werror -o /opt/u4/build-supervisor /opt/u4/build-supervisor.c
RUN printf '#!/bin/sh\nexec node /opt/u4/build-worker.mjs "$@"\n' > /usr/local/bin/u4-build && chmod 755 /usr/local/bin/u4-build
USER 1000:1000
WORKDIR /workspace
FROM tools AS builder
USER 1001:1000
ENV HOME=/cache/home
ENTRYPOINT ["node", "/opt/u4/build-worker.mjs", "serve"]
FROM tools AS runtime
ARG PI_VERSION
USER root
RUN test -n "$PI_VERSION" && npm install -g @earendil-works/pi-coding-agent@${PI_VERSION} && npm cache clean --force
COPY runtime/ /opt/u4/runtime/
USER 1000:1000
ENV HOME=/provider U4CODE_HOME=/state/u4 PI_CODING_AGENT_DIR=/provider/.pi/agent
ENTRYPOINT ["node", "/opt/u4/entrypoint.mjs"]
