# Multi-stage build for a persistent Node process (Railway/Render/Fly.io).
# Node 24: node:sqlite is unflagged since 22.13 and stable since 24.2.
FROM node:24-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS run
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
# Railway injects PORT automatically; our code reads it.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3000
CMD ["npm", "start"]
