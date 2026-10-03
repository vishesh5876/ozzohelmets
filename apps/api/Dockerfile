# syntax=docker/dockerfile:1.7
# Build context: repository root.  docker build -f apps/api/Dockerfile .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/types/package.json packages/types/
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
  && cd /out && npx prisma generate

# bookworm-slim already ships libssl3, which is all Prisma's query engine needs.
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Run with an init process (compose `init: true` / `docker run --init`) for signal handling.
# Migrations are applied with `prisma migrate deploy` (never `db push`) before start.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/main.js"]
