#!/usr/bin/env python3
"""llm_extract 纯逻辑单测（不依赖 Ollama）。"""

from __future__ import annotations

import json
import unittest

from llm_extract import (
    AggregatedInvoice,
    PageOutcome,
    build_export_payload,
    build_page_request_body,
    document_export_file_name,
    extract_json_text,
    loads_json_lenient,
    normalize_extraction,
)


class LlmExtractHelpersTest(unittest.TestCase):
    def test_extract_json_text_from_fence(self):
        text = '说明\n```json\n{"is_target": true}\n```\n'
        self.assertEqual(extract_json_text(text), '{"is_target": true}')

    def test_loads_json_lenient_trailing_comma(self):
        raw = '{\n  "model": "x",\n  "messages": [{\n    "role": "user",\n    "content": "hi",\n  }],\n}'
        parsed = loads_json_lenient(raw)
        self.assertEqual(parsed["model"], "x")
        self.assertEqual(parsed["messages"][0]["role"], "user")

    def test_normalize_extraction(self):
        parsed = {
            "is_target": True,
            "invoices": [
                {
                    "header": {"invoice_no": "1"},
                    "sublist": [{"air_waybill_number": "AWB"}],
                }
            ],
            "orphan_sublist": [],
        }
        result = normalize_extraction(parsed)
        self.assertTrue(result["is_target"])
        self.assertEqual(result["invoices"][0]["header"]["invoice_no"], "1")

    def test_build_page_request_body_replaces_placeholder(self):
        request = {
            "model": "qwen3-vl:4b",
            "messages": [
                {"role": "system", "content": "sys"},
                {
                    "role": "user",
                    "content": "page",
                    "images": ["{{PAGE_IMAGE}}"],
                },
            ],
            "options": {"num_predict": 256},
        }
        body = build_page_request_body(json.dumps(request), "BASE64DATA")
        self.assertEqual(body["messages"][-1]["images"], ["BASE64DATA"])
        self.assertEqual(body["options"]["num_predict"], 4096)
        self.assertTrue(body["stream"])
        self.assertFalse(body["think"])

    def test_export_payload_and_filename(self):
        payload = build_export_payload(
            file_name="A.pdf",
            file_size=12,
            structure_type="invoice_with_sublist",
            invoices=[
                AggregatedInvoice(
                    header={"invoice_no": "1"},
                    sublist=[{"air_waybill_number": "AWB", "total": "10"}],
                )
            ],
            header_fields=[{"id": "h1", "key": "invoice_no", "label": "发票号码"}],
            sublist_columns=[
                {"id": "c1", "key": "air_waybill_number", "label": "空运单号"},
                {"id": "c2", "key": "total", "label": "收费"},
            ],
            layout_template_id="air_waybill",
            llm_model="qwen3-vl:4b",
            page_outcomes=[PageOutcome(page_index=0, status="target")],
        )
        self.assertEqual(payload["fileName"], "A.pdf")
        self.assertEqual(payload["invoice"]["invoice_no"], "1")
        self.assertEqual(payload["sublist"][0]["air_waybill_number"], "AWB")
        self.assertEqual(payload["extraction"]["layoutTemplateId"], "air_waybill")
        self.assertEqual(document_export_file_name("A.pdf"), "A.json")


if __name__ == "__main__":
    unittest.main()
