FROM node:20-bookworm-slim AS build

WORKDIR /app
COPY . .
RUN npm ci
RUN npm run typecheck && npm test && npm run build
RUN npm prune --omit=dev

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
  PORT=8080 \
  MAC_MINER_DB_PATH=/data/mac-miner.sqlite \
  MAC_MINER_WEB_ROOT=/app/dist/web
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
VOLUME ["/data"]
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))"
CMD ["node", "dist/server/server/index.js"]
