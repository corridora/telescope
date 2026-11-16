# syntax=docker/dockerfile:1
# Build from the repository root:
# docker build --platform linux/amd64 -f packages/telescope/Dockerfile -t telescope .
FROM node:24-bookworm

ARG TARGETARCH
ARG PLAYWRIGHT_VERSION=1.61.1

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    HEADLESS=true \
    RUNNING_IN_DOCKER=true

WORKDIR /app

# Chrome, Chrome Beta, and Edge require Linux AMD64 in this image.
RUN if [ "$TARGETARCH" != "amd64" ]; then \
      echo 'This browser image supports linux/amd64. Build with --platform linux/amd64.' >&2; \
      exit 1; \
    fi

# Include workspace manifests so npm can resolve the monorepo root lockfile.
COPY package.json package-lock.json ./
COPY packages/telescope/package.json packages/telescope/package.json
COPY packages/telescope-web/package.json packages/telescope-web/package.json
COPY packages/waterfall/package.json packages/waterfall/package.json

# Browser installation is explicit below; lifecycle scripts must not download
# another browser revision or build an unrelated workspace.
RUN npm ci --ignore-scripts --workspace packages/telescope --include-workspace-root

COPY LICENSE ./LICENSE
COPY packages/telescope/ packages/telescope/

# Keep browser binaries aligned with all Playwright packages and the CI image.
RUN node -e "for (const name of ['playwright', 'playwright-webkit', '@playwright/test']) { const version = require(name + '/package.json').version; if (version !== process.argv[1]) throw new Error(name + ' version ' + version + ' must match ' + process.argv[1]); }" "$PLAYWRIGHT_VERSION" \
    && npx --no-install playwright install --with-deps chromium firefox webkit chrome chrome-beta msedge

# Traffic-shaping tools are only usable through the optional Linux profile.
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg iproute2 kmod sudo ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && npm run build --workspace packages/telescope \
    && npm prune --omit=dev --ignore-scripts --workspace packages/telescope --include-workspace-root \
    && mkdir -p /app/results /app/tmp /data \
    && chown node:node /app/results /app/tmp /data \
    && chmod -R a+rX "$PLAYWRIGHT_BROWSERS_PATH"

USER node

ENTRYPOINT ["node", "/app/packages/telescope/dist/src/cli.js"]
CMD ["--help"]
