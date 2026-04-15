FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build
RUN cd templates/express-server && npm ci --omit=dev

# -------------------------------------------------------
FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/templates ./templates   # <-- thêm dòng này

EXPOSE 3001

CMD ["node", "dist/main"]
