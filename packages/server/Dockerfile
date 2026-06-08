# ===========================
# Build stage
# ===========================
FROM node:20-alpine AS builder

WORKDIR /app

# Install native build dependencies for better-sqlite3 and pnpm.
RUN apk add --no-cache python3 make g++ && \
    npm install -g pnpm@latest && \
    rm -rf /root/.npm

# Copy workspace configuration files.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY scripts ./scripts
COPY packages/shared/package.json ./packages/shared/
COPY packages/core/package.json ./packages/core/
COPY packages/server/package.json ./packages/server/

# Install dependencies, including dev dependencies required for builds.
RUN pnpm install --frozen-lockfile && \
    pnpm store prune

# Copy source code and build artifacts.
COPY packages/shared ./packages/shared
COPY packages/core ./packages/core
COPY packages/server ./packages/server

# Build all required packages.
WORKDIR /app/packages/core
RUN pnpm build

WORKDIR /app/packages/shared
RUN pnpm build

WORKDIR /app/packages/server
RUN pnpm build && \
    rm -rf node_modules/.cache

# ===========================
# Production stage
# ===========================
FROM node:20-alpine AS production

# Install PM2, curl, runtime libraries for better-sqlite3, and pm2-logrotate.
RUN apk add --no-cache curl libstdc++ && \
    npm install -g pm2 pm2-logrotate --no-scripts && \
    pm2 install pm2-logrotate && \
    pm2 set pm2-logrotate:max_size 100M && \
    pm2 set pm2-logrotate:retain 5 && \
    pm2 set pm2-logrotate:compress true && \
    pm2 set pm2-logrotate:rotateInterval '0 0 * * *'

WORKDIR /app

# Copy the core package used by workspace dependencies.
COPY --from=builder /app/packages/core ./packages/core

# Copy production dependencies and pnpm's root virtual store used by workspace symlinks.
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/packages/server/node_modules ./packages/server/node_modules

# Copy the server bundle from the build stage.
COPY --from=builder /app/packages/server/dist ./packages/server/dist
# Copy locally prebuilt UI assets into the same directory.
COPY packages/ui/dist/. ./packages/server/dist/

# Copy PM2 configuration.
COPY packages/server/ecosystem.config.cjs /app/

# Create log and data directories.
RUN mkdir -p /root/.claude-code-router/logs /root/.claude-code-router/data

# Expose the server port.
EXPOSE 3456

# Health check.
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
    CMD curl -f http://127.0.0.1:3456/health || exit 1

# Start the application.
CMD ["pm2-runtime", "start", "/app/ecosystem.config.cjs"]
