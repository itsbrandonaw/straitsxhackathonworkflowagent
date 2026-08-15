FROM public.ecr.aws/docker/library/node:22-slim AS build

WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@10.14.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/agentcore ./apps/agentcore
COPY packages/aws ./packages/aws
COPY packages/contracts ./packages/contracts
COPY packages/core ./packages/core
COPY packages/runtime ./packages/runtime

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @happy/agentcore... build
RUN pnpm --filter @happy/agentcore deploy --legacy --prod /opt/happy-agentcore

FROM public.ecr.aws/docker/library/node:22-slim AS runtime

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=8080

WORKDIR /app
COPY --from=build --chown=1000:1000 /opt/happy-agentcore/ ./

USER 1000:1000
EXPOSE 8080
CMD ["node", "dist/server.js"]
