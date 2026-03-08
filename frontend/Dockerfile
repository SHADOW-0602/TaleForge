# Build stage
FROM node:20-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .
RUN npm run build

# Production stage
RUN npm install -g serve
EXPOSE 8080
CMD serve -s dist -l tcp://0.0.0.0:${PORT:-8080}
