"""
PinchBench grading engine.
"""

from __future__ import annotations

import json
import logging
import os
import re
import ssl
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional
from urllib import error, request

from lib_tasks import Task


logger = logging.getLogger(__name__)


DEFAULT_JUDGE_MODEL = "tokenpilot/gpt-5.4-mini"
DEFAULT_JUDGE_AGENT_PREFIX = "bench-judge"
DEFAULT_JUDGE_TIMEOUT_SECONDS = 180


def _resolve_ssl_cafile() -> Optional[str]:
    env_path = os.environ.get("SSL_CERT_FILE")
    if env_path:
        path = Path(env_path).expanduser()
        if path.is_file():
            return str(path)
        logger.warning("SSL_CERT_FILE is set but missing: %s", env_path)

    try:
        import certifi  # type: ignore

        certifi_path = Path(certifi.where())
        if certifi_path.is_file():
            return str(certifi_path)
    except Exception:
        pass

    defaults = ssl.get_default_verify_paths()
    for candidate in (defaults.cafile, defaults.openssl_cafile):
        if not candidate:
            continue
        path = Path(candidate).expanduser()
        if path.is_file():
            return str(path)
    return None


def _urlopen_with_ssl(req: request.Request, timeout_seconds: float):
    # FWS injects HTTPS_PROXY for mock task services. The judge is an external
    # model endpoint, so inheriting that short-lived local proxy makes grading
    # fail after FWS starts or stops. Use a proxy-free opener deliberately.
    cafile = _resolve_ssl_cafile()
    handlers = [request.ProxyHandler({})]
    if cafile:
        context = ssl.create_default_context(cafile=cafile)
        handlers.append(request.HTTPSHandler(context=context))
    return request.build_opener(*handlers).open(req, timeout=timeout_seconds)


@dataclass
class GradeResult:
    task_id: str
    score: float
    max_score: float
    grading_type: str
    breakdown: Dict[str, float]
    passed: bool
    failure_modes: List[str]
    judge_summary: str
    judge_raw_response: Dict[str, Any]
    judge_response_text: str
    notes: str

    def to_dict(self) -> Dict[str, Any]:
        return {
            "task_id": self.task_id,
            "score": self.score,
            "max_score": self.max_score,
            "grading_type": self.grading_type,
            "breakdown": self.breakdown,
            "passed": self.passed,
            "failure_modes": self.failure_modes,
            "judge_summary": self.judge_summary,
            "judge_raw_response": self.judge_raw_response,
            "judge_response_text": self.judge_response_text,
            "notes": self.notes,
        }


def _derive_passed(score: float, max_score: float) -> bool:
    if max_score <= 0:
        return False
    ratio = score / max_score
    return ratio >= 0.5


def _derive_failure_modes(*, score: float, execution_status: str, notes: str, raw_response: Dict[str, Any]) -> List[str]:
    failures: List[str] = []
    if execution_status and execution_status != "success":
        failures.append("execution_error")
    if score < 0.5:
        failures.append("low_score")
    text = " ".join(
        [
            str(notes or ""),
            str(raw_response.get("notes") or ""),
            str(raw_response.get("reasoning") or ""),
            str(raw_response.get("justification") or ""),
        ]
    ).lower()
    if "timeout" in text:
        failures.append("timeout")
    if "parse" in text or "invalid" in text:
        failures.append("judge_parse_issue")
    deduped: List[str] = []
    seen = set()
    for item in failures:
        if item in seen:
            continue
        seen.add(item)
        deduped.append(item)
    return deduped


def grade_task(
    *,
    task: Task,
    execution_result: Dict[str, Any],
    skill_dir: Path,
    judge_model: str = DEFAULT_JUDGE_MODEL,
    judge_agent_prefix: str = DEFAULT_JUDGE_AGENT_PREFIX,
    judge_timeout_seconds: float = DEFAULT_JUDGE_TIMEOUT_SECONDS,
    verbose: bool = False,
) -> GradeResult:
    grading_type = task.grading_type
    if verbose:
        logger.info("   [VERBOSE] Grading task %s with type: %s", task.task_id, grading_type)
        logger.info("   [VERBOSE] Execution status: %s", execution_result.get("status", "unknown"))

    if grading_type == "automated":
        result = _grade_automated(task, execution_result, verbose=verbose)
        if verbose:
            logger.info("   [VERBOSE] Automated grade breakdown: %s", result.breakdown)
        return result
    if grading_type == "llm_judge":
        result = _grade_llm_judge(
            task=task,
            execution_result=execution_result,
            judge_model=judge_model,
            judge_agent_prefix=judge_agent_prefix,
            judge_timeout_seconds=judge_timeout_seconds,
            skill_dir=skill_dir,
            verbose=verbose,
        )
        if verbose:
            logger.info("   [VERBOSE] LLM judge breakdown: %s", result.breakdown)
        return result
    if grading_type == "hybrid":
        auto_result = _grade_automated(task, execution_result, verbose=verbose)
        llm_result = _grade_llm_judge(
            task=task,
            execution_result=execution_result,
            judge_model=judge_model,
            judge_agent_prefix=judge_agent_prefix,
            judge_timeout_seconds=judge_timeout_seconds,
            skill_dir=skill_dir,
            verbose=verbose,
        )
        return _combine_grades(task, auto_result, llm_result)
    raise ValueError(f"Unknown grading type: {grading_type}")


def _grade_automated(task: Task, execution_result: Dict[str, Any], verbose: bool = False) -> GradeResult:
    grading_code = _extract_grading_code(task)
    if not grading_code:
        return GradeResult(
            task_id=task.task_id,
            score=0.0,
            max_score=1.0,
            grading_type="automated",
            breakdown={},
            passed=False,
            failure_modes=["missing_automated_grader"],
            judge_summary="",
            judge_raw_response={},
            judge_response_text="",
            notes="No automated grading code found",
        )

    namespace: Dict[str, Any] = {}
    exec(grading_code, namespace)
    grade_func = namespace.get("grade")
    if not callable(grade_func):
        return GradeResult(
            task_id=task.task_id,
            score=0.0,
            max_score=1.0,
            grading_type="automated",
            breakdown={},
            passed=False,
            failure_modes=["missing_automated_grading_function"],
            judge_summary="",
            judge_raw_response={},
            judge_response_text="",
            notes="Automated grading function missing",
        )

    scores = grade_func(
        execution_result.get("transcript", []),
        execution_result.get("workspace", ""),
    )
    if not isinstance(scores, dict):
        scores = {}

    if verbose:
        logger.info("   [VERBOSE] Automated grading scores: %s", scores)

    total = _average_scores(scores)
    return GradeResult(
        task_id=task.task_id,
        score=total,
        max_score=1.0,
        grading_type="automated",
        breakdown=_normalize_score_dict(scores),
        passed=_derive_passed(total, 1.0),
        failure_modes=[] if _derive_passed(total, 1.0) else ["low_score"],
        judge_summary="",
        judge_raw_response={},
        judge_response_text="",
        notes="",
    )


def _grade_llm_judge(
    *,
    task: Task,
    execution_result: Dict[str, Any],
    judge_model: str,
    judge_agent_prefix: str,
    judge_timeout_seconds: float,
    skill_dir: Path,
    verbose: bool = False,
) -> GradeResult:
    del judge_agent_prefix, skill_dir
    transcript = execution_result.get("transcript", [])
    execution_status = execution_result.get("status", "unknown")

    if not transcript and execution_status != "success":
        if verbose:
            logger.info(
                "   [VERBOSE] Skipping LLM judge: status=%s, transcript empty",
                execution_status,
            )
        return GradeResult(
            task_id=task.task_id,
            score=0.0,
            max_score=1.0,
            grading_type="llm_judge",
            breakdown={},
            passed=False,
            failure_modes=["execution_error", "missing_transcript"],
            judge_summary="",
            judge_raw_response={},
            judge_response_text="",
            notes=f"Skipped: task execution failed ({execution_status}), no transcript to evaluate",
        )

    transcript_summary = _summarize_transcript(transcript)
    if verbose:
        logger.info(
            "   [VERBOSE] Transcript summary for judge (first 1000 chars):\n%s",
            transcript_summary[:1000],
        )
    workspace_content = _read_workspace_files(execution_result.get("workspace", ""))
    if verbose and workspace_content:
        logger.info(
            "   [VERBOSE] Workspace files passed to judge (first 500 chars):\n%s",
            workspace_content[:500],
        )
    rubric = task.llm_judge_rubric or _format_grading_criteria(task)
    prompt = _build_judge_prompt(task, transcript_summary, rubric, workspace_content)

    max_judge_attempts = 3
    raw_parsed: Dict[str, Any] = {}
    parsed: Dict[str, Any] = {}
    last_error = ""
    last_response_text = ""

    for attempt in range(max_judge_attempts):
        judge_result = call_judge_api(
            prompt=prompt if attempt == 0 else _build_judge_retry_prompt(task, transcript_summary, rubric, workspace_content),
            model=judge_model,
            timeout_seconds=judge_timeout_seconds,
        )
        if verbose:
            logger.info("   [VERBOSE] Judge execution status: %s", judge_result.get("status"))
            if judge_result.get("error"):
                logger.info("   [VERBOSE] Judge error: %s", judge_result.get("error"))
        last_response_text = str(judge_result.get("text", "") or "")
        if judge_result.get("status") != "success":
            last_error = str(judge_result.get("error") or judge_result.get("status") or "judge_error")
            logger.warning(
                "Judge API call failed (attempt %d/%d): %s",
                attempt + 1,
                max_judge_attempts,
                last_error,
            )
            continue

        raw_parsed = _parse_judge_text(judge_result.get("text", ""))
        if verbose:
            logger.info("   [VERBOSE] Judge raw response parsed: %s", raw_parsed)
        parsed = _normalize_judge_response(raw_parsed)
        if verbose:
            logger.info("   [VERBOSE] Normalized judge response: %s", parsed)
        if parsed.get("scores") or parsed.get("total") is not None:
            break
        logger.warning(
            "Judge returned no parseable scores for %s (attempt %d/%d)",
            task.task_id,
            attempt + 1,
            max_judge_attempts,
        )

    breakdown = parsed.get("scores", {})
    total = parsed.get("total")
    notes = parsed.get("notes", "")
    if total is None:
        notes = str(notes or last_error or "LLM judge failed: no parseable response")
        total = 0.0
    judge_summary = str(
        parsed.get("notes")
        or raw_parsed.get("notes")
        or raw_parsed.get("reasoning")
        or raw_parsed.get("justification")
        or notes
        or ""
    )
    passed = _derive_passed(float(total), 1.0)
    failure_modes = _derive_failure_modes(
        score=float(total),
        execution_status=execution_status,
        notes=str(notes),
        raw_response=raw_parsed,
    )
    return GradeResult(
        task_id=task.task_id,
        score=float(total),
        max_score=1.0,
        grading_type="llm_judge",
        breakdown=_normalize_score_dict(breakdown),
        passed=passed,
        failure_modes=failure_modes,
        judge_summary=judge_summary,
        judge_raw_response=raw_parsed,
        judge_response_text=last_response_text,
        notes=str(notes) if notes is not None else "",
    )


def _combine_grades(task: Task, auto_result: GradeResult, llm_result: GradeResult) -> GradeResult:
    weights = task.grading_weights or {"automated": 0.5, "llm_judge": 0.5}
    auto_weight = float(weights.get("automated", 0.5))
    llm_weight = float(weights.get("llm_judge", 0.5))
    total_weight = auto_weight + llm_weight
    if total_weight <= 0:
        auto_weight = llm_weight = 0.5
        total_weight = 1.0
    combined_score = (
        auto_result.score * auto_weight + llm_result.score * llm_weight
    ) / total_weight
    breakdown = {
        **{f"automated.{k}": v for k, v in auto_result.breakdown.items()},
        **{f"llm_judge.{k}": v for k, v in llm_result.breakdown.items()},
    }
    notes = " | ".join(filter(None, [auto_result.notes, llm_result.notes]))
    return GradeResult(
        task_id=task.task_id,
        score=combined_score,
        max_score=1.0,
        grading_type="hybrid",
        breakdown=breakdown,
        passed=_derive_passed(combined_score, 1.0),
        failure_modes=list(dict.fromkeys([*auto_result.failure_modes, *llm_result.failure_modes])),
        judge_summary=llm_result.judge_summary or auto_result.judge_summary,
        judge_raw_response={
            "automated": auto_result.judge_raw_response,
            "llm_judge": llm_result.judge_raw_response,
        },
        judge_response_text=llm_result.judge_response_text or auto_result.judge_response_text,
        notes=notes,
    )


def _extract_grading_code(task: Task) -> str:
    if not task.automated_checks:
        return ""
    match = re.search(r"```python\s*(.*?)\s*```", task.automated_checks, re.DOTALL)
    if not match:
        return ""
    return match.group(1)


def _average_scores(scores: Dict[str, Any]) -> float:
    values = [float(v) for v in scores.values() if isinstance(v, (int, float))]
    if not values:
        return 0.0
    return sum(values) / len(values)


def _normalize_score_dict(scores: Dict[str, Any]) -> Dict[str, float]:
    normalized: Dict[str, float] = {}
    for key, value in scores.items():
        try:
            normalized[str(key)] = float(value)
        except (TypeError, ValueError):
            continue
    return normalized


def _format_grading_criteria(task: Task) -> str:
    if not task.grading_criteria:
        return ""
    return "\n".join(f"- {criterion}" for criterion in task.grading_criteria)


def _summarize_transcript(transcript: List[Dict[str, Any]]) -> str:
    summary_parts: List[str] = []
    for event in transcript:
        if event.get("type") != "message":
            continue
        msg = event.get("message", {})
        role = msg.get("role")
        if role == "assistant":
            for item in msg.get("content", []):
                if item.get("type") == "toolCall":
                    summary_parts.append(
                        f"Tool: {item.get('name')}({json.dumps(item.get('arguments', {}))})"
                    )
                elif item.get("type") == "text":
                    text = str(item.get("text", "")).strip()
                    if text and text.upper() not in ("NO_REPLY", ".", ".."):
                        summary_parts.append(f"Assistant: {text}")
        elif role == "toolResult":
            content = msg.get("content", [])
            if content:
                result_preview = str(content[0])[:200]
                summary_parts.append(f"Result: {result_preview}")
        elif role == "user":
            content = msg.get("content", [])
            if content:
                summary_parts.append(f"User: {content[0]}")
    return "\n".join(summary_parts)


def _read_workspace_files(workspace_path: str) -> str:
    if not workspace_path:
        return ""
    workspace = Path(workspace_path)
    if not workspace.exists():
        return ""
    skip_names = {
        "BOOTSTRAP.md",
        "SOUL.md",
        "USER.md",
        "IDENTITY.md",
        "HEARTBEAT.md",
        "TOOLS.md",
        "AGENTS.md",
    }
    skip_dirs = {".git", ".openclaw", "__pycache__", "node_modules", "skills"}
    file_contents: List[str] = []
    for file_path in sorted(workspace.rglob("*")):
        if not file_path.is_file():
            continue
        rel = file_path.relative_to(workspace)
        parts = rel.parts
        if any(part.startswith(".") or part in skip_dirs for part in parts):
            continue
        if file_path.name in skip_names:
            continue
        try:
            content = file_path.read_text(encoding="utf-8")
            file_contents.append(f"### File: {rel}\n{content[:3000]}")
        except (OSError, UnicodeDecodeError):
            pass
    return "\n\n".join(file_contents)


def _build_judge_prompt(
    task: Task, transcript_summary: str, rubric: str, workspace_content: str = ""
) -> str:
    workspace_section = ""
    if workspace_content.strip():
        workspace_section = f"## Workspace Files Created by Agent\n{workspace_content}\n\n"
    return (
        "You are a grading function. Your ONLY job is to output a single JSON object.\n\n"
        "CRITICAL RULES:\n"
        "- Do NOT use any tools\n"
        "- Do NOT create files or run commands\n"
        "- Do NOT write any prose, explanation, or commentary outside the JSON\n"
        "- Respond with ONLY a JSON object — nothing else\n\n"
        "Be a strict evaluator. Reserve 1.0 for genuinely excellent performance. "
        "An average acceptable completion should score around 0.6-0.7. "
        "Deduct points for unnecessary steps, verbose output, and inefficient tool usage.\n\n"
        "## Task\n"
        f"{task.prompt}\n\n"
        "## Expected Behavior\n"
        f"{task.expected_behavior}\n\n"
        "## Agent Transcript (summarized)\n"
        f"{transcript_summary}\n\n"
        f"{workspace_section}"
        "## Grading Rubric\n"
        f"{rubric}\n\n"
        "Score each criterion from 0.0 to 1.0.\n"
        'The "total" field must also be between 0.0 and 1.0, and it must be the arithmetic mean of the criterion scores, not their sum.\n\n'
        "Respond with ONLY this JSON structure (no markdown, no code fences, no extra text):\n"
        '{"scores": {"criterion_name": 0.0}, "total": 0.0, "notes": "brief justification"}'
    )


def _build_judge_retry_prompt(
    task: Task, transcript_summary: str, rubric: str, workspace_content: str = ""
) -> str:
    return (
        _build_judge_prompt(task, transcript_summary, rubric, workspace_content)
        + "\n\nIMPORTANT: Your previous response was invalid for parsing. "
        + "Reply again with one JSON object only. No markdown, no surrounding text, no code fences."
    )


_JUDGE_SYSTEM_MSG = (
    "You are a strict grading function. "
    "Respond with ONLY a JSON object, no prose, no markdown fences, no extra text."
)


def call_judge_api(*, prompt: str, model: str, timeout_seconds: float = 120.0) -> Dict[str, Any]:
    model = (model or "").strip()
    if model.startswith("anthropic/"):
        return _judge_via_anthropic(prompt, model, timeout_seconds)
    if model.startswith("openai/"):
        return _judge_via_openai(prompt, model, timeout_seconds)
    if model.startswith("openrouter/"):
        return _judge_via_openrouter(prompt, model, timeout_seconds)
    return _judge_via_runtime_compat(prompt, model, timeout_seconds)


def _normalize_model_name_for_env(model_like: str) -> str:
    value = (model_like or "").strip()
    if value.startswith("tokenpilot/"):
        value = value.split("/", 1)[1]
    if "/" in value:
        value = value.split("/", 1)[1]
    if "gpt-5-4-mini" in value:
        value = value.replace("gpt-5-4-mini", "gpt-5.4-mini")
    return value


def _model_env_key(model_like: str) -> str:
    return re.sub(r"[^A-Z0-9]", "_", _normalize_model_name_for_env(model_like).upper())


def _judge_via_openai_compat(
    prompt: str,
    api_model: str,
    endpoint: str,
    api_key: str,
    timeout_seconds: float,
    extra_headers: Optional[Dict[str, str]] = None,
) -> Dict[str, Any]:
    payload = json.dumps(
        {
            "model": api_model,
            "messages": [
                {"role": "system", "content": _JUDGE_SYSTEM_MSG},
                {"role": "user", "content": prompt},
            ],
            "temperature": 0.0,
            "max_completion_tokens": 2048,
        }
    ).encode("utf-8")
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    if extra_headers:
        headers.update(extra_headers)
    req = request.Request(endpoint, data=payload, headers=headers, method="POST")
    try:
        with _urlopen_with_ssl(req, timeout_seconds) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        logger.error("Judge API error (%s): %s", exc.code, body)
        return {"status": "error", "text": "", "error": f"HTTP {exc.code}: {body}"}
    except error.URLError as exc:
        logger.error("Judge network error: %s", exc)
        return {"status": "error", "text": "", "error": str(exc)}
    except TimeoutError:
        return {"status": "timeout", "text": "", "error": "Request timed out"}

    choices = data.get("choices", [])
    if not choices:
        return {"status": "error", "text": "", "error": "No choices in response"}
    text = choices[0].get("message", {}).get("content", "")
    return {"status": "success", "text": text}


def _judge_via_runtime_compat(prompt: str, model: str, timeout_seconds: float) -> Dict[str, Any]:
    model_key = _model_env_key(model)
    provider = model.split("/", 1)[0] if "/" in model else ""
    provider_key = re.sub(r"[^A-Z0-9]", "_", provider.upper())
    base_url = (
        os.environ.get(f"PINCHBENCH_JUDGE_{provider_key}_BASE_URL")
        if provider_key
        else None
    ) or (
        os.environ.get(f"PINCHBENCH_MODEL_{model_key}_BASE_URL")
        or os.environ.get("TOKENPILOT_BASE_URL")
        or os.environ.get("OPENAI_BASE_URL")
    )
    api_key = (
        os.environ.get(f"PINCHBENCH_JUDGE_{provider_key}_API_KEY")
        if provider_key
        else None
    ) or (
        os.environ.get(f"PINCHBENCH_MODEL_{model_key}_API_KEY")
        or os.environ.get("TOKENPILOT_API_KEY")
        or os.environ.get("OPENAI_API_KEY")
    )
    if not base_url or not api_key:
        return {"status": "error", "text": "", "error": "runtime compat judge credentials not set"}
    bare_model = model.split("/", 1)[1] if "/" in model else model
    endpoint = base_url.rstrip("/") + "/chat/completions"
    return _judge_via_openai_compat(prompt, bare_model, endpoint, api_key, timeout_seconds)


def _judge_via_openrouter(prompt: str, model: str, timeout_seconds: float) -> Dict[str, Any]:
    api_key = os.environ.get("OPENROUTER_API_KEY")
    if not api_key:
        return {"status": "error", "text": "", "error": "OPENROUTER_API_KEY not set"}
    bare_model = model.removeprefix("openrouter/")
    return _judge_via_openai_compat(
        prompt,
        bare_model,
        "https://openrouter.ai/api/v1/chat/completions",
        api_key,
        timeout_seconds,
        extra_headers={"HTTP-Referer": "https://pinchbench.com", "X-Title": "PinchBench-Judge"},
    )


def _judge_via_openai(prompt: str, model: str, timeout_seconds: float) -> Dict[str, Any]:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return {"status": "error", "text": "", "error": "OPENAI_API_KEY not set"}
    bare_model = model.removeprefix("openai/")
    return _judge_via_openai_compat(
        prompt,
        bare_model,
        "https://api.openai.com/v1/chat/completions",
        api_key,
        timeout_seconds,
    )


def _judge_via_anthropic(prompt: str, model: str, timeout_seconds: float) -> Dict[str, Any]:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return {"status": "error", "text": "", "error": "ANTHROPIC_API_KEY not set"}
    payload = json.dumps(
        {
            "model": model.removeprefix("anthropic/"),
            "max_tokens": 2048,
            "temperature": 0.0,
            "system": _JUDGE_SYSTEM_MSG,
            "messages": [{"role": "user", "content": prompt}],
        }
    ).encode("utf-8")
    headers = {
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    req = request.Request(
        "https://api.anthropic.com/v1/messages",
        data=payload,
        headers=headers,
        method="POST",
    )
    try:
        with _urlopen_with_ssl(req, timeout_seconds) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="replace")[:500]
        except Exception:
            pass
        logger.error("Anthropic judge API error (%s): %s", exc.code, body)
        return {"status": "error", "text": "", "error": f"HTTP {exc.code}: {body}"}
    except error.URLError as exc:
        logger.error("Anthropic judge network error: %s", exc)
        return {"status": "error", "text": "", "error": str(exc)}
    except TimeoutError:
        return {"status": "timeout", "text": "", "error": "Request timed out"}

    content = data.get("content", [])
    text_parts = [item.get("text", "") for item in content if item.get("type") == "text"]
    return {"status": "success", "text": "\n".join(text_parts)}


def _looks_like_judge_payload(parsed: Dict[str, Any]) -> bool:
    if not isinstance(parsed, dict) or not parsed:
        return False
    judge_keys = {
        "scores",
        "criteria_scores",
        "criterion_scores",
        "total",
        "score",
        "overall_score",
        "total_score",
        "completionScore",
        "notes",
        "justification",
        "reasoning",
        "overall",
    }
    return any(key in parsed for key in judge_keys)


def _coerce_score_value(value: Any) -> float | None:
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return float(value)
    if isinstance(value, str):
        try:
            return float(value.strip())
        except ValueError:
            return None
    if isinstance(value, dict):
        for key in ("score", "value", "weighted_score"):
            if key in value:
                return _coerce_score_value(value[key])
    return None


def _extract_named_scores(parsed: Dict[str, Any]) -> Dict[str, float]:
    scores: Dict[str, float] = {}

    if "scores" in parsed and isinstance(parsed["scores"], dict):
        for key, value in parsed["scores"].items():
            coerced = _coerce_score_value(value)
            if coerced is not None:
                scores[str(key)] = coerced

    if "criteria_scores" in parsed:
        criteria = parsed["criteria_scores"]
        if isinstance(criteria, dict):
            for key, value in criteria.items():
                coerced = _coerce_score_value(value)
                if coerced is not None:
                    scores[str(key)] = coerced

    if "criterion_scores" in parsed:
        criteria = parsed["criterion_scores"]
        if isinstance(criteria, dict):
            for key, value in criteria.items():
                coerced = _coerce_score_value(value)
                if coerced is not None:
                    scores[str(key)] = coerced
        elif isinstance(criteria, list):
            for idx, item in enumerate(criteria, start=1):
                if isinstance(item, dict):
                    name = item.get("name") or item.get("criterion") or item.get("label") or f"criterion_{idx}"
                    coerced = _coerce_score_value(item)
                else:
                    name = f"criterion_{idx}"
                    coerced = _coerce_score_value(item)
                if coerced is not None:
                    scores[str(name)] = coerced

    for key, value in parsed.items():
        if re.fullmatch(r"criterion\d+", str(key), re.IGNORECASE):
            coerced = _coerce_score_value(value)
            if coerced is not None:
                scores[str(key)] = coerced

    return scores


def _extract_total_score(parsed: Dict[str, Any], scores: Dict[str, float]) -> float | None:
    for key in ("total", "score", "overall_score", "completionScore", "total_score"):
        if key in parsed:
            coerced = _coerce_score_value(parsed[key])
            if coerced is not None:
                return coerced

    overall = parsed.get("overall")
    if isinstance(overall, dict):
        coerced = _coerce_score_value(overall)
        if coerced is not None:
            return coerced

    if scores:
        values = [v for v in scores.values() if isinstance(v, (int, float))]
        if values:
            return sum(values) / len(values)

    return None


def _parse_judge_text(raw_text: str) -> Dict[str, Any]:
    raw_text = raw_text.strip()
    if not raw_text:
        return {}

    try:
        parsed = json.loads(raw_text)
        if isinstance(parsed, dict):
            return parsed
    except json.JSONDecodeError:
        pass

    code_block_match = re.search(r"```(?:json)?\s*(.*?)\s*```", raw_text, re.DOTALL)
    if code_block_match:
        try:
            parsed = json.loads(code_block_match.group(1))
            if isinstance(parsed, dict):
                return parsed
        except json.JSONDecodeError:
            pass

    json_candidates: List[str] = []
    brace_depth = 0
    current_json: List[str] = []
    for char in raw_text:
        if char == "{":
            if brace_depth == 0:
                current_json = []
            brace_depth += 1
        if brace_depth > 0:
            current_json.append(char)
        if char == "}":
            brace_depth -= 1
            if brace_depth == 0 and current_json:
                json_candidates.append("".join(current_json))

    for candidate in reversed(json_candidates):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict) and _looks_like_judge_payload(parsed):
                return parsed
        except json.JSONDecodeError:
            continue

    score_pattern = re.search(
        r"(?:total|overall|final)\s*(?:score)?[:\s]*(0\.\d+|1\.0+)",
        raw_text,
        re.IGNORECASE,
    )
    if score_pattern:
        try:
            total = float(score_pattern.group(1))
            if 0.0 <= total <= 1.0:
                logger.warning("Fell back to regex score extraction (total=%.2f)", total)
                return {"scores": {}, "total": total, "notes": "Score extracted from prose"}
        except ValueError:
            pass

    logger.warning("Failed to parse judge text response. Raw text (first 500 chars): %s", raw_text[:500])
    return {}


def _normalize_judge_response(parsed: Dict[str, Any]) -> Dict[str, Any]:
    result: Dict[str, Any] = {"scores": {}, "total": None, "notes": ""}
    result["scores"] = _extract_named_scores(parsed)
    result["total"] = _extract_total_score(parsed, result["scores"])

    values = [v for v in result["scores"].values() if isinstance(v, (int, float))]
    if values and result["total"] is not None and result["total"] > 1.0 and all(0.0 <= float(v) <= 1.0 for v in values):
        result["total"] = sum(values) / len(values)

    if "notes" in parsed:
        result["notes"] = str(parsed["notes"])
    elif "feedback" in parsed:
        result["notes"] = str(parsed["feedback"])
    elif "justification" in parsed:
        result["notes"] = str(parsed["justification"])
    elif "reasoning" in parsed:
        result["notes"] = str(parsed["reasoning"])
    elif "explanation" in parsed:
        result["notes"] = str(parsed["explanation"])

    return result
