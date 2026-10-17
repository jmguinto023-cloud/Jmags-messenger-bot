# JMAG's Messenger bot – no npm dependencies, so the image is just Node + our files.
FROM node:20-alpine
ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY prompts ./prompts
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:${PORT}/health || exit 1
CMD ["node", "src/index.js"]
