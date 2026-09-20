# 文档抽取 API

将「上传 PDF → 按版式逐页视觉抽取 → 跨页聚合」封装为 HTTP 接口，供其他系统对接。调用方只需提交 PDF 和版式 ID，服务端使用内置提示词与字段定义，无需前端页面。

交互式 Swagger 文档在网页顶部导航 **接口文档** 中打开，也可直接访问：

| 环境 | 地址 |
|------|------|
| 本地前端 | `http://localhost:5173/` → 点击「接口文档」 |
| 本地 label-api | `http://localhost:8001/api/v1/docs` |
| Docker 生产 | `http://<服务器IP>:8080/` → 点击「接口文档」 |

## 服务地址

| 环境 | Base URL | 说明 |
|------|----------|------|
| 本地开发 | `http://localhost:8001` | `npm run dev:label` |
| 经前端代理 | `http://localhost:5173` | Vite 将 `/api/v1` 转到 8001 |
| Docker 生产 | `http://<服务器IP>:8080` | Nginx 反代到 label-api |

依赖：label-api 进程，以及可达的 Ollama（默认模型 `qwen3-vl:4b`，环境变量 `OLLAMA_BASE` / `EXTRACT_LLM_MODEL`）。

## 鉴权

默认不校验。若部署时设置了环境变量 `EXTRACT_API_KEY`，所有 `/api/v1/*` 请求必须带：

```http
X-API-Key: <EXTRACT_API_KEY>
```

缺失或错误时返回 `401`：

```json
{"detail": "无效的 API Key"}
```

## 调用流程

```
POST /api/v1/extract          → 202 { id, status: "queued", documents: [...] }
GET  /api/v1/jobs/{id}        → 轮询 status（queued → running → completed）
GET  /api/v1/jobs/{id}/result → 结构化抽取结果
```

多页 PDF 的视觉抽取通常需要数分钟。也可在提交时加 `wait=true`，服务端阻塞直到结束（最长约 1700 秒，可用 `EXTRACT_SYNC_TIMEOUT` 调整）。

任务状态：`queued` | `running` | `completed` | `cancelled` | `failed`。

文档状态：`queued` | `running` | `done` | `error` | `cancelled`。

---

## 接口一览

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/v1/health` | 抽取服务健康检查 |
| GET | `/api/v1/templates` | 列出内置版式与输出字段 |
| GET | `/api/v1/templates/{template_id}` | 版式详情 |
| POST | `/api/v1/extract` | 上传 PDF，创建抽取任务 |
| GET | `/api/v1/jobs/{job_id}` | 查询任务进度 |
| GET | `/api/v1/jobs/{job_id}/result` | 获取抽取结果 |
| GET | `/api/v1/jobs/{job_id}/events` | SSE 实时进度 |
| POST | `/api/v1/jobs/{job_id}/cancel` | 取消任务 |
| GET | `/api/v1/jobs/{job_id}/export.zip` | 下载全部结果 ZIP |
| GET | `/api/v1/jobs/{job_id}/documents/{doc_id}/result` | 单份文档结果 |
| GET | `/api/v1/jobs/{job_id}/documents/{doc_id}/file` | 下载原始 PDF |

---

## GET `/api/v1/health`

```json
{
  "status": "healthy",
  "service": "document-extract-api",
  "auth_required": false,
  "templates": ["air_waybill", "air_waybill_dhl", "freight_invoice"]
}
```

## GET `/api/v1/templates`

返回内置版式。当前三种：

| template_id | 名称 | 发票头字段 | 明细字段 |
|-------------|------|------------|----------|
| `air_waybill` | 空运单（FedEx） | `invoice_no`, `invoice_date` | `air_waybill_number`, `total` |
| `air_waybill_dhl` | 空运单（DHL） | `invoice_no`, `invoice_date` | `air_waybill_number`, `total` |
| `freight_invoice` | 货运发票（GEODIS） | `invoice_no`, `invoice_date`, `packages`, `volume`, `weight`, `terms`, `incoterm`, `supplier`, `vessel_voyage_imo`, `house_bill_of_lading`, `total_hkd` | `description`, `charges_in_hkd` |

响应节选：

```json
{
  "templates": [
    {
      "id": "air_waybill",
      "name": "空运单版式（FedEx）",
      "description": "发票号码、发票日期 + 空中运输单编号 / 收费（INVOICE 發票双语发票）",
      "header_fields": [
        {"key": "invoice_no", "label": "发票号码"},
        {"key": "invoice_date", "label": "发票日期"}
      ],
      "sublist_columns": [
        {"key": "air_waybill_number", "label": "空中运输单编号（Air Waybill Number）"},
        {"key": "total", "label": "收费（Total）"}
      ],
      "required_sublist_keys": ["air_waybill_number"],
      "output_shape": {
        "structure_type": "invoice_with_sublist | multi_invoice | multi_invoice_with_sublist | single",
        "invoice": {"invoice_no": "string", "invoice_date": "string"},
        "sublist": [{"air_waybill_number": "string", "total": "string"}]
      }
    }
  ]
}
```

未知 `template_id` 返回 `400`。

## POST `/api/v1/extract`

`multipart/form-data`。成功默认 **202 Accepted**。

### 表单字段

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `files` | file | 是 | 一个或多个 PDF，字段名必须为 `files`。单文件默认上限 40MB，单次最多 50 个（`LLM_JOB_MAX_MB` / `LLM_JOB_MAX_FILES`） |
| `template_id` | string | 是 | 见上表 |
| `llm_model` | string | 否 | 覆盖默认 Ollama 模型名 |

### Query

| 参数 | 默认 | 说明 |
|------|------|------|
| `wait` | `false` | `true` 时阻塞到任务结束，成功返回 200 并附带结果；超时仍返回 202，并带 `timed_out: true` |

### 请求示例

```bash
curl -X POST "http://localhost:8001/api/v1/extract" \
  -H "X-API-Key: $EXTRACT_API_KEY" \
  -F "template_id=air_waybill" \
  -F "files=@/path/to/fedex-invoice.pdf"
```

同步等待：

```bash
curl -X POST "http://localhost:8001/api/v1/extract?wait=true" \
  -F "template_id=air_waybill" \
  -F "files=@/path/to/fedex-invoice.pdf"
```

批量：

```bash
curl -X POST "http://localhost:8001/api/v1/extract" \
  -F "template_id=air_waybill_dhl" \
  -F "files=@dhl-1.pdf" \
  -F "files=@dhl-2.pdf"
```

### 202 响应

```json
{
  "id": "job-a1b2c3d4e5f6",
  "status": "queued",
  "template_id": "air_waybill",
  "llm_model": "qwen3-vl:4b",
  "created_at": "2026-09-14T07:12:00.000000+00:00",
  "updated_at": "2026-09-14T07:12:00.000000+00:00",
  "error": null,
  "cancel_requested": false,
  "current": null,
  "documents": [
    {
      "id": "doc-9f8e7d6c5b",
      "file_name": "fedex-invoice.pdf",
      "file_size": 184320,
      "status": "queued",
      "progress": {"done": 0, "total": 0},
      "error": null,
      "structure_type": null,
      "has_result": false
    }
  ]
}
```

### 错误

| HTTP | 原因 |
|------|------|
| 400 | 非 PDF、空文件、超大小/数量、未知版式 |
| 401 | API Key 无效 |
| 422 | 缺少 `files` 或 `template_id` |

## GET `/api/v1/jobs/{job_id}`

查询进度。`include_results=true` 时，已完成的文档会附带抽取字段。

```bash
curl "http://localhost:8001/api/v1/jobs/job-a1b2c3d4e5f6"
curl "http://localhost:8001/api/v1/jobs/job-a1b2c3d4e5f6?include_results=true"
```

`current` 表示正在处理的页：

```json
{
  "current": {
    "document_id": "doc-9f8e7d6c5b",
    "file_name": "fedex-invoice.pdf",
    "page_index": 1,
    "total_pages": 3,
    "label": "逐页抽取 · fedex-invoice.pdf · 第 2/3 页"
  }
}
```

任务不存在返回 `404`。

## GET `/api/v1/jobs/{job_id}/result`

完整结果。任务尚未结束时仍返回当前已完成部分，并带 `"partial": true`。

FedEx / DHL 空运单典型结构（`structure_type = invoice_with_sublist`）：

```json
{
  "id": "job-a1b2c3d4e5f6",
  "status": "completed",
  "template_id": "air_waybill",
  "llm_model": "qwen3-vl:4b",
  "documents": [
    {
      "id": "doc-9f8e7d6c5b",
      "file_name": "fedex-invoice.pdf",
      "status": "done",
      "structure_type": "invoice_with_sublist",
      "has_result": true,
      "invoice": {
        "invoice_no": "9-522-83357",
        "invoice_date": "13 Nov 2025"
      },
      "sublist": [
        {"air_waybill_number": "444760470550", "total": "21.38"},
        {"air_waybill_number": "444760472792", "total": "17.09"}
      ],
      "extraction": {
        "engine": "ollama/qwen3-vl:4b",
        "layoutTemplateId": "air_waybill",
        "totalPages": 3,
        "targetPages": [2, 3],
        "skippedPages": [1],
        "errorPages": []
      },
      "page_outcomes": [
        {"page": 1, "status": "skipped", "error": null},
        {"page": 2, "status": "target", "error": null},
        {"page": 3, "status": "target", "error": null}
      ]
    }
  ]
}
```

`structure_type` 与结果字段对应关系：

| structure_type | 结果字段 |
|----------------|----------|
| `invoice_with_sublist` | `invoice`（对象）+ `sublist`（数组） |
| `multi_invoice` | `invoices`（发票头对象数组） |
| `multi_invoice_with_sublist` | `invoices_with_sublist`: `[{ "invoice", "sublist" }]` |
| `single` | `fields`（对象） |

封面、汇总页会被跳过（`skipped`），不进入明细。空运单跨页时，明细会按发票号聚合到同一张发票。

## GET `/api/v1/jobs/{job_id}/events`

`text/event-stream`。用于实时进度，轮询可忽略此接口。

事件名：`snapshot`、`job_status`、`doc_started`、`stream`、`page_done`、`doc_done`、`doc_error`。

```javascript
const source = new EventSource("http://localhost:8001/api/v1/jobs/job-xxx/events");
source.addEventListener("job_status", (ev) => {
  const data = JSON.parse(ev.data);
  if (["completed", "failed", "cancelled"].includes(data.status)) source.close();
});
```

注意：若启用了 `EXTRACT_API_KEY`，浏览器 `EventSource` 无法自定义 Header，请改用轮询或带 query/cookie 的网关。

## POST `/api/v1/jobs/{job_id}/cancel`

取消排队或正在运行的任务。

```bash
curl -X POST "http://localhost:8001/api/v1/jobs/job-a1b2c3d4e5f6/cancel"
```

## GET `/api/v1/jobs/{job_id}/export.zip`

打包已完成文档的 JSON（与页面「导出」同结构）。没有可导出结果时返回 `400`。

```bash
curl -L "http://localhost:8001/api/v1/jobs/job-a1b2c3d4e5f6/export.zip" -o results.zip
```

---

## Python 示例

```python
import time
import requests

BASE = "http://localhost:8001"
headers = {}  # 若配置了 EXTRACT_API_KEY：{"X-API-Key": "..."}

with open("fedex-invoice.pdf", "rb") as f:
    created = requests.post(
        f"{BASE}/api/v1/extract",
        headers=headers,
        files={"files": ("fedex-invoice.pdf", f, "application/pdf")},
        data={"template_id": "air_waybill"},
        timeout=120,
    )
created.raise_for_status()
job_id = created.json()["id"]

while True:
    job = requests.get(f"{BASE}/api/v1/jobs/{job_id}", headers=headers, timeout=30).json()
    if job["status"] in {"completed", "cancelled", "failed"}:
        break
    time.sleep(2)

result = requests.get(f"{BASE}/api/v1/jobs/{job_id}/result", headers=headers, timeout=60).json()
print(result["documents"][0]["invoice"])
print(result["documents"][0]["sublist"])
```

仓库内完整脚本：[`server/extract_client_demo.py`](./server/extract_client_demo.py)

```bash
cd server
python3 extract_client_demo.py /path/to/invoice.pdf air_waybill
```

## 环境变量

| 变量 | 默认 | 说明 |
|------|------|------|
| `OLLAMA_BASE` | `http://127.0.0.1:11434` | Ollama 地址 |
| `EXTRACT_LLM_MODEL` | `qwen3-vl:4b` | 默认视觉模型 |
| `EXTRACT_API_KEY` | 空 | 非空则启用 `X-API-Key` |
| `EXTRACT_SYNC_TIMEOUT` | `1700` | `wait=true` 最长等待秒数 |
| `LLM_JOB_MAX_FILES` | `50` | 单次最多 PDF 数 |
| `LLM_JOB_MAX_MB` | `40` | 单个 PDF 上限（MB） |
| `LABEL_DATA_DIR` | `./data/label_data` | 任务与结果落盘目录 |

## 与页面内部接口的区别

前端预识别仍使用 `/api/label/llm-jobs`（需自行提交提示词 JSON）。`/api/v1` 面向系统集成：版式、字段和提示词由服务端内置，调用方只传 PDF 和 `template_id`。
