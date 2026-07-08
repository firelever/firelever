# FireLever Copilot server. better-sqlite3 and onnxruntime (local embeddings) need
# a glibc base with build tools, so this is the full node image, not alpine.
FROM node:22-slim

RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY web ./web

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# The embedding model downloads to this cache on first request; the volume keeps
# it and the SQLite databases across restarts.
ENV HF_HOME=/data/hf
CMD ["npx", "tsx", "src/server/index.ts"]
