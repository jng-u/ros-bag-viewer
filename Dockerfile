FROM node:22-bookworm-slim AS build

USER root
WORKDIR /workspace
ENV NODE_ENV=development

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.tests.json ./
COPY apps ./apps
COPY packages ./packages
COPY examples ./examples
COPY tests ./tests
COPY scripts ./scripts
COPY benchmarks ./benchmarks
COPY docs ./docs
COPY eslint.config.mjs vitest.config.ts ./

RUN corepack pnpm install --frozen-lockfile
RUN corepack pnpm build
RUN corepack pnpm --filter @ros-web-viewer/web build:web

FROM caddy:2.10-alpine AS runtime

COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /workspace/apps/web/dist-web /srv

EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/healthz || exit 1

CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
