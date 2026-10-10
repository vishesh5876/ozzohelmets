# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f apps/api/Dockerfile .
# One image runs three roles: API (default CMD), worker (`node dist/worker.js`) and offline
# maintenance (`node dist/cli.js …`, `prisma migrate deploy`).

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/types/package.json packages/types/
COPY packages/api-client/package.json packages/api-client/
COPY apps/api/package.json apps/api/
COPY apps/api/prisma apps/api/prisma
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @helmet/api...
COPY packages/tsconfig packages/tsconfig
COPY packages/types packages/types
COPY apps/api apps/api
RUN pnpm --filter @helmet/types build && pnpm --filter @helmet/api exec prisma generate && pnpm --filter @helmet/api exec nest build -p tsconfig.build.json
# Self-contained production tree (workspace deps are copied in, dev deps dropped).
RUN pnpm --filter @helmet/api deploy --prod --legacy /out \
  && cp -r apps/api/dist /out/dist \
  && cd /out && ./node_modules/.bin/prisma generate
# Keep only what runs: compiled code, prisma schema + migrations, production node_modules.
# Removed: sources/tests/configs, musl (Alpine) sharp binaries, Prisma WASM engines for other
# databases (the native PostgreSQL engine is used), source maps, TypeScript declarations and the
# TypeScript compiler (only needed for seeds/config files, not for `migrate deploy`).
RUN cd /out \
  && rm -rf src test scripts storage Dockerfile eslint.config.mjs jest.config.ts nest-cli.json tsconfig*.json dist/**/*.tsbuildinfo \
  && rm -rf node_modules/.pnpm/@img+sharp-libvips-linuxmusl* node_modules/.pnpm/@img+sharp-linuxmusl* \
  && find node_modules/.pnpm -path '*@prisma/client/runtime/*' \( -name '*cockroachdb*' -o -name '*mysql*' -o -name '*sqlite*' -o -name '*sqlserver*' \) -delete \
  && rm -rf node_modules/.pnpm/typescript@* \
  && find node_modules dist -type f \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete \
  && find node_modules -xtype l -delete \
  && printf '#!/bin/sh\nset -e\n# Opt-in auto-migration (development compose). Production runs `prisma migrate deploy` explicitly.\nif [ "$RUN_MIGRATIONS_ON_START" = "true" ]; then ./node_modules/.bin/prisma migrate deploy; fi\nexec "$@"\n' > /out/docker-entrypoint.sh \
  && chmod 755 /out/docker-entrypoint.sh

# The Prisma query engine used here has no OpenSSL dependency (verified with ldd), so the slim
# image needs no extra packages. Prisma CLI commands print a harmless "install OpenSSL" notice.
FROM node:22-bookworm-slim AS runtime
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
ENV NODE_ENV=production APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA BUILD_DATE=$BUILD_DATE \
    FILE_STORAGE_LOCAL_DIR=/app/storage NPM_CONFIG_UPDATE_NOTIFIER=false
LABEL org.opencontainers.image.title="helmet-api" org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$GIT_SHA org.opencontainers.image.created=$BUILD_DATE
WORKDIR /app
# Files are root-owned and read-only to the app user; only the storage mount is writable.
COPY --from=build /out ./
# Uploads live on a host bind mount (/srv/helmet-platform/uploads) owned by UID 1000 (node).
RUN mkdir -p /app/storage && chown node:node /app/storage && chmod 700 /app/storage
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run with an init process (compose `init: true` / `docker run --init`) for signal handling.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "dist/main.js"]
