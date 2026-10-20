# JMAG's Messenger bot. web-push is the only production dependency.
FROM node:20-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY prompts ./prompts
COPY knowledge ./knowledge
COPY public ./public
# Catch missing runtime files during build, before serving Messenger webhooks.
RUN node -e "require('./src/index')"
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "src/index.js"]
