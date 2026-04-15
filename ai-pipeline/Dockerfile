FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .
RUN npm run build

# -------------------------------------------------------
# Đổi từ alpine sang slim (Debian)
FROM node:20-slim

# Cài Chrome + git
RUN apt-get update && apt-get install -y \
    git \
    chromium \
    fonts-freefont-ttf \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Báo cho Puppeteer dùng Chromium đã cài thay vì tự download
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src ./src
COPY --from=builder /app/templates ./templates   

EXPOSE 3001

CMD ["node", "dist/main"]
