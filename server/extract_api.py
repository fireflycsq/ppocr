"""对外文档抽取 API：上传 PDF + 版式 ID，返回结构化发票/运单字段。"""

from __future__ import annotations

import asyncio
import json
import os
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, File, Form, Header, HTTPException, Query, UploadFile
from fastapi.responses import FileResponse, JSONResponse

from extract_templates import (
    DEFAULT_LLM_MODEL,
    UnknownTemplateError,
    build_request_json,
    get_template,
    list_templates,
    public_template,
    resolve_llm_model,
)
from llm_jobs import (
    _doc_pdf_path,
    _doc_result_path,
    _read_job,
    cancel_llm_job,
    create_stored_job,
    export_job_zip,
    stream_llm_job_events,
)

router = APIRouter(prefix="/api/v1", tags=["extract-api"])

EXTRACT_API_KEY = os.environ.get("EXTRACT_API_KEY", "").strip()
SYNC_WAIT_TIMEOUT = float(os.environ.get("EXTRACT_SYNC_TIMEOUT", "1700"))
TERMINAL_STATUSES = {"completed", "cancelled", "failed"}


async def require_api_key(
    x_api_key: Optional[str] = Header(default=None, alias="X-API-Key"),
) -> None:
    if not EXTRACT_API_KEY:
        return
    if (x_api_key or "").strip() != EXTRACT_API_KEY:
        raise HTTPException(status_code=401, detail="无效的 API Key")


def _http_unknown_template(exc: UnknownTemplateError) -> HTTPException:
    return HTTPException(status_code=400, detail=str(exc))


def _load_doc_result(job_id: str, doc_id: str) -> Optional[Dict[str, Any]]:
    path = _doc_result_path(job_id, doc_id)
    if not path.is_file():
        return None
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _flatten_export_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    structure = payload.get("structureType") or "single"
    result: Dict[str, Any] = {
        "structure_type": structure,
        "extraction": payload.get("extraction") or {},
        "note": payload.get("note") or "",
    }
    if structure == "multi_invoice":
        result["invoices"] = payload.get("invoices") or []
    elif structure == "multi_invoice_with_sublist":
        result["invoices_with_sublist"] = [
            {
                "invoice": item.get("invoice") or {},
                "sublist": item.get("sublist") or [],
            }
            for item in (payload.get("invoicesWithSublist") or [])
            if isinstance(item, dict)
        ]
    elif structure == "invoice_with_sublist":
        result["invoice"] = payload.get("invoice") or {}
        result["sublist"] = payload.get("sublist") or []
    else:
        result["fields"] = payload.get("fields") or {}
    return result


def _public_document(
    job: Dict[str, Any],
    doc: Dict[str, Any],
    *,
    include_result: bool,
) -> Dict[str, Any]:
    item: Dict[str, Any] = {
        "id": doc["id"],
        "file_name": doc.get("fileName"),
        "file_size": doc.get("fileSize"),
        "status": doc.get("status"),
        "progress": doc.get("progress") or {"done": 0, "total": 0},
        "error": doc.get("error"),
        "structure_type": doc.get("structureType"),
        "has_result": bool(doc.get("resultPath")),
    }
    if not include_result:
        return item

    raw = _load_doc_result(job["id"], doc["id"])
    if not raw:
        return item

    payload = raw.get("exportPayload") or {}
    item.update(_flatten_export_payload(payload))
    item["page_outcomes"] = [
        {
            "page": (outcome.get("pageIndex") or 0) + 1,
            "status": outcome.get("status"),
            "error": outcome.get("error"),
        }
        for outcome in (raw.get("pageOutcomes") or [])
        if isinstance(outcome, dict)
    ]
    return item


def public_job(job: Dict[str, Any], *, include_results: bool = False) -> Dict[str, Any]:
    current = job.get("current") or None
    current_out = None
    if isinstance(current, dict):
        current_out = {
            "document_id": current.get("docId"),
            "file_name": current.get("fileName"),
            "page_index": current.get("pageIndex"),
            "total_pages": current.get("totalPages"),
            "label": current.get("streamLabel"),
        }
    return {
        "id": job["id"],
        "status": job.get("status"),
        "template_id": job.get("templateId"),
        "llm_model": job.get("llmModel") or "",
        "created_at": job.get("createdAt"),
        "updated_at": job.get("updatedAt"),
        "error": job.get("error"),
        "cancel_requested": bool(job.get("cancelRequested")),
        "current": current_out,
        "documents": [
            _public_document(job, doc, include_result=include_results)
            for doc in job.get("documents") or []
        ],
    }


async def _wait_for_job(job_id: str, timeout: float) -> Dict[str, Any]:
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        job = _read_job(job_id)
        if job.get("status") in TERMINAL_STATUSES:
            return job
        if asyncio.get_event_loop().time() >= deadline:
            return job
        await asyncio.sleep(0.4)


@router.get("/health")
async def extract_health(_auth: None = Depends(require_api_key)) -> Dict[str, Any]:
    return {
        "status": "healthy",
        "service": "document-extract-api",
        "auth_required": bool(EXTRACT_API_KEY),
        "templates": [item["id"] for item in list_templates()],
        "default_llm_model": DEFAULT_LLM_MODEL,
    }


@router.get("/templates")
async def get_templates(_auth: None = Depends(require_api_key)) -> Dict[str, Any]:
    return {"templates": [public_template(item) for item in list_templates()]}


@router.get("/templates/{template_id}")
async def get_template_detail(
    template_id: str,
    _auth: None = Depends(require_api_key),
) -> Dict[str, Any]:
    try:
        template = get_template(template_id)
    except UnknownTemplateError as exc:
        raise _http_unknown_template(exc) from exc
    return public_template(template)


@router.post("/extract", status_code=202)
async def create_extract_job(
    files: List[UploadFile] = File(..., description="一个或多个 PDF 文件"),
    template_id: str = Form(
        ...,
        description="版式 ID：air_waybill / air_waybill_dhl / freight_invoice",
    ),
    llm_model: Optional[str] = Form(
        None,
        description="可选。Ollama 模型名；不传则使用默认 qwen3.8:latest",
    ),
    wait: bool = Query(
        False,
        description="true 时阻塞直到任务结束（或超时），并返回完整抽取结果",
    ),
    _auth: None = Depends(require_api_key),
):
    try:
        template = get_template(template_id)
    except UnknownTemplateError as exc:
        raise _http_unknown_template(exc) from exc

    file_items: List[tuple[str, bytes]] = []
    for upload in files:
        file_items.append((upload.filename or "document.pdf", await upload.read()))

    model = resolve_llm_model(llm_model)
    job = create_stored_job(
        file_items=file_items,
        template_id=template["id"],
        request_json=build_request_json(template["id"], model),
        header_fields=list(template["header_fields"]),
        sublist_columns=list(template["sublist_columns"]),
        required_sublist_keys=list(template["required_sublist_keys"]),
        llm_model=model,
    )

    if wait:
        job = await _wait_for_job(job["id"], SYNC_WAIT_TIMEOUT)
        finished = job.get("status") in TERMINAL_STATUSES
        payload = public_job(job, include_results=True)
        if not finished:
            payload["timed_out"] = True
        return JSONResponse(
            status_code=200 if finished else 202,
            content=payload,
        )

    return JSONResponse(status_code=202, content=public_job(job))


@router.get("/jobs/{job_id}")
async def get_extract_job(
    job_id: str,
    include_results: bool = Query(False, description="true 时附带已完成文档的抽取结果"),
    _auth: None = Depends(require_api_key),
):
    return public_job(_read_job(job_id), include_results=include_results)


@router.get("/jobs/{job_id}/events")
async def stream_extract_job_events(
    job_id: str,
    _auth: None = Depends(require_api_key),
):
    return await stream_llm_job_events(job_id)


@router.post("/jobs/{job_id}/cancel")
async def cancel_extract_job(
    job_id: str,
    _auth: None = Depends(require_api_key),
):
    await cancel_llm_job(job_id)
    return public_job(_read_job(job_id))


@router.get("/jobs/{job_id}/result")
async def get_extract_job_result(
    job_id: str,
    _auth: None = Depends(require_api_key),
):
    job = _read_job(job_id)
    payload = public_job(job, include_results=True)
    if job.get("status") not in TERMINAL_STATUSES:
        payload["partial"] = True
    return payload


@router.get("/jobs/{job_id}/export.zip")
async def download_extract_zip(
    job_id: str,
    _auth: None = Depends(require_api_key),
):
    return await export_job_zip(job_id)


@router.get("/jobs/{job_id}/documents/{doc_id}/result")
async def get_extract_document_result(
    job_id: str,
    doc_id: str,
    _auth: None = Depends(require_api_key),
):
    job = _read_job(job_id)
    doc = next((item for item in job.get("documents") or [] if item["id"] == doc_id), None)
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")
    item = _public_document(job, doc, include_result=True)
    if not item.get("has_result"):
        raise HTTPException(status_code=404, detail="尚未生成识别结果")
    return item


@router.get("/jobs/{job_id}/documents/{doc_id}/file")
async def get_extract_document_file(
    job_id: str,
    doc_id: str,
    _auth: None = Depends(require_api_key),
):
    job = _read_job(job_id)
    doc = next((item for item in job.get("documents") or [] if item["id"] == doc_id), None)
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")
    path = _doc_pdf_path(job, doc)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件已丢失")
    return FileResponse(
        path,
        media_type="application/pdf",
        filename=doc["fileName"],
    )
