# syntax=docker/dockerfile:1

FROM node:24-alpine AS base
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml .npmrc ./
COPY apps/worker/package.json apps/worker/package.json
COPY packages/shared/package.json packages/shared/package.json
COPY packages/db/package.json packages/db/package.json
RUN pnpm install --frozen-lockfile --trust-lockfile --filter "@tower-of-habit/worker..."

FROM deps AS build
COPY tsconfig.base.json ./
COPY apps/worker apps/worker
COPY packages/shared packages/shared
COPY packages/db packages/db
RUN pnpm --filter @tower-of-habit/worker build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
COPY --from=build /app/packages/shared/src ./packages/shared/src
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/db/src ./packages/db/src
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/db/node_modules ./packages/db/node_modules
CMD ["node", "apps/worker/dist/index.js"]
