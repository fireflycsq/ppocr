#!/usr/bin/env python3
"""文档抽取 API 调用示例。

依赖：pip install requests

默认对接本地 label-api：http://localhost:8001
生产环境经 Nginx 时改为 http://<服务器IP>:8080
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any, Dict

import requests

BASE_URL = os.environ.get("EXTRACT_API_BASE", "http://localhost:8001")
API_KEY = os.environ.get("EXTRACT_API_KEY", "")


def _headers() -> Dict[str, str]:
    if not API_KEY:
        return {}
    return {"X-API-Key": API_KEY}


def list_templates() -> None:
    print("=== 可用版式 ===")
    response = requests.get(f"{BASE_URL}/api/v1/templates", headers=_headers(), timeout=30)
    response.raise_for_status()
    for item in response.json()["templates"]:
        print(f"- {item['id']}: {item['name']}")
        print(f"  {item['description']}")
    print()


def extract_pdf(pdf_path: str, template_id: str, wait: bool = False) -> Dict[str, Any]:
    print(f"=== 提交抽取：{pdf_path}（template={template_id}）===")
    with open(pdf_path, "rb") as fh:
        files = {"files": (os.path.basename(pdf_path), fh, "application/pdf")}
        data = {"template_id": template_id}
        response = requests.post(
            f"{BASE_URL}/api/v1/extract",
            headers=_headers(),
            files=files,
            data=data,
            params={"wait": "true"} if wait else None,
            timeout=1800 if wait else 120,
        )
    if response.status_code not in {200, 202}:
        raise RuntimeError(f"提交失败 {response.status_code}: {response.text}")
    return response.json()


def wait_for_job(job_id: str, interval: float = 2.0) -> Dict[str, Any]:
    print(f"=== 轮询任务 {job_id} ===")
    while True:
        response = requests.get(
            f"{BASE_URL}/api/v1/jobs/{job_id}",
            headers=_headers(),
            timeout=30,
        )
        response.raise_for_status()
        job = response.json()
        status = job.get("status")
        current = job.get("current") or {}
        label = current.get("label") or ""
        print(f"  status={status} {label}".rstrip())
        if status in {"completed", "cancelled", "failed"}:
            return job
        time.sleep(interval)


def fetch_result(job_id: str) -> Dict[str, Any]:
    response = requests.get(
        f"{BASE_URL}/api/v1/jobs/{job_id}/result",
        headers=_headers(),
        timeout=60,
    )
    response.raise_for_status()
    return response.json()


def main(argv: list[str]) -> int:
    pdf_path = argv[1] if len(argv) > 1 else ""
    template_id = argv[2] if len(argv) > 2 else "air_waybill"

    print(f"BASE_URL={BASE_URL}")
    health = requests.get(f"{BASE_URL}/api/v1/health", headers=_headers(), timeout=15)
    print("health:", json.dumps(health.json(), ensure_ascii=False))
    print()
    list_templates()

    if not pdf_path:
        print("用法: python extract_client_demo.py <invoice.pdf> [template_id]")
        print("示例: python extract_client_demo.py ./fedex.pdf air_waybill")
        return 0

    if not os.path.isfile(pdf_path):
        print(f"找不到文件: {pdf_path}")
        return 1

    job = extract_pdf(pdf_path, template_id, wait=False)
    print("已受理:", json.dumps({"id": job["id"], "status": job["status"]}, ensure_ascii=False))
    wait_for_job(job["id"])
    result = fetch_result(job["id"])
    print("\n=== 抽取结果 ===")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
