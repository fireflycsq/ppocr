#!/usr/bin/env python3
"""单证标注登录与数据 API（独立于 OCR 服务）"""

from __future__ import annotations

import traceback

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from database import init_db
from label_routes import maybe_seed_default_user, router

app = FastAPI(title="PPOCR Label API", version="1.0.0")
app.include_router(router)


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


@app.get("/health")
async def health() -> dict:
    return {"status": "healthy", "service": "label-api"}
