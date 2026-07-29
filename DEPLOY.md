# Docker 部署指南

基于 **PaddleOCR-VL** API（`server/main.py`）与已有镜像 **`myppocr:1.0`**。

| 容器 | 镜像 | 说明 | 对外端口 |
|------|------|------|----------|
| `myppocr` | `myppocr:1.0` | PaddleOCR-VL 识别服务 | 默认不暴露 |
| `ppocr-web` | 本地构建 | Nginx 前端 + API 反向代理 | **8080 → 80** |

Nginx 转发规则：

- `/health` → OCR 健康检查
- `/api/*` → OCR API（如 `/api/recognize/image`）

---

## 快速部署（OCR 镜像已在服务器）

```bash
# 1. 确认镜像存在
docker images | grep myppocr
# myppocr   1.0   40852e5f81eb   ...

# 2. 上传前端代码到服务器
cd ppocr
cp .env.example .env

# 3. 一键启动 OCR + 前端
docker compose up -d --build

# 4. 查看状态（OCR 首次加载模型约 2–5 分钟）
docker compose ps
docker compose logs -f ocr
```

访问：`http://<服务器IP>:8080`

验证 OCR：

```bash
curl http://localhost:8080/health
# {"status":"healthy","ocr_pipeline_ready":true,"model":"PaddleOCRVL (Offline)",...}

curl -X POST http://localhost:8080/api/recognize/image -F "file=@test.jpg"
```

---

## OCR 已在运行 — 只部署前端

若 `myppocr:1.0` 容器**已经单独跑起来**，只需编排前端：

```bash
# 查看 OCR 容器名与网络
docker ps | grep myppocr
docker inspect myppocr --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'

# 创建共享网络并连接 OCR 容器
docker network create ppocr-net 2>/dev/null || true
docker network connect ppocr-net myppocr 2>/dev/null || true

# 配置 .env
cp .env.example .env
# OCR_UPSTREAM=myppocr:8000
# OCR_EXTERNAL_NETWORK=ppocr-net

# 仅启动前端
docker compose -f docker-compose.frontend.yml up -d --build
```

若 OCR 映射到宿主机 `8000` 端口：

```env
OCR_UPSTREAM=host.docker.internal:8000
```

---

## 环境变量（.env）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `OCR_IMAGE` | `myppocr:1.0` | OCR 镜像名 |
| `OCR_CONTAINER_NAME` | `myppocr` | OCR 容器名 |
| `FRONTEND_PORT` | `8080` | 前端对外端口 |
| `OCR_UPSTREAM` | `myppocr:8000` | 前端 Nginx 转发目标 |
| `OCR_EXTERNAL_NETWORK` | `ppocr-net` | 仅前端模式时的外部网络 |

---

## API 接口对照

| 前端调用 | OCR 服务 | 说明 |
|----------|----------|------|
| `GET /health` | `GET /health` | 健康检查 |
| `POST /api/recognize/image` | 同左 | 单文件识别，字段名 `file` |
| `GET /api/models/status` | 同左 | 模型状态 |

Python 调用示例见 `server/client_demo.py`。

---

## 1. 服务器准备

- Linux x86_64，Docker + Docker Compose
- 内存建议 **≥ 8GB**（PaddleOCR-VL 模型约 18GB 镜像）
- 磁盘空间充足

```bash
docker --version
docker compose version
docker images myppocr:1.0
```

---

## 2. 上传代码

```bash
git clone <仓库> ppocr && cd ppocr
# 或 scp 上传
```

---

## 3. 构建并启动

```bash
cp .env.example .env
docker compose up -d --build
```

```bash
docker compose ps
docker compose logs -f
docker compose logs -f ocr    # OCR 模型加载日志
```

---

## 4. 访问应用

```
http://<服务器IP>:8080
```

流程：上传图片/PDF → 开始 OCR 识别 → 审核字段 → 导出 JSON。

---

## 5. 常用运维命令

```bash
docker compose down
docker compose down --rmi local
docker compose build frontend && docker compose up -d frontend
git pull && docker compose up -d --build
```

---

## 6. 配置调整

### 修改对外端口

`.env` 中设置 `FRONTEND_PORT=80`，然后 `docker compose up -d`。

### 对外暴露 OCR API

在 `docker-compose.yml` 的 `ocr` 服务下添加：

```yaml
ports:
  - "8000:8000"
```

直接调用：`curl -X POST http://<IP>:8000/api/recognize/image -F "file=@a.jpg"`

### 限制上传大小

编辑 `nginx.conf.template` 中 `client_max_body_size`，重新构建 frontend。

---

## 7. 对接已有 OCR 容器（详细）

确认 OCR 接口路径与 `main.py` 一致：

- `GET /health`
- `POST /api/recognize/image`

**场景 A — OCR 映射到宿主机 8000**

```env
OCR_UPSTREAM=host.docker.internal:8000
```

```bash
docker compose -f docker-compose.frontend.yml up -d --build
```

**场景 B — 同一 Docker 网络**

```bash
docker network connect ppocr-net <ocr容器名>
```

```env
OCR_UPSTREAM=<ocr容器名>:8000
OCR_EXTERNAL_NETWORK=ppocr-net
```

验证：

```bash
curl http://localhost:8080/health
docker exec ppocr-web wget -qO- http://myppocr:8000/health
```

---

## 8. 生产环境 HTTPS（可选）

```
用户 → https://ocr.example.com
         ↓ 宿主机 Nginx (SSL)
      localhost:8080 (ppocr-web)
         ↓ /api /health
      myppocr:8000
```

---

## 9. 架构示意

```
┌─────────────┐    :8080    ┌───────────────────┐
│   浏览器     │ ──────────► │  ppocr-web (nginx) │
└─────────────┘             │  /health /api/*    │
                            └─────────┬─────────┘
                                      │ ppocr-net
                                      ▼
                            ┌───────────────────┐
                            │  myppocr:1.0       │
                            │  PaddleOCR-VL API  │
                            └───────────────────┘
```

---

## 10. 故障排查

| 现象 | 处理 |
|------|------|
| `ocr` 一直 starting | 模型加载慢，看 `docker compose logs ocr`，等 2–5 分钟 |
| `ocr_pipeline_ready: false` | 检查容器内 `./paddleocr_models/` 模型文件 |
| 前端 502 / OCR 不可用 | `docker compose ps` 确认 ocr healthy；检查 `OCR_UPSTREAM` |
| 识别超时 | Nginx 已设 600s；大 PDF 需更长时间 |
| 容器名冲突 | 改 `.env` 中 `OCR_CONTAINER_NAME` 或停掉旧容器 |

---

## 11. 手动运行（不用 compose）

```bash
# OCR（已有镜像）
docker run -d --name myppocr --network ppocr-net myppocr:1.0

# 前端
docker build -t ppocr-web .
docker run -d --name ppocr-web -p 8080:80 \
  -e OCR_UPSTREAM=myppocr:8000 \
  --network ppocr-net \
  ppocr-web
```
