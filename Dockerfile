# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./

RUN pnpm install --frozen-lockfile

FROM deps AS build
WORKDIR /app

COPY . .

RUN pnpm run build

FROM deps AS prod-deps
WORKDIR /app

RUN pnpm prune --prod

FROM node:22-bookworm-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV CORDN_STORAGE_BACKEND=memory

RUN corepack enable \
  && groupadd --system cordn \
  && useradd --system --gid cordn --home-dir /app cordn \
  && mkdir -p /data \
  && chown -R cordn:cordn /data /app

COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY --from=build /app/dist ./dist

USER cordn

VOLUME ["/data"]

CMD ["node", "./dist/main.js"]
