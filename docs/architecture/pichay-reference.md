# PICHAY Reference

*Old design document - some concepts may still be relevant*

## Core Concepts

1. **Tool Definition Stubs**: Replace large JSON Schema with small stubs when tool unused
   - Keep tool name and description first line only
   - Set `input_schema` to empty object
   - Recovery triggers when model requests tool_use for that name

2. **Retrieval Handles/Tombstones**: Text markers for evicted content
   - Format: `[Paged out: Read /path/to/file.py (12,450 bytes, 287 lines). Re-read if needed.]`
   - Three elements: action (Read), target (path), size (bytes/lines)
   - Models自发 re-read when seeing these handles

3. **Pressure-aware hint injection**: Warning when context fills to 60K-100K tokens
   - Format: `System Notice: Current context is 75% full...`
   - Gives model time to organize before involuntary eviction

4. **Fault-driven pinning**: On fault (re-read same hash), pin the file for session
   - On evict: record file path + content hash
   - On fault (re-read same hash): mark as Pinned, don't evict again this session
   - Unpin if file is Edit-modified
