"""kb_documents, kb_doc_revisions, kb_doc_pages, kb_doc_links, kb_doc_pins: Knowledge Base PDF library

docs/plans/kb-documents.md §4. SQL keeps the metadata, the text per page and the links; the files
are in object storage (GCS in prod, a local folder in dev), never changed. `ensure_schema` creates
the tables at startup too, so each is skipped when present.

Revision ID: e4f5a6b7c8d9
Revises: d3e4f5a6b7c8
Create Date: 2026-11-22 23:30:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "e4f5a6b7c8d9"
down_revision: Union[str, None] = "d3e4f5a6b7c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "kb_documents" not in tables:
        op.create_table(
            "kb_documents",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("number", sa.String(length=40), nullable=False),
            sa.Column("kind", sa.String(length=16), nullable=False),
            sa.Column("doc_type", sa.String(length=24), nullable=False),
            sa.Column("discipline", sa.String(length=8), nullable=False),
            sa.Column("title_en", sa.String(length=200), nullable=False),
            sa.Column("title_th", sa.String(length=200), nullable=False),
            sa.Column("language", sa.String(length=8), nullable=False),
            sa.Column("tags", sa.JSON(), nullable=False),
            sa.Column("general", sa.Boolean(), nullable=False),
            sa.Column("status", sa.String(length=16), nullable=False),
            sa.Column("status_note", sa.String(length=500), nullable=True),
            sa.Column("superseded_by_id", sa.Integer(), sa.ForeignKey("kb_documents.id", ondelete="SET NULL"), nullable=True),
            sa.Column("current_rev_id", sa.Integer(), nullable=True),
            sa.Column("search_text", sa.Text(), nullable=False),
            sa.Column("owner", sa.String(length=64), nullable=True),
            sa.Column("created_by_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_by", sa.String(length=64), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("released_by", sa.String(length=64), nullable=True),
            sa.Column("released_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("number", name="uq_kb_documents_number"),
        )
        op.create_index("ix_kb_documents_doc_type", "kb_documents", ["doc_type"])
        op.create_index("ix_kb_documents_status", "kb_documents", ["status"])
    if "kb_doc_revisions" not in tables:
        op.create_table(
            "kb_doc_revisions",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("doc_id", sa.Integer(), sa.ForeignKey("kb_documents.id", ondelete="CASCADE"), nullable=False),
            sa.Column("rev_no", sa.Integer(), nullable=False),
            sa.Column("label", sa.String(length=40), nullable=True),
            sa.Column("change_note", sa.String(length=500), nullable=True),
            sa.Column("object_name", sa.String(length=255), nullable=False),
            sa.Column("original_name", sa.String(length=255), nullable=True),
            sa.Column("content_type", sa.String(length=64), nullable=False),
            sa.Column("bytes", sa.Integer(), nullable=False),
            sa.Column("sha256", sa.String(length=64), nullable=False),
            sa.Column("page_count", sa.Integer(), nullable=False),
            sa.Column("text_status", sa.String(length=16), nullable=False),
            sa.Column("ocr_langs", sa.String(length=32), nullable=True),
            sa.Column("uploaded_by", sa.String(length=64), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("doc_id", "rev_no", name="uq_kb_doc_revisions_doc_rev"),
        )
        op.create_index("ix_kb_doc_revisions_doc_id", "kb_doc_revisions", ["doc_id"])
        op.create_index("ix_kb_doc_revisions_text_status", "kb_doc_revisions", ["text_status"])
    if "kb_doc_pages" not in tables:
        op.create_table(
            "kb_doc_pages",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("revision_id", sa.Integer(), sa.ForeignKey("kb_doc_revisions.id", ondelete="CASCADE"), nullable=False),
            sa.Column("page_no", sa.Integer(), nullable=False),
            sa.Column("text", sa.Text(), nullable=False),
            sa.Column("search_text", sa.Text(), nullable=False),
            sa.Column("source", sa.String(length=8), nullable=False),
            sa.UniqueConstraint("revision_id", "page_no", name="uq_kb_doc_pages_rev_page"),
        )
        op.create_index("ix_kb_doc_pages_source", "kb_doc_pages", ["source"])
    if "kb_doc_links" not in tables:
        op.create_table(
            "kb_doc_links",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("doc_id", sa.Integer(), sa.ForeignKey("kb_documents.id", ondelete="CASCADE"), nullable=False),
            sa.Column("target_type", sa.String(length=16), nullable=False),
            sa.Column("target_id", sa.String(length=64), nullable=False),
            sa.Column("page", sa.Integer(), nullable=True),
            sa.Column("label", sa.String(length=120), nullable=True),
            sa.UniqueConstraint("doc_id", "target_type", "target_id", "page", name="uq_kb_doc_links"),
        )
        op.create_index("ix_kb_doc_links_doc_id", "kb_doc_links", ["doc_id"])
        op.create_index("ix_kb_doc_links_target", "kb_doc_links", ["target_type", "target_id"])
    if "kb_doc_pins" not in tables:
        op.create_table(
            "kb_doc_pins",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
            sa.Column("doc_id", sa.Integer(), sa.ForeignKey("kb_documents.id", ondelete="CASCADE"), nullable=False),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("user_id", "doc_id", name="uq_kb_doc_pins"),
        )
        op.create_index("ix_kb_doc_pins_user_id", "kb_doc_pins", ["user_id"])


def downgrade() -> None:
    op.drop_table("kb_doc_pins")
    op.drop_table("kb_doc_links")
    op.drop_table("kb_doc_pages")
    op.drop_table("kb_doc_revisions")
    op.drop_table("kb_documents")
