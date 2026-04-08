FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

ARG VITE_BACKEND_URL=/api
ARG VITE_BACKEND_AI_URL=/ai-api
ARG VITE_WP_URL=""

ENV VITE_BACKEND_URL=$VITE_BACKEND_URL
ENV VITE_BACKEND_AI_URL=$VITE_BACKEND_AI_URL
ENV VITE_WP_URL=$VITE_WP_URL

RUN npm run build

# -------------------------------------------------------
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
