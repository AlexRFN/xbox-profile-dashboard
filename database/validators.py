"""SQL helpers for data validation in queries.

Centralises repeated WHERE-clause fragments so the rules for what counts as
a "valid" value are defined once and applied consistently everywhere.
"""


def valid_ts_sql(alias: str = "") -> str:
    """Return a SQL fragment that filters out null/invalid achievement timestamps.

    Xbox returns '0001-01-01T00:00:00.0000000Z' for locked or unset achievements.
    Every query that filters on real unlock times must include this fragment.

    Args:
        alias: Optional table alias prefix (e.g. 'a' → 'a.time_unlocked ...').

    Example::

        WHERE progress_state = 'Achieved'
          AND {valid_ts_sql('a')}
    """
    col = f"{alias}.time_unlocked" if alias else "time_unlocked"
    return f"{col} IS NOT NULL AND {col} != '' AND {col} NOT LIKE '0001%'"
