# syntax=docker/dockerfile:1.7
# Builds a Vite SPA (admin or portal) and serves it with nginx, proxying /api to the API.
#   docker build -f docker/spa.Dockerfile --build-arg APP=admin .
ARG APP=admin

FROM node:22-bookworm-slim AS build
ARG APP
ARG VITE_EMERGENCY_NUMBER=112
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true VITE_EMERGENCY_NUMBER=$VITE_EMERGENCY_NUMBER
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/types/package.json packages/types/
COPY packages/ui/package.json packages/ui/
COPY apps/${APP}/package.json apps/${APP}/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @helmet/${APP}...
COPY packages packages
COPY apps/${APP} apps/${APP}
RUN pnpm --filter @helmet/${APP} exec vite build

FROM nginx:1.27-alpine AS runtime
ARG APP
ENV API_UPSTREAM=http://api:4000
COPY docker/nginx/spa.conf.template /etc/nginx/templates/default.conf.template
COPY docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/${APP}/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1/healthz || exit 1
