FROM oven/bun:1.3.1 AS bun
FROM node:24.14.1-bookworm-slim
ARG PLAYWRIGHT_VERSION

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update && apt-get install -y curl git gpg libatomic1 unzip && rm -rf /var/lib/apt/lists/*

RUN npm install --prefix /tmp/pw @playwright/test@${PLAYWRIGHT_VERSION} \
    && echo "playwright npm install finished"

RUN /tmp/pw/node_modules/.bin/playwright install-deps chromium \
    && echo "playwright chromium dependency install finished"

RUN DEBUG=pw:install /tmp/pw/node_modules/.bin/playwright install chromium \
    && echo "playwright chromium install finished"

RUN rm -rf /tmp/pw \
    && echo "playwright temp cleanup finished" \
    # Remove node in the same RUN so it is invisible to the container at runtime.
    # Deletions in a later layer would still bloat the image with the unreachable binary.
    # setup-node is the sole provider of node at runtime.
    && rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && rm -rf /usr/local/lib/node_modules /usr/local/include/node \
    && echo "node runtime cleanup finished"
