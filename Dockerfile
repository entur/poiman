FROM oven/bun:1.3-alpine AS build
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile

COPY tsconfig.json ./
COPY src ./src
RUN bun run build

FROM oven/bun:1.3-alpine
WORKDIR /app

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

COPY --from=build /app/dist ./dist
COPY src ./src

ENV NODE_ENV=production PORT=8080
EXPOSE 8080

RUN chown -R bun:bun /app
USER bun

CMD ["bun", "src/server.ts"]
