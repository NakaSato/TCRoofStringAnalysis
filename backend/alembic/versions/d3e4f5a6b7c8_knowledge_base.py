"""kb_articles, kb_revisions: Knowledge Base phase 1 (articles, text only, with revisions)

docs/plans/knowledge-base.md §4. SQL only, never Firestore. `ensure_schema` creates the tables
at startup too, so each is skipped when present.

Revision ID: d3e4f5a6b7c8
Revises: c2d3e4f5a6b7
Create Date: 2026-11-22 23:00:00

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "d3e4f5a6b7c8"
down_revision: Union[str, None] = "c2d3e4f5a6b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    tables = set(sa.inspect(op.get_bind()).get_table_names())
    if "kb_articles" not in tables:
        op.create_table(
            "kb_articles",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("slug", sa.String(length=120), nullable=False),
            sa.Column("title", sa.String(length=200), nullable=False),
            sa.Column("category", sa.String(length=24), nullable=False),
            sa.Column("tags", sa.JSON(), nullable=False),
            sa.Column("body_md", sa.Text(), nullable=False),
            sa.Column("search_text", sa.Text(), nullable=False),
            sa.Column("status", sa.String(length=16), nullable=False),
            sa.Column("version", sa.Integer(), nullable=False),
            sa.Column("created_by", sa.String(length=64), nullable=True),
            sa.Column("created_by_user_id", sa.Integer(), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("updated_by", sa.String(length=64), nullable=True),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("published_by", sa.String(length=64), nullable=True),
            sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
            sa.UniqueConstraint("slug", name="uq_kb_articles_slug"),
        )
        op.create_index("ix_kb_articles_status", "kb_articles", ["status"])
    if "kb_revisions" not in tables:
        op.create_table(
            "kb_revisions",
            sa.Column("id", sa.Integer(), primary_key=True, autoincrement=True),
            sa.Column("article_id", sa.Integer(), sa.ForeignKey("kb_articles.id", ondelete="CASCADE"), nullable=False),
            sa.Column("rev_no", sa.Integer(), nullable=False),
            sa.Column("title", sa.String(length=200), nullable=False),
            sa.Column("category", sa.String(length=24), nullable=False),
            sa.Column("tags", sa.JSON(), nullable=False),
            sa.Column("body_md", sa.Text(), nullable=False),
            sa.Column("author", sa.String(length=64), nullable=True),
            sa.Column("note", sa.String(length=500), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
            sa.UniqueConstraint("article_id", "rev_no", name="uq_kb_revisions_article_rev"),
        )


def downgrade() -> None:
    op.drop_table("kb_revisions")
    op.drop_index("ix_kb_articles_status", table_name="kb_articles")
    op.drop_table("kb_articles")
