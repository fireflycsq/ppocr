#!/usr/bin/env python3
"""对外抽取 API：内置版式与 HTTP 接口单测（不依赖 Ollama）。"""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

import extract_api
import llm_jobs
from extract_api import public_job, router
from extract_templates import (
    UnknownTemplateError,
    build_request_json,
    get_template,
    list_templates,
)
from llm_extract import PageOutcome, build_export_payload
from llm_extract import AggregatedInvoice

MINIMAL_PDF = (
    b"%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"
)


class ExtractTemplatesTest(unittest.TestCase):
    def test_list_known_templates(self):
        ids = {item["id"] for item in list_templates()}
        self.assertEqual(
            ids, {"air_waybill", "air_waybill_dhl", "freight_invoice"}
        )

    def test_unknown_template(self):
        with self.assertRaises(UnknownTemplateError):
            get_template("unknown_layout")

    def test_build_request_json_contains_placeholder(self):
        body = json.loads(build_request_json("air_waybill", "qwen3-vl:4b"))
        self.assertEqual(body["model"], "qwen3-vl:4b")
        self.assertEqual(body["messages"][-1]["images"], ["{{PAGE_IMAGE}}"])
        self.assertIn("Air Waybill Number", body["messages"][-1]["content"])
        self.assertGreaterEqual(body["options"]["num_predict"], 1024)


class ExtractApiHttpTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        llm_jobs.JOBS_DIR = Path(self.temp_dir.name) / "llm_jobs"
        extract_api.EXTRACT_API_KEY = ""
        app = FastAPI()
        app.include_router(router)
        self.client = TestClient(app)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_health_and_templates(self):
        health = self.client.get("/api/v1/health")
        self.assertEqual(health.status_code, 200)
        self.assertIn("air_waybill", health.json()["templates"])

        listed = self.client.get("/api/v1/templates")
        self.assertEqual(listed.status_code, 200)
        self.assertGreaterEqual(len(listed.json()["templates"]), 3)

        detail = self.client.get("/api/v1/templates/air_waybill")
        self.assertEqual(detail.status_code, 200)
        self.assertEqual(detail.json()["id"], "air_waybill")
        keys = {field["key"] for field in detail.json()["header_fields"]}
        self.assertEqual(keys, {"invoice_no", "invoice_date"})

        missing = self.client.get("/api/v1/templates/nope")
        self.assertEqual(missing.status_code, 400)

    def test_create_job_and_cancel(self):
        created = self.client.post(
            "/api/v1/extract",
            data={"template_id": "air_waybill"},
            files={"files": ("invoice.pdf", MINIMAL_PDF, "application/pdf")},
        )
        self.assertEqual(created.status_code, 202, created.text)
        job = created.json()
        self.assertEqual(job["status"], "queued")
        self.assertEqual(job["template_id"], "air_waybill")
        self.assertEqual(len(job["documents"]), 1)
        self.assertEqual(job["documents"][0]["file_name"], "invoice.pdf")

        fetched = self.client.get(f"/api/v1/jobs/{job['id']}")
        self.assertEqual(fetched.status_code, 200)
        self.assertEqual(fetched.json()["id"], job["id"])

        cancelled = self.client.post(f"/api/v1/jobs/{job['id']}/cancel")
        self.assertEqual(cancelled.status_code, 200)
        self.assertEqual(cancelled.json()["status"], "cancelled")

    def test_reject_non_pdf_and_unknown_template(self):
        bad_file = self.client.post(
            "/api/v1/extract",
            data={"template_id": "air_waybill"},
            files={"files": ("note.txt", b"hello", "text/plain")},
        )
        self.assertEqual(bad_file.status_code, 400)

        bad_template = self.client.post(
            "/api/v1/extract",
            data={"template_id": "not_a_template"},
            files={"files": ("invoice.pdf", MINIMAL_PDF, "application/pdf")},
        )
        self.assertEqual(bad_template.status_code, 400)

    def test_api_key_required_when_configured(self):
        extract_api.EXTRACT_API_KEY = "secret-key"
        denied = self.client.get("/api/v1/health")
        self.assertEqual(denied.status_code, 401)

        ok = self.client.get("/api/v1/health", headers={"X-API-Key": "secret-key"})
        self.assertEqual(ok.status_code, 200)
        extract_api.EXTRACT_API_KEY = ""

    def test_public_job_flattens_invoice_result(self):
        payload = build_export_payload(
            file_name="A.pdf",
            file_size=12,
            structure_type="invoice_with_sublist",
            invoices=[
                AggregatedInvoice(
                    header={"invoice_no": "1", "invoice_date": "13 Nov 2025"},
                    sublist=[{"air_waybill_number": "AWB", "total": "10"}],
                )
            ],
            header_fields=[{"id": "h1", "key": "invoice_no", "label": "发票号码"}],
            sublist_columns=[
                {"id": "c1", "key": "air_waybill_number", "label": "空运单号"}
            ],
            layout_template_id="air_waybill",
            llm_model="qwen3-vl:4b",
            page_outcomes=[PageOutcome(page_index=1, status="target")],
        )
        job = {
            "id": "job-test",
            "status": "completed",
            "templateId": "air_waybill",
            "llmModel": "qwen3-vl:4b",
            "createdAt": "t",
            "updatedAt": "t",
            "error": None,
            "cancelRequested": False,
            "current": None,
            "documents": [
                {
                    "id": "doc-1",
                    "fileName": "A.pdf",
                    "fileSize": 12,
                    "status": "done",
                    "progress": {"done": 1, "total": 1},
                    "error": None,
                    "structureType": "invoice_with_sublist",
                    "resultPath": "results/doc-1.json",
                }
            ],
        }
        result_dir = llm_jobs.JOBS_DIR / "job-test" / "results"
        result_dir.mkdir(parents=True)
        (result_dir / "doc-1.json").write_text(
            json.dumps({"exportPayload": payload, "pageOutcomes": []}),
            encoding="utf-8",
        )
        public = public_job(job, include_results=True)
        self.assertEqual(public["documents"][0]["invoice"]["invoice_no"], "1")
        self.assertEqual(public["documents"][0]["sublist"][0]["total"], "10")


class LabelServerDocsTest(unittest.TestCase):
    def test_openapi_is_public_extract_api(self):
        try:
            from label_server import app
        except ImportError as exc:  # pragma: no cover
            self.skipTest(f"label_server 依赖不可用: {exc}")
        schema = app.openapi()
        paths = list(schema["paths"])
        self.assertTrue(paths)
        self.assertTrue(all(path.startswith("/api/v1") for path in paths))
        self.assertIn("/api/v1/extract", paths)
        self.assertEqual(schema["info"]["title"], "文档抽取 API")
        client = TestClient(app)
        docs = client.get("/api/v1/docs")
        self.assertEqual(docs.status_code, 200)
        self.assertIn("swagger", docs.text.lower())
        spec = client.get("/api/v1/openapi.json")
        self.assertEqual(spec.status_code, 200)
        self.assertIn("/api/v1/extract", spec.json()["paths"])


if __name__ == "__main__":
    unittest.main()
