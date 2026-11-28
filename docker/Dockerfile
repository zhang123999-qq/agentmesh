# syntax=docker/dockerfile:1.7

# ---------------------------------------------------------------- build stage
FROM node:22-bookworm-slim AS build
WORKDIR /app

RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/
COPY packages/protocol/package.json packages/protocol/
COPY packages/store/package.json packages/store/
COPY packages/core/package.json packages/core/
COPY packages/sdk/package.json packages/sdk/
COPY packages/adapters/package.json packages/adapters/
COPY packages/mock-agents/package.json packages/mock-agents/
COPY apps/web/package.json apps/web/
COPY apps/cli/package.json apps/cli/

RUN npm ci --include=dev

COPY . .
RUN npm run build
RUN npm prune --omit=dev

# -------------------------------------------------------------- runtime stage
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8787 \
    HOST=0.0.0.0 \
    DB_PATH=/app/data/agentmesh.db

WORKDIR /app

RUN groupadd --system app \
 && useradd --system --gid app --uid 10001 --create-home app \
 && mkdir -p /app/data \
 && chown -R app:app /app \
 && chmod 700 /app/data

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules

COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist

COPY --from=build /app/packages/protocol/package.json ./packages/protocol/package.json
COPY --from=build /app/packages/protocol/dist ./packages/protocol/dist
COPY --from=build /app/packages/store/package.json ./packages/store/package.json
COPY --from=build /app/packages/store/dist ./packages/store/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist

COPY docker/entrypoint.sh /usr/local/bin/agentmesh-entrypoint
COPY docker/backup.sh /usr/local/bin/agentmesh-backup
RUN chmod 0755 /usr/local/bin/agentmesh-entrypoint /usr/local/bin/agentmesh-backup \
 && chown -R app:app /app/data \
 && chmod 700 /app/data

# The server itself runs as `app` (see entrypoint.sh, which starts as root
# only to read the 600 Docker secret, then drops privileges with runuser).
# Do NOT add `USER app` here: the entrypoint must start as root.

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["agentmesh-entrypoint"]
CMD ["node", "apps/server/dist/index.js"]
