#!/usr/bin/env python3
"""
PinchBench - OpenClaw Agent Benchmarking System

This script orchestrates benchmarking of OpenClaw agents using tasks loaded
from the tasks/ directory.
"""
# /// script
# requires-python = ">=3.10"
# dependencies = [
#     "pyyaml>=6.0.1",
#     "python-dotenv>=1.0.0",
# ]
# ///

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import logging
import os
import shutil
import statistics
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Any, Set

from dotenv import load_dotenv
import yaml

# Load environment variables from .env file
# scripts/ is at: EcoClaw-Bench/experiments/dataset/pinchbench/scripts/
# .env is at: EcoClaw-Bench/.env
# So we need to go up 5 levels
ENV_FILE = Path(__file__).parent.parent.parent.parent.parent / ".env"
if ENV_FILE.exists():
    load_dotenv(ENV_FILE)

from lib_agent import (
    cleanup_agent_sessions,
    _extract_llm_calls_from_transcript,
    _extract_usage_from_transcript,
    _get_agent_store_dir,
    _cleanup_stale_lock_files,
    _load_transcript,
    _pending_transcript_lock_paths,
    _resolve_session_file_from_store,
    ensure_agent_exists,
    execute_openclaw_task,
    normalize_benchmark_model_id,
    slugify_model,
)
from lib_fws import fws_available, is_fws_task, start_fws, stop_fws
from lib_grading import GradeResult, grade_task
from lib_tasks import Task, TaskLoader


# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s - %(levelname)s - %(message)s",
    handlers=[logging.StreamHandler(sys.stdout), logging.FileHandler("benchmark.log")],
)

logger = logging.getLogger("benchmark")
eval_logger = logging.getLogger("benchmark.eval")
_eval_log_file = os.environ.get("PINCHBENCH_EVAL_LOG_FILE", "").strip()
if _eval_log_file and not eval_logger.handlers:
    eval_logger.setLevel(logging.INFO)
    eval_handler = logging.FileHandler(_eval_log_file, encoding="utf-8")
    eval_handler.setFormatter(logging.Formatter("%(asctime)s - %(levelname)s - %(message)s"))
    eval_logger.addHandler(eval_handler)
    eval_logger.propagate = False


def _wait_for_continuous_session_unlock(agent_id: str) -> bool:
    timeout_seconds = float(
        os.environ.get("PINCHBENCH_CONTINUOUS_UNLOCK_WAIT_SECONDS", "420")
    )
    poll_seconds = float(
        os.environ.get("PINCHBENCH_CONTINUOUS_UNLOCK_POLL_SECONDS", "2")
    )
    stale_grace_seconds = float(
        os.environ.get("PINCHBENCH_CONTINUOUS_UNLOCK_STALE_GRACE_SECONDS", "90")
    )
    agent_dir = _get_agent_store_dir(agent_id)
    deadline = time.time() + timeout_seconds
    last_logged_locks: tuple[str, ...] = ()

    while True:
        pending_locks = _pending_transcript_lock_paths(agent_dir, "", agent_id)
        if not pending_locks:
            return True

        # Best-effort stale sweep in case the writer died after the previous poll.
        pending_locks = _cleanup_stale_lock_files(pending_locks)
        if not pending_locks:
            logger.info("Cleared stale continual transcript locks for %s", agent_id)
            return True

        resolved_session_file = _resolve_session_file_from_store(agent_id)
        transcript_exists = bool(resolved_session_file and resolved_session_file.exists())
        oldest_lock_age = 0.0
        for path in pending_locks:
            try:
                oldest_lock_age = max(oldest_lock_age, time.time() - path.stat().st_mtime)
            except OSError:
                continue

        # Generate/eval is now decoupled. If the transcript is already durable and
        # a lock lingers well past the grace window, continuing is safer than
        # blocking the entire continual run on a stale writer lock.
        if transcript_exists and oldest_lock_age >= stale_grace_seconds:
            logger.warning(
                "Proceeding past lingering continual transcript locks for %s; transcript exists and oldest lock age is %.1fs: %s",
                agent_id,
                oldest_lock_age,
                [path.name for path in pending_locks],
            )
            return False

        lock_names = tuple(path.name for path in pending_locks)
        if lock_names != last_logged_locks:
            logger.info(
                "Waiting for continual session unlock on %s; pending locks: %s",
                agent_id,
                list(lock_names),
            )
            last_logged_locks = lock_names

        if time.time() >= deadline:
            logger.warning(
                "Timed out waiting for continual session unlock on %s; locks still present: %s",
                agent_id,
                list(lock_names),
            )
            return False

        time.sleep(poll_seconds)


def _make_json_safe(value: Any) -> Any:
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, dict):
        return {str(k): _make_json_safe(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_make_json_safe(item) for item in value]
    if isinstance(value, tuple):
        return [_make_json_safe(item) for item in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    return str(value)


def _append_jsonl(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(_make_json_safe(payload), ensure_ascii=False) + "\n")


def _snapshot_workspace_for_task(
    *,
    run_id: str,
    job_index: int,
    task_id: str,
    workspace_path: str,
) -> str:
    if not workspace_path:
        return workspace_path
    source_workspace = Path(workspace_path)
    if not source_workspace.exists():
        return workspace_path

    snapshot_root = Path(f"/tmp/pinchbench/{run_id}/workspace_snapshots")
    snapshot_root.mkdir(parents=True, exist_ok=True)
    snapshot_path = snapshot_root / f"job_{job_index:04d}_{task_id}"
    if snapshot_path.exists():
        shutil.rmtree(snapshot_path)
    shutil.copytree(source_workspace, snapshot_path)
    return str(snapshot_path)


def _salvage_continuous_job_transcript(job: Dict[str, Any]) -> bool:
    result = job.get("result", {})
    if result.get("transcript"):
        return False

    agent_id = str(job.get("agent_id") or "")
    final_session_id = str(job.get("final_session_id") or "")
    if not agent_id:
        return False

    reloaded = _load_transcript(agent_id, final_session_id, time.time(), log_success=False)
    if not reloaded:
        return False

    span = job.get("transcript_span", {}) if isinstance(job.get("transcript_span"), dict) else {}
    start = max(0, int(span.get("start", 0) or 0))
    end = len(reloaded)
    sliced = reloaded[start:end]

    result["transcript"] = sliced
    result["usage"] = _extract_usage_from_transcript(sliced)
    result["llm_calls"] = _extract_llm_calls_from_transcript(sliced)
    result["llm_models"] = sorted(
        {str(call.get("model")) for call in result["llm_calls"] if call.get("model")}
    )
    span["end"] = end
    span["length"] = max(0, end - start)
    job["transcript_span"] = span
    job["result"] = result
    logger.info(
        "Salvaged continual transcript for %s after unlock wait: %s entries",
        job.get("task_id", "unknown"),
        len(sliced),
    )
    return True


def _transcript_debug_dump(transcript: List[Dict[str, Any]]) -> str:
    return json.dumps(_make_json_safe(transcript), ensure_ascii=False, indent=2)


def _format_progress_bar(current: int, total: int, width: int = 24) -> str:
    if total <= 0:
        return "[{}]".format("-" * width)
    ratio = max(0.0, min(1.0, current / total))
    filled = int(ratio * width)
    return "[{}{}]".format("#" * filled, "-" * (width - filled))


def _log_eval_snapshot(
    *,
    phase: str,
    task_id: str,
    job_index: int,
    transcript_span: Dict[str, Any],
    result: Dict[str, Any],
    assistant_errors: List[Dict[str, Any]],
    grade: Optional[GradeResult] = None,
    notes: Optional[str] = None,
) -> None:
    if not eval_logger.handlers:
        return
    eval_logger.info("=" * 100)
    eval_logger.info(
        "[%s] task=%s job=%s status=%s workspace=%s span=%s",
        phase,
        task_id,
        job_index,
        result.get("status"),
        result.get("workspace", ""),
        transcript_span,
    )
    if grade is not None:
        eval_logger.info(
            "[%s] grade=%.1f/%.1f type=%s notes=%s",
            phase,
            grade.score,
            grade.max_score,
            grade.grading_type,
            grade.notes or "",
        )
    elif notes:
        eval_logger.info("[%s] notes=%s", phase, notes)
    usage = result.get("usage", {})
    if usage:
        eval_logger.info("[%s] usage=%s", phase, json.dumps(_make_json_safe(usage), ensure_ascii=False))
    if assistant_errors:
        eval_logger.info(
            "[%s] assistant_errors=%s",
            phase,
            json.dumps(_make_json_safe(assistant_errors), ensure_ascii=False, indent=2),
        )
    eval_logger.info("[%s] transcript=%s", phase, _transcript_debug_dump(result.get("transcript", [])))


class OpenClawAgent:
    """Scaffold for OpenClaw agent creation and execution."""

    def __init__(self, agent_id: str, config: Optional[Dict[str, Any]] = None):
        self.agent_id = agent_id
        self.config = config or {}
        logger.info(f"Initialized OpenClawAgent: {agent_id}")

    def execute_task(self, task: Task, simulate: bool = False) -> Dict[str, Any]:
        """
        Execute a task with this agent.

        Args:
            task: The Task object to execute
            simulate: If True, simulates execution for demonstration

        Returns:
            Dictionary containing execution results
        """
        if simulate:
            logger.info("Simulate flag no longer supported for execute_task")
        raise NotImplementedError("Use execute_openclaw_task helper for real runs")


class BenchmarkRunner:
    """Orchestrates benchmark execution across tasks and agents."""

    def __init__(self, tasks_dir: Path):
        self.task_loader = TaskLoader(tasks_dir)
        self.tasks: List[Task] = []
        self.agents: List[OpenClawAgent] = []
        logger.info("Initialized BenchmarkRunner")

    def load_tasks(self) -> None:
        """Load all tasks from the tasks directory."""
        logger.info("Loading tasks...")
        self.tasks = self.task_loader.load_all_tasks()
        logger.info(f"Loaded {len(self.tasks)} tasks")

    def create_agent(self, agent_id: str, config: Optional[Dict[str, Any]] = None) -> OpenClawAgent:
        """
        Create a new OpenClaw agent for benchmarking.

        Args:
            agent_id: Unique identifier for the agent
            config: Optional configuration dictionary

        Returns:
            OpenClawAgent instance
        """
        logger.info(f"Creating agent: {agent_id}")
        agent = OpenClawAgent(agent_id, config)
        self.agents.append(agent)
        return agent

    def run_benchmark(
        self, agent: OpenClawAgent, task_ids: Optional[List[str]] = None, simulate: bool = False
    ) -> List[Dict[str, Any]]:
        """
        Run benchmark for an agent on specified tasks.

        Args:
            agent: The OpenClawAgent to benchmark
            task_ids: Optional list of task IDs to run. If None, runs all tasks.
            simulate: If True, simulates execution for demonstration

        Returns:
            List of result dictionaries
        """
        # Filter tasks if specific IDs provided
        if task_ids:
            tasks_to_run = [t for t in self.tasks if t.task_id in task_ids]
            logger.info(f"🎯 Running benchmark on {len(tasks_to_run)} specified tasks")
        else:
            tasks_to_run = self.tasks
            logger.info(f"🎯 Running benchmark on all {len(tasks_to_run)} tasks")

        results = []
        for i, task in enumerate(tasks_to_run, 1):
            logger.info(f"\n{'=' * 80}")
            logger.info(f"📋 Task {i}/{len(tasks_to_run)}")
            logger.info(f"{'=' * 80}")
            result = agent.execute_task(task, simulate=simulate)
            results.append(result)

        logger.info(f"\n{'=' * 80}")
        logger.info(f"✨ Benchmark complete! Executed {len(results)} tasks")
        logger.info(f"{'=' * 80}")

        # Print summary
        total_time = sum(r["execution_time"] for r in results)
        logger.info(f"\n📊 BENCHMARK SUMMARY")
        logger.info(f"   Agent: {agent.agent_id}")
        logger.info(f"   Tasks completed: {len(results)}")
        logger.info(f"   Total execution time: {total_time:.2f}s")
        logger.info(f"   Average time per task: {total_time / len(results):.2f}s")

        return results

    def print_task_summary(self) -> None:
        """Print a summary of all loaded tasks."""
        if not self.tasks:
            logger.warning("No tasks loaded")
            return

        print("\n" + "=" * 80)
        print(f"LOADED TASKS SUMMARY ({len(self.tasks)} tasks)")
        print("=" * 80)

        for task in self.tasks:
            print(f"\n[{task.task_id}] {task.name}")
            print(f"  Category: {task.category}")
            print(f"  Grading: {task.grading_type}")
            print(f"  Timeout: {task.timeout_seconds}s")
            print(f"  Criteria: {len(task.grading_criteria)} items")
            print(
                f"  Prompt: {task.prompt[:100]}..."
                if len(task.prompt) > 100
                else f"  Prompt: {task.prompt}"
            )

        print("\n" + "=" * 80)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="PinchBench OpenClaw Benchmark Runner")
    parser.add_argument(
        "--model",
        required=False,
        help="Model identifier (e.g., anthropic/claude-sonnet-4)",
    )
    parser.add_argument(
        "--suite",
        default=os.environ.get("TOKENPILOT_SUITE")
        or os.environ.get("ECOCLAW_SUITE")
        or "all",
        help='Tasks to run: "all" (local supported set), "all-upstream", "automated-only", or comma-separated IDs',
    )
    parser.add_argument(
        "--output-dir",
        default=None,
        help="Results directory for the active PinchBench method path",
    )
    parser.add_argument(
        "--timeout-multiplier",
        type=float,
        default=float(
            os.environ.get("TOKENPILOT_TIMEOUT_MULTIPLIER")
            or os.environ.get("ECOCLAW_TIMEOUT_MULTIPLIER")
            or "1.0"
        ),
        help="Scale all task timeouts",
    )
    parser.add_argument(
        "--runs",
        type=int,
        default=int(os.environ.get("TOKENPILOT_RUNS") or os.environ.get("ECOCLAW_RUNS") or "1"),
        help="Number of runs per task for averaging",
    )
    parser.add_argument(
        "--parallel",
        type=int,
        default=None,
        help="Number of fully isolated task runs to execute in parallel",
    )
    parser.add_argument(
        "--session-mode",
        type=str,
        choices=["isolated", "continuous"],
        default=os.environ.get("TOKENPILOT_SESSION_MODE")
        or os.environ.get("ECOCLAW_SESSION_MODE")
        or "isolated",
        help="Transcript/session isolation mode: isolated (default) or continuous (sequential accumulated transcript with per-task slicing)",
    )
    parser.add_argument(
        "--judge",
        default=None,
        help="Judge model identifier (default: openrouter/anthropic/claude-opus-4.5)",
    )
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        help="Enable verbose logging (shows transcript contents, workspace files, etc.)",
    )
    parser.add_argument(
        "--generate-only",
        action="store_true",
        help="Generate transcripts/results only and skip all grading.",
    )
    parser.add_argument(
        "--max-llm-calls-per-task",
        type=int,
        default=int(os.environ.get("PINCHBENCH_MAX_LLM_CALLS_PER_TASK", "60")),
        help="Hard cap for assistant LLM calls per task (0 disables guard).",
    )
    parser.add_argument(
        "--max-tool-calls-per-task",
        type=int,
        default=int(os.environ.get("PINCHBENCH_MAX_TOOL_CALLS_PER_TASK", "120")),
        help="Hard cap for tool calls per task (0 disables guard).",
    )
    return parser.parse_args()


def _load_local_dataset_policy(tasks_dir: Path) -> Dict[str, Any]:
    policy_path = tasks_dir / "local_policy.yaml"
    if not policy_path.exists():
        return {
            "default_exclude_task_ids": [],
            "default_exclude_prefixes": [],
        }

    data = yaml.safe_load(policy_path.read_text(encoding="utf-8")) or {}
    return {
        "default_exclude_task_ids": list(data.get("default_exclude_task_ids", []) or []),
        "default_exclude_prefixes": list(data.get("default_exclude_prefixes", []) or []),
    }


def _apply_local_dataset_policy(tasks: List[Task], policy: Dict[str, Any]) -> List[Task]:
    excluded_ids: Set[str] = set(policy.get("default_exclude_task_ids", []) or [])
    excluded_prefixes = tuple(policy.get("default_exclude_prefixes", []) or [])

    filtered: List[Task] = []
    excluded: List[str] = []
    for task in tasks:
        if task.task_id in excluded_ids or any(task.task_id.startswith(prefix) for prefix in excluded_prefixes):
            excluded.append(task.task_id)
            continue
        filtered.append(task)

    if excluded:
        logger.info(
            "Applied local dataset policy: excluded %s upstream tasks: %s",
            len(excluded),
            ", ".join(excluded),
        )

    return filtered


def _select_tasks(tasks: List[Task], suite: str, policy: Dict[str, Any]) -> List[Task]:
    suite = (suite or "all").strip()

    if suite == "all":
        return _apply_local_dataset_policy(tasks, policy)

    if suite == "all-upstream":
        return tasks

    if suite == "automated-only":
        return [task for task in _apply_local_dataset_policy(tasks, policy) if task.grading_type == "automated"]

    explicit_ids = {task_id.strip() for task_id in suite.split(",") if task_id.strip()}
    return [task for task in tasks if task.task_id in explicit_ids]


def _next_run_id(run_root: Path) -> str:
    run_root.mkdir(parents=True, exist_ok=True)
    existing = []
    for entry in run_root.iterdir():
        if entry.is_dir() and entry.name.isdigit():
            existing.append(int(entry.name))
    next_id = (max(existing) + 1) if existing else 1
    return f"{next_id:04d}"


def _count_tool_calls_from_transcript(transcript: List[Dict[str, Any]]) -> int:
    """Count toolCall blocks in assistant message content."""
    count = 0
    for entry in transcript:
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        content = message.get("content")
        if not isinstance(content, list):
            continue
        for item in content:
            if isinstance(item, dict) and item.get("type") == "toolCall":
                count += 1
    return count


def _extract_assistant_errors(transcript: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    errors: List[Dict[str, Any]] = []
    for entry in transcript:
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        if not isinstance(message, dict) or message.get("role") != "assistant":
            continue
        error_message = message.get("errorMessage")
        stop_reason = message.get("stopReason")
        if error_message or stop_reason == "error":
            errors.append(
                {
                    "provider": message.get("provider"),
                    "model": message.get("model"),
                    "stop_reason": stop_reason,
                    "error_message": error_message,
                }
            )
    return errors


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
                if "text" in item:
                    parts.append(_message_content_to_text(item.get("text")))
                elif "content" in item:
                    parts.append(_message_content_to_text(item.get("content")))
                elif item.get("type") == "toolCall":
                    parts.append("[toolCall]")
                elif item.get("type") == "toolResult":
                    parts.append("[toolResult]")
            else:
                parts.append(_message_content_to_text(item))
        return "\n".join(part for part in parts if part)
    if isinstance(content, dict):
        text = content.get("text")
        if text is not None:
            return _message_content_to_text(text)
    return str(content)


def _normalize_text_for_match(value: str) -> str:
    return " ".join(value.split()).strip()


def _find_user_prompt_index(
    transcript: List[Dict[str, Any]],
    prompt: str,
    start_index: int,
) -> Optional[int]:
    prompt_norm = _normalize_text_for_match(prompt)
    if not prompt_norm:
        return None
    for idx in range(max(0, start_index), len(transcript)):
        entry = transcript[idx]
        if entry.get("type") != "message":
            continue
        message = entry.get("message", {})
        if not isinstance(message, dict) or message.get("role") != "user":
            continue
        content_norm = _normalize_text_for_match(_message_content_to_text(message.get("content")))
        if not content_norm:
            continue
        if prompt_norm == content_norm or prompt_norm in content_norm:
            return idx
    return None


def _task_prompt_sequence(task: Task) -> List[str]:
    sessions = task.frontmatter.get("sessions") if isinstance(task.frontmatter, dict) else None
    prompts: List[str] = []
    if isinstance(sessions, list):
        for session in sessions:
            if not isinstance(session, dict):
                continue
            prompt = str(session.get("prompt") or "").strip()
            if prompt:
                prompts.append(prompt)
    if prompts:
        return prompts
    prompt = str(task.prompt or "").strip()
    return [prompt] if prompt else []


def _find_task_start_and_cursor(
    transcript: List[Dict[str, Any]],
    task: Task,
    start_index: int,
) -> tuple[Optional[int], int]:
    prompts = _task_prompt_sequence(task)
    if not prompts:
        return None, start_index

    cursor = max(0, start_index)
    first_start: Optional[int] = None
    for prompt in prompts:
        match = _find_user_prompt_index(transcript, prompt, cursor)
        if match is None:
            return None, start_index
        if first_start is None:
            first_start = match
        cursor = match + 1
    return first_start, cursor


def _grade_execution_result(
    *,
    task: Task,
    execution_result: Dict[str, Any],
    skill_dir: Path,
    verbose: bool,
    judge_model: Optional[str],
    judge_agent_prefix: str,
    max_llm_calls_per_task: int,
    max_tool_calls_per_task: int,
) -> tuple[GradeResult, Dict[str, Any]]:
    llm_call_count = len(execution_result.get("llm_calls", []))
    tool_call_count = _count_tool_calls_from_transcript(execution_result.get("transcript", []))
    guard_triggered = False
    guard_notes: List[str] = []
    if max_llm_calls_per_task > 0 and llm_call_count > max_llm_calls_per_task:
        guard_triggered = True
        guard_notes.append(
            f"llm_calls={llm_call_count} exceeds max_llm_calls_per_task={max_llm_calls_per_task}"
        )
    if max_tool_calls_per_task > 0 and tool_call_count > max_tool_calls_per_task:
        guard_triggered = True
        guard_notes.append(
            f"tool_calls={tool_call_count} exceeds max_tool_calls_per_task={max_tool_calls_per_task}"
        )

    if guard_triggered:
        note = "; ".join(guard_notes)
        logger.warning("Guard triggered for %s: %s", task.task_id, note)
        execution_result["status"] = "error"
        execution_result["stderr"] = (
            f"{execution_result.get('stderr', '').strip()}\nGuard triggered: {note}".strip()
        )
        execution_result["transcript"] = []
        execution_result["llm_calls"] = []
        execution_result["llm_models"] = []
        execution_result["usage"] = {}
        grade = GradeResult(
            task_id=task.task_id,
            score=0.0,
            max_score=1.0,
            grading_type=task.grading_type,
            breakdown={},
            notes=f"Guard triggered: {'; '.join(guard_notes)}",
        )
    else:
        execution_error = execution_result.get("stderr", "") if execution_result.get("status") == "error" else None
        try:
            grade_kwargs = dict(
                task=task,
                execution_result=execution_result,
                skill_dir=skill_dir,
                verbose=verbose,
            )
            if judge_model:
                grade_kwargs["judge_model"] = judge_model
            grade_kwargs["judge_agent_prefix"] = judge_agent_prefix
            grade = grade_task(**grade_kwargs)
        except Exception as exc:
            if execution_error:
                note = f"Execution failed: {execution_error}; Grading failed: {exc}"
            else:
                note = f"Grading failed: {exc}"
            logger.warning("Task grading failed for %s, continuing: %s", task.task_id, exc)
            grade = GradeResult(
                task_id=task.task_id,
                score=0.0,
                max_score=1.0,
                grading_type=task.grading_type,
                breakdown={},
                notes=note,
            )

    return grade, {
        "llm_calls": llm_call_count,
        "tool_calls": tool_call_count,
        "guard_triggered": guard_triggered,
    }


def _finalize_continuous_jobs(
    *,
    completed_jobs: List[Dict[str, Any]],
    tasks_by_id: Dict[str, Task],
    agent_id: str,
    skill_dir: Path,
    verbose: bool,
    judge_model: Optional[str],
    run_id: str,
    max_llm_calls_per_task: int,
    max_tool_calls_per_task: int,
) -> None:
    transcript = _load_transcript(agent_id, "", 0)
    if not transcript:
        logger.warning(
            "Deferred continual grading could not load final transcript for %s; leaving per-task slices empty.",
            agent_id,
        )
        transcript = []

    boundaries: List[Optional[int]] = []
    search_cursor = 0
    for job in completed_jobs:
        task = tasks_by_id[job["task_id"]]
        boundary, next_cursor = _find_task_start_and_cursor(transcript, task, search_cursor)
        boundaries.append(boundary)
        if boundary is not None:
            search_cursor = next_cursor

    for idx, job in enumerate(completed_jobs):
        task = tasks_by_id[job["task_id"]]
        start = boundaries[idx]
        next_start: Optional[int] = None
        for later in boundaries[idx + 1 :]:
            if later is not None:
                next_start = later
                break

        if start is None:
            sliced_transcript: List[Dict[str, Any]] = []
            span_start = 0
            span_end = 0
        else:
            span_start = start
            span_end = next_start if next_start is not None else len(transcript)
            sliced_transcript = transcript[span_start:span_end]

        result = dict(job["result"])
        result["transcript"] = sliced_transcript
        result["usage"] = _extract_usage_from_transcript(sliced_transcript)
        result["llm_calls"] = _extract_llm_calls_from_transcript(sliced_transcript)
        result["llm_models"] = sorted(
            {str(call.get("model")) for call in result["llm_calls"] if call.get("model")}
        )
        if sliced_transcript and result.get("status") == "error":
            if not result.get("timed_out") and result.get("exit_code") in (0, -1):
                result["status"] = "success"

        judge_agent_prefix = f"bench-judge-{run_id}-j{job['job_index']:04d}"
        grade, call_counts = _grade_execution_result(
            task=task,
            execution_result=result,
            skill_dir=skill_dir,
            verbose=verbose,
            judge_model=judge_model,
            judge_agent_prefix=judge_agent_prefix,
            max_llm_calls_per_task=max_llm_calls_per_task,
            max_tool_calls_per_task=max_tool_calls_per_task,
        )

        job["result"] = result
        job["grade"] = grade
        job["call_counts"] = call_counts
        job["transcript_span"] = {
            "mode": "continuous",
            "start": span_start,
            "end": span_end,
            "length": max(0, span_end - span_start),
            "deferred": True,
        }
        assistant_errors = _extract_assistant_errors(sliced_transcript)
        _log_eval_snapshot(
            phase="final",
            task_id=task.task_id,
            job_index=int(job["job_index"]),
            transcript_span=job["transcript_span"],
            result=result,
            assistant_errors=assistant_errors,
            grade=grade,
        )
        score_pct = grade.score / grade.max_score * 100 if grade.max_score > 0 else 0
        status_emoji = "✅" if grade.score >= grade.max_score else "⚠️" if grade.score > 0 else "❌"
        logger.info(
            "%s Final grade %s: %.1f/%.1f (%.0f%%) - %s",
            status_emoji,
            task.task_id,
            grade.score,
            grade.max_score,
            score_pct,
            grade.grading_type,
        )
        if grade.notes:
            logger.info("   Final notes: %s", grade.notes[:200])


def _run_progress_grader_loop(
    *,
    completed_jobs: List[Dict[str, Any]],
    completed_jobs_lock: threading.Lock,
    stop_event: threading.Event,
    tasks_by_id: Dict[str, Task],
    agent_id: str,
    skill_dir: Path,
    verbose: bool,
    judge_model: Optional[str],
    run_id: str,
    max_llm_calls_per_task: int,
    max_tool_calls_per_task: int,
    progress_log_path: Path,
    poll_interval_seconds: float = 5.0,
) -> None:
    graded_keys: set[tuple[str, int]] = set()
    enable_async_llm_judge = os.environ.get("PINCHBENCH_ASYNC_PROGRESS_ENABLE_LLM_JUDGE", "").lower() == "true"
    cached_transcript: List[Dict[str, Any]] = []
    loaded_job_count = -1
    loaded_after_stop = False

    while True:
        with completed_jobs_lock:
            jobs_snapshot = [dict(job) for job in completed_jobs]

        if not jobs_snapshot and stop_event.is_set():
            break
        if not jobs_snapshot:
            stop_event.wait(poll_interval_seconds)
            continue

        should_reload_transcript = len(jobs_snapshot) != loaded_job_count or (stop_event.is_set() and not loaded_after_stop)
        if should_reload_transcript:
            cached_transcript = _load_transcript(agent_id, "", 0, log_success=False) or []
            loaded_job_count = len(jobs_snapshot)
            if stop_event.is_set():
                loaded_after_stop = True
        transcript = cached_transcript

        boundaries: List[Optional[int]] = []
        search_cursor = 0
        for job in jobs_snapshot:
            task = tasks_by_id[job["task_id"]]
            boundary, next_cursor = _find_task_start_and_cursor(transcript, task, search_cursor)
            boundaries.append(boundary)
            if boundary is not None:
                search_cursor = next_cursor

        progress_made = False
        for idx, job in enumerate(jobs_snapshot):
            key = (str(job["task_id"]), int(job["job_index"]))
            if key in graded_keys:
                continue

            task = tasks_by_id[job["task_id"]]
            start = boundaries[idx]
            next_start: Optional[int] = None
            for later in boundaries[idx + 1 :]:
                if later is not None:
                    next_start = later
                    break

            # Progress grading only touches tasks whose slice is stable.
            # During the run that means "we've already observed the next user prompt".
            # Once the run stops, the last task can also be graded.
            if start is None:
                continue
            if next_start is None and not stop_event.is_set():
                continue

            span_start = start
            span_end = next_start if next_start is not None else len(transcript)
            sliced_transcript = transcript[span_start:span_end]

            result = dict(job["result"])
            result["transcript"] = sliced_transcript
            result["usage"] = _extract_usage_from_transcript(sliced_transcript)
            result["llm_calls"] = _extract_llm_calls_from_transcript(sliced_transcript)
            result["llm_models"] = sorted(
                {str(call.get("model")) for call in result["llm_calls"] if call.get("model")}
            )
            if sliced_transcript and result.get("status") == "error":
                if not result.get("timed_out") and result.get("exit_code") in (0, -1):
                    result["status"] = "success"

            assistant_errors = _extract_assistant_errors(sliced_transcript)

            progress_record: Dict[str, Any] = {
                "timestamp": time.time(),
                "run_id": run_id,
                "task_id": task.task_id,
                "job_index": int(job["job_index"]),
                "mode": "continuous_progress",
                "transcript_span": {
                    "start": span_start,
                    "end": span_end,
                    "length": max(0, span_end - span_start),
                },
                "workspace": result.get("workspace", ""),
                "status": result.get("status"),
                "usage": result.get("usage", {}),
                "assistant_errors": assistant_errors,
            }

            if task.grading_type == "automated" or enable_async_llm_judge:
                judge_agent_prefix = f"bench-progress-judge-{run_id}-j{job['job_index']:04d}"
                progress_judge_model = judge_model if enable_async_llm_judge else None
                grade, call_counts = _grade_execution_result(
                    task=task,
                    execution_result=result,
                    skill_dir=skill_dir,
                    verbose=verbose,
                    judge_model=progress_judge_model,
                    judge_agent_prefix=judge_agent_prefix,
                    max_llm_calls_per_task=max_llm_calls_per_task,
                    max_tool_calls_per_task=max_tool_calls_per_task,
                )
                progress_record["grading"] = {
                    "mode": "provisional",
                    "score": grade.score,
                    "max_score": grade.max_score,
                    "grading_type": grade.grading_type,
                    "notes": grade.notes,
                }
                progress_record["call_counts"] = call_counts
                logger.info(
                    "📝 Progress grade %s: %.1f/%.1f (%s)",
                    task.task_id,
                    grade.score,
                    grade.max_score,
                    grade.grading_type,
                )
                _log_eval_snapshot(
                    phase="progress",
                    task_id=task.task_id,
                    job_index=int(job["job_index"]),
                    transcript_span=progress_record["transcript_span"],
                    result=result,
                    assistant_errors=assistant_errors,
                    grade=grade,
                )
            else:
                progress_record["grading"] = {
                    "mode": "provisional",
                    "score": None,
                    "max_score": 1.0,
                    "grading_type": task.grading_type,
                    "notes": "Waiting for final grading; async LLM judge disabled",
                }
                logger.info(
                    "📝 Progress ready %s: transcript span=%s..%s, waiting for final %s grading",
                    task.task_id,
                    span_start,
                    span_end,
                    task.grading_type,
                )
                _log_eval_snapshot(
                    phase="progress",
                    task_id=task.task_id,
                    job_index=int(job["job_index"]),
                    transcript_span=progress_record["transcript_span"],
                    result=result,
                    assistant_errors=assistant_errors,
                    notes="Waiting for final grading; async LLM judge disabled",
                )

            _append_jsonl(progress_log_path, progress_record)
            graded_keys.add(key)
            progress_made = True

        if stop_event.is_set() and len(graded_keys) >= len(jobs_snapshot):
            break
        if not progress_made:
            stop_event.wait(poll_interval_seconds)


def _run_task_job(
    *,
    task: Task,
    task_index: int,
    total_tasks: int,
    run_index: int,
    runs_per_task: int,
    job_index: int,
    model: str,
    run_id: str,
    timeout_multiplier: float,
    skill_dir: Path,
    verbose: bool,
    judge_model: Optional[str],
    session_mode: str = "isolated",
    agent_id_override: Optional[str] = None,
    agent_workspace_override: Optional[Path] = None,
    initial_session_id: Optional[str] = None,
    transcript_start_index: int = 0,
    max_llm_calls_per_task: int = 0,
    max_tool_calls_per_task: int = 0,
    defer_continuous_grading: bool = False,
    generate_only: bool = False,
    manage_fws: bool = True,
) -> Dict[str, Any]:
    progress_bar = _format_progress_bar(task_index, total_tasks)
    progress_pct = (task_index / total_tasks * 100.0) if total_tasks else 0.0
    logger.info("\n%s", "=" * 80)
    logger.info(
        "📋 Task %s/%s %s %5.1f%% (Run %s/%s) [job %s]%s",
        task_index,
        total_tasks,
        progress_bar,
        progress_pct,
        run_index + 1,
        runs_per_task,
        job_index,
        "",
    )
    logger.info("%s", "=" * 80)

    model_slug = slugify_model(model)
    agent_workspace = agent_workspace_override or Path(
        f"/tmp/pinchbench/{run_id}/agent_workspace_j{job_index:04d}"
    )

    agent_id = agent_id_override or f"bench-{model_slug}-{run_id}-j{job_index:04d}"
    ensure_agent_exists(agent_id, model, agent_workspace)
    if session_mode != "continuous":
        cleanup_agent_sessions(agent_id)

    execution_error = None
    try:
        result = execute_openclaw_task(
            task=task,
            agent_id=agent_id,
            model_id=model,
            run_id=f"{run_id}-r{run_index + 1}-j{job_index:04d}",
            timeout_multiplier=timeout_multiplier,
            skill_dir=skill_dir,
            agent_workspace=agent_workspace,
            verbose=verbose,
            session_mode=session_mode,
            cleanup_sessions=(session_mode != "continuous"),
            defer_transcript_load=bool(
                (defer_continuous_grading and not generate_only) and session_mode == "continuous"
            ),
            initial_session_id=initial_session_id,
            manage_fws=manage_fws,
        )
    except Exception as exc:
        execution_error = str(exc)
        logger.warning("Task execution failed for %s, continuing: %s", task.task_id, exc)
        result = {
            "agent_id": agent_id,
            "task_id": task.task_id,
            "final_session_id": initial_session_id or "",
            "executed_session_ids": [initial_session_id] if initial_session_id else [],
            "status": "error",
            "transcript": [],
            "llm_calls": [],
            "llm_models": [],
            "usage": {},
            "workspace": "",
            "exit_code": -1,
            "timed_out": False,
            "execution_time": 0.0,
            "stdout": "",
            "stderr": execution_error,
        }

    transcript_end_index = len(result.get("transcript", []))
    transcript_slice_start = 0
    if session_mode == "continuous" and not defer_continuous_grading:
        transcript_slice_start = max(0, min(transcript_start_index, transcript_end_index))
        sliced_transcript = result.get("transcript", [])[transcript_slice_start:transcript_end_index]
        result["transcript"] = sliced_transcript
        result["usage"] = _extract_usage_from_transcript(sliced_transcript)
        result["llm_calls"] = _extract_llm_calls_from_transcript(sliced_transcript)
        result["llm_models"] = sorted(
            {str(call.get("model")) for call in result["llm_calls"] if call.get("model")}
        )
    if generate_only:
        if session_mode == "continuous":
            result["workspace"] = _snapshot_workspace_for_task(
                run_id=run_id,
                job_index=job_index,
                task_id=task.task_id,
                workspace_path=result.get("workspace", ""),
            )
        grade = GradeResult(
            task_id=task.task_id,
            score=0.0,
            max_score=1.0,
            grading_type=task.grading_type,
            breakdown={},
            notes="Generate-only phase; grading deferred",
        )
        call_counts = {
            "llm_calls": len(result.get("llm_calls", [])),
            "tool_calls": _count_tool_calls_from_transcript(result.get("transcript", [])),
            "guard_triggered": False,
        }
    elif defer_continuous_grading and session_mode == "continuous":
        result["workspace"] = _snapshot_workspace_for_task(
            run_id=run_id,
            job_index=job_index,
            task_id=task.task_id,
            workspace_path=result.get("workspace", ""),
        )
        grade = GradeResult(
            task_id=task.task_id,
            score=0.0,
            max_score=1.0,
            grading_type=task.grading_type,
            breakdown={},
            notes="Deferred continual grading",
        )
        call_counts = {
            "llm_calls": len(result.get("llm_calls", [])),
            "tool_calls": _count_tool_calls_from_transcript(result.get("transcript", [])),
            "guard_triggered": False,
        }
    else:
        judge_agent_prefix = f"bench-judge-{run_id}-j{job_index:04d}"
        grade, call_counts = _grade_execution_result(
            task=task,
            execution_result=result,
            skill_dir=skill_dir,
            verbose=verbose,
            judge_model=judge_model,
            judge_agent_prefix=judge_agent_prefix,
            max_llm_calls_per_task=max_llm_calls_per_task,
            max_tool_calls_per_task=max_tool_calls_per_task,
        )

    if generate_only:
        logger.info("⏳ Task %s generated; grading skipped", task.task_id)
    elif defer_continuous_grading and session_mode == "continuous":
        logger.info("⏳ Task %s deferred for final grading", task.task_id)
    else:
        score_pct = grade.score / grade.max_score * 100 if grade.max_score > 0 else 0
        status_emoji = "✅" if grade.score >= grade.max_score else "⚠️" if grade.score > 0 else "❌"
        logger.info(
            "%s Task %s: %.1f/%.1f (%.0f%%) - %s",
            status_emoji,
            task.task_id,
            grade.score,
            grade.max_score,
            score_pct,
            grade.grading_type,
        )
        if grade.notes:
            logger.info("   Notes: %s", grade.notes[:200])

    return {
        "task_id": task.task_id,
        "task_index": task_index,
        "run_index": run_index,
        "job_index": job_index,
        "agent_id": result.get("agent_id", ""),
        "final_session_id": result.get("final_session_id", ""),
        "transcript_span": {
            "mode": session_mode,
            "start": transcript_slice_start,
            "end": transcript_end_index,
            "length": max(0, transcript_end_index - transcript_slice_start),
            "deferred": bool(
                generate_only or (defer_continuous_grading and session_mode == "continuous")
            ),
        },
        "call_counts": call_counts,
        "result": result,
        "grade": grade,
    }


def _load_ascii_art(script_dir: Path, filename: str) -> str | None:
    """Load ASCII art from a local file if available."""
    art_path = script_dir / filename
    try:
        return art_path.read_text(encoding="utf-8").rstrip("\n")
    except FileNotFoundError:
        return None


def _supports_truecolor() -> bool:
    if os.environ.get("NO_COLOR"):
        return False
    return sys.stdout.isatty()


def _get_git_version(script_dir: Path) -> str:
    try:
        result = subprocess.run(
            ["git", "rev-parse", "--short", "HEAD"],
            capture_output=True,
            text=True,
            timeout=2,
            check=False,
            cwd=script_dir,
        )
    except (subprocess.SubprocessError, FileNotFoundError, OSError):
        return ""
    if result.returncode != 0:
        return ""
    return result.stdout.strip()


def _colorize_gradient(ascii_art: str) -> str:
    if not _supports_truecolor():
        return ascii_art
    lines = ascii_art.splitlines()
    if not lines:
        return ascii_art
    last_index = max(len(lines) - 1, 1)
    colored_lines = []
    for idx, line in enumerate(lines):
        t = idx / last_index
        green_blue = int(255 * (1 - t))
        colored_lines.append(f"\x1b[38;2;255;{green_blue};{green_blue}m{line}\x1b[0m")
    return "\n".join(colored_lines)


def _compute_efficiency_summary(
    task_entries: List[Dict[str, Any]],
    grades_by_task_id: Dict[str, Dict[str, Any]],
) -> Dict[str, Any]:
    """Compute aggregate token efficiency metrics across all tasks.

    Returns a dict with total token usage, cost, and efficiency ratios
    (score per token, score per dollar) so that different models can be
    compared not just on quality but also on resource consumption.
    """
    total_input_tokens = 0
    total_output_tokens = 0
    total_cache_read_tokens = 0
    total_cache_write_tokens = 0
    total_cache_hit_tokens = 0
    total_tokens = 0
    total_cost_usd = 0.0
    total_requests = 0
    total_usage_available_requests = 0
    total_usage_missing_requests = 0
    total_execution_time = 0.0
    tasks_with_usage = 0

    per_task_efficiency: List[Dict[str, Any]] = []
    for entry in task_entries:
        usage = entry.get("usage", {})
        task_id = entry["task_id"]
        grading = grades_by_task_id.get(task_id, {})
        score = float(grading.get("mean", 0.0))

        inp = int(usage.get("input_tokens", 0))
        out = int(usage.get("output_tokens", 0))
        cache_read = int(usage.get("cache_read_tokens", 0))
        cache_write = int(usage.get("cache_write_tokens", 0))
        cache_hit = int(usage.get("cache_hit_tokens", cache_read))
        tot = int(usage.get("total_tokens", 0))
        cost = float(usage.get("cost_usd", 0.0) or 0.0)
        reqs = int(usage.get("request_count", 0))
        usage_available_reqs = int(usage.get("usage_available_count", 0))
        usage_missing_reqs = int(usage.get("usage_missing_count", 0))
        exec_time = float(entry.get("execution_time", 0.0) or 0.0)

        total_input_tokens += inp
        total_output_tokens += out
        total_cache_read_tokens += cache_read
        total_cache_write_tokens += cache_write
        total_cache_hit_tokens += cache_hit
        total_tokens += tot
        total_cost_usd += cost
        total_requests += reqs
        total_usage_available_requests += usage_available_reqs
        total_usage_missing_requests += usage_missing_reqs
        total_execution_time += exec_time

        if tot > 0:
            tasks_with_usage += 1

        per_task_efficiency.append({
            "task_id": task_id,
            "score": round(score, 4),
            "total_tokens": tot,
            "cache_hit_tokens": cache_hit,
            "cost_usd": round(cost, 6),
            "tokens_per_score_point": round(tot / score, 1) if score > 0 else None,
        })

    # Aggregate scores
    all_scores = [
        float(g.get("mean", 0.0)) for g in grades_by_task_id.values()
    ]
    total_score = sum(all_scores)
    num_tasks = len(all_scores)

    summary: Dict[str, Any] = {
        "total_tokens": total_tokens,
        "total_input_tokens": total_input_tokens,
        "total_output_tokens": total_output_tokens,
        "total_cache_read_tokens": total_cache_read_tokens,
        "total_cache_write_tokens": total_cache_write_tokens,
        "total_cache_hit_tokens": total_cache_hit_tokens,
        "total_cost_usd": round(total_cost_usd, 6),
        "total_requests": total_requests,
        "usage_available_requests": total_usage_available_requests,
        "usage_missing_requests": total_usage_missing_requests,
        "total_execution_time_seconds": round(total_execution_time, 2),
        "tasks_with_usage_data": tasks_with_usage,
        "tokens_per_task": round(total_tokens / num_tasks, 1) if num_tasks > 0 else 0,
        "cost_per_task_usd": round(total_cost_usd / num_tasks, 6) if num_tasks > 0 else 0,
        "score_per_1k_tokens": (
            round(total_score / (total_tokens / 1000), 6)
            if total_tokens > 0
            else None
        ),
        "score_per_dollar": (
            round(total_score / total_cost_usd, 4)
            if total_cost_usd > 0
            else None
        ),
        "per_task": per_task_efficiency,
    }
    return summary


def _log_efficiency_summary(
    efficiency: Dict[str, Any],
    grades_by_task_id: Dict[str, Dict[str, Any]],
) -> None:
    """Log a human-readable token efficiency summary."""
    all_scores = [
        float(g.get("mean", 0.0)) for g in grades_by_task_id.values()
    ]
    mean_score = statistics.mean(all_scores) if all_scores else 0.0

    logger.info("\n%s", "=" * 80)
    logger.info("📊 TOKEN EFFICIENCY SUMMARY")
    logger.info("%s", "=" * 80)
    logger.info(
        "   Total tokens used: %s (input: %s, output: %s)",
        f"{efficiency['total_tokens']:,}",
        f"{efficiency['total_input_tokens']:,}",
        f"{efficiency['total_output_tokens']:,}",
    )
    logger.info(
        "   Cache tokens (read/write): %s / %s",
        f"{efficiency.get('total_cache_read_tokens', 0):,}",
        f"{efficiency.get('total_cache_write_tokens', 0):,}",
    )
    logger.info("   Total API requests: %s", f"{efficiency['total_requests']:,}")
    if efficiency.get("usage_missing_requests", 0) > 0:
        logger.warning(
            "   Usage unavailable for %s/%s requests (provider returned missing/zero token usage).",
            f"{efficiency.get('usage_missing_requests', 0):,}",
            f"{efficiency.get('total_requests', 0):,}",
        )
    if efficiency["total_cost_usd"] > 0:
        logger.info("   Total cost: $%.4f", efficiency["total_cost_usd"])
    logger.info(
        "   Avg tokens/task: %s",
        f"{efficiency['tokens_per_task']:,.0f}",
    )
    logger.info("   Mean score: %.4f", mean_score)
    if efficiency.get("score_per_1k_tokens") is not None:
        logger.info(
            "   Score per 1K tokens: %.4f (higher = more efficient)",
            efficiency["score_per_1k_tokens"],
        )
    if efficiency.get("score_per_dollar") is not None:
        logger.info(
            "   Score per dollar: %.4f (higher = more cost-efficient)",
            efficiency["score_per_dollar"],
        )
    logger.info("%s", "=" * 80)


def _log_category_summary(
    task_entries: List[Dict[str, Any]],
    tasks_by_id: Dict[str, Any],
) -> None:
    """Log a summary grouped by category, matching the PinchBench website format."""
    # Group scores by category
    category_scores: Dict[str, Dict[str, float]] = {}
    
    for entry in task_entries:
        task_id = entry["task_id"]
        task = tasks_by_id.get(task_id)
        if not task:
            continue
        
        category = task.category.upper() if task.category else "UNCATEGORIZED"
        grading = entry.get("grading", {})
        mean_score = float(grading.get("mean", 0.0))
        max_score = 1.0  # Each task is scored 0-1
        
        if category not in category_scores:
            category_scores[category] = {"earned": 0.0, "possible": 0.0, "task_count": 0}
        
        category_scores[category]["earned"] += mean_score
        category_scores[category]["possible"] += max_score
        category_scores[category]["task_count"] += 1
    
    # Calculate overall totals
    total_earned = sum(c["earned"] for c in category_scores.values())
    total_possible = sum(c["possible"] for c in category_scores.values())
    overall_pct = (total_earned / total_possible * 100) if total_possible > 0 else 0
    
    logger.info("\n%s", "=" * 80)
    logger.info("🦀 PINCHBENCH SCORE SUMMARY")
    logger.info("%s", "=" * 80)
    logger.info("")
    logger.info("   Overall Score: %.1f%% (%.1f / %.1f)", overall_pct, total_earned, total_possible)
    logger.info("")
    logger.info("   %-20s %8s %12s", "CATEGORY", "SCORE", "TASKS")
    logger.info("   %s", "-" * 44)
    
    # Sort categories alphabetically for consistent output
    for category in sorted(category_scores.keys()):
        data = category_scores[category]
        pct = (data["earned"] / data["possible"] * 100) if data["possible"] > 0 else 0
        task_count = int(data["task_count"])
        task_label = "task" if task_count == 1 else "tasks"
        
        # Color indicator based on score
        if pct >= 90:
            indicator = "🟢"
        elif pct >= 70:
            indicator = "🟡"
        else:
            indicator = "🔴"
        
        logger.info(
            "   %s %-17s %6.1f%% %6d %s",
            indicator,
            category,
            pct,
            task_count,
            task_label,
        )
    
    logger.info("   %s", "-" * 44)
    logger.info("%s", "=" * 80)


def main():
    """Main entry point for the benchmark script."""
    # Determine tasks directory
    script_dir = Path(__file__).parent
    skill_root = script_dir.parent  # Parent of scripts/ is the skill root
    tasks_dir = skill_root / "tasks"

    logger.info("🦞🦀🦐 PinchBench - OpenClaw Benchmarking")
    ascii_crab = _load_ascii_art(skill_root, "crab.txt")
    if ascii_crab:
        print("\n" + _colorize_gradient(ascii_crab) + "\n")
    else:
        print("\n" + "🦀 " * 30)
        print("🦀 " * 30 + "\n")
    logger.info("🦞🦀🦐 Starting PinchBench 🦐🦀🦞")
    time.sleep(5)

    if not tasks_dir.exists():
        logger.error(f"❌ Tasks directory not found: {tasks_dir}")
        sys.exit(1)

    args = _parse_args()
    if not args.model:
        logger.error("Missing required argument: --model")
        sys.exit(2)

    # Determine judge model: --judge arg > TOKENPILOT_JUDGE/ECOCLAW_JUDGE env > default
    args.model = normalize_benchmark_model_id(args.model)
    judge_model = args.judge
    if not judge_model:
        judge_model = os.environ.get("TOKENPILOT_JUDGE") or os.environ.get("ECOCLAW_JUDGE")
    if not judge_model:
        judge_model = "openrouter/anthropic/claude-opus-4.5"
    judge_model = normalize_benchmark_model_id(judge_model)
    logger.info("Using judge model: %s", judge_model)

    logger.info("🔧 Initializing BenchmarkRunner...")
    runner = BenchmarkRunner(tasks_dir)

    logger.info("📂 Loading tasks from directory...")
    runner.load_tasks()

    model_slug = slugify_model(args.model)
    run_root = Path("/tmp/pinchbench")
    run_id = _next_run_id(run_root)
    skill_dir = skill_root

    # Determine parallel jobs: --parallel arg > TOKENPILOT_PARALLEL/ECOCLAW_PARALLEL env > default 1
    parallel_jobs = args.parallel
    if parallel_jobs is None:
        parallel_jobs = int(os.environ.get("TOKENPILOT_PARALLEL") or os.environ.get("ECOCLAW_PARALLEL", "1"))
    parallel_jobs = max(1, int(parallel_jobs))
    logger.info("Parallel isolated jobs: %s", parallel_jobs)
    session_mode = args.session_mode
    logger.info("Session mode: %s", session_mode)
    logger.info(
        "Per-task call guards: max_llm_calls=%s, max_tool_calls=%s",
        args.max_llm_calls_per_task,
        args.max_tool_calls_per_task,
    )

    if session_mode == "continuous" and parallel_jobs != 1:
        logger.error("--session-mode continuous requires --parallel 1")
        sys.exit(2)
    os.environ["PINCHBENCH_SESSION_MODE"] = session_mode

    local_dataset_policy = _load_local_dataset_policy(tasks_dir)
    tasks_to_run = _select_tasks(runner.tasks, args.suite, local_dataset_policy)
    logger.info("Selected %s tasks for suite=%s (loaded=%s)", len(tasks_to_run), args.suite, len(runner.tasks))
    results = []
    grades_by_task_id = {}
    tasks_by_id = {task.task_id: task for task in tasks_to_run}

    runs_per_task = max(1, args.runs)
    jobs: List[Dict[str, Any]] = []
    job_counter = 1
    for i, task in enumerate(tasks_to_run, 1):
        for run_index in range(runs_per_task):
            jobs.append(
                {
                    "task": task,
                    "task_index": i,
                    "run_index": run_index,
                    "job_index": job_counter,
                }
            )
            job_counter += 1

    logger.info("Scheduling %s total task runs", len(jobs))
    completed_jobs: List[Dict[str, Any]] = []
    completed_jobs_lock = threading.Lock()
    progress_grader_thread: Optional[threading.Thread] = None
    progress_grader_stop_event: Optional[threading.Event] = None
    run_scoped_fws_env: Optional[Dict[str, Optional[str]]] = None
    continuous_agent_id: Optional[str] = None
    continuous_agent_workspace: Optional[Path] = None
    continuous_session_id: Optional[str] = None
    isolated_agent_id: Optional[str] = None
    isolated_agent_workspace: Optional[Path] = None
    generate_only = args.generate_only or (
        os.environ.get("PINCHBENCH_GENERATE_ONLY", "").strip().lower() == "true"
    )
    defer_continuous_grading = session_mode == "continuous" and not generate_only
    manage_fws_per_task = True
    try:
        if session_mode == "continuous" and any(is_fws_task(task.frontmatter) for task in tasks_to_run):
            if not fws_available():
                logger.warning(
                    "Continuous run includes fws-backed tasks, but fws is not available; proceeding without run-scoped startup."
                )
            else:
                run_scoped_fws_env = start_fws()
                manage_fws_per_task = False
                logger.info("Started run-scoped fws for continuous benchmark run")

        if parallel_jobs == 1:
            transcript_cursor_by_agent: Dict[str, int] = {}
            if session_mode == "continuous":
                continuous_agent_id = f"bench-{model_slug}-{run_id}-serial"
                continuous_agent_workspace = Path(f"/tmp/pinchbench/{run_id}/agent_workspace_serial")
                continuous_session_id = f"bench-{model_slug}-{run_id}-continuous-s1-{int(time.time() * 1000)}"
                ensure_agent_exists(continuous_agent_id, args.model, continuous_agent_workspace)
                cleanup_agent_sessions(continuous_agent_id)
                transcript_cursor_by_agent[continuous_agent_id] = 0
                if defer_continuous_grading:
                    bench_root = skill_root.parent.parent.parent
                    progress_jsonl_env = os.environ.get("PINCHBENCH_EVAL_JSONL_FILE", "").strip()
                    if progress_jsonl_env:
                        progress_log_path = Path(progress_jsonl_env)
                    else:
                        progress_log_path = bench_root / "log" / f"pinchbench_{run_id}_eval.jsonl"
                    if progress_log_path.exists():
                        progress_log_path.unlink()
                    progress_grader_stop_event = threading.Event()
                    progress_grader_thread = threading.Thread(
                        target=_run_progress_grader_loop,
                        kwargs={
                            "completed_jobs": completed_jobs,
                            "completed_jobs_lock": completed_jobs_lock,
                            "stop_event": progress_grader_stop_event,
                            "tasks_by_id": tasks_by_id,
                            "agent_id": continuous_agent_id,
                            "skill_dir": skill_dir,
                            "verbose": args.verbose,
                            "judge_model": judge_model,
                            "run_id": run_id,
                            "max_llm_calls_per_task": args.max_llm_calls_per_task,
                            "max_tool_calls_per_task": args.max_tool_calls_per_task,
                            "progress_log_path": progress_log_path,
                        },
                        daemon=True,
                    )
                    progress_grader_thread.start()
                    logger.info("Async continual progress grading log: %s", progress_log_path)
            if session_mode == "isolated":
                isolated_agent_id = f"bench-{model_slug}-{run_id}-isolated"
                isolated_agent_workspace = Path(f"/tmp/pinchbench/{run_id}/agent_workspace_isolated")
                ensure_agent_exists(isolated_agent_id, args.model, isolated_agent_workspace)
                cleanup_agent_sessions(isolated_agent_id)
            for job in jobs:
                agent_id_override = None
                workspace_override = None
                if session_mode == "continuous":
                    agent_id_override = continuous_agent_id
                    workspace_override = continuous_agent_workspace
                elif session_mode == "isolated":
                    agent_id_override = isolated_agent_id
                    workspace_override = isolated_agent_workspace
                transcript_start = 0
                if agent_id_override and session_mode == "continuous":
                    transcript_start = transcript_cursor_by_agent.get(agent_id_override, 0)
                completed_job = _run_task_job(
                        task=job["task"],
                        task_index=job["task_index"],
                        total_tasks=len(tasks_to_run),
                        run_index=job["run_index"],
                        runs_per_task=runs_per_task,
                        job_index=job["job_index"],
                        model=args.model,
                        run_id=run_id,
                        timeout_multiplier=args.timeout_multiplier,
                        skill_dir=skill_dir,
                        verbose=args.verbose,
                        judge_model=judge_model,
                        session_mode=session_mode,
                        agent_id_override=agent_id_override,
                        agent_workspace_override=workspace_override,
                        initial_session_id=continuous_session_id if session_mode == "continuous" else None,
                        transcript_start_index=transcript_start,
                        max_llm_calls_per_task=args.max_llm_calls_per_task,
                        max_tool_calls_per_task=args.max_tool_calls_per_task,
                        defer_continuous_grading=defer_continuous_grading,
                        generate_only=generate_only,
                        manage_fws=manage_fws_per_task,
                    )
                with completed_jobs_lock:
                    completed_jobs.append(completed_job)
                if agent_id_override and session_mode == "continuous":
                    unlocked = _wait_for_continuous_session_unlock(agent_id_override)
                    _salvage_continuous_job_transcript(completed_job)
                    if not unlocked:
                        logger.warning(
                            "Proceeding without a clean continual unlock for agent %s; prior session locks may still be draining or stale.",
                            agent_id_override,
                        )
                if agent_id_override and completed_jobs and not defer_continuous_grading:
                    latest = completed_jobs[-1]
                    span = latest.get("transcript_span", {})
                    transcript_cursor_by_agent[agent_id_override] = int(
                        span.get("end", transcript_cursor_by_agent.get(agent_id_override, 0))
                    )
                if session_mode == "continuous":
                    latest_session_id = completed_job.get("final_session_id")
                    if isinstance(latest_session_id, str) and latest_session_id.strip():
                        continuous_session_id = latest_session_id.strip()
        else:
            with ThreadPoolExecutor(max_workers=parallel_jobs) as executor:
                futures = {
                    executor.submit(
                        _run_task_job,
                        task=job["task"],
                        task_index=job["task_index"],
                        total_tasks=len(tasks_to_run),
                        run_index=job["run_index"],
                        runs_per_task=runs_per_task,
                        job_index=job["job_index"],
                        model=args.model,
                        run_id=run_id,
                        timeout_multiplier=args.timeout_multiplier,
                        skill_dir=skill_dir,
                        verbose=args.verbose,
                        judge_model=judge_model,
                        session_mode=session_mode,
                        max_llm_calls_per_task=args.max_llm_calls_per_task,
                        max_tool_calls_per_task=args.max_tool_calls_per_task,
                        generate_only=generate_only,
                        manage_fws=manage_fws_per_task,
                    ): job
                    for job in jobs
                }
                for future in as_completed(futures):
                    job = futures[future]
                    try:
                        completed_jobs.append(future.result())
                    except Exception as exc:
                        task = job["task"]
                        logger.warning("Task execution crashed for %s, continuing: %s", task.task_id, exc)
                        fallback_grade = GradeResult(
                            task_id=task.task_id,
                            score=0.0,
                            max_score=1.0,
                            grading_type=task.grading_type,
                            breakdown={},
                            notes=f"Parallel worker crashed: {exc}",
                        )
                        completed_jobs.append(
                            {
                                "task_id": task.task_id,
                                "task_index": job["task_index"],
                                "run_index": job["run_index"],
                                "agent_id": "",
                                "transcript_span": {
                                    "mode": session_mode,
                                    "start": 0,
                                    "end": 0,
                                    "length": 0,
                                },
                                "call_counts": {
                                    "llm_calls": 0,
                                    "tool_calls": 0,
                                    "guard_triggered": False,
                                },
                                "result": {
                                    "agent_id": "",
                                    "task_id": task.task_id,
                                    "status": "error",
                                    "transcript": [],
                                    "llm_calls": [],
                                    "llm_models": [],
                                    "usage": {},
                                    "workspace": "",
                                    "exit_code": -1,
                                    "timed_out": False,
                                    "execution_time": 0.0,
                                    "stdout": "",
                                    "stderr": str(exc),
                                },
                                "grade": fallback_grade,
                            }
                        )
    finally:
        if progress_grader_stop_event is not None:
            progress_grader_stop_event.set()
        if progress_grader_thread is not None:
            progress_grader_thread.join(timeout=60)
        if run_scoped_fws_env is not None:
            stop_fws(run_scoped_fws_env)
            logger.info("Stopped run-scoped fws for continuous benchmark run")

    completed_jobs.sort(key=lambda item: (int(item["task_index"]), int(item["run_index"])))

    if (
        parallel_jobs == 1
        and session_mode == "continuous"
        and continuous_agent_id
        and defer_continuous_grading
        and not generate_only
    ):
        _finalize_continuous_jobs(
            completed_jobs=completed_jobs,
            tasks_by_id=tasks_by_id,
            agent_id=continuous_agent_id,
            skill_dir=skill_dir,
            verbose=args.verbose,
            judge_model=judge_model,
            run_id=run_id,
            max_llm_calls_per_task=args.max_llm_calls_per_task,
            max_tool_calls_per_task=args.max_tool_calls_per_task,
        )

    for i, task in enumerate(tasks_to_run, 1):
        task_runs = [job for job in completed_jobs if job["task_id"] == task.task_id]
        if not task_runs:
            grades_by_task_id[task.task_id] = {
                "runs": [],
                "mean": 0.0,
                "std": 0.0,
                "min": 0.0,
                "max": 0.0,
            }
            continue
        task_grades = [job["grade"] for job in task_runs]
        task_scores = [grade.score for grade in task_grades]
        grades_by_task_id[task.task_id] = {
            "runs": [grade.to_dict() for grade in task_grades],
            "mean": statistics.mean(task_scores),
            "std": statistics.stdev(task_scores) if len(task_scores) > 1 else 0.0,
            "min": min(task_scores),
            "max": max(task_scores),
        }

    output_dir = args.output_dir
    if not output_dir:
        # Default to <repo_root>/results/raw/pinchbench/tokenpilot
        # skill_root is at: <repo_root>/experiments/pinchbench/dataset/
        output_dir = str(skill_root.parent.parent.parent / "results" / "raw" / "pinchbench" / "tokenpilot")
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    task_entries = []
    for job in completed_jobs:
        result = job["result"]
        task_entries.append(
            {
                "task_id": result["task_id"],
                "status": result["status"],
                "timed_out": result["timed_out"],
                "execution_time": result["execution_time"],
                "transcript_length": len(result["transcript"]),
                "transcript": result["transcript"],
                "transcript_span": job.get("transcript_span", {}),
                "call_counts": job.get("call_counts", {}),
                "llm_calls": result.get("llm_calls", []),
                "llm_models": result.get("llm_models", []),
                "usage": result.get("usage", {}),
                "workspace": result["workspace"],
                "agent_id": job.get("agent_id") or result.get("agent_id", ""),
                "stdout": result.get("stdout", ""),
                "stderr": result.get("stderr", ""),
                "grading": grades_by_task_id[result["task_id"]],
                "frontmatter": tasks_by_id[result["task_id"]].frontmatter,
            }
        )

    efficiency = _compute_efficiency_summary(task_entries, grades_by_task_id)

    aggregate = {
        "model": args.model,
        "benchmark_version": _get_git_version(skill_root),
        "run_id": run_id,
        "timestamp": time.time(),
        "suite": args.suite,
        "runs_per_task": runs_per_task,
        "parallel": parallel_jobs,
        "session_mode": session_mode,
        "max_llm_calls_per_task": args.max_llm_calls_per_task,
        "max_tool_calls_per_task": args.max_tool_calls_per_task,
        "phase": "generate" if generate_only else "full",
        "tasks": task_entries,
        "efficiency": efficiency,
    }

    output_path = output_dir / f"{run_id}_{model_slug}.json"
    safe_aggregate = _make_json_safe(aggregate)
    output_path.write_text(json.dumps(safe_aggregate, indent=2), encoding="utf-8")

    logger.info("Saved results to %s", output_path)
    _log_category_summary(task_entries, tasks_by_id)
    _log_efficiency_summary(efficiency, grades_by_task_id)
    logger.info("Upload path is deferred in the migrated mainline harness.")


if __name__ == "__main__":
    main()
