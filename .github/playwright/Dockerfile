FROM oven/bun:1.3.1 AS bun
FROM node:24-bookworm-slim
ARG PLAYWRIGHT_VERSION

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN npm install --prefix /tmp/pw @playwright/test@${PLAYWRIGHT_VERSION} \
    && /tmp/pw/node_modules/.bin/playwright install --with-deps chromium \
    && rm -rf /tmp/pw \
    # Remove node in the same RUN so it is invisible to the container at runtime.
    # Deletions in a later layer would still bloat the image with the unreachable binary.
    # setup-node is the sole provider of node at runtime.
    && rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && rm -rf /usr/local/lib/node_modules /usr/local/include/node
