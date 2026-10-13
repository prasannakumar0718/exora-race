# Production Dockerfile for Exora Race Authoritative Multiplayer Server
FROM node:20-alpine AS runner

WORKDIR /app

# Set production environment
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Copy application files
COPY package.json ./
COPY server.js ./
COPY index.html ./

# Expose HTTP / WebSocket port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:8080/health || exit 1

# Start authoritative server
CMD ["node", "server.js"]
