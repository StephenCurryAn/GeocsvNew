FROM node:24.11.0-bookworm-slim AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM python_runtime
USER root
WORKDIR /app/server
ENV NODE_ENV=production
COPY --from=build /usr/local/bin/node /usr/local/bin/node
RUN install -d -o geocsv -g geocsv uploads /app/python_engine/models \
    && install -d -o geocsv -g geocsv -m 0700 analysis-worker \
    && node --version
COPY --from=build --chown=geocsv:geocsv /app/server/node_modules ./node_modules
COPY --from=build --chown=geocsv:geocsv /app/server/dist ./dist
USER geocsv
CMD ["node", "dist/index.js"]
