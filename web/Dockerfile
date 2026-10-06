# Сборка из корня репозитория (docker-compose: context: .): редактору нужен общий с сервером модуль server/src/shared
FROM node:22-alpine AS build
WORKDIR /repo/web
COPY web/package.json ./
RUN npm install
COPY web/ ./
COPY server/src/shared /repo/server/src/shared
RUN npm run build

FROM nginx:1.27-alpine
COPY --from=build /repo/web/dist /usr/share/nginx/html
COPY web/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
