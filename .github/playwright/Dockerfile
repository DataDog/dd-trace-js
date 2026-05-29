FROM oven/bun:1.3.1@sha256:c1526bc496336087e5bdfaf519746c12ac4d5ebdda6d8a99d27ebd5d9ad7304c AS bun
FROM node:24.14.1-bookworm-slim@sha256:e484ae3f1e3c378021c967fd42254f343c302a9263e412280eac32bf5bca7008
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
