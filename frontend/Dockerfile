FROM node:26.8.1-alpine3.24 AS builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY CHANGELOG.md /app/CHANGELOG.md
RUN npm run build

FROM nginx:1.31.4-alpine3.24
COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
