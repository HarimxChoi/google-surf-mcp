# Dockerfile for the google-surf-mcp server.
#
# Hybrid of the upstream Dockerfile and container-friendly tweaks:
#   * System Chromium (apt) + Xvfb — small image, headed CAPTCHA possible
#   * No build-time profile bake: baking runs bootstrap against Google from
#     the build host's IP (no proxy), which datacenter IPs get CAPTCHA'd on.
#     Instead the warm profile lives on a volume; first run can warm it
#     headlessly from an exported cookies JSON (SURF_COOKIES_FILE).
#
# Run:
#   docker run -i --rm \
#     -e SURF_PROXY=socks5://host:port \
#     -e SURF_COOKIES_FILE=/data/cookies.json \
#     -v google-surf-data:/data \
#     google-surf-mcp

FROM node:22-bookworm-slim

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    SURF_PROFILE_ROOT=/data \
    SURF_NO_SANDBOX=true \
    SURF_CLOUD_MODE=true

# System Chromium (detectChrome picks up /usr/bin/chromium) + Xvfb for headed
# bootstrap / manual CAPTCHA solving if you ever run it that way.
RUN apt-get update && \
    apt-get install -y --no-install-recommends chromium xvfb xauth && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json server.json manifest.json ./
COPY src ./src
COPY scripts ./scripts

# Install (with devDeps for tsc), build, then prune dev
RUN npm ci --ignore-scripts && \
    npm run build && \
    npm prune --omit=dev

ENV NODE_ENV=production

COPY README.md LICENSE ./

VOLUME /data
ENTRYPOINT ["node", "build/index.js"]
