# Single-stage image. We run TypeScript directly with tsx (same as `npm run
# server`), so dev deps must stay installed — do NOT use --omit=dev here, tsx
# lives in devDependencies. better-sqlite3 is a native module: it is compiled
# inside this Linux image, so the binary matches the container arch (not your
# Windows dev machine).
FROM node:22-bookworm-slim

# Build toolchain for better-sqlite3's native addon (used only if no prebuilt
# binary is available for this platform/node version).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json package-lock.json ./
RUN npm ci

# App source.
COPY . .

ENV NODE_ENV=production
# orders.db lives on the mounted volume, not the ephemeral container fs.
ENV ORDER_DB_PATH=/data/orders.db

EXPOSE 4021

CMD ["npx", "tsx", "src/server.ts"]
