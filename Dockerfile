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

# Bake the embedding model into the image at build time — no runtime download,
# deterministic cold starts, works even if HuggingFace is unreachable.
ENV TRANSFORMERS_CACHE=/app/models
RUN npx tsx scripts/prefetch-model.mjs

CMD ["npx", "tsx", "src/server/index.ts"]
