# OCR 预识别审核系统

完整流程：**上传图片/PDF → PaddleOCR-VL 识别 → 展示文本与检测框 → 配置字段 → 采纳/不采纳 → 导出 JSON**

后端 API 基于 `server/main.py`（PaddleOCR-VL），调用方式见 `server/client_demo.py`。

## 本地开发

```bash
# 终端 1：启动 PaddleOCR-VL API（或使用已运行的 myppocr 容器映射 8000）
cd server
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python main.py

# 终端 2：前端
npm install
npm run dev
```

浏览器打开 http://localhost:5173/

## Docker 部署（生产）

OCR 使用服务器上已构建的镜像 **`myppocr:1.0`**，详见 **[DEPLOY.md](./DEPLOY.md)**。

### 方式一：OCR + 前端一起编排（推荐首次部署）

镜像不含代码/模型时，需先准备挂载目录，见 **[MOUNT.md](./MOUNT.md)**。

```bash
cp .env.example .env   # 按实际路径修改 OCR_SERVER_DIR、OCR_MODELS_DIR
docker compose up -d --build
```

访问 `http://<服务器IP>:8080`

### 方式二：OCR 已在运行，只部署前端

```bash
# 确保 OCR 容器与前端在同一 Docker 网络
docker network create ppocr-net 2>/dev/null || true
docker network connect ppocr-net myppocr 2>/dev/null || true

cp .env.example .env
docker compose -f docker-compose.frontend.yml up -d --build
```

## API 接口（PaddleOCR-VL）

| 接口 | 说明 |
|------|------|
| `GET /health` | 健康检查 |
| `GET /api/models/status` | 模型状态 |
| `POST /api/recognize/image` | 单图/PDF 识别（字段名 `file`） |
| `POST /api/recognize/batch` | 批量识别（字段名 `files`） |

调用示例：

```bash
curl http://localhost:8000/health
curl -X POST http://localhost:8000/api/recognize/image -F "file=@test.jpg"
```

Python 示例见 `server/client_demo.py`。

## 导出 JSON 结构

```json
{
  "exportedAt": "2026-06-19T12:00:00.000Z",
  "sourceFile": "document.pdf",
  "ocrEngine": "PaddleOCR-VL",
  "fields": { "name": "张三" },
  "adopted": [...],
  "rejected": [...],
  "ocrRaw": [...]
}
```
