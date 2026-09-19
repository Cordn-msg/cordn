# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN corepack enable

# Workspace member manifests must exist for the frozen-lockfile install to
# resolve every importer (the runtime deps of @cordn/server live in
# packages/server, not the root).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/coordinator/package.json packages/coordinator/
COPY packages/server/package.json packages/server/
COPY packages/cli/package.json packages/cli/
COPY packages/test-utils/package.json packages/test-utils/

RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app

COPY . .

RUN pnpm run build

FROM deps AS prod-deps
WORKDIR /app

# ponytail: --legacy deploy (workspace doesn't use injected deps). Hoists the
# server's direct prod deps — including better-sqlite3 and @scure/base, which
# the external-packages bundle in dist/main.js imports via inlined @cordn/* code.
RUN pnpm deploy --filter=@cordn/server --prod --legacy /app/deployed

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV CORDN_STORAGE_BACKEND=memory

RUN groupadd --system cordn \
  && useradd --system --gid cordn --home-dir /app cordn \
  && mkdir -p /data \
  && chown -R cordn:cordn /data /app

COPY --from=prod-deps /app/deployed/node_modules ./node_modules
# package.json marks the module type ("type": "module") for dist/main.js
COPY package.json ./
COPY --from=build /app/dist ./dist

USER cordn

VOLUME ["/data"]

CMD ["node", "./dist/main.js"]
