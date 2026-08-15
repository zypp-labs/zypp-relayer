# ZRN API — container image (Render).
#
# Three things this file has to get right, each of which was wrong before:
#
#  1. `migrations/` ships. `migrate.ts` resolves the directory relative to its
#     own compiled location (`dist/store/` -> `../../migrations`), so the
#     runner needs it at `/app/migrations`. Without it `migrate` throws ENOENT
#     in the container and schema changes can only be applied from a laptop
#     with the repo checked out.
#  2. pnpm, not npm. The lockfile here is `pnpm-lock.yaml` (lockfileVersion
#     9.0). The old `COPY package-lock.json*` glob matched nothing and
#     `npm install` then resolved dependencies fresh, so the image could drift
#     from the versions that were tested.
#  3. Migrations run compiled. `pnpm migrate` uses tsx, a dev dependency that
#     `--prod` correctly omits; `migrate:deploy` runs `dist/store/run-migrate.js`
#     instead, so production needs no TypeScript toolchain.

FROM node:20-bookworm-slim AS base
WORKDIR /app
# Pinned rather than `pnpm@latest`: the version that installs the lockfile is
# part of what makes the build reproducible.
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Runtime dependencies only.
FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --prod --frozen-lockfile

# Full dependencies, for tsc.
FROM base AS builder
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

FROM base AS runner
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./
COPY --from=builder /app/dist ./dist
# Read at runtime by migrate.ts, so this is a real dependency of the image and
# not a convenience copy.
COPY migrations ./migrations

# The base image ships an unprivileged `node` user; nothing here needs root.
USER node

EXPOSE 3000
CMD ["node", "dist/api/index.js"]
