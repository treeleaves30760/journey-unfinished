# syntax=docker/dockerfile:1.7
FROM node:24.18.0-trixie-slim AS build
WORKDIR /app

ENV NUXT_TELEMETRY_DISABLED=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24.18.0-trixie-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    NUXT_TELEMETRY_DISABLED=1 \
    NUXT_DATABASE_PATH=/app/data/journey-unfinished.sqlite \
    NUXT_UPLOAD_DIR=/app/data/uploads

RUN groupadd --system --gid 1001 nuxt \
    && useradd --system --uid 1001 --gid nuxt --create-home nuxt \
    && mkdir -p /app/data/uploads \
    && chown -R nuxt:nuxt /app

COPY --from=build --chown=nuxt:nuxt /app/.output ./.output

USER nuxt
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"

CMD ["node", ".output/server/index.mjs"]
