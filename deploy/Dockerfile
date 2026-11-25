# Production image (Stage 8, D21). One image runs the API, the worker or a one-off migration, chosen by the command.
#   docker build -f deploy/Dockerfile -t dhruv-erp:$(git rev-parse --short HEAD) .
FROM node:22.11.0-bookworm-slim AS build
WORKDIR /src
RUN npm install -g pnpm@10.9.0   # not corepack: the corepack bundled with Node 22.11 rejects current npm registry signatures
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/contracts/package.json packages/contracts/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @dhruv/api build && pnpm --filter @dhruv/web build \
 && pnpm --filter @dhruv/api deploy --prod --legacy /out/api \
 && cp -r apps/api/dist apps/api/migrations /out/api/ && cp -r apps/web/dist /out/web

FROM node:22.11.0-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=4000 MIGRATIONS_DIR=/app/migrations
WORKDIR /app
RUN useradd --system --uid 10001 erp && mkdir -p /app/storage && chown erp /app/storage
COPY --from=build /out/api /app
COPY --from=build /out/web /web
USER erp
EXPOSE 4000
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:4000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
