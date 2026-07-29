# 挂载部署说明

## 容器内没有 /app 怎么办？

**正常。** 镜像里可以没有任何业务目录；`volumes` 挂载时会**自动创建**容器内路径。

路径需与 `main.py` 一致：

- `main.py` → `${OCR_CONTAINER_WORKDIR}/main.py`（宿主机 `server/` 整目录挂到工作目录）
- 模型 → `/models`（宿主机 `paddleocr_models/`，PaddleOCR 可能写入缓存，勿挂只读）
- 上传/输出 → `/data/temp_uploads`、`/data/output`

**不需要额外的 `code/` 子目录**；之前加 `code/` 只是为了避免误把代码挂到镜像原有的 `/app` 上把环境覆盖掉。

默认用 `/workspace`（不是 `/app`），可在 `.env` 里改。

查镜像默认配置：

```bash
docker inspect myppocr:1.0 --format 'Workdir={{.Config.WorkingDir}}'
docker inspect myppocr:1.0 --format 'Cmd={{.Config.Cmd}}'
```

若镜像 CMD 已能启动服务，可删掉 compose 里的 `command` 段，只保留 volumes。

---

# 服务器目录结构

镜像 `myppocr:1.0` 只提供 Python 运行环境，**代码和模型通过 volumes 挂载**。

```
/opt/ppocr/
├── docker-compose.yml
├── .env
├── server/
│   └── main.py                  # → 容器 /workspace/main.py
├── paddleocr_models/            # → 容器 /models
│   ├── vl_rec/
│   ├── layout_det/
│   └── doc_orientation/
└── data/
    ├── temp_uploads/
    └── output/
```

## 部署步骤

```bash
# 1. 准备目录和文件
mkdir -p server data/temp_uploads data/output paddleocr_models
cp /path/to/main.py server/
# 将模型拷入 paddleocr_models/

# 2. 配置 .env
cp .env.example .env
# 确认 OCR_SERVER_DIR、OCR_MODELS_DIR 路径正确

# 3. 启动
docker compose up -d

# 4. 验证挂载
docker exec myppocr ls -la /app/main.py
docker exec myppocr ls /app/paddleocr_models
curl http://localhost:8080/health
```

## .env 挂载配置示例

```env
OCR_SERVER_DIR=./server
OCR_MODELS_DIR=./paddleocr_models
OCR_TEMP_DIR=./data/temp_uploads
OCR_OUTPUT_DIR=./data/output
```

模型与代码在服务器其他绝对路径时：

```env
OCR_SERVER_DIR=/data/ppocr/server
OCR_MODELS_DIR=/data/ppocr/paddleocr_models
```

## 常见问题

| 问题 | 处理 |
|------|------|
| 健康检查很快失败 / 容器反复重启 | **不要把 `./server` 挂到 `/app`**，会覆盖镜像内环境；已改为挂到 `/app/code` |
| compose 有没有执行 main.py | **不会自动执行**；靠镜像 `CMD` 或 compose 的 `command` 启动 uvicorn |
| 模型加载失败 | 检查 `paddleocr_models` 三个子目录 |
| 找不到 main.py | 确认 `server/main.py` 存在，且 `PYTHONPATH=/app/code` |
| 权限错误 / mkdir 失败 | 确认 `data/temp_uploads`、`data/output` 存在；模型挂到 `/models`（可写），勿再挂到只读 `/workspace` 子路径 |
