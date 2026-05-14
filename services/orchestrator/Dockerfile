FROM node:20-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY services/orchestrator ./services/orchestrator
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @audio-api/orchestrator... build

FROM node:20-alpine AS runtime
USER node
WORKDIR /app
COPY --from=builder /repo/services/orchestrator/dist ./dist
COPY --from=builder /repo/services/orchestrator/package.json ./package.json
COPY --from=builder /repo/node_modules ./node_modules
COPY --from=builder /repo/packages ./packages
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
