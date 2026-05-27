FROM oven/bun:1.3.1@sha256:c1526bc496336087e5bdfaf519746c12ac4d5ebdda6d8a99d27ebd5d9ad7304c AS bun
FROM node:24.14.1-bookworm-slim@sha256:e484ae3f1e3c378021c967fd42254f343c302a9263e412280eac32bf5bca7008
ARG PLAYWRIGHT_VERSION

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update && apt-get install -y curl git gpg libatomic1 unzip && rm -rf /var/lib/apt/lists/*

RUN npm install --prefix /tmp/pw @playwright/test@${PLAYWRIGHT_VERSION} \
    && /tmp/pw/node_modules/.bin/playwright install --with-deps chromium \
    && rm -rf /tmp/pw \
    # Remove node in the same RUN so it is invisible to the container at runtime.
    # Deletions in a later layer would still bloat the image with the unreachable binary.
    # setup-node is the sole provider of node at runtime.
    && rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && rm -rf /usr/local/lib/node_modules /usr/local/include/node
