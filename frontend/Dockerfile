FROM node:24.17.0-alpine3.24 AS builder

WORKDIR /app/frontend
COPY frontend/package*.json ./
RUN npm ci
COPY frontend/ ./
COPY CHANGELOG.md /app/CHANGELOG.md
RUN npm run build

FROM nginx:1.30.4-alpine3.24
COPY --from=builder /app/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
