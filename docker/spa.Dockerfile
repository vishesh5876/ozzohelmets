# syntax=docker/dockerfile:1.7
# Builds a Vite SPA (admin or portal) and serves it with an unprivileged nginx (:8080) that also
# proxies /api to the API.   docker build -f docker/spa.Dockerfile --build-arg APP=admin .
ARG APP=admin

FROM node:22-bookworm-slim AS build
ARG APP
ARG VITE_EMERGENCY_NUMBER=112
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true VITE_EMERGENCY_NUMBER=$VITE_EMERGENCY_NUMBER \
    VITE_APP_VERSION=$APP_VERSION VITE_GIT_SHA=$GIT_SHA
RUN corepack enable
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json .npmrc ./
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/eslint-config/package.json packages/eslint-config/
COPY packages/types/package.json packages/types/
COPY packages/ui/package.json packages/ui/
COPY packages/api-client/package.json packages/api-client/
COPY apps/${APP}/package.json apps/${APP}/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile --filter @helmet/${APP}...
COPY packages packages
COPY apps/${APP} apps/${APP}
RUN pnpm --filter @helmet/${APP} exec vite build

FROM nginxinc/nginx-unprivileged:1.27-alpine AS runtime
ARG APP
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
# Admin loads Inter from Google Fonts; the portal uses system fonts only.
ARG CSP_POLICY="default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"
ENV API_HOST_PORT=api:4000 CSP_POLICY=$CSP_POLICY
LABEL org.opencontainers.image.title="helmet-${APP}" org.opencontainers.image.version=$APP_VERSION \
      org.opencontainers.image.revision=$GIT_SHA
COPY docker/nginx/nginx.conf /etc/nginx/nginx.conf
COPY docker/nginx/spa.conf.template /etc/nginx/templates/default.conf.template
COPY docker/nginx/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY --from=build /repo/apps/${APP}/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
