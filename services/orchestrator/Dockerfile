FROM node:20-alpine AS builder
WORKDIR /repo
RUN corepack enable && corepack prepare pnpm@9.0.0 --activate
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml tsconfig.base.json ./
COPY packages ./packages
COPY services/orchestrator ./services/orchestrator
RUN pnpm install --frozen-lockfile=false
RUN pnpm --filter @audio-api/orchestrator... build
RUN pnpm --filter @audio-api/orchestrator --prod deploy /deploy

FROM node:20-alpine AS runtime
USER node
WORKDIR /app
COPY --from=builder --chown=node:node /deploy /app
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]
