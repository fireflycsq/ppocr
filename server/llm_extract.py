"""Qwen3-VL 逐页抽取：PDF 渲染 → Ollama 流式请求 → 跨页聚合。

逻辑与前端 src/utils/llmExtraction.ts / src/api/llm.ts 对齐，供后台批量任务使用。
"""

from __future__ import annotations

import base64
import io
import json
import re
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, Iterable, List, Optional, Set, Tuple

import httpx
from PIL import Image

try:
    import pypdfium2 as pdfium
except ImportError:  # pragma: no cover
    pdfium = None  # type: ignore

PAGE_IMAGE_PLACEHOLDER = "{{PAGE_IMAGE}}"
MAX_DIMENSION = 1600
JPEG_QUALITY = 75


StreamCallback = Callable[[Dict[str, Any]], None]
CancelCheck = Callable[[], bool]


class LlmExtractError(Exception):
    def __init__(self, message: str, raw_content: Optional[str] = None):
        super().__init__(message)
        self.raw_content = raw_content


@dataclass
class PageImage:
    page_index: int
    base64: str
    width: int
    height: int


@dataclass
class PageOutcome:
    page_index: int
    status: str  # target | skipped | error
    error: Optional[str] = None
    raw: Optional[str] = None

    def to_dict(self) -> Dict[str, Any]:
        data: Dict[str, Any] = {
            "pageIndex": self.page_index,
            "status": self.status,
        }
        if self.error:
            data["error"] = self.error
        if self.raw is not None:
            data["raw"] = self.raw
        return data


@dataclass
class AggregatedInvoice:
    header: Dict[str, str] = field(default_factory=dict)
    sublist: List[Dict[str, str]] = field(default_factory=list)


@dataclass
class PdfExtractionResult:
    structure_type: str
    invoices: List[AggregatedInvoice]
    page_outcomes: List[PageOutcome]


def _coerce_value(value: Any) -> str:
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, (int, float, bool)):
        return str(value)
    return ""


def _coerce_record(raw: Dict[str, Any], allowed_keys: Set[str]) -> Dict[str, str]:
    return {key: _coerce_value(raw.get(key)) for key in allowed_keys}


def _has_values(record: Dict[str, str]) -> bool:
    return any(v for v in record.values())


def _as_record(value: Any) -> Dict[str, Any]:
    if isinstance(value, dict):
        return value
    return {}


def _as_record_array(value: Any) -> List[Dict[str, Any]]:
    if not isinstance(value, list):
        return []
    return [_as_record(item) for item in value if isinstance(item, dict) and item]


def extract_json_text(content: str) -> str:
    text = content.strip()
    fenced = re.search(r"```(?:json)?\s*([\s\S]*?)```", text, flags=re.IGNORECASE)
    if fenced:
        text = fenced.group(1).strip()
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        text = text[start : end + 1]
    return text


def normalize_extraction(parsed: Any) -> Dict[str, Any]:
    root = _as_record(parsed)
    invoices_raw = root.get("invoices") if isinstance(root.get("invoices"), list) else []
    return {
        "is_target": root.get("is_target") is True or root.get("is_target") == "true",
        "invoices": [
            {
                "header": _as_record(_as_record(item).get("header")),
                "sublist": _as_record_array(_as_record(item).get("sublist")),
            }
            for item in invoices_raw
        ],
        "orphan_sublist": _as_record_array(root.get("orphan_sublist")),
    }


def normalize_ollama_chat_body(body: Dict[str, Any]) -> Dict[str, Any]:
    raw_opts = body.get("options")
    options: Dict[str, Any] = (
        dict(raw_opts) if isinstance(raw_opts, dict) else {}
    )
    options.pop("think", None)
    num_predict = options.get("num_predict")
    if not isinstance(num_predict, (int, float)) or num_predict < 1024:
        options["num_predict"] = 4096
    if not isinstance(options.get("num_ctx"), (int, float)):
        options["num_ctx"] = 8192
    if "temperature" not in options:
        options["temperature"] = 0
    if "repeat_penalty" not in options:
        options["repeat_penalty"] = 1.12
    result = dict(body)
    result["think"] = False
    result["options"] = options
    result["stream"] = True
    return result


def sanitize_extract_messages(body: Dict[str, Any]) -> Dict[str, Any]:
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        return body
    system_msg = None
    last_user = None
    for msg in messages:
        if not isinstance(msg, dict):
            continue
        role = msg.get("role")
        if role == "system" and system_msg is None:
            system_msg = msg
        if role == "user":
            last_user = msg
    if not last_user:
        return body
    sanitized: List[Dict[str, Any]] = []
    if system_msg:
        sanitized.append(dict(system_msg))
    sanitized.append(dict(last_user))
    result = dict(body)
    result["messages"] = sanitized
    return result


def _replace_placeholder(value: Any, image_base64: str) -> Tuple[Any, bool]:
    if isinstance(value, str):
        if value == PAGE_IMAGE_PLACEHOLDER:
            return image_base64, True
        return value, False
    if isinstance(value, list):
        replaced = False
        next_list = []
        for item in value:
            new_item, did = _replace_placeholder(item, image_base64)
            replaced = replaced or did
            next_list.append(new_item)
        return next_list, replaced
    if isinstance(value, dict):
        replaced = False
        next_dict: Dict[str, Any] = {}
        for key, item in value.items():
            new_item, did = _replace_placeholder(item, image_base64)
            replaced = replaced or did
            next_dict[key] = new_item
        return next_dict, replaced
    return value, False


def loads_json_lenient(text: str) -> Any:
    """兼容前端配置：标准 JSON，并自动去掉对象/数组末尾多余逗号。"""
    current = text.strip()
    last_error: Optional[json.JSONDecodeError] = None
    for _ in range(8):
        try:
            return json.loads(current)
        except json.JSONDecodeError as exc:
            last_error = exc
            fixed = re.sub(r",\s*([}\]])", r"\1", current)
            if fixed == current:
                break
            current = fixed
    if last_error:
        raise last_error
    raise json.JSONDecodeError("JSON 无效", text, 0)


def build_page_request_body(
    request_json: str, image_base64: str
) -> Dict[str, Any]:
    try:
        body = loads_json_lenient(request_json)
    except json.JSONDecodeError as exc:
        raise LlmExtractError(f"请求 JSON 无效：{exc}") from exc
    if not isinstance(body, dict):
        raise LlmExtractError("请求 JSON 必须是对象")

    sanitized = sanitize_extract_messages(body)
    value, replaced = _replace_placeholder(sanitized, image_base64)
    result = normalize_ollama_chat_body(value)  # type: ignore[arg-type]

    if not replaced:
        messages = result.get("messages")
        if not isinstance(messages, list) or not messages:
            raise LlmExtractError("请求 JSON 缺少 messages")
        last = messages[-1]
        if not isinstance(last, dict):
            raise LlmExtractError("最后一条 message 无效")
        images = last.get("images")
        image_list = list(images) if isinstance(images, list) else []
        image_list.append(image_base64)
        last["images"] = image_list
    return result


def render_pdf_pages(pdf_path: str) -> List[PageImage]:
    if pdfium is None:
        raise LlmExtractError("缺少 pypdfium2，无法在服务端渲染 PDF")

    pdf = pdfium.PdfDocument(pdf_path)
    images: List[PageImage] = []
    try:
        for page_index in range(len(pdf)):
            page = pdf[page_index]
            width = float(page.get_width())
            height = float(page.get_height())
            scale = min(2.5, MAX_DIMENSION / max(width, height, 1.0))
            bitmap = page.render(scale=scale)
            pil_image: Image.Image = bitmap.to_pil().convert("RGB")
            buffer = io.BytesIO()
            pil_image.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
            images.append(
                PageImage(
                    page_index=page_index,
                    base64=base64.b64encode(buffer.getvalue()).decode("ascii"),
                    width=pil_image.width,
                    height=pil_image.height,
                )
            )
    finally:
        pdf.close()
    return images


def _append_stream_delta(accumulated: str, delta: str) -> str:
    if not delta:
        return accumulated
    if (
        accumulated
        and len(delta) >= len(accumulated)
        and delta.startswith(accumulated)
    ):
        return delta
    return accumulated + delta


def _is_complete_extract_json(text: str) -> bool:
    candidate = extract_json_text(text.strip())
    if not candidate.startswith("{"):
        return False
    try:
        parsed = json.loads(candidate)
    except json.JSONDecodeError:
        return False
    return isinstance(parsed, dict) and (
        "is_target" in parsed or isinstance(parsed.get("invoices"), list)
    )


def _try_recover_json_from_thinking(thinking: str) -> Optional[str]:
    candidate = extract_json_text(thinking.strip())
    if not candidate.startswith("{"):
        return None
    try:
        json.loads(candidate)
        return candidate
    except json.JSONDecodeError:
        return None


def format_stream_text(content: str, thinking: str) -> str:
    raw = content.strip() and content or (
        f"【思考过程】\n{thinking}" if thinking.strip() else ""
    )
    if not content.strip():
        return raw
    candidate = extract_json_text(content)
    try:
        json.loads(candidate)
        return candidate
    except json.JSONDecodeError:
        return content


def chat_with_ollama(
    ollama_base: str,
    body: Dict[str, Any],
    *,
    on_stream: Optional[StreamCallback] = None,
    cancel_check: Optional[CancelCheck] = None,
    timeout: float = 1800.0,
) -> str:
    url = f"{ollama_base.rstrip('/')}/api/chat"
    content = ""
    thinking = ""
    with httpx.Client(timeout=timeout) as client:
        with client.stream("POST", url, json=body) as response:
            if response.status_code >= 400:
                detail = response.read().decode("utf-8", errors="replace")[:300]
                raise LlmExtractError(
                    f"Ollama 请求失败（{response.status_code}）{('：' + detail) if detail else ''}"
                )
            for line in response.iter_lines():
                if cancel_check and cancel_check():
                    raise LlmExtractError("已中断抽取")
                if not line or not line.strip():
                    continue
                try:
                    chunk = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if chunk.get("error"):
                    raise LlmExtractError(str(chunk["error"]))
                message = chunk.get("message") or {}
                if message.get("content"):
                    content = _append_stream_delta(content, message["content"])
                if message.get("thinking"):
                    thinking = _append_stream_delta(thinking, message["thinking"])
                if on_stream:
                    on_stream(
                        {
                            "content": content,
                            "thinking": thinking,
                            "text": format_stream_text(content, thinking),
                        }
                    )
                if _is_complete_extract_json(content):
                    break

    resolved = content.strip() and content or (
        _try_recover_json_from_thinking(thinking) or content
    )
    if not resolved.strip():
        if thinking.strip():
            raise LlmExtractError(
                "模型只返回了思考过程，未生成最终内容。请调大 options.num_predict",
                thinking,
            )
        raise LlmExtractError("模型未返回内容")
    return resolved


def extract_page_with_ollama(
    ollama_base: str,
    body: Dict[str, Any],
    *,
    on_stream: Optional[StreamCallback] = None,
    cancel_check: Optional[CancelCheck] = None,
) -> Tuple[Dict[str, Any], str]:
    content = chat_with_ollama(
        ollama_base,
        body,
        on_stream=on_stream,
        cancel_check=cancel_check,
    )
    try:
        parsed = json.loads(extract_json_text(content))
    except json.JSONDecodeError as exc:
        raise LlmExtractError("模型输出不是合法 JSON，可调整提示词后重试", content) from exc
    return normalize_extraction(parsed), content


def find_invoice_no_key(header_fields: Iterable[Dict[str, Any]]) -> Optional[str]:
    for field_def in header_fields:
        key = str(field_def.get("key") or "")
        label = str(field_def.get("label") or "")
        if re.search(r"invoice.*(no|number)|发票号", f"{key} {label}", flags=re.I):
            return key or None
    fields = list(header_fields)
    if not fields:
        return None
    return str(fields[0].get("key") or "") or None


# FedEx / DHL：跨页合并为「发票 + 子清单」
AIR_WAYBILL_MERGE_TEMPLATE_IDS = {"air_waybill", "air_waybill_dhl"}


def normalize_invoice_no(value: str) -> str:
    return re.sub(r"\s+", "", value or "").upper()


def pick_majority_invoice_no(counts: Dict[str, int]) -> Optional[str]:
    best_key: Optional[str] = None
    best_count = 0
    for key, count in counts.items():
        if not key:
            continue
        if count > best_count:
            best_key = key
            best_count = count
    return best_key


def merge_air_waybill_by_majority_invoice_no(
    invoices: List[AggregatedInvoice],
    invoice_no_key: str,
    invoice_no_counts: Dict[str, int],
) -> List[AggregatedInvoice]:
    """子清单全部归到出现次数最多的发票号；其余发票号视为识别错误。"""
    if not invoices:
        return invoices

    majority_key = pick_majority_invoice_no(invoice_no_counts)
    if not majority_key:
        for inv in invoices:
            raw = (inv.header.get(invoice_no_key) or "").strip()
            if raw:
                majority_key = normalize_invoice_no(raw)
                break

    canonical: Optional[AggregatedInvoice] = None
    if majority_key:
        for inv in invoices:
            if normalize_invoice_no(inv.header.get(invoice_no_key, "")) == majority_key:
                canonical = inv
                break
    if canonical is None:
        canonical = invoices[0]

    canonical_no = canonical.header.get(invoice_no_key, "")
    if normalize_invoice_no(canonical_no) != (majority_key or ""):
        canonical_no = majority_key or canonical_no

    result = AggregatedInvoice(
        header=dict(canonical.header),
        sublist=list(canonical.sublist),
    )
    if canonical_no:
        result.header[invoice_no_key] = canonical_no

    for inv in invoices:
        if inv is canonical:
            continue
        for key, value in inv.header.items():
            if key == invoice_no_key:
                continue
            if not result.header.get(key) and value:
                result.header[key] = value
        result.sublist.extend(inv.sublist)

    return [result]


def extract_pdf_with_llm(
    pdf_path: str,
    *,
    request_json: str,
    header_fields: List[Dict[str, Any]],
    sublist_columns: List[Dict[str, Any]],
    required_sublist_keys: Optional[List[str]] = None,
    template_id: str = "",
    ollama_base: str,
    on_page_done: Optional[Callable[[PageOutcome, int, int], None]] = None,
    on_stream_update: Optional[
        Callable[[int, int, Dict[str, Any]], None]
    ] = None,
    on_page_image_prepared: Optional[Callable[[PageImage, int], None]] = None,
    cancel_check: Optional[CancelCheck] = None,
) -> PdfExtractionResult:
    header_keys = {str(f["key"]) for f in header_fields if f.get("key")}
    sublist_keys = {str(c["key"]) for c in sublist_columns if c.get("key")}
    required_keys = [
        key
        for key in (required_sublist_keys or [])
        if key in sublist_keys
    ]

    def is_valid_sublist_row(row: Dict[str, str]) -> bool:
        return _has_values(row) and all(row.get(key) for key in required_keys)

    invoice_no_key = find_invoice_no_key(header_fields)
    is_air_waybill_merge = template_id in AIR_WAYBILL_MERGE_TEMPLATE_IDS
    images = render_pdf_pages(pdf_path)
    total_pages = len(images)

    invoices: List[AggregatedInvoice] = []
    pending_orphans: List[Dict[str, str]] = []
    page_outcomes: List[PageOutcome] = []
    invoice_no_counts: Dict[str, int] = {}

    for i, image in enumerate(images):
        if cancel_check and cancel_check():
            raise LlmExtractError("已中断抽取")

        if on_page_image_prepared:
            on_page_image_prepared(image, total_pages)

        try:
            body = build_page_request_body(request_json, image.base64)

            def _stream(snapshot: Dict[str, Any], page_index=image.page_index) -> None:
                if on_stream_update:
                    on_stream_update(page_index, total_pages, snapshot)

            raw, raw_content = extract_page_with_ollama(
                ollama_base,
                body,
                on_stream=_stream,
                cancel_check=cancel_check,
            )

            if not raw["is_target"]:
                outcome = PageOutcome(
                    page_index=image.page_index, status="skipped", raw=raw_content
                )
            else:
                page_invoices = [
                    {
                        "header": _coerce_record(inv["header"], header_keys),
                        "sublist": [
                            row
                            for row in (
                                _coerce_record(item, sublist_keys)
                                for item in inv["sublist"]
                            )
                            if is_valid_sublist_row(row)
                        ],
                    }
                    for inv in raw["invoices"]
                ]
                orphans = [
                    row
                    for row in (
                        _coerce_record(item, sublist_keys)
                        for item in raw["orphan_sublist"]
                    )
                    if is_valid_sublist_row(row)
                ]
                page_has_content = orphans or any(
                    _has_values(inv["header"]) or inv["sublist"] for inv in page_invoices
                )
                if not page_has_content:
                    outcome = PageOutcome(
                        page_index=image.page_index,
                        status="skipped",
                        raw=raw_content,
                    )
                else:
                    for inv in page_invoices:
                        header = inv["header"]
                        sublist = inv["sublist"]
                        invoice_no = (
                            header.get(invoice_no_key, "") if invoice_no_key else ""
                        )
                        if is_air_waybill_merge and invoice_no:
                            key = normalize_invoice_no(invoice_no)
                            if key:
                                invoice_no_counts[key] = (
                                    invoice_no_counts.get(key, 0) + 1
                                )

                        existing = None
                        if invoice_no and invoice_no_key:
                            normalized = normalize_invoice_no(invoice_no)
                            existing = next(
                                (
                                    item
                                    for item in invoices
                                    if normalize_invoice_no(
                                        item.header.get(invoice_no_key, "")
                                    )
                                    == normalized
                                ),
                                None,
                            )
                        if existing:
                            for key, value in header.items():
                                if not existing.header.get(key) and value:
                                    existing.header[key] = value
                            existing.sublist.extend(sublist)
                        elif not _has_values(header) and invoices:
                            invoices[-1].sublist.extend(sublist)
                        elif _has_values(header) or sublist:
                            invoices.append(
                                AggregatedInvoice(header=header, sublist=list(sublist))
                            )

                    if orphans:
                        if invoices:
                            invoices[-1].sublist.extend(orphans)
                        else:
                            pending_orphans.extend(orphans)

                    outcome = PageOutcome(
                        page_index=image.page_index,
                        status="target",
                        raw=raw_content,
                    )
        except LlmExtractError as exc:
            if str(exc) == "已中断抽取":
                raise
            outcome = PageOutcome(
                page_index=image.page_index,
                status="error",
                error=str(exc),
                raw=exc.raw_content,
            )
        except Exception as exc:  # noqa: BLE001
            outcome = PageOutcome(
                page_index=image.page_index,
                status="error",
                error=str(exc) or "抽取失败",
            )

        page_outcomes.append(outcome)
        if on_page_done:
            on_page_done(outcome, i + 1, total_pages)

    if pending_orphans:
        if invoices:
            invoices[0].sublist[0:0] = pending_orphans
        else:
            invoices.append(AggregatedInvoice(header={}, sublist=pending_orphans))

    final_invoices = invoices
    if is_air_waybill_merge and invoice_no_key:
        final_invoices = merge_air_waybill_by_majority_invoice_no(
            invoices, invoice_no_key, invoice_no_counts
        )

    has_sublist = any(inv.sublist for inv in final_invoices)
    if is_air_waybill_merge:
        structure_type = "invoice_with_sublist"
    elif len(final_invoices) > 1:
        structure_type = (
            "multi_invoice_with_sublist" if has_sublist else "multi_invoice"
        )
    else:
        structure_type = "invoice_with_sublist" if has_sublist else "single"

    return PdfExtractionResult(
        structure_type=structure_type,
        invoices=final_invoices,
        page_outcomes=page_outcomes,
    )


def build_export_payload(
    *,
    file_name: str,
    file_size: int,
    structure_type: str,
    invoices: List[AggregatedInvoice],
    header_fields: List[Dict[str, Any]],
    sublist_columns: List[Dict[str, Any]],
    layout_template_id: str,
    llm_model: str,
    page_outcomes: List[PageOutcome],
    note: str = "",
) -> Dict[str, Any]:
    base = {
        "exportedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
        "headerFields": header_fields,
        "sublistColumns": sublist_columns,
        "fileName": file_name,
        "fileSize": file_size,
        "category": "target",
        "structureType": structure_type,
        "note": note,
        "updatedAt": __import__("datetime").datetime.now(
            __import__("datetime").timezone.utc
        ).isoformat(),
    }

    if structure_type == "multi_invoice":
        payload: Dict[str, Any] = {
            **base,
            "invoices": [dict(inv.header) for inv in invoices],
        }
    elif structure_type == "multi_invoice_with_sublist":
        payload = {
            **base,
            "invoicesWithSublist": [
                {"invoice": dict(inv.header), "sublist": [dict(row) for row in inv.sublist]}
                for inv in invoices
            ],
        }
    elif structure_type == "invoice_with_sublist":
        first = invoices[0] if invoices else AggregatedInvoice()
        payload = {
            **base,
            "invoice": dict(first.header),
            "sublist": [dict(row) for row in first.sublist],
        }
    else:
        first = invoices[0] if invoices else AggregatedInvoice()
        payload = {**base, "fields": dict(first.header)}

    payload["extraction"] = {
        "engine": f"ollama/{llm_model or '未设置'}",
        "layoutTemplateId": layout_template_id,
        "totalPages": len(page_outcomes),
        "targetPages": [
            o.page_index + 1 for o in page_outcomes if o.status == "target"
        ],
        "skippedPages": [
            o.page_index + 1 for o in page_outcomes if o.status == "skipped"
        ],
        "errorPages": [
            {"page": o.page_index + 1, "error": o.error}
            for o in page_outcomes
            if o.status == "error"
        ],
    }
    return payload


def document_export_file_name(file_name: str) -> str:
    if re.search(r"\.pdf$", file_name, flags=re.I):
        return re.sub(r"\.pdf$", ".json", file_name, flags=re.I)
    return f"{file_name}.json"
