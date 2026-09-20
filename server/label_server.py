#!/usr/bin/env python3
"""单证标注登录与数据 API（独立于 OCR 服务）"""

from __future__ import annotations

import asyncio
import traceback

from fastapi import FastAPI, Request
from fastapi.openapi.utils import get_openapi
from fastapi.responses import JSONResponse, RedirectResponse

from database import init_db
from extract_api import router as extract_router
from label_routes import maybe_seed_default_user, router
from llm_jobs import router as llm_jobs_router, start_llm_job_worker

EXTRACT_API_DESCRIPTION = """
上传 PDF 和版式 ID，异步抽取发票头与明细。

**调用顺序：** `POST /api/v1/extract` → 轮询 `GET /api/v1/jobs/{id}` → `GET /api/v1/jobs/{id}/result`

**内置版式：** `air_waybill`（FedEx）、`air_waybill_dhl`（DHL）、`freight_invoice`（GEODIS）

**默认模型：** `qwen3.8:latest`。调用 `POST /api/v1/extract` 时可传表单字段 `llm_model` 覆盖。

若部署时配置了 `EXTRACT_API_KEY`，请点击右上角 **Authorize**，填入 `X-API-Key`。
"""

app = FastAPI(
    title="文档抽取 API",
    version="1.0.0",
    description=EXTRACT_API_DESCRIPTION,
    docs_url="/api/v1/docs",
    redoc_url="/api/v1/redoc",
    openapi_url="/api/v1/openapi.json",
    swagger_ui_parameters={"persistAuthorization": True, "docExpansion": "list"},
)
app.include_router(router, include_in_schema=False)
app.include_router(llm_jobs_router, include_in_schema=False)
app.include_router(extract_router)


def custom_openapi():
    if app.openapi_schema:
        return app.openapi_schema
    schema = get_openapi(
        title=app.title,
        version=app.version,
        description=app.description,
        routes=app.routes,
    )
    schema["paths"] = {
        path: item
        for path, item in schema.get("paths", {}).items()
        if path.startswith("/api/v1")
    }
    schema["servers"] = [{"url": "/", "description": "当前站点"}]
    schema.setdefault("components", {}).setdefault("securitySchemes", {})["ApiKeyAuth"] = {
        "type": "apiKey",
        "in": "header",
        "name": "X-API-Key",
    }
    app.openapi_schema = schema
    return app.openapi_schema


app.openapi = custom_openapi


@app.get("/docs", include_in_schema=False)
async def docs_redirect() -> RedirectResponse:
    return RedirectResponse(url="/api/v1/docs")


@app.get("/redoc", include_in_schema=False)
async def redoc_redirect() -> RedirectResponse:
    return RedirectResponse(url="/api/v1/redoc")


@app.get("/openapi.json", include_in_schema=False)
async def openapi_redirect() -> RedirectResponse:
    return RedirectResponse(url="/api/v1/openapi.json")


@app.exception_handler(Exception)
async def unhandled_exception(_request: Request, exc: Exception):
    traceback.print_exc()
    return JSONResponse(status_code=500, content={"detail": f"服务器错误: {exc}"})


@app.on_event("startup")
async def startup() -> None:
    init_db()
    try:
        maybe_seed_default_user()
        print("✓ 标注 API 已启动，默认用户已就绪")
    except Exception as exc:
        print(f"⚠ 默认用户创建失败（{exc}）")
    try:
        start_llm_job_worker(asyncio.get_running_loop())
        print("✓ 预识别批量任务队列已启动")
    except Exception as exc:
        print(f"⚠ 预识别任务队列启动失败（{exc}）")


@app.get("/health")
async def health() -> dict:
    return {"status": "healthy", "service": "label-api"}
