FROM node:20-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

# Install Playwright system dependencies + Chromium browser
RUN npx playwright install --with-deps chromium

COPY . .

EXPOSE 5000

CMD ["node", "index.js"]
