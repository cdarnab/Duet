FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server ./server
COPY shared ./shared
COPY web ./web
COPY agent ./agent
COPY extension ./extension
COPY scripts ./scripts
RUN apk add --no-cache zip \
  && node scripts/build-extension.js \
  && cp /app/duet-extension.zip /app/web/duet-extension.zip

ENV PORT=8080 HOST=0.0.0.0
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD wget -qO- http://127.0.0.1:8080/health || exit 1

USER node
CMD ["node", "server/index.js"]
