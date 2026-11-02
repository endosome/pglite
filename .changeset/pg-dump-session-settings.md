---
'@electric-sql/pglite-tools': patch
---

`pgDump()` restores all session settings pg_dump changes, not only `search_path`. Before, `restrict_nonsystem_relation_kind` stayed set to `view, foreign-table` afterwards, and every query on a view failed.
