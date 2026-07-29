"""用户登录与标注数据 API"""

from __future__ import annotations

import os
import json
import re
import uuid
from pathlib import Path
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from auth_utils import create_access_token, decode_access_token, hash_password, verify_password
from database import (
    count_users,
    create_llm_example,
    create_user,
    delete_llm_example,
    delete_label_batch,
    get_llm_example,
    get_label_batch,
    get_user_by_id,
    get_user_by_username,
    list_llm_examples,
    LABEL_DATA_DIR,
    save_label_batch,
)

router = APIRouter(tags=["label-auth"])

REGISTER_ENABLED = os.environ.get("LABEL_ALLOW_REGISTER", "true").lower() in {
    "1",
    "true",
    "yes",
}
EXAMPLE_DIR = LABEL_DATA_DIR / "examples"
MAX_EXAMPLE_BYTES = int(os.environ.get("LABEL_EXAMPLE_MAX_MB", "25")) * 1024 * 1024
LAYOUT_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SAMPLE_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}


def _media_type_from_name(name: str) -> str:
    ext = Path(name).suffix.lower()
    return "pdf" if ext == ".pdf" else "image"


def _detect_sample_type(filename: str, content: bytes) -> tuple[str, str, str]:
    """返回 (media_type, 存储后缀, Content-Type)。"""
    lower = filename.lower()
    if content.startswith(b"%PDF") or lower.endswith(".pdf"):
        return "pdf", ".pdf", "application/pdf"
    if content.startswith(b"\xff\xd8\xff") or lower.endswith((".jpg", ".jpeg")):
        return "image", ".jpg", "image/jpeg"
    if content.startswith(b"\x89PNG\r\n\x1a\n") or lower.endswith(".png"):
        return "image", ".png", "image/png"
    if (
        len(content) >= 12
        and content[:4] == b"RIFF"
        and content[8:12] == b"WEBP"
    ) or lower.endswith(".webp"):
        return "image", ".webp", "image/webp"
    raise HTTPException(
        status_code=400,
        detail="样例文件必须是 PDF 或 JPEG/PNG/WebP 图片",
    )


class RegisterRequest(BaseModel):
    username: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=6, max_length=128)


class LoginRequest(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=128)


class BatchPayload(BaseModel):
    batch: Dict[str, Any]


def _extract_bearer(authorization: Optional[str]) -> str:
    if not authorization:
        raise HTTPException(status_code=401, detail="未登录")
    parts = authorization.split(" ", 1)
    if len(parts) != 2 or parts[0].lower() != "bearer":
        raise HTTPException(status_code=401, detail="无效的认证头")
    return parts[1].strip()


def get_current_user(authorization: Optional[str] = Header(default=None)) -> Dict[str, Any]:
    token = _extract_bearer(authorization)
    payload = decode_access_token(token)
    if not payload or "sub" not in payload:
        raise HTTPException(status_code=401, detail="登录已过期，请重新登录")

    user_id = int(payload["sub"])
    user = get_user_by_id(user_id)
    if not user:
        raise HTTPException(status_code=401, detail="用户不存在")
    return user


def maybe_seed_default_user() -> None:
    if count_users() > 0:
        return
    username = os.environ.get("LABEL_DEFAULT_USER", "admin").strip()
    password = os.environ.get("LABEL_DEFAULT_PASSWORD", "admin123").strip()
    if not username or not password:
        return
    create_user(username, hash_password(password))


@router.get("/api/auth/status")
def auth_status() -> Dict[str, Any]:
    return {
        "enabled": True,
        "register_enabled": REGISTER_ENABLED,
    }


@router.post("/api/auth/register")
def register(body: RegisterRequest) -> Dict[str, Any]:
    if not REGISTER_ENABLED:
        raise HTTPException(status_code=403, detail="系统未开放注册")

    username = body.username.strip()
    try:
        if get_user_by_username(username):
            raise HTTPException(status_code=409, detail="用户名已存在")

        user = create_user(username, hash_password(body.password))
        token = create_access_token(user["id"], user["username"])
        return {
            "token": token,
            "user": {"id": user["id"], "username": user["username"]},
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"注册失败: {exc}") from exc


@router.post("/api/auth/login")
def login(body: LoginRequest) -> Dict[str, Any]:
    try:
        user = get_user_by_username(body.username)
        if not user or not verify_password(body.password, user["password_hash"]):
            raise HTTPException(status_code=401, detail="用户名或密码错误")

        token = create_access_token(user["id"], user["username"])
        return {
            "token": token,
            "user": {"id": user["id"], "username": user["username"]},
        }
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"登录失败: {exc}") from exc


@router.get("/api/auth/me")
def me(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    return {"id": user["id"], "username": user["username"]}


@router.get("/api/label/batch")
def load_batch(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    stored = get_label_batch(user["id"])
    if not stored:
        return {"batch": None, "updated_at": None}
    return stored


@router.put("/api/label/batch")
def upsert_batch(
    body: BatchPayload,
    user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    updated_at = save_label_batch(user["id"], body.batch)
    return {"ok": True, "updated_at": updated_at}


@router.delete("/api/label/batch")
def remove_batch(user: Dict[str, Any] = Depends(get_current_user)) -> Dict[str, Any]:
    delete_label_batch(user["id"])
    return {"ok": True}


def _public_example(example: Dict[str, Any]) -> Dict[str, Any]:
    media_type = _media_type_from_name(example["file_name"])
    return {
        key: value
        for key, value in example.items()
        if key != "pdf_path"
    } | {
        "media_type": media_type,
        "pdf_url": f"/api/label/examples/{example['id']}/pdf",
    }


@router.get("/api/label/examples")
def load_examples(
    layout_template_id: Optional[str] = None,
    _user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    if layout_template_id and not LAYOUT_ID_RE.fullmatch(layout_template_id):
        raise HTTPException(status_code=400, detail="无效的版式 ID")
    return {
        "examples": [
            _public_example(item)
            for item in list_llm_examples(layout_template_id)
        ]
    }


@router.post("/api/label/examples")
async def upload_example(
    layout_template_id: str = Form(...),
    category: str = Form(...),
    answer_json: str = Form(...),
    sample: UploadFile = File(...),
    user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    if not LAYOUT_ID_RE.fullmatch(layout_template_id):
        raise HTTPException(status_code=400, detail="无效的版式 ID")
    if category not in {"target", "non_target"}:
        raise HTTPException(status_code=400, detail="样例类别必须是 target 或 non_target")
    if not sample.filename:
        raise HTTPException(status_code=400, detail="请选择样例文件")
    try:
        answer = json.loads(answer_json)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"答案不是合法 JSON: {exc}") from exc
    if not isinstance(answer, dict):
        raise HTTPException(status_code=400, detail="答案 JSON 必须是对象")
    if category == "target" and not answer:
        raise HTTPException(status_code=400, detail="目标样例必须提供答案")

    content = await sample.read(MAX_EXAMPLE_BYTES + 1)
    if len(content) > MAX_EXAMPLE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"样例文件不能超过 {MAX_EXAMPLE_BYTES // 1024 // 1024} MB",
        )
    _media_type, ext, _mime = _detect_sample_type(sample.filename, content)

    EXAMPLE_DIR.mkdir(parents=True, exist_ok=True)
    stored_name = f"{uuid.uuid4().hex}{ext}"
    stored_path = EXAMPLE_DIR / stored_name
    try:
        stored_path.write_bytes(content)
        example = create_llm_example(
            layout_template_id=layout_template_id,
            file_name=Path(sample.filename).name,
            file_size=len(content),
            pdf_path=str(stored_path),
            category=category,
            answer=answer,
            created_by=int(user["id"]),
        )
    except Exception:
        stored_path.unlink(missing_ok=True)
        raise
    return {"example": _public_example(example)}


@router.get("/api/label/examples/{example_id}/pdf")
def download_example_pdf(
    example_id: int,
    _user: Dict[str, Any] = Depends(get_current_user),
):
    example = get_llm_example(example_id)
    if not example:
        raise HTTPException(status_code=404, detail="样例不存在")
    path = Path(example["pdf_path"])
    if not path.is_file():
        raise HTTPException(status_code=404, detail="样例文件不存在")
    media_type = _media_type_from_name(example["file_name"])
    mime = "application/pdf"
    if media_type == "image":
        ext = path.suffix.lower()
        mime = {
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".png": "image/png",
            ".webp": "image/webp",
        }.get(ext, "application/octet-stream")
    return FileResponse(path, media_type=mime, filename=example["file_name"])


@router.delete("/api/label/examples/{example_id}")
def remove_example(
    example_id: int,
    _user: Dict[str, Any] = Depends(get_current_user),
) -> Dict[str, Any]:
    example = delete_llm_example(example_id)
    if not example:
        raise HTTPException(status_code=404, detail="样例不存在")
    Path(example["pdf_path"]).unlink(missing_ok=True)
    return {"ok": True}
