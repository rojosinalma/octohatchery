# syntax=docker/dockerfile:1
FROM oven/bun:1.4.3-alpine AS deps
WORKDIR /deps
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile

# Development: the project is bind-mounted at /app; node_modules comes from a named volume
# seeded from this layer, so a dependency change means rebuilding the image.
FROM oven/bun:1.4.3-alpine AS dev
RUN apk add --no-cache bash=5.3.9-r1 docker-cli=29.8.2-r1 git=2.54.0-r0
WORKDIR /app
COPY --from=deps /deps/node_modules /app/node_modules
ENV NODE_ENV=development
EXPOSE 3000
CMD ["bun", "--watch", "src/index.ts"]

FROM oven/bun:1.4.3-alpine AS prod-deps
WORKDIR /deps
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.4.3-alpine AS prod
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /deps/node_modules ./node_modules
COPY package.json bunfig.toml tsconfig.json ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown -R bun:bun /app
USER 1000:1000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD ["bun", "-e", "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "src/index.ts"]
