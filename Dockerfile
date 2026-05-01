# Dockerfile for the google-surf-mcp server.
#
# Includes Chromium + Xvfb so the image can auto-bootstrap a warm profile
# during build (no human interaction needed). End-to-end functional after
# build, validates cleanly against MCP introspection.
#
# Note: the baked profile is build-time state. For long-running production
# use, mount your own host-bootstrapped profile:
#   -v $HOME/.google-surf-mcp:/root/.google-surf-mcp

FROM node:22-bookworm-slim

WORKDIR /app

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

# System Chromium (detectChrome picks up /usr/bin/chromium) + Xvfb for headed bootstrap
RUN apt-get update && \
    apt-get install -y --no-install-recommends chromium xvfb xauth && \
    rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json tsconfig.json ./
COPY src ./src

# Install (with devDeps for tsc), build, then prune dev
RUN npm ci --ignore-scripts && \
    npm run build && \
    npm prune --omit=dev

# Auto-warm a Chrome profile during image build via Xvfb virtual display
RUN xvfb-run -a node build/bootstrap-auto.js

ENV NODE_ENV=production

COPY README.md LICENSE ./

CMD ["node", "build/index.js"]
