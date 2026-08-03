# syntax=docker/dockerfile:1
# google-surf-mcp — MCP server over stdio (Google search, no API key).
# Run: docker run -i --rm \
#        -e SURF_PROXY=socks5://host:port \
#        -v google-surf-data:/data \
#        google-surf-mcp

FROM node:22-slim AS build
WORKDIR /app
COPY package*.json ./
COPY . .
RUN npm ci && npm run build

FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    SURF_PROFILE_ROOT=/data \
    SURF_NO_SANDBOX=true \
    SURF_CLOUD_MODE=true
WORKDIR /app
COPY --from=build /app/package*.json ./
COPY --from=build /app/build ./build
# Playwright + system deps for Chromium, then the browser itself.
RUN npm ci --omit=dev --ignore-scripts && \
    npx playwright install --with-deps chromium
VOLUME /data
ENTRYPOINT ["node", "build/index.js"]
