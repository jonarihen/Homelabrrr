FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && apk add --no-cache putty

COPY src ./src

RUN mkdir -p /app/data

EXPOSE 3000

CMD ["node", "src/index.js"]
