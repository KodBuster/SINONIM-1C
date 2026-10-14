FROM node:20-alpine

# Без CA-сертификатов HTTPS к my.advantshop.net падает с «fetch failed».
RUN apk add --no-cache ca-certificates \
  && update-ca-certificates

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY sync.mjs admin-import.mjs ./
COPY samples ./samples

CMD ["node", "sync.mjs"]
