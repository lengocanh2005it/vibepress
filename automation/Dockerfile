FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

RUN apt-get update && apt-get install -y git ca-certificates --no-install-recommends && rm -rf /var/lib/apt/lists/*

# Install Playwright system dependencies + Chromium browser
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 5000

CMD ["node", "index.js"]
