"""
OpenClaw agent execution helpers for PinchBench.
"""

from __future__ import annotations

import json
import hashlib
import logging
import os
import re
import subprocess
import time
import fcntl
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Dict, List, Tuple, Optional

from lib_fws import fws_available, is_fws_task, start_fws, stop_fws
from lib_tasks import Task


logger = logging.getLogger(__name__)
MAX_OPENCLAW_MESSAGE_CHARS = int(os.environ.get("PINCHBENCH_MAX_MSG_CHARS", "32000"))
CONTEXT_HASH_PREFIX_CHARS = int(os.environ.get("PINCHBENCH_CONTEXT_HASH_PREFIX_CHARS", "1024"))
CONTEXT_RECENT_MESSAGES = int(os.environ.get("PINCHBENCH_CONTEXT_RECENT_MESSAGES", "4"))
OPENCLAW_AGENT_LOCAL = os.environ.get("OPENCLAW_AGENT_LOCAL", "false").strip().lower() in {
    "1",
    "true",
    "yes",
    "on",
}
DEFAULT_BENCH_OPENCLAW_HOME = Path(
    os.environ.get("TOKENPILOT_OPENCLAW_HOME")
    or os.environ.get("ECOCLAW_OPENCLAW_HOME", "/mnt/20t/xubuqiang")
)
DEFAULT_BENCH_OPENCLAW_STATE_DIR = DEFAULT_BENCH_OPENCLAW_HOME / ".openclaw"
if not os.environ.get("OPENCLAW_CONFIG_PATH"):
    default_config_path = DEFAULT_BENCH_OPENCLAW_STATE_DIR / "openclaw.json"
    if default_config_path.exists():
        os.environ["OPENCLAW_CONFIG_PATH"] = str(default_config_path)
if not os.environ.get("OPENCLAW_STATE_DIR") and DEFAULT_BENCH_OPENCLAW_STATE_DIR.exists():
    os.environ["OPENCLAW_STATE_DIR"] = str(DEFAULT_BENCH_OPENCLAW_STATE_DIR)
if not os.environ.get("HOME") or os.environ.get("HOME") == "/home/xubuqiang":
    if DEFAULT_BENCH_OPENCLAW_HOME.exists():
        os.environ["HOME"] = str(DEFAULT_BENCH_OPENCLAW_HOME)
        os.environ.setdefault("XDG_CACHE_HOME", str(DEFAULT_BENCH_OPENCLAW_HOME / ".cache"))
        os.environ.setdefault("XDG_CONFIG_HOME", str(DEFAULT_BENCH_OPENCLAW_HOME / ".config"))
if os.environ.get("PINCHBENCH_OPENCLAW_CONFIG_PATH"):
    os.environ["OPENCLAW_CONFIG_PATH"] = os.environ["PINCHBENCH_OPENCLAW_CONFIG_PATH"]
if os.environ.get("PINCHBENCH_OPENCLAW_STATE_DIR"):
    os.environ["OPENCLAW_STATE_DIR"] = os.environ["PINCHBENCH_OPENCLAW_STATE_DIR"]
OPENCLAW_AGENT_LOCK_FILE = Path(
    os.environ.get("PINCHBENCH_OPENCLAW_AGENT_LOCK_FILE", "/tmp/pinchbench_openclaw_agents.lock")
)
OPENCLAW_CONFIG_PATH = Path(
    os.environ.get("OPENCLAW_CONFIG_PATH", str(Path.home() / ".openclaw" / "openclaw.json"))
)
OPENCLAW_AGENT_CONFIG_SETTLE_S = float(
    os.environ.get("PINCHBENCH_OPENCLAW_AGENT_CONFIG_SETTLE_S", "15.0")
)
OPENCLAW_GATEWAY_STABLE_PROBES = int(
    os.environ.get("PINCHBENCH_OPENCLAW_GATEWAY_STABLE_PROBES", "3")
)
OPENCLAW_GATEWAY_STABLE_POLL_S = float(
    os.environ.get("PINCHBENCH_OPENCLAW_GATEWAY_STABLE_POLL_S", "1.0")
)
OPENCLAW_GATEWAY_STABLE_MAX_WAIT_S = float(
    os.environ.get("PINCHBENCH_OPENCLAW_GATEWAY_STABLE_MAX_WAIT_S", "12.0")
)


def _wait_for_gateway_stability() -> bool:
    required = max(1, OPENCLAW_GATEWAY_STABLE_PROBES)
    poll_s = max(0.1, OPENCLAW_GATEWAY_STABLE_POLL_S)
    max_wait_s = max(0.0, OPENCLAW_GATEWAY_STABLE_MAX_WAIT_S)
    if required <= 0 or max_wait_s <= 0:
        return True
    stable = 0
    deadline = time.monotonic() + max_wait_s
    while time.monotonic() < deadline:
        try:
            result = subprocess.run(
                ["openclaw", "gateway", "health"],
                capture_output=True,
                text=True,
                check=False,
                timeout=5,
            )
            if result.returncode == 0:
                stable += 1
                if stable >= required:
                    return True
            else:
                stable = 0
        except Exception:
            stable = 0
        time.sleep(poll_s)
    return False


@contextmanager
def _openclaw_agent_lock() -> Any:
    OPENCLAW_AGENT_LOCK_FILE.parent.mkdir(parents=True, exist_ok=True)
    with OPENCLAW_AGENT_LOCK_FILE.open("a+") as lock_fp:
        fcntl.flock(lock_fp.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(lock_fp.fileno(), fcntl.LOCK_UN)


def slugify_model(model_id: str) -> str:
    return normalize_benchmark_model_id(model_id).replace("/", "-").replace(".", "-").lower()


def normalize_benchmark_model_id(model_id: str) -> str:
    value = (model_id or "").strip()
    if not value:
        return value
    # Some OpenAI-compatible gateways expect dotted minor version names like
    # gpt-5.4-mini and reject dashed variants like gpt-5-4-mini.
    return value.replace("gpt-5-4-mini", "gpt-5.4-mini")


def _ensure_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    return str(value)


def _message_content_to_text(content: Any) -> str:
    if content is None:
        return ""
    if isinstance(content, str):
        return content
    if isinstance(content, bytes):
        return content.decode("utf-8", errors="replace")
    if isinstance(content, list):
        parts: List[str] = []
        for item in content:
            if isinstance(item, dict):
                # Keep this generic: capture common payload fields without
                # assuming one provider schema.
                item_type = item.get("type")
                if item_type:
                    parts.append(f"[{item_type}]")
                for key in ("text", "content", "input", "output", "result", "value"):
                    if key in item:
                        parts.append(_message_content_to_text(item.get(key)))
            else:
                parts.append(_message_content_to_text(item))
        return "\n".join([p for p in parts if p])
    if isinstance(content, dict):
        try:
            return json.dumps(content, ensure_ascii=False, sort_keys=True)
        except TypeError:
            return str(content)
    return str(content)


def _normalize_cache_signature_text(text: str) -> str:
    normalized = text
    normalized = re.sub(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", "<UUID>", normalized, flags=re.IGNORECASE)
    normalized = re.sub(r"/tmp/pinchbench/[^\s\"']+", "/tmp/pinchbench/<PATH>", normalized)
    normalized = re.sub(r"\b\d{4}-\d{2}-\d{2}[T ][0-9:\.\+\-Z]{6,}\b", "<TIMESTAMP>", normalized)
    normalized = re.sub(r"\b\d{10,}\b", "<LONGNUM>", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    return normalized


def _sha256_text(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8", errors="replace")).hexdigest()


def _build_call_context_detail(
    transcript: List[Dict[str, Any]],
    assistant_entry_index: int,
) -> Dict[str, Any]:
    message_items: List[Dict[str, Any]] = []
    message_indices: List[int] = []
    for idx, entry in enumerate(transcript[:assistant_entry_index]):
        if entry.get("type") != "message":
            continue
        msg = entry.get("message", {}) if isinstance(entry.get("message"), dict) else {}
        role = str(msg.get("role") or "unknown")
        content_text = _message_content_to_text(msg.get("content"))
        message_items.append(
            {
                "transcript_index": idx,
                "role": role,
                "content": content_text,
            }
        )
        message_indices.append(idx)

    signature_payload = json.dumps(message_items, ensure_ascii=False, sort_keys=True)
    normalized_payload = _normalize_cache_signature_text(signature_payload)
    prefix_chars = max(128, CONTEXT_HASH_PREFIX_CHARS)
    recent_count = max(1, CONTEXT_RECENT_MESSAGES)
    recent_messages = message_items[-recent_count:]

    return {
        "assistant_transcript_index": assistant_entry_index,
        "context_message_count": len(message_items),
        "context_message_indices": message_indices,
        "context_chars": len(signature_payload),
        "context_signature_sha256": _sha256_text(signature_payload),
        "context_signature_normalized_sha256": _sha256_text(normalized_payload),
        "prefix_chars": prefix_chars,
        "prefix_signature_sha256": _sha256_text(signature_payload[:prefix_chars]),
        "prefix_signature_normalized_sha256": _sha256_text(normalized_payload[:prefix_chars]),
        "recent_messages": recent_messages,
    }



def _get_agent_workspace(agent_id: str) -> Path | None:
    """Get the workspace path for an agent from OpenClaw config."""
    try:
        list_result = subprocess.run(
            ["openclaw", "agents", "list"],
            capture_output=True,
            text=True,
            check=False,
        )
        if list_result.returncode != 0:
            return None

        # Parse the agent list output to find workspace
        # OpenClaw normalizes colons to dashes in agent names, so check both.
        normalized_id = agent_id.replace(":", "-")
        lines = list_result.stdout.split("\n")
        found_agent = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith(f"- {agent_id}") or stripped.startswith(f"- {normalized_id}"):
                found_agent = True
            elif found_agent and "Workspace:" in line:
                workspace_str = line.split("Workspace:")[1].strip()
                # Expand ~ if present
                if workspace_str.startswith("~/"):
                    workspace_str = str(Path.home() / workspace_str[2:])
                return Path(workspace_str)
            elif found_agent and line.strip().startswith("-"):
                # Found next agent, stop looking
                break
        return None
    except Exception as exc:
        logger.warning("Failed to get agent workspace: %s", exc)
        return None


def ensure_agent_exists(agent_id: str, model_id: str, workspace_dir: Path) -> bool:
    """Ensure the OpenClaw agent exists with the correct workspace.

    If the agent already exists but points to a different workspace, it is
    deleted and recreated so that the new workspace takes effect.
    Returns True if the agent was (re)created.
    """
    workspace_dir.mkdir(parents=True, exist_ok=True)
    model_id = normalize_benchmark_model_id(model_id)

    with _openclaw_agent_lock():
        try:
            list_result = subprocess.run(
                ["openclaw", "agents", "list"],
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError:
            logger.error("openclaw CLI not found while listing agents")
            return False

        if list_result.returncode == 0:
            existing_agents = set()
            for line in list_result.stdout.splitlines():
                line = line.strip()
                if line.startswith("- "):
                    name_part = line[2:].split()[0] if line[2:].strip() else ""
                    if name_part:
                        existing_agents.add(name_part)
            normalized_id = agent_id.replace(":", "-")
            if agent_id in existing_agents or normalized_id in existing_agents:
                current_workspace = _get_agent_workspace(agent_id)
                if (
                    current_workspace is not None
                    and current_workspace.resolve() == workspace_dir.resolve()
                ):
                    logger.info("Agent %s already exists with correct workspace", agent_id)
                    return False
                delete_name = normalized_id if normalized_id in existing_agents else agent_id
                logger.info(
                    "Agent %s exists with stale workspace (%s != %s), recreating",
                    agent_id,
                    current_workspace,
                    workspace_dir,
                )
                subprocess.run(
                    ["openclaw", "agents", "delete", delete_name, "--force"],
                    capture_output=True,
                    text=True,
                    check=False,
                )

        logger.info("Creating OpenClaw agent %s", agent_id)
        try:
            create_result = subprocess.run(
                [
                    "openclaw",
                    "agents",
                    "add",
                    agent_id,
                    "--model",
                    model_id,
                    "--workspace",
                    str(workspace_dir),
                    "--non-interactive",
                ],
                capture_output=True,
                text=True,
                check=False,
            )
        except FileNotFoundError:
            logger.error("openclaw CLI not found while creating agent")
            return False

        if create_result.returncode != 0:
            logger.warning(
                "Agent creation returned %s: %s", create_result.returncode, create_result.stderr
            )
        if OPENCLAW_AGENT_CONFIG_SETTLE_S > 0:
            logger.info(
                "Waiting %.1fs for OpenClaw gateway to settle after agent config rewrite",
                OPENCLAW_AGENT_CONFIG_SETTLE_S,
            )
            time.sleep(OPENCLAW_AGENT_CONFIG_SETTLE_S)
        if OPENCLAW_GATEWAY_STABLE_PROBES > 0 and OPENCLAW_GATEWAY_STABLE_MAX_WAIT_S > 0:
            logger.info(
                "Best-effort gateway health probe: need %s stable checks within %.1fs after agent config rewrite",
                OPENCLAW_GATEWAY_STABLE_PROBES,
                OPENCLAW_GATEWAY_STABLE_MAX_WAIT_S,
            )
            if not _wait_for_gateway_stability():
                logger.warning(
                    "Gateway health probe did not stabilize within %.1fs; continuing anyway",
                    OPENCLAW_GATEWAY_STABLE_MAX_WAIT_S,
                )
        return True


def cleanup_agent_sessions(agent_id: str) -> None:
    """Remove stored session transcripts for an agent to avoid unbounded growth."""
    agent_dir = _get_agent_store_dir(agent_id)
    sessions_dir = agent_dir / "sessions"
    if not sessions_dir.exists():
        return
    removed = 0
    for pattern in ("*.jsonl", "*.jsonl.lock"):
        for path in sessions_dir.glob(pattern):
            try:
                path.unlink()
                removed += 1
            except OSError as exc:
                logger.warning("Failed to remove session file %s: %s", path, exc)
    sessions_store = sessions_dir / "sessions.json"
    if sessions_store.exists():
        try:
            sessions_store.unlink()
        except OSError as exc:
            logger.warning("Failed to remove session store %s: %s", sessions_store, exc)
    if removed:
        logger.info("Removed %s old OpenClaw session transcripts for %s", removed, agent_id)


def prepare_task_workspace(
    skill_dir: Path,
    run_id: str,
    task: Task,
    agent_id: str,
    workspace_override: Path | None = None,
    preserve_existing: bool = False,
) -> Path:
    """
    Prepare workspace for a task by copying fixtures.
    Uses the agent's configured workspace to ensure files are in the right place.
    """
    import shutil

    # Prefer explicit workspace from caller (parallel-safe).
    workspace = workspace_override
    if workspace is None:
        # Get agent's workspace from agent config
        workspace = _get_agent_workspace(agent_id)
    if workspace is None:
        # Fallback to task-specific workspace if agent workspace not found
        logger.warning("Could not find agent workspace, using fallback")
        workspace = Path(f"/tmp/pinchbench/{run_id}/{task.task_id}")

    # In persistent-workspace mode we intentionally accumulate filesystem state
    # across tasks. Otherwise, reset to a clean workspace.
    if workspace.exists() and not preserve_existing:
        shutil.rmtree(workspace)
    workspace.mkdir(parents=True, exist_ok=True)

    for file_spec in task.workspace_files:
        if "content" in file_spec:
            dest = workspace / file_spec["path"]
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_text(file_spec["content"])
            continue

        source = skill_dir / "assets" / file_spec["source"]
        dest = workspace / file_spec["dest"]
        dest.parent.mkdir(parents=True, exist_ok=True)
        try:
            dest.write_bytes(source.read_bytes())
        except FileNotFoundError:
            logger.error("Workspace file not found: %s", source)
            raise

    return workspace


def _get_agent_store_dir(agent_id: str) -> Path:
    state_dir = os.environ.get("OPENCLAW_STATE_DIR")
    if state_dir:
        base_dir = Path(state_dir) / "agents"
    else:
        base_dir = Path.home() / ".openclaw" / "agents"
    direct_dir = base_dir / agent_id
    if direct_dir.exists():
        return direct_dir
    normalized_dir = base_dir / agent_id.replace(":", "-")
    if normalized_dir.exists():
        return normalized_dir
    return direct_dir


def _resolve_session_store_entry(agent_id: str) -> Optional[Dict[str, Any]]:
    agent_dir = _get_agent_store_dir(agent_id)
    sessions_store = agent_dir / "sessions" / "sessions.json"
    if not sessions_store.exists():
        return None
    try:
        sessions_payload = json.loads(sessions_store.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        logger.warning("Failed to parse sessions store: %s", exc)
        return None
    if not isinstance(sessions_payload, dict):
        return None

    normalized_id = agent_id.replace(":", "-")
    preferred_keys = [
        f"agent:{agent_id}:main",
        f"agent:{agent_id}:default",
        f"agent:{normalized_id}:main",
        f"agent:{normalized_id}:default",
    ]
    for key in preferred_keys:
        entry = sessions_payload.get(key)
        if isinstance(entry, dict) and entry.get("sessionId"):
            return entry

    newest_entry = None
    newest_timestamp = -1
    for entry in sessions_payload.values():
        if not isinstance(entry, dict):
            continue
        if "sessionId" not in entry:
            continue
        updated_at = entry.get("updatedAt")
        if isinstance(updated_at, (int, float)) and updated_at > newest_timestamp:
            newest_timestamp = updated_at
            newest_entry = entry
    return newest_entry if isinstance(newest_entry, dict) else None


def _resolve_session_id_from_store(agent_id: str) -> str | None:
    entry = _resolve_session_store_entry(agent_id)
    if isinstance(entry, dict):
        session_id = entry.get("sessionId")
        if isinstance(session_id, str) and session_id:
            return session_id
    return None


def _find_recent_session_path(agent_dir: Path, started_at: float) -> Path | None:
    sessions_dir = agent_dir / "sessions"
    if not sessions_dir.exists():
        return None
    candidates = list(sessions_dir.glob("*.jsonl"))
    if not candidates:
        return None
    tolerance_seconds = 5.0
    recent_candidates = [
        path for path in candidates if path.stat().st_mtime >= (started_at - tolerance_seconds)
    ]
    pool = recent_candidates or candidates
    return max(pool, key=lambda path: path.stat().st_mtime)


def _read_proc_starttime(pid: int) -> int | None:
    try:
        stat_text = Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None

    try:
        tail = stat_text.rsplit(")", 1)[1].strip()
        fields = tail.split()
        return int(fields[19])
    except (IndexError, ValueError):
        return None


def _is_stale_lock_file(path: Path) -> bool:
    try:
        payload = json.loads(path.read_text())
    except Exception:
        return False

    pid = payload.get("pid")
    starttime = payload.get("starttime")
    if not isinstance(pid, int):
        return False

    current_starttime = _read_proc_starttime(pid)
    if current_starttime is None:
        return True
    if isinstance(starttime, int) and current_starttime != starttime:
        return True
    return False


def _cleanup_stale_lock_files(paths: List[Path]) -> List[Path]:
    active: List[Path] = []
    for path in paths:
        if not path.exists():
            continue
        if _is_stale_lock_file(path):
            try:
                path.unlink()
                logger.warning("Removed stale transcript lock: %s", path)
            except OSError:
                active.append(path)
            continue
        active.append(path)
    return active


def _resolve_session_file_from_store(agent_id: str) -> Path | None:
    entry = _resolve_session_store_entry(agent_id)
    if not isinstance(entry, dict):
        return None
    session_file = entry.get("sessionFile")
    if isinstance(session_file, str) and session_file.strip():
        return Path(session_file)
    return None


def _pending_transcript_lock_paths(agent_dir: Path, session_id: str, agent_id: str) -> List[Path]:
    sessions_dir = agent_dir / "sessions"
    candidates: List[Path] = []

    resolved_session_file = _resolve_session_file_from_store(agent_id)
    if resolved_session_file is not None:
        candidates.append(Path(f"{resolved_session_file}.lock"))

    resolved_session_id = _resolve_session_id_from_store(agent_id)
    if resolved_session_id:
        candidates.append(sessions_dir / f"{resolved_session_id}.jsonl.lock")

    if session_id:
        candidates.append(sessions_dir / f"{session_id}.jsonl.lock")

    seen: set[str] = set()
    existing: List[Path] = []
    for path in candidates:
        key = str(path)
        if key in seen:
            continue
        seen.add(key)
        if path.exists():
            existing.append(path)

    if existing:
        return _cleanup_stale_lock_files(existing)

    fallback = sorted(sessions_dir.glob("*.jsonl.lock")) if sessions_dir.exists() else []
    return _cleanup_stale_lock_files(fallback)


def _load_transcript(
    agent_id: str,
    session_id: str,
    started_at: float,
    *,
    log_success: bool = True,
) -> List[Dict[str, Any]]:
    agent_dir = _get_agent_store_dir(agent_id)
    transcript_path = None
    last_pending_locks: List[Path] = []

    # OpenClaw ignores the --session-id we pass and generates its own UUID-based
    # session ID internally.  We need to discover the actual transcript path.
    #
    # Strategy (with retries to handle write-delay):
    #   1. Resolve the real session ID from sessions.json
    #   2. Glob for any .jsonl in the sessions dir (most-recently-modified)
    #   3. Try our passed-in session ID as a last resort
    session_mode = os.environ.get("PINCHBENCH_SESSION_MODE", "").strip().lower()
    continuous_mode = session_mode == "continuous"
    max_attempts = int(os.environ.get(
        "PINCHBENCH_TRANSCRIPT_RETRIES_CONTINUOUS" if continuous_mode else "PINCHBENCH_TRANSCRIPT_RETRIES",
        "24" if continuous_mode else "6",
    ))
    retry_sleep_s = float(os.environ.get(
        "PINCHBENCH_TRANSCRIPT_RETRY_SLEEP_CONTINUOUS" if continuous_mode else "PINCHBENCH_TRANSCRIPT_RETRY_SLEEP",
        "5.0" if continuous_mode else "1.0",
    ))
    lock_drain_wait_seconds = float(
        os.environ.get(
            "PINCHBENCH_TRANSCRIPT_LOCK_DRAIN_WAIT_SECONDS_CONTINUOUS" if continuous_mode else "PINCHBENCH_TRANSCRIPT_LOCK_DRAIN_WAIT_SECONDS",
            "120" if continuous_mode else "45",
        )
    )
    deadline = time.time() + max_attempts * retry_sleep_s
    lock_deadline = deadline

    attempt = 0
    while True:
        # 1. Prefer the concrete transcript path from sessions.json when available.
        resolved_session_file = _resolve_session_file_from_store(agent_id)
        if resolved_session_file and resolved_session_file.exists():
            transcript_path = resolved_session_file
            if log_success:
                logger.info(
                    "Found transcript via sessionFile: %s (attempt %s)",
                    resolved_session_file.name,
                    attempt + 1,
                )
            break

        # 2. Try sessions.json sessionId — OpenClaw writes the real UUID / logical id here
        resolved_session_id = _resolve_session_id_from_store(agent_id)
        if resolved_session_id:
            candidate = agent_dir / "sessions" / f"{resolved_session_id}.jsonl"
            if candidate.exists():
                transcript_path = candidate
                if log_success:
                    logger.info(
                        "Found transcript via sessions.json: %s (attempt %s)",
                        candidate.name,
                        attempt + 1,
                    )
                break

        # 3. Glob fallback — pick the most recently modified .jsonl
        recent_path = _find_recent_session_path(agent_dir, started_at)
        if recent_path is not None:
            transcript_path = recent_path
            if log_success:
                logger.info(
                    "Found transcript via glob fallback: %s (attempt %s)",
                    recent_path.name,
                    attempt + 1,
                )
            break

        # 4. Try our passed-in session ID (unlikely to work, but check anyway)
        direct_path = agent_dir / "sessions" / f"{session_id}.jsonl"
        if direct_path.exists():
            transcript_path = direct_path
            if log_success:
                logger.info(
                    "Found transcript via passed session ID: %s (attempt %s)",
                    direct_path.name,
                    attempt + 1,
                )
            break

        pending_locks = _pending_transcript_lock_paths(agent_dir, session_id, agent_id)
        if pending_locks:
            last_pending_locks = pending_locks
            oldest_lock_age = 0.0
            for lock_path in pending_locks:
                try:
                    oldest_lock_age = max(oldest_lock_age, time.time() - lock_path.stat().st_mtime)
                except OSError:
                    continue
            lock_deadline = max(lock_deadline, time.time() + lock_drain_wait_seconds)
            if attempt in (0, 2, 5) or time.time() >= deadline:
                logger.info(
                    "Transcript not ready yet for agent %s; pending lock files: %s (attempt %s, oldest_lock_age=%.1fs, drain_deadline=%.1fs)",
                    agent_id,
                    [path.name for path in pending_locks],
                    attempt + 1,
                    oldest_lock_age,
                    max(0.0, lock_deadline - time.time()),
                )
        else:
            lock_deadline = deadline

        attempt += 1
        now = time.time()
        if now >= deadline and (not last_pending_locks or now >= lock_deadline):
            break

        time.sleep(retry_sleep_s)

    if transcript_path is None:
        sessions_dir = agent_dir / "sessions"
        if last_pending_locks:
            logger.warning(
                "Transcript still not ready for agent %s after waiting; lock files remain: %s",
                agent_id,
                [path.name for path in last_pending_locks],
            )
        elif sessions_dir.exists():
            all_files = list(sessions_dir.iterdir())
            logger.warning(
                "Transcript not found for agent %s. Sessions dir contents: %s",
                agent_id,
                [f.name for f in all_files],
            )
        else:
            logger.warning(
                "Transcript not found — sessions dir does not exist: %s",
                sessions_dir,
            )
        return []

    return _parse_jsonl_file(transcript_path)


def _parse_jsonl_file(path: Path) -> List[Dict[str, Any]]:
    """Parse a JSONL transcript file into a list of dicts."""
    def _split_candidate_records(raw: str) -> List[str]:
        records: List[str] = []
        current = ""
        for line in raw.splitlines():
            if line.startswith('{"type":'):
                if current.strip():
                    records.append(current)
                current = line
            elif current:
                current = f"{current}\n{line}"
        if current.strip():
            records.append(current)
        return records

    def _salvage_tool_result_record(candidate: str) -> Optional[Dict[str, Any]]:
        text = str(candidate or "")
        if '"type":"message"' not in text or '"role":"toolResult"' not in text:
            return None

        def _extract(pattern: str) -> Optional[str]:
            match = re.search(pattern, text)
            return match.group(1) if match else None

        tool_name = _extract(r'"toolName":"([^"\n]+)"') or "tool"
        tool_call_id = _extract(r'"toolCallId":"([^"\n]+)"')
        salvaged: Dict[str, Any] = {
            "type": "message",
            "message": {
                "role": "toolResult",
                "toolName": tool_name,
                "content": [{
                    "type": "text",
                    "text": f"[Unparseable toolResult omitted: {tool_name}]",
                }],
                "details": {
                    "contextSafe": {
                        "transcriptSalvaged": True,
                        "transcriptSalvageReason": "unparseable_tool_result",
                    }
                },
            },
        }
        record_id = _extract(r'"id":"([^"\n]+)"')
        parent_id = _extract(r'"parentId":"([^"\n]+)"')
        timestamp = _extract(r'"timestamp":"([^"\n]+)"')
        if record_id:
            salvaged["id"] = record_id
        if parent_id:
            salvaged["parentId"] = parent_id
        if timestamp:
            salvaged["timestamp"] = timestamp
        if tool_call_id:
            salvaged["message"]["toolCallId"] = tool_call_id
        return salvaged

    entries: List[Dict[str, Any]] = []
    raw = path.read_text(encoding="utf-8")
    for candidate in _split_candidate_records(raw):
        if not candidate.strip():
            continue
        try:
            entries.append(json.loads(candidate))
        except json.JSONDecodeError as exc:
            salvaged = _salvage_tool_result_record(candidate)
            if salvaged is not None:
                entries.append(salvaged)
                continue
            logger.warning("Failed to parse transcript line in %s: %s", path.name, exc)
            entries.append({"raw": candidate, "parse_error": str(exc)})
    return entries


def _dedupe_transcript_entries(entries: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Deduplicate transcript entries while preserving order.

    Some OpenClaw session-loading paths can return the same underlying JSONL
    content multiple times (especially when synthetic session IDs resolve to
    the latest real UUID session). This helper removes duplicate events by
    stable key so usage/call counts are not inflated by repeated merges.
    """
    deduped: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        event_id = entry.get("id")
        if event_id:
            key = f"id:{event_id}"
        else:
            try:
                key = f"hash:{hashlib.sha1(json.dumps(entry, sort_keys=True, ensure_ascii=False).encode('utf-8', errors='replace')).hexdigest()}"
            except (TypeError, ValueError):
                key = f"repr:{repr(entry)}"
        if key in seen:
            continue
        seen.add(key)
        deduped.append(entry)
    return deduped


def _extract_usage_from_transcript(transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Sum token usage and cost from all assistant messages in transcript."""
    def _to_int(value: Any, default: int = 0) -> int:
        try:
            if value is None:
                return default
            return int(value)
        except (TypeError, ValueError):
            return default

    def _to_float(value: Any, default: float = 0.0) -> float:
        try:
            if value is None:
                return default
            return float(value)
        except (TypeError, ValueError):
            return default

    totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "cache_write_tokens": 0,
        "cache_hit_tokens": 0,
        "total_tokens": 0,
        "cost_usd": 0.0,
        "request_count": 0,
        "usage_available_count": 0,
        "usage_missing_count": 0,
    }

    for entry in transcript:
        if entry.get("type") != "message":
            continue
        msg = entry.get("message", {})
        if msg.get("role") != "assistant":
            continue
        totals["request_count"] += 1
        usage = msg.get("usage", {}) if isinstance(msg.get("usage"), dict) else {}
        provider_raw = usage.get("providerRaw", {})
        if not isinstance(provider_raw, dict):
            provider_raw = {}

        input_tokens = _to_int(usage.get("input"), _to_int(usage.get("input_tokens"), _to_int(usage.get("prompt_tokens"), 0)))
        output_tokens = _to_int(usage.get("output"), _to_int(usage.get("output_tokens"), _to_int(usage.get("completion_tokens"), 0)))
        if input_tokens == 0:
            input_tokens = _to_int(provider_raw.get("input_tokens"), _to_int(provider_raw.get("prompt_tokens"), 0))
        if output_tokens == 0:
            output_tokens = _to_int(provider_raw.get("output_tokens"), _to_int(provider_raw.get("completion_tokens"), 0))

        # Cross-provider cache fields:
        # - OpenClaw transcript style: cacheRead/cacheWrite
        # - Anthropic style: cache_read_input_tokens/cache_creation_input_tokens
        # - OpenAI style: prompt_tokens_details.cached_tokens
        cached_tokens = _to_int(
            usage.get("cachedTokens"),
            _to_int(
                usage.get("cached_tokens"),
                _to_int((usage.get("prompt_tokens_details") or {}).get("cached_tokens"), 0),
            ),
        )
        cache_read_tokens = _to_int(
            usage.get("cacheRead"),
            _to_int(
                usage.get("cache_read_tokens"),
                _to_int(usage.get("cache_read_input_tokens"), cached_tokens),
            ),
        )
        cache_write_tokens = _to_int(
            usage.get("cacheWrite"),
            _to_int(usage.get("cache_write_tokens"), _to_int(usage.get("cache_creation_input_tokens"), 0)),
        )
        total_tokens = _to_int(
            usage.get("totalTokens"),
            _to_int(usage.get("total_tokens"), input_tokens + output_tokens),
        )
        if total_tokens == 0:
            total_tokens = _to_int(provider_raw.get("total_tokens"), input_tokens + output_tokens)

        totals["input_tokens"] += input_tokens
        totals["output_tokens"] += output_tokens
        totals["cache_read_tokens"] += cache_read_tokens
        totals["cache_write_tokens"] += cache_write_tokens
        totals["cache_hit_tokens"] += cache_read_tokens
        totals["total_tokens"] += total_tokens
        cost = usage.get("cost", {})
        totals["cost_usd"] += _to_float(cost.get("total"), _to_float(usage.get("cost_usd"), 0.0))
        if input_tokens > 0 or output_tokens > 0 or total_tokens > 0:
            totals["usage_available_count"] += 1
        else:
            totals["usage_missing_count"] += 1

    return totals


def _extract_llm_calls_from_transcript(transcript: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Extract per-assistant-message LLM call metadata for debugging and audit."""
    def _to_int(value: Any, default: int = 0) -> int:
        try:
            if value is None:
                return default
            return int(value)
        except (TypeError, ValueError):
            return default

    def _to_float(value: Any, default: float = 0.0) -> float:
        try:
            if value is None:
                return default
            return float(value)
        except (TypeError, ValueError):
            return default

    calls: List[Dict[str, Any]] = []
    for idx, entry in enumerate(transcript):
        if entry.get("type") != "message":
            continue
        msg = entry.get("message", {})
        if msg.get("role") != "assistant":
            continue

        usage = msg.get("usage", {}) if isinstance(msg.get("usage"), dict) else {}
        cost_obj = usage.get("cost", {}) if isinstance(usage.get("cost"), dict) else {}
        context_detail = _build_call_context_detail(transcript, idx)
        calls.append({
            "index": idx,
            "timestamp": msg.get("timestamp") or entry.get("timestamp"),
            "provider": msg.get("provider"),
            "model": msg.get("model"),
            "api": msg.get("api"),
            "stop_reason": msg.get("stopReason"),
            "input_tokens": _to_int(usage.get("input"), _to_int(usage.get("input_tokens"), _to_int(usage.get("prompt_tokens"), 0))),
            "output_tokens": _to_int(usage.get("output"), _to_int(usage.get("output_tokens"), _to_int(usage.get("completion_tokens"), 0))),
            "cache_read_tokens": _to_int(usage.get("cacheRead"), _to_int(usage.get("cache_read_tokens"), _to_int(usage.get("cache_read_input_tokens"), 0))),
            "cache_write_tokens": _to_int(usage.get("cacheWrite"), _to_int(usage.get("cache_write_tokens"), _to_int(usage.get("cache_creation_input_tokens"), 0))),
            "total_tokens": _to_int(usage.get("totalTokens"), _to_int(usage.get("total_tokens"), 0)),
            "cost_usd": _to_float(cost_obj.get("total"), _to_float(usage.get("cost_usd"), 0.0)),
            "context_detail": context_detail,
        })
    return calls


def _latest_assistant_message(transcript: List[Dict[str, Any]]) -> Dict[str, Any] | None:
    for entry in reversed(transcript):
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        if isinstance(message, dict) and message.get("role") == "assistant":
            return message
    return None


def _is_transient_provider_error(transcript: List[Dict[str, Any]]) -> tuple[bool, str]:
    assistant_message = _latest_assistant_message(transcript)
    if not assistant_message:
        return False, ""
    if assistant_message.get("stopReason") != "error":
        return False, ""
    error_message = _ensure_text(assistant_message.get("errorMessage")).lower()
    signatures = [
        "bad gateway",
        "502",
        "connection error",
        "temporarily unavailable",
        "help.openai.com",
        "rate limit",
        "timeout",
    ]
    if any(signature in error_message for signature in signatures):
        return True, error_message[:200]
    return False, ""


def execute_openclaw_task(
    *,
    task: Task,
    agent_id: str,
    model_id: str,
    run_id: str,
    timeout_multiplier: float,
    skill_dir: Path,
    agent_workspace: Path | None = None,
    verbose: bool = False,
    session_mode: str = "isolated",
    cleanup_sessions: bool = True,
    defer_transcript_load: bool = False,
    initial_session_id: str | None = None,
    manage_fws: bool = True,
) -> Dict[str, Any]:
    logger.info("🤖 Agent [%s] starting task: %s", agent_id, task.task_id)
    logger.info("   Task: %s", task.name)
    logger.info("   Category: %s", task.category)
    if verbose:
        logger.info(
            "   Prompt: %s", task.prompt[:500] + "..." if len(task.prompt) > 500 else task.prompt
        )

    # Clean up previous session transcripts so we can reliably find this task's
    # transcript (OpenClaw uses its own UUID-based naming, not our session ID).
    # In continuous-session mode we intentionally preserve history and let the
    # caller slice per-task transcript ranges.
    if cleanup_sessions:
        cleanup_agent_sessions(agent_id)

    requires_fws = is_fws_task(task.frontmatter)
    fws_env: Dict[str, Optional[str]] | None = None
    if manage_fws and requires_fws:
        if not fws_available():
            logger.warning(
                "Task %s requires fws-backed services, but fws is not available.",
                task.task_id,
            )
        else:
            fws_env = start_fws()

    try:
        start_time = time.time()
        workspace = prepare_task_workspace(
            skill_dir=skill_dir,
            run_id=run_id,
            task=task,
            agent_id=agent_id,
            workspace_override=agent_workspace,
            preserve_existing=(session_mode == "continuous"),
        )
        session_id = initial_session_id or f"{task.task_id}_{int(time.time() * 1000)}"
        timeout_seconds = task.timeout_seconds * timeout_multiplier
        stdout = ""
        stderr = ""
        exit_code = -1
        timed_out = False
        # FWS-backed tasks must run with --local so the agent inherits the mock
        # service environment, including when fws was started at run scope.
        use_local = OPENCLAW_AGENT_LOCAL or requires_fws or (fws_env is not None)

        session_plan = _build_task_session_plan(task)

        def _run_once(
            current_session_id: str,
            current_timeout_seconds: float,
            current_prompt: str,
        ) -> tuple[str, str, int, bool]:
            run_stdout = ""
            run_stderr = ""
            run_exit_code = -1
            run_timed_out = False
            try:
                command = [
                    "openclaw",
                    "agent",
                    "--agent",
                    agent_id,
                    "--session-id",
                    current_session_id,
                    "--message",
                    current_prompt,
                ]
                if use_local:
                    command.append("--local")
                result = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    cwd=str(workspace),
                    check=False,
                )
                run_stdout = result.stdout
                run_stderr = result.stderr
                run_exit_code = result.returncode
            except FileNotFoundError as exc:
                run_stderr = f"openclaw command not found: {exc}"
            return run_stdout, run_stderr, run_exit_code, run_timed_out

        executed_session_ids: List[str] = []
        current_session_id = session_id
        for index, session_spec in enumerate(session_plan):
            prompt_text = str(session_spec.get("prompt") or task.prompt).strip() or task.prompt
            if index == 0 and not initial_session_id:
                current_session_id = f"{task.task_id}_s{index + 1}_{int(time.time() * 1000)}"
            elif session_spec.get("new_session"):
                current_session_id = f"{task.task_id}_s{index + 1}_{int(time.time() * 1000)}"
            if current_session_id not in executed_session_ids:
                executed_session_ids.append(current_session_id)
            run_stdout, run_stderr, run_exit_code, run_timed_out = _run_once(
                current_session_id,
                timeout_seconds,
                prompt_text,
            )
            stdout = f"{stdout}\n{run_stdout}".strip() if stdout else run_stdout
            stderr = f"{stderr}\n{run_stderr}".strip() if stderr else run_stderr
            exit_code = run_exit_code
            timed_out = run_timed_out
            if timed_out or (exit_code not in (0, -1) and "openclaw command not found" not in str(stderr)):
                break

        if defer_transcript_load:
            transcript = []
        else:
            transcript = _load_transcripts_for_session_ids(agent_id, executed_session_ids, start_time)

        if (
            not defer_transcript_load
            and not transcript
            and not timed_out
            and exit_code in (0, -1)
            and "openclaw command not found" not in str(stderr)
        ):
            logger.warning(
                "Empty transcript for %s; retrying task execution once (session sync fallback).",
                task.task_id,
            )
            if cleanup_sessions:
                cleanup_agent_sessions(agent_id)
            retry_session_id = f"{session_id}_retry"
            retry_started_at = time.time()
            retry_stdout, retry_stderr, retry_exit_code, retry_timed_out = _run_once(
                retry_session_id, timeout_seconds, task.prompt
            )
            stdout = f"{stdout}\n{retry_stdout}".strip() if stdout else retry_stdout
            stderr = f"{stderr}\n{retry_stderr}".strip() if stderr else retry_stderr
            exit_code = retry_exit_code
            timed_out = retry_timed_out
            transcript = _load_transcript(agent_id, retry_session_id, retry_started_at)

        should_retry_error, retry_reason = _is_transient_provider_error(transcript)
        if (
            not defer_transcript_load
            and should_retry_error
            and not timed_out
            and exit_code in (0, -1)
            and "openclaw command not found" not in str(stderr)
        ):
            logger.warning(
                "Transient provider error for %s; retrying task execution once. reason=%s",
                task.task_id,
                retry_reason,
            )
            time.sleep(1.5)
            if cleanup_sessions:
                cleanup_agent_sessions(agent_id)
            retry_session_id = f"{session_id}_provider_retry"
            retry_started_at = time.time()
            retry_stdout, retry_stderr, retry_exit_code, retry_timed_out = _run_once(
                retry_session_id, timeout_seconds, task.prompt
            )
            stdout = f"{stdout}\n{retry_stdout}".strip() if stdout else retry_stdout
            stderr = f"{stderr}\n{retry_stderr}".strip() if stderr else retry_stderr
            exit_code = retry_exit_code
            timed_out = retry_timed_out
            transcript = _load_transcript(agent_id, retry_session_id, retry_started_at)

        usage = _extract_usage_from_transcript(transcript)
        llm_calls = _extract_llm_calls_from_transcript(transcript)
        execution_time = time.time() - start_time

        status = "success"
        if timed_out:
            status = "timeout"
        if not transcript:
            status = "error"
        if exit_code not in (0, -1) and not timed_out:
            status = "error"
        if stderr and "openclaw command not found" in str(stderr):
            status = "error"

        if verbose:
            logger.info("   [VERBOSE] Exit code: %s", exit_code)
            logger.info("   [VERBOSE] Execution time: %.2fs", execution_time)
            logger.info("   [VERBOSE] Workspace: %s", workspace)
            if stdout:
                logger.info("   [VERBOSE] Stdout (first 1000 chars):\n%s", stdout[:1000])
            if stderr:
                logger.info("   [VERBOSE] Stderr:\n%s", stderr[:1000])
            logger.info("   [VERBOSE] Transcript entries: %d", len(transcript))

            for entry in transcript:
                if entry.get("type") == "message":
                    msg = entry.get("message", {})
                    role = msg.get("role", "unknown")
                    content = msg.get("content", "")
                    if role == "assistant":
                        preview = content[:500] + "..." if len(content) > 500 else content
                        logger.info("   [VERBOSE] Agent response: %s", preview)
                    elif role == "user":
                        preview = content[:200] + "..." if len(content) > 200 else content
                        logger.info("   [VERBOSE] User message: %s", preview)

            if workspace.exists():
                logger.info("   [VERBOSE] Workspace files after task:")
                for f in sorted(workspace.rglob("*")):
                    if f.is_file():
                        try:
                            size = f.stat().st_size
                            logger.info("      %s (%d bytes)", f.relative_to(workspace), size)
                        except OSError:
                            logger.info("      %s", f.relative_to(workspace))

        return {
            "agent_id": agent_id,
            "task_id": task.task_id,
            "final_session_id": current_session_id,
            "executed_session_ids": executed_session_ids,
            "status": status,
            "transcript": transcript,
            "llm_calls": llm_calls,
            "llm_models": sorted({str(call.get("model")) for call in llm_calls if call.get("model")}),
            "usage": usage,
            "workspace": str(workspace),
            "exit_code": exit_code,
            "timed_out": timed_out,
            "execution_time": execution_time,
            "stdout": stdout,
            "stderr": stderr,
        }
    finally:
        if fws_env is not None:
            stop_fws(fws_env)


def run_openclaw_prompt(
    *,
    agent_id: str,
    prompt: str,
    workspace: Path,
    timeout_seconds: float,
) -> Dict[str, Any]:
    """Run a single OpenClaw prompt for helper agents like the judge."""
    # Clean up previous session transcripts so we can reliably find this
    # prompt's transcript (OpenClaw uses its own UUID-based naming).
    cleanup_agent_sessions(agent_id)

    start_time = time.time()
    workspace.mkdir(parents=True, exist_ok=True)
    session_id = f"judge_{int(time.time() * 1000)}"
    stdout = ""
    stderr = ""
    exit_code = -1
    timed_out = False

    chunks = [
        prompt[i : i + MAX_OPENCLAW_MESSAGE_CHARS]
        for i in range(0, max(1, len(prompt)), MAX_OPENCLAW_MESSAGE_CHARS)
    ]
    if len(chunks) > 1:
        total_chunks = len(chunks)
        chunks = [
            (
                f"You are receiving a long prompt in {total_chunks} parts.\n"
                f"This is NOT the final part. Reply with ONLY a single period (.) and nothing else.\n\n"
                f"Part 1/{total_chunks}:\n{chunks[0]}"
            )
        ] + [
            (
                f"This is NOT the final part. Reply with ONLY a single period (.) and nothing else.\n\n"
                f"Part {i + 2}/{total_chunks}:\n{chunks[i + 1]}"
                if i + 2 < total_chunks
                else (
                    f"Part {i + 2}/{total_chunks} (FINAL PART):\n{chunks[i + 1]}\n\n"
                    "All parts received. Now process the COMPLETE prompt above and respond accordingly."
                )
            )
            for i in range(0, total_chunks - 1)
        ]
    for chunk in chunks:
        try:
            command = [
                "openclaw",
                "agent",
                "--agent",
                agent_id,
                "--session-id",
                session_id,
                "--message",
                chunk,
            ]
            if OPENCLAW_AGENT_LOCAL:
                command.append("--local")
            result = subprocess.run(
                command,
                capture_output=True,
                text=True,
                cwd=str(workspace),
                check=False,
            )
            stdout += result.stdout
            stderr += result.stderr
            exit_code = result.returncode
            if result.returncode not in (0, -1):
                break
        except FileNotFoundError as exc:
            stderr += f"openclaw command not found: {exc}"
            break

    transcript = _load_transcript(agent_id, session_id, start_time)
    execution_time = time.time() - start_time

    status = "success"
    if timed_out:
        status = "timeout"
    if not transcript:
        status = "error"
    if exit_code not in (0, -1) and not timed_out:
        status = "error"
    if stderr and "openclaw command not found" in str(stderr):
        status = "error"

    return {
        "agent_id": agent_id,
        "status": status,
        "transcript": transcript,
        "workspace": str(workspace),
        "exit_code": exit_code,
        "timed_out": timed_out,
        "execution_time": execution_time,
        "stdout": stdout,
        "stderr": stderr,
    }


def _build_task_session_plan(task: Task) -> List[Dict[str, Any]]:
    sessions = task.frontmatter.get("sessions") if isinstance(task.frontmatter, dict) else None
    if isinstance(sessions, list) and sessions:
        normalized: List[Dict[str, Any]] = []
        for index, session in enumerate(sessions):
            if not isinstance(session, dict):
                continue
            prompt = str(session.get("prompt") or "").strip()
            if not prompt:
                continue
            normalized.append(
                {
                    "id": session.get("id") or f"session_{index + 1}",
                    "prompt": prompt,
                    "new_session": bool(session.get("new_session", False)),
                }
            )
        if normalized:
            return normalized
    return [{"id": "main", "prompt": task.prompt, "new_session": False}]


def _load_transcripts_for_session_ids(
    agent_id: str,
    session_ids: List[str],
    started_at: float,
) -> List[Dict[str, Any]]:
    combined: List[Dict[str, Any]] = []
    seen: set[str] = set()
    for session_id in session_ids:
        if session_id in seen:
            continue
        seen.add(session_id)
        combined.extend(_load_transcript(agent_id, session_id, started_at))
    return _dedupe_transcript_entries(combined)
