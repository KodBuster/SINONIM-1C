FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY sync.mjs admin-import.mjs ./
COPY samples ./samples

CMD ["node", "sync.mjs"]
