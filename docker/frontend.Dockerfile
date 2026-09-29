FROM node:22-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

FROM nginx:1.27-alpine
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx-tls.conf /opt/nginx-tls.conf
COPY --chmod=0755 docker/40-tls.sh /docker-entrypoint.d/40-tls.sh
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 5173 5443
