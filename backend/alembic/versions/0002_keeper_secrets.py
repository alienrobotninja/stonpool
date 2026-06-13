"""keeper secrets

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

import sqlalchemy as sa

from alembic import op

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "keeper_secrets",
        sa.Column("epoch", sa.Integer(), autoincrement=False, nullable=False),
        sa.Column("secret", sa.String(length=66), nullable=False),
        sa.Column("commit_hash", sa.String(length=66), nullable=False),
        sa.Column("revealed", sa.Boolean(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("(CURRENT_TIMESTAMP)"),
            nullable=False,
        ),
        sa.PrimaryKeyConstraint("epoch", name=op.f("pk_keeper_secrets")),
    )


def downgrade() -> None:
    op.drop_table("keeper_secrets")
