FROM node:24.11.0-bookworm-slim AS build
WORKDIR /app/client
COPY client/package.json client/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY client/ ./
ARG VITE_PROTOMAPS_API_KEY
ENV VITE_PROTOMAPS_API_KEY=$VITE_PROTOMAPS_API_KEY
RUN npm run build

FROM nginx:1.28-alpine
COPY deploy/docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html
