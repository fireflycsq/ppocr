"""批量预识别任务：上传持久化、后台排队抽取、SSE 进度、JSON/ZIP 导出。"""

from __future__ import annotations

import asyncio
import json
import os
import threading
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel, Field

from database import LABEL_DATA_DIR
from llm_extract import (
    LlmExtractError,
    PageOutcome,
    build_export_payload,
    document_export_file_name,
    extract_pdf_with_llm,
)

router = APIRouter(prefix="/api/label/llm-jobs", tags=["llm-jobs"])

JOBS_DIR = LABEL_DATA_DIR / "llm_jobs"
OLLAMA_BASE = os.environ.get("OLLAMA_BASE", "http://127.0.0.1:11434")
MAX_BATCH_FILES = int(os.environ.get("LLM_JOB_MAX_FILES", "50"))
MAX_FILE_BYTES = int(os.environ.get("LLM_JOB_MAX_MB", "40")) * 1024 * 1024

_lock = threading.RLock()
_worker_thread: Optional[threading.Thread] = None
_wake = threading.Event()
_subscribers: Dict[str, Set[asyncio.Queue]] = {}
_loop: Optional[asyncio.AbstractEventLoop] = None


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _job_dir(job_id: str) -> Path:
    return JOBS_DIR / job_id


def _job_json_path(job_id: str) -> Path:
    return _job_dir(job_id) / "job.json"


def _ensure_jobs_dir() -> None:
    JOBS_DIR.mkdir(parents=True, exist_ok=True)


def _read_job(job_id: str) -> Dict[str, Any]:
    path = _job_json_path(job_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="任务不存在")
    with path.open("r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_job(job: Dict[str, Any]) -> None:
    path = _job_json_path(job["id"])
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(job, fh, ensure_ascii=False, indent=2)
    tmp.replace(path)


def _public_job(job: Dict[str, Any]) -> Dict[str, Any]:
    """返回给前端的精简状态（不含巨大 requestJson 时可按需裁剪）。"""
    docs = []
    for doc in job.get("documents", []):
        docs.append(
            {
                "id": doc["id"],
                "fileName": doc["fileName"],
                "fileSize": doc["fileSize"],
                "status": doc["status"],
                "progress": doc.get("progress") or {"done": 0, "total": 0},
                "pageOutcomes": doc.get("pageOutcomes") or [],
                "error": doc.get("error"),
                "structureType": doc.get("structureType"),
                "hasResult": bool(doc.get("resultPath")),
                "note": doc.get("note") or "",
            }
        )
    return {
        "id": job["id"],
        "createdAt": job["createdAt"],
        "updatedAt": job["updatedAt"],
        "status": job["status"],
        "templateId": job["templateId"],
        "llmModel": job.get("llmModel") or "",
        "headerFields": job.get("headerFields") or [],
        "sublistColumns": job.get("sublistColumns") or [],
        "requiredSublistKeys": job.get("requiredSublistKeys") or [],
        "documents": docs,
        "current": job.get("current"),
        "error": job.get("error"),
        "cancelRequested": bool(job.get("cancelRequested")),
    }


def _emit(job_id: str, event: str, data: Dict[str, Any]) -> None:
    payload = {"event": event, "data": data, "ts": _utc_now()}
    queues = list(_subscribers.get(job_id, set()))
    loop = _loop
    if not loop or not queues:
        return
    for queue in queues:
        try:
            loop.call_soon_threadsafe(queue.put_nowait, payload)
        except Exception:
            pass


def _update_job(job_id: str, mutator) -> Dict[str, Any]:
    with _lock:
        job = _read_job(job_id)
        mutator(job)
        job["updatedAt"] = _utc_now()
        _write_job(job)
        return job


def _find_next_job_id() -> Optional[str]:
    _ensure_jobs_dir()
    candidates: List[tuple[str, str]] = []
    for path in JOBS_DIR.iterdir():
        if not path.is_dir():
            continue
        job_path = path / "job.json"
        if not job_path.is_file():
            continue
        try:
            with job_path.open("r", encoding="utf-8") as fh:
                job = json.load(fh)
        except Exception:
            continue
        if job.get("status") in {"queued", "running"} and not job.get("cancelRequested"):
            candidates.append((job.get("createdAt") or "", job["id"]))
        elif job.get("status") == "running" and job.get("cancelRequested"):
            # 清理中断态
            job["status"] = "cancelled"
            job["updatedAt"] = _utc_now()
            _write_job(job)
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    return candidates[0][1]


def _doc_pdf_path(job: Dict[str, Any], doc: Dict[str, Any]) -> Path:
    return _job_dir(job["id"]) / "files" / doc["storedName"]


def _doc_result_path(job_id: str, doc_id: str) -> Path:
    return _job_dir(job_id) / "results" / f"{doc_id}.json"


def _process_document(job: Dict[str, Any], doc: Dict[str, Any]) -> None:
    job_id = job["id"]
    pdf_path = _doc_pdf_path(job, doc)
    if not pdf_path.is_file():
        raise LlmExtractError(f"找不到文件：{doc['fileName']}")

    def cancel_check() -> bool:
        with _lock:
            latest = _read_job(job_id)
            return bool(latest.get("cancelRequested"))

    def on_stream(page_index: int, total_pages: int, snapshot: Dict[str, Any]) -> None:
        current = {
            "docId": doc["id"],
            "fileName": doc["fileName"],
            "pageIndex": page_index,
            "totalPages": total_pages,
            "streamLabel": f"逐页抽取 · {doc['fileName']} · 第 {page_index + 1}/{total_pages} 页",
            "streamText": snapshot.get("text") or "",
        }

        def mutate(j: Dict[str, Any]) -> None:
            j["current"] = current
            for item in j["documents"]:
                if item["id"] == doc["id"]:
                    item["progress"] = {
                        "done": page_index,
                        "total": total_pages,
                    }
                    break

        _update_job(job_id, mutate)
        _emit(job_id, "stream", current)

    def on_page_done(outcome: PageOutcome, done: int, total: int) -> None:
        outcome_dict = outcome.to_dict()

        def mutate(j: Dict[str, Any]) -> None:
            for item in j["documents"]:
                if item["id"] != doc["id"]:
                    continue
                item["progress"] = {"done": done, "total": total}
                outcomes = item.get("pageOutcomes") or []
                outcomes.append(outcome_dict)
                item["pageOutcomes"] = outcomes
                break
            j["current"] = {
                "docId": doc["id"],
                "fileName": doc["fileName"],
                "pageIndex": outcome.page_index,
                "totalPages": total,
                "streamLabel": f"已完成第 {outcome.page_index + 1}/{total} 页",
                "streamText": "",
            }

        _update_job(job_id, mutate)
        _emit(
            job_id,
            "page_done",
            {
                "docId": doc["id"],
                "fileName": doc["fileName"],
                "outcome": outcome_dict,
                "done": done,
                "total": total,
            },
        )

    result = extract_pdf_with_llm(
        str(pdf_path),
        request_json=job["requestJson"],
        header_fields=job.get("headerFields") or [],
        sublist_columns=job.get("sublistColumns") or [],
        required_sublist_keys=job.get("requiredSublistKeys") or [],
        ollama_base=OLLAMA_BASE,
        on_page_done=on_page_done,
        on_stream_update=on_stream,
        cancel_check=cancel_check,
    )

    if cancel_check():
        raise LlmExtractError("已中断抽取")

    export_payload = build_export_payload(
        file_name=doc["fileName"],
        file_size=doc["fileSize"],
        structure_type=result.structure_type,
        invoices=result.invoices,
        header_fields=job.get("headerFields") or [],
        sublist_columns=job.get("sublistColumns") or [],
        layout_template_id=job.get("templateId") or "",
        llm_model=job.get("llmModel") or "",
        page_outcomes=result.page_outcomes,
        note=doc.get("note") or "",
    )
    result_path = _doc_result_path(job_id, doc["id"])
    result_path.parent.mkdir(parents=True, exist_ok=True)
    with result_path.open("w", encoding="utf-8") as fh:
        json.dump(
            {
                "exportPayload": export_payload,
                "structureType": result.structure_type,
                "invoices": [
                    {"header": inv.header, "sublist": inv.sublist}
                    for inv in result.invoices
                ],
                "pageOutcomes": [o.to_dict() for o in result.page_outcomes],
            },
            fh,
            ensure_ascii=False,
            indent=2,
        )

    def mutate_done(j: Dict[str, Any]) -> None:
        for item in j["documents"]:
            if item["id"] != doc["id"]:
                continue
            item["status"] = "done"
            item["structureType"] = result.structure_type
            item["resultPath"] = str(result_path.relative_to(_job_dir(job_id)))
            item["pageOutcomes"] = [o.to_dict() for o in result.page_outcomes]
            item["progress"] = {
                "done": len(result.page_outcomes),
                "total": len(result.page_outcomes),
            }
            item["error"] = None
            break

    _update_job(job_id, mutate_done)
    _emit(
        job_id,
        "doc_done",
        {
            "docId": doc["id"],
            "fileName": doc["fileName"],
            "structureType": result.structure_type,
            "invoiceCount": len(result.invoices),
        },
    )


def _run_job(job_id: str) -> None:
    def mark_running(j: Dict[str, Any]) -> None:
        j["status"] = "running"
        j["error"] = None

    job = _update_job(job_id, mark_running)
    _emit(job_id, "job_status", {"status": "running"})

    try:
        while True:
            with _lock:
                job = _read_job(job_id)
                if job.get("cancelRequested"):
                    job["status"] = "cancelled"
                    job["updatedAt"] = _utc_now()
                    job["current"] = None
                    _write_job(job)
                    _emit(job_id, "job_status", {"status": "cancelled"})
                    return

                next_doc = next(
                    (
                        d
                        for d in job["documents"]
                        if d["status"] in {"queued", "running"}
                    ),
                    None,
                )
                if not next_doc:
                    job["status"] = "completed"
                    job["current"] = None
                    job["updatedAt"] = _utc_now()
                    _write_job(job)
                    _emit(job_id, "job_status", {"status": "completed"})
                    return

                doc_id = next_doc["id"]

                def mark_doc_running(j: Dict[str, Any]) -> None:
                    for item in j["documents"]:
                        if item["id"] == doc_id:
                            item["status"] = "running"
                            item["error"] = None
                            item["pageOutcomes"] = []
                            item["progress"] = {"done": 0, "total": 0}
                            break
                    j["current"] = {
                        "docId": doc_id,
                        "fileName": next_doc["fileName"],
                        "pageIndex": 0,
                        "totalPages": 0,
                        "streamLabel": f"准备识别：{next_doc['fileName']}",
                        "streamText": "",
                    }

                job = _update_job(job_id, mark_doc_running)

            _emit(
                job_id,
                "doc_started",
                {"docId": doc_id, "fileName": next_doc["fileName"]},
            )

            try:
                _process_document(job, next_doc)
            except LlmExtractError as exc:
                if str(exc) == "已中断抽取" or _read_job(job_id).get("cancelRequested"):

                    def mark_cancelled(j: Dict[str, Any]) -> None:
                        j["status"] = "cancelled"
                        j["current"] = None
                        for item in j["documents"]:
                            if item["id"] == doc_id and item["status"] == "running":
                                item["status"] = "cancelled"
                                item["error"] = "已中断"
                        j["updatedAt"] = _utc_now()

                    _update_job(job_id, mark_cancelled)
                    _emit(job_id, "job_status", {"status": "cancelled"})
                    return

                def mark_doc_error(j: Dict[str, Any]) -> None:
                    for item in j["documents"]:
                        if item["id"] == doc_id:
                            item["status"] = "error"
                            item["error"] = str(exc)
                            break

                _update_job(job_id, mark_doc_error)
                _emit(
                    job_id,
                    "doc_error",
                    {
                        "docId": doc_id,
                        "fileName": next_doc["fileName"],
                        "error": str(exc),
                    },
                )
            except Exception as exc:  # noqa: BLE001

                def mark_doc_error2(j: Dict[str, Any]) -> None:
                    for item in j["documents"]:
                        if item["id"] == doc_id:
                            item["status"] = "error"
                            item["error"] = str(exc) or "抽取失败"
                            break

                _update_job(job_id, mark_doc_error2)
                _emit(
                    job_id,
                    "doc_error",
                    {
                        "docId": doc_id,
                        "fileName": next_doc["fileName"],
                        "error": str(exc) or "抽取失败",
                    },
                )
    except Exception as exc:  # noqa: BLE001

        def mark_failed(j: Dict[str, Any]) -> None:
            j["status"] = "failed"
            j["error"] = str(exc)
            j["current"] = None

        _update_job(job_id, mark_failed)
        _emit(job_id, "job_status", {"status": "failed", "error": str(exc)})


def _worker_loop() -> None:
    while True:
        job_id = _find_next_job_id()
        if not job_id:
            _wake.wait(timeout=2.0)
            _wake.clear()
            continue
        try:
            _run_job(job_id)
        except Exception as exc:  # noqa: BLE001
            try:

                def mark_failed(j: Dict[str, Any]) -> None:
                    j["status"] = "failed"
                    j["error"] = str(exc)
                    j["current"] = None

                _update_job(job_id, mark_failed)
                _emit(job_id, "job_status", {"status": "failed", "error": str(exc)})
            except Exception:
                pass
        time.sleep(0.05)


def start_llm_job_worker(loop: asyncio.AbstractEventLoop) -> None:
    global _worker_thread, _loop
    _loop = loop
    _ensure_jobs_dir()
    # 重启后把中断的 running 任务重新排队（文件仍在）
    for path in JOBS_DIR.iterdir():
        job_path = path / "job.json"
        if not job_path.is_file():
            continue
        try:
            with job_path.open("r", encoding="utf-8") as fh:
                job = json.load(fh)
            if job.get("status") == "running" and not job.get("cancelRequested"):
                for doc in job.get("documents", []):
                    if doc.get("status") == "running":
                        doc["status"] = "queued"
                        doc["pageOutcomes"] = []
                        doc["progress"] = {"done": 0, "total": 0}
                job["status"] = "queued"
                job["current"] = None
                job["updatedAt"] = _utc_now()
                _write_job(job)
        except Exception:
            continue

    if _worker_thread and _worker_thread.is_alive():
        return
    _worker_thread = threading.Thread(
        target=_worker_loop, name="llm-job-worker", daemon=True
    )
    _worker_thread.start()


def _parse_json_field(raw: str, field_name: str) -> Any:
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400, detail=f"{field_name} 不是合法 JSON：{exc}"
        ) from exc


@router.post("")
async def create_llm_job(
    files: List[UploadFile] = File(...),
    template_id: str = Form(...),
    request_json: str = Form(...),
    header_fields: str = Form(...),
    sublist_columns: str = Form(...),
    required_sublist_keys: str = Form("[]"),
    llm_model: str = Form(""),
):
    if not files:
        raise HTTPException(status_code=400, detail="请至少上传一个 PDF")
    if len(files) > MAX_BATCH_FILES:
        raise HTTPException(
            status_code=400, detail=f"单次最多上传 {MAX_BATCH_FILES} 个文件"
        )

    header_field_list = _parse_json_field(header_fields, "header_fields")
    sublist_column_list = _parse_json_field(sublist_columns, "sublist_columns")
    required_keys = _parse_json_field(required_sublist_keys, "required_sublist_keys")
    if not isinstance(header_field_list, list) or not isinstance(sublist_column_list, list):
        raise HTTPException(status_code=400, detail="字段定义格式错误")
    if not isinstance(required_keys, list):
        raise HTTPException(status_code=400, detail="required_sublist_keys 必须是数组")

    try:
        body = json.loads(request_json)
        if not isinstance(body, dict):
            raise ValueError("request_json 必须是对象")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"request_json 无效：{exc}") from exc

    job_id = f"job-{uuid.uuid4().hex[:12]}"
    job_dir = _job_dir(job_id)
    files_dir = job_dir / "files"
    files_dir.mkdir(parents=True, exist_ok=True)

    documents: List[Dict[str, Any]] = []
    used_names: Set[str] = set()
    for upload in files:
        original = upload.filename or "document.pdf"
        lower = original.lower()
        if not lower.endswith(".pdf"):
            raise HTTPException(status_code=400, detail=f"仅支持 PDF：{original}")
        content = await upload.read()
        if not content:
            raise HTTPException(status_code=400, detail=f"空文件：{original}")
        if len(content) > MAX_FILE_BYTES:
            raise HTTPException(
                status_code=400,
                detail=f"文件过大（>{MAX_FILE_BYTES // (1024 * 1024)}MB）：{original}",
            )
        if not content.startswith(b"%PDF"):
            raise HTTPException(status_code=400, detail=f"不是合法 PDF：{original}")

        base_name = original
        if base_name in used_names:
            stem = Path(original).stem
            base_name = f"{stem}-{uuid.uuid4().hex[:6]}.pdf"
        used_names.add(base_name)

        doc_id = f"doc-{uuid.uuid4().hex[:10]}"
        stored_name = f"{doc_id}.pdf"
        (files_dir / stored_name).write_bytes(content)
        documents.append(
            {
                "id": doc_id,
                "fileName": base_name,
                "fileSize": len(content),
                "storedName": stored_name,
                "status": "queued",
                "progress": {"done": 0, "total": 0},
                "pageOutcomes": [],
                "error": None,
                "note": "",
                "resultPath": None,
                "structureType": None,
            }
        )

    now = _utc_now()
    job = {
        "id": job_id,
        "createdAt": now,
        "updatedAt": now,
        "status": "queued",
        "templateId": template_id,
        "requestJson": request_json,
        "headerFields": header_field_list,
        "sublistColumns": sublist_column_list,
        "requiredSublistKeys": required_keys,
        "llmModel": llm_model or str(body.get("model") or ""),
        "documents": documents,
        "current": None,
        "error": None,
        "cancelRequested": False,
    }
    _write_job(job)
    _wake.set()
    return _public_job(job)


@router.get("/{job_id}")
async def get_llm_job(job_id: str):
    return _public_job(_read_job(job_id))


@router.get("/{job_id}/events")
async def stream_llm_job_events(job_id: str):
    _read_job(job_id)  # 404 if missing
    queue: asyncio.Queue = asyncio.Queue(maxsize=200)
    _subscribers.setdefault(job_id, set()).add(queue)

    async def event_generator():
        try:
            # 首包：当前完整状态，便于刷新后恢复
            yield _sse("snapshot", _public_job(_read_job(job_id)))
            while True:
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=15.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    # 任务结束后再推一次最终状态并结束流
                    job = _read_job(job_id)
                    if job.get("status") in {"completed", "cancelled", "failed"}:
                        yield _sse("snapshot", _public_job(job))
                        break
                    continue
                yield _sse(item["event"], item["data"])
                if item["event"] == "job_status" and item["data"].get("status") in {
                    "completed",
                    "cancelled",
                    "failed",
                }:
                    yield _sse("snapshot", _public_job(_read_job(job_id)))
                    break
        finally:
            subs = _subscribers.get(job_id)
            if subs and queue in subs:
                subs.discard(queue)
                if not subs:
                    _subscribers.pop(job_id, None)

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@router.post("/{job_id}/cancel")
async def cancel_llm_job(job_id: str):
    def mutate(j: Dict[str, Any]) -> None:
        j["cancelRequested"] = True
        if j.get("status") in {"queued", "running"}:
            # 未开始的文档标记取消
            if j.get("status") == "queued":
                j["status"] = "cancelled"
                for doc in j["documents"]:
                    if doc["status"] == "queued":
                        doc["status"] = "cancelled"
                        doc["error"] = "已中断"

    job = _update_job(job_id, mutate)
    _wake.set()
    _emit(job_id, "job_status", {"status": job["status"], "cancelRequested": True})
    return _public_job(job)


@router.get("/{job_id}/documents/{doc_id}/file")
async def get_job_document_file(job_id: str, doc_id: str):
    job = _read_job(job_id)
    doc = next((d for d in job["documents"] if d["id"] == doc_id), None)
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


@router.get("/{job_id}/documents/{doc_id}/result")
async def get_job_document_result(job_id: str, doc_id: str):
    job = _read_job(job_id)
    doc = next((d for d in job["documents"] if d["id"] == doc_id), None)
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")
    result_path = _doc_result_path(job_id, doc_id)
    if not result_path.is_file():
        raise HTTPException(status_code=404, detail="尚未生成识别结果")
    with result_path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    return data


class DocumentPatch(BaseModel):
    note: Optional[str] = None
    export_payload: Optional[Dict[str, Any]] = Field(default=None, alias="exportPayload")

    model_config = {"populate_by_name": True}


@router.patch("/{job_id}/documents/{doc_id}")
async def patch_job_document(job_id: str, doc_id: str, body: DocumentPatch):
    result_path = _doc_result_path(job_id, doc_id)
    if not result_path.is_file():
        raise HTTPException(status_code=404, detail="尚未生成识别结果")

    with result_path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)

    def mutate(j: Dict[str, Any]) -> None:
        for doc in j["documents"]:
            if doc["id"] != doc_id:
                continue
            if body.note is not None:
                doc["note"] = body.note
            break

    job = _update_job(job_id, mutate)

    if body.export_payload is not None:
        data["exportPayload"] = body.export_payload
    elif body.note is not None:
        payload = data.get("exportPayload") or {}
        payload["note"] = body.note
        data["exportPayload"] = payload

    with result_path.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)

    return {"ok": True, "document": next(d for d in job["documents"] if d["id"] == doc_id)}


@router.get("/{job_id}/export.zip")
async def export_job_zip(job_id: str):
    job = _read_job(job_id)
    result_files = []
    for doc in job["documents"]:
        path = _doc_result_path(job_id, doc["id"])
        if path.is_file():
            result_files.append((doc, path))
    if not result_files:
        raise HTTPException(status_code=400, detail="没有可导出的识别结果")

    zip_path = _job_dir(job_id) / "export.zip"
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        used: Set[str] = set()
        for doc, path in result_files:
            with path.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            payload = data.get("exportPayload") or data
            name = document_export_file_name(doc["fileName"])
            if name in used:
                stem = Path(name).stem
                name = f"{stem}-{doc['id'][:6]}.json"
            used.add(name)
            zf.writestr(name, json.dumps(payload, ensure_ascii=False, indent=2))

    return FileResponse(
        zip_path,
        media_type="application/zip",
        filename=f"llm-results-{job_id}.zip",
    )


@router.get("/{job_id}/documents/{doc_id}/export.json")
async def export_job_document_json(job_id: str, doc_id: str):
    job = _read_job(job_id)
    doc = next((d for d in job["documents"] if d["id"] == doc_id), None)
    if not doc:
        raise HTTPException(status_code=404, detail="文档不存在")
    path = _doc_result_path(job_id, doc_id)
    if not path.is_file():
        raise HTTPException(status_code=404, detail="尚未生成识别结果")
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    payload = data.get("exportPayload") or data
    export_name = document_export_file_name(doc["fileName"])
    tmp = _job_dir(job_id) / export_name
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
    return FileResponse(tmp, media_type="application/json", filename=export_name)
