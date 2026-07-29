"""SQLite 存储：用户与标注批次"""

from __future__ import annotations

import json
import os
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

LABEL_DATA_DIR = Path(os.environ.get("LABEL_DATA_DIR", "./data/label_data"))
DB_PATH = LABEL_DATA_DIR / "labeling.db"


def _utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def init_db() -> None:
    LABEL_DATA_DIR.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL COLLATE NOCASE UNIQUE,
                password_hash TEXT NOT NULL,
                created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS label_batches (
                user_id INTEGER PRIMARY KEY,
                batch_json TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS llm_examples (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                layout_template_id TEXT NOT NULL,
                file_name TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                pdf_path TEXT NOT NULL,
                category TEXT NOT NULL CHECK(category IN ('target', 'non_target')),
                answer_json TEXT NOT NULL,
                created_by INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_llm_examples_template
            ON llm_examples(layout_template_id, created_at DESC);
            """
        )


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def create_user(username: str, password_hash: str) -> Dict[str, Any]:
    created_at = _utc_now()
    with get_conn() as conn:
        cursor = conn.execute(
            "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)",
            (username.strip(), password_hash, created_at),
        )
        user_id = cursor.lastrowid
    return {"id": user_id, "username": username.strip(), "created_at": created_at}


def get_user_by_username(username: str) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, username, password_hash, created_at FROM users WHERE username = ? COLLATE NOCASE",
            (username.strip(),),
        ).fetchone()
    return dict(row) if row else None


def get_user_by_id(user_id: int) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT id, username, created_at FROM users WHERE id = ?",
            (user_id,),
        ).fetchone()
    return dict(row) if row else None


def count_users() -> int:
    with get_conn() as conn:
        row = conn.execute("SELECT COUNT(*) AS total FROM users").fetchone()
    return int(row["total"]) if row else 0


def get_label_batch(user_id: int) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT batch_json, updated_at FROM label_batches WHERE user_id = ?",
            (user_id,),
        ).fetchone()
    if not row:
        return None
    return {
        "batch": json.loads(row["batch_json"]),
        "updated_at": row["updated_at"],
    }


def save_label_batch(user_id: int, batch: Dict[str, Any]) -> str:
    updated_at = _utc_now()
    payload = json.dumps(batch, ensure_ascii=False)
    with get_conn() as conn:
        conn.execute(
            """
            INSERT INTO label_batches (user_id, batch_json, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                batch_json = excluded.batch_json,
                updated_at = excluded.updated_at
            """,
            (user_id, payload, updated_at),
        )
    return updated_at


def delete_label_batch(user_id: int) -> None:
    with get_conn() as conn:
        conn.execute("DELETE FROM label_batches WHERE user_id = ?", (user_id,))


def create_llm_example(
    layout_template_id: str,
    file_name: str,
    file_size: int,
    pdf_path: str,
    category: str,
    answer: Dict[str, Any],
    created_by: int,
) -> Dict[str, Any]:
    created_at = _utc_now()
    answer_json = json.dumps(answer, ensure_ascii=False)
    with get_conn() as conn:
        cursor = conn.execute(
            """
            INSERT INTO llm_examples (
                layout_template_id, file_name, file_size, pdf_path,
                category, answer_json, created_by, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                layout_template_id,
                file_name,
                file_size,
                pdf_path,
                category,
                answer_json,
                created_by,
                created_at,
            ),
        )
        example_id = int(cursor.lastrowid)
    return get_llm_example(example_id) or {}


def _example_from_row(row: sqlite3.Row) -> Dict[str, Any]:
    return {
        "id": int(row["id"]),
        "layout_template_id": row["layout_template_id"],
        "file_name": row["file_name"],
        "file_size": int(row["file_size"]),
        "pdf_path": row["pdf_path"],
        "category": row["category"],
        "answer": json.loads(row["answer_json"]),
        "created_by": int(row["created_by"]),
        "created_by_username": row["created_by_username"],
        "created_at": row["created_at"],
    }


def list_llm_examples(layout_template_id: Optional[str] = None) -> List[Dict[str, Any]]:
    query = """
        SELECT e.*, u.username AS created_by_username
        FROM llm_examples e
        JOIN users u ON u.id = e.created_by
    """
    params: tuple[Any, ...] = ()
    if layout_template_id:
        query += " WHERE e.layout_template_id = ?"
        params = (layout_template_id,)
    query += " ORDER BY e.created_at DESC"
    with get_conn() as conn:
        rows = conn.execute(query, params).fetchall()
    return [_example_from_row(row) for row in rows]


def get_llm_example(example_id: int) -> Optional[Dict[str, Any]]:
    with get_conn() as conn:
        row = conn.execute(
            """
            SELECT e.*, u.username AS created_by_username
            FROM llm_examples e
            JOIN users u ON u.id = e.created_by
            WHERE e.id = ?
            """,
            (example_id,),
        ).fetchone()
    return _example_from_row(row) if row else None


def delete_llm_example(example_id: int) -> Optional[Dict[str, Any]]:
    example = get_llm_example(example_id)
    if not example:
        return None
    with get_conn() as conn:
        conn.execute("DELETE FROM llm_examples WHERE id = ?", (example_id,))
    return example
