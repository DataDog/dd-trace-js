FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS bun
FROM node:24.22.1-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
ARG PLAYWRIGHT_VERSION

ENV DEBIAN_FRONTEND=noninteractive
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    gpg \
    libatomic1 \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Playwright 1.18.x tries obsolete Ubuntu package names on Debian Bookworm
# (`ttf-unifont`, `xfonts-cyrillic`, `ttf-ubuntu-font-family`) and exits 0
# even though apt fails. Install Chromium's runtime dependencies directly.
RUN npm install --prefix /tmp/pw @playwright/test@${PLAYWRIGHT_VERSION} \
    && case "$PLAYWRIGHT_VERSION" in \
      1.18|1.18.*) \
        echo "Installing Playwright 1.18 Chromium dependencies for Debian Bookworm" \
        && apt-get update && apt-get install -y --no-install-recommends \
          ca-certificates \
          fonts-ipafont-gothic \
          fonts-liberation \
          fonts-noto-color-emoji \
          fonts-tlwg-loma-otf \
          fonts-unifont \
          fonts-wqy-zenhei \
          libasound2 \
          libatk-bridge2.0-0 \
          libatk1.0-0 \
          libatspi2.0-0 \
          libcairo2 \
          libcups2 \
          libdbus-1-3 \
          libdrm2 \
          libegl1 \
          libfontconfig1 \
          libfreetype6 \
          libgbm1 \
          libglib2.0-0 \
          libgtk-3-0 \
          libnspr4 \
          libnss3 \
          libpango-1.0-0 \
          libx11-6 \
          libx11-xcb1 \
          libxcb1 \
          libxcomposite1 \
          libxdamage1 \
          libxext6 \
          libxfixes3 \
          libxrandr2 \
          libxshmfence1 \
          xfonts-scalable \
          xvfb \
        && rm -rf /var/lib/apt/lists/* \
        && /tmp/pw/node_modules/.bin/playwright install chromium \
        ;; \
      *) \
        echo "Installing Chromium through Playwright dependency installer" \
        && /tmp/pw/node_modules/.bin/playwright install --with-deps chromium \
        ;; \
    esac \
    && rm -rf /tmp/pw \
    # Remove node in the same RUN so it is invisible to the container at runtime.
    # Deletions in a later layer would still bloat the image with the unreachable binary.
    # setup-node is the sole provider of node at runtime.
    && rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && rm -rf /usr/local/lib/node_modules /usr/local/include/node
