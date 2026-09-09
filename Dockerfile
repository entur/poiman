FROM oven/bun:1.3-alpine AS build
WORKDIR /app

COPY package.json bun.lock* ./
# preinstall refuses any installer but bun; it needs the script present.
COPY scripts ./scripts
# Production deps only: bun's bundler is built into the runtime, and the client
# build pulls nothing from devDependencies, so this doubles as the runtime
# node_modules copied into the distroless stage below.
RUN bun install --frozen-lockfile --production

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

# Local-development target (docker-compose builds this). Alpine keeps a shell
# for compose's `sh -c` watcher command; the distroless prod stage has none.
# Source is bind-mounted at runtime; the baked node_modules is used as-is.
FROM oven/bun:1.3-alpine AS dev
WORKDIR /app
COPY package.json bun.lock* ./
COPY scripts ./scripts
RUN bun install --frozen-lockfile
EXPOSE 8080

FROM oven/bun:1.3-distroless
WORKDIR /app

ENV NODE_ENV=production PORT=8080

COPY --from=build --chown=nonroot:nonroot /app/node_modules ./node_modules
COPY --from=build --chown=nonroot:nonroot /app/dist ./dist
COPY --chown=nonroot:nonroot package.json ./
COPY --chown=nonroot:nonroot src ./src

EXPOSE 8080
USER nonroot

# Base image ENTRYPOINT is ["bun"]; pass the server entry as its argument.
CMD ["src/server/server.ts"]
