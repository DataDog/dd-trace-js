FROM node:24.14.1-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update && apt-get install -y curl wget gnupg unzip \
    && rm -rf /var/lib/apt/lists/*

# Install Google Chrome stable
RUN wget -q -O - https://dl.google.com/linux/linux_signing_key.pub \
    | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] http://dl.google.com/linux/chrome/deb/ stable main" \
       > /etc/apt/sources.list.d/google-chrome.list \
    && apt-get update \
    && apt-get install -y google-chrome-stable \
    && rm -rf /var/lib/apt/lists/*

# Install ChromeDriver matching the installed Chrome version
RUN CHROME_VER=$(google-chrome --version | awk '{print $3}' | cut -d. -f1-3) \
    && curl -sf https://googlechromelabs.github.io/chrome-for-testing/known-good-versions-with-downloads.json \
       > /tmp/chrome-versions.json \
    && DRIVER_URL=$(CHROME_VER="$CHROME_VER" node -e " \
        const d = JSON.parse(require('fs').readFileSync('/tmp/chrome-versions.json', 'utf8')); \
        const prefix = process.env.CHROME_VER; \
        const matches = d.versions.filter(v => v.version.startsWith(prefix)); \
        const latest = matches[matches.length - 1]; \
        const entry = latest.downloads.chromedriver.find(e => e.platform === 'linux64'); \
        console.log(entry.url);") \
    && wget -q "$DRIVER_URL" -O /tmp/chromedriver.zip \
    && unzip /tmp/chromedriver.zip -d /tmp/chromedriver-dir \
    && mv /tmp/chromedriver-dir/chromedriver-linux64/chromedriver /usr/bin/chromedriver \
    && chmod +x /usr/bin/chromedriver \
    && rm -rf /tmp/chrome-versions.json /tmp/chromedriver.zip /tmp/chromedriver-dir

# Remove node since it will be injected at runtime by setup-node
RUN rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    && rm -rf /usr/local/lib/node_modules /usr/local/include/node
