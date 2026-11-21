FROM node:24-bookworm-slim AS api
WORKDIR /app
COPY --chown=node:node platform/package.json platform/package-lock.json platform/
RUN --mount=type=secret,id=npm_ca \
    if [ -f /run/secrets/npm_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npm_ca; fi; \
    npm ci --prefix platform --omit=dev --no-audit --no-fund --fetch-retries=0 \
    && npm cache clean --force
COPY --chown=node:node platform/*.mjs platform/
COPY --chown=node:node worker/public/assets/places-search.json.gz worker/public/assets/
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8788
EXPOSE 8788
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=35s CMD ["node", "/app/platform/healthcheck.mjs"]
CMD ["node", "/app/platform/server.mjs"]

FROM api AS renderer
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium fonts-liberation fonts-noto-core \
    && rm -rf /var/lib/apt/lists/*
ENV SIFRIC_CHROMIUM=/usr/bin/chromium
USER node
