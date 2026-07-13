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
COPY scripts ./scripts

# Build the Levi (React/Vite) frontend into /app/web-dist, served by the server.
COPY frontend ./frontend
RUN cd frontend && npm ci && npm run build

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

# Bake the embedding model into the image from the BUILD CONTEXT — HuggingFace
# began returning 403 to anonymous file downloads (2026-07-13, broke deploys),
# so the model ships alongside the checkout (models/, gitignored but inside
# the Docker context). The prefetch script then just validates the cache.
ENV TRANSFORMERS_CACHE=/app/models
COPY models /app/models
RUN npx tsx scripts/prefetch-model.mjs

CMD ["npx", "tsx", "src/server/index.ts"]
