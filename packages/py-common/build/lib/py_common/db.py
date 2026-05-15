import os
from typing import Optional
from psycopg_pool import ConnectionPool

_pool: Optional[ConnectionPool] = None

def pool() -> ConnectionPool:
    global _pool
    if _pool is None:
        _pool = ConnectionPool(
            conninfo=os.environ["DATABASE_URL"],
            min_size=1,
            max_size=int(os.environ.get("DB_POOL_MAX", "5")),
        )
    return _pool
