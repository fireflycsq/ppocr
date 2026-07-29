# 多阶段构建：Node 编译 + Nginx 静态托管
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY index.html vite.config.ts tsconfig.json tsconfig.node.json ./
COPY src ./src
COPY public ./public

RUN npm run build

FROM nginx:1.27-alpine

RUN apk add --no-cache gettext

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
# 从 Windows/Mac 拉代码时可能带 CRLF，会导致 exec: no such file or directory
RUN sed -i 's/\r$//' /docker-entrypoint.sh && chmod +x /docker-entrypoint.sh
COPY --from=builder /app/dist /usr/share/nginx/html

ENV OCR_UPSTREAM=ocr:8000
ENV LABEL_UPSTREAM=label-api:8001

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD wget -qO- http://127.0.0.1/ > /dev/null || exit 1

ENTRYPOINT ["/docker-entrypoint.sh"]
