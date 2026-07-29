import tempfile
import unittest
from pathlib import Path

import database


class LlmExampleDatabaseTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        database.LABEL_DATA_DIR = Path(self.temp_dir.name)
        database.DB_PATH = database.LABEL_DATA_DIR / "labeling.db"
        database.init_db()
        self.user = database.create_user("tester", "hash")

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_shared_example_crud(self):
        created = database.create_llm_example(
            layout_template_id="freight_invoice",
            file_name="sample.pdf",
            file_size=123,
            pdf_path="/tmp/sample.pdf",
            category="target",
            answer={"category": "target", "fields": {"invoice_no": "A1"}},
            created_by=int(self.user["id"]),
        )
        self.assertEqual(created["file_name"], "sample.pdf")
        listed = database.list_llm_examples("freight_invoice")
        self.assertEqual(len(listed), 1)
        self.assertEqual(listed[0]["answer"]["fields"]["invoice_no"], "A1")
        removed = database.delete_llm_example(int(created["id"]))
        self.assertIsNotNone(removed)
        self.assertEqual(database.list_llm_examples("freight_invoice"), [])


if __name__ == "__main__":
    unittest.main()
