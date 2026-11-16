FROM node:24.11.0-bookworm-slim AS build
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY server/tsconfig.json ./
COPY server/src ./src
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

FROM node:24.11.0-bookworm-slim
WORKDIR /app/server
ENV NODE_ENV=production
RUN mkdir -p uploads /app/python_engine/models && chown -R node:node uploads /app/python_engine
COPY --from=build --chown=node:node /app/server/node_modules ./node_modules
COPY --from=build --chown=node:node /app/server/dist ./dist
USER node
CMD ["node", "dist/index.js"]
