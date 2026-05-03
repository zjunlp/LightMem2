from __future__ import annotations

import base64
import copy
import json
import mimetypes
import os
import random
import re
import shutil
import socket
import subprocess
import time
import uuid
import urllib.error
import urllib.request
from dataclasses import dataclass
from glob import glob
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlparse, urlunparse

from lib_tasks import ClawEvalTask


DEFAULT_USER_AGENT_MODEL = "tokenpilot/gpt-5.4-mini"


def _slugify(value: str) -> str:
    return value.replace("/", "-").replace(".", "-").replace(":", "-").lower()


def _make_agent_id(model_id: str, task_id: str) -> str:
    model_slug = _slugify(model_id).split("-", 1)[0]
    task_slug = re.sub(r"[^a-z0-9]+", "-", task_id.lower()).strip("-")
    suffix = uuid.uuid4().hex[:8]
    return f"ce-{model_slug}-{task_slug[:24]}-{suffix}"


def _task_prompt(task: ClawEvalTask) -> str:
    tools = "\n".join(f"- {name}" for name in task.declared_tools) or "- (none declared)"
    attachments = "\n".join(f"- /workspace/{path}" if not str(path).startswith("/workspace/") else f"- {path}" for path in task.attachments) or "- (none attached)"
    return (
        "You are executing a benchmark task.\n"
        "Ignore any workspace bootstrap or identity files unrelated to the task.\n"
        "Use available tools faithfully and do not fabricate tool results.\n\n"
        "## Workspace Mapping\n"
        "The current workspace directory is the logical `/workspace` root mentioned in task files.\n"
        "Paths like `/workspace/foo/bar` refer to files inside the current workspace.\n\n"
        "## Task\n"
        f"{task.prompt.strip()}\n\n"
        "## Attached Files\n"
        f"{attachments}\n\n"
        "## Declared Tools\n"
        f"{tools}\n"
    )


def _shift_localhost_port(url: str, offset: int) -> str:
    if not url or offset == 0:
        return url
    parsed = urlparse(url)
    if parsed.hostname not in {"localhost", "127.0.0.1"} or parsed.port is None:
        return url
    netloc = f"{parsed.hostname}:{parsed.port + offset}"
    return urlunparse(parsed._replace(netloc=netloc))


def _task_with_service_port_offset(task: ClawEvalTask, offset: int) -> ClawEvalTask:
    cloned = copy.deepcopy(task)
    if offset == 0:
        return cloned
    for service in cloned.services:
        port = service.get("port")
        if isinstance(port, int):
            service["port"] = port + offset
            service.setdefault("env", {})
            if isinstance(service["env"], dict):
                service["env"]["PORT"] = str(service["port"])
        for key in ("health_check", "reset_endpoint"):
            value = service.get(key)
            if isinstance(value, str) and value:
                service[key] = _shift_localhost_port(value, offset)
    return cloned


def _is_port_available(port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            sock.bind(("127.0.0.1", port))
        except OSError:
            return False
    return True


def _pick_free_port(preferred: int) -> int:
    if preferred > 0 and _is_port_available(preferred):
        return preferred
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _task_with_available_service_ports(task: ClawEvalTask) -> ClawEvalTask:
    cloned = copy.deepcopy(task)
    for service in cloned.services:
        port = service.get("port")
        if not isinstance(port, int):
            continue
        chosen = _pick_free_port(port)
        if chosen == port:
            continue
        service["port"] = chosen
        service.setdefault("env", {})
        if isinstance(service["env"], dict):
            service["env"]["PORT"] = str(chosen)
        for key in ("health_check", "reset_endpoint"):
            value = service.get(key)
            if isinstance(value, str) and value:
                parsed = urlparse(value)
                if parsed.hostname in {"localhost", "127.0.0.1"} and parsed.port is not None:
                    service[key] = urlunparse(parsed._replace(netloc=f"{parsed.hostname}:{chosen}"))
    return cloned


def _openclaw_env(config_path: Path) -> Dict[str, str]:
    env = os.environ.copy()
    home_root = str(config_path.resolve().parent.parent)
    env["OPENCLAW_CONFIG_PATH"] = str(config_path.resolve())
    env.setdefault("TOKENPILOT_OPENCLAW_HOME", home_root)
    env["HOME"] = home_root
    local_bin = str(Path(home_root) / ".local" / "bin")
    env["PATH"] = f"{local_bin}:{env.get('PATH', '')}"
    return env


def _inject_mock_service_urls(env: Dict[str, str], task: ClawEvalTask) -> Dict[str, str]:
    updated = dict(env)
    for service in task.services:
        name = str(service.get("name") or "").strip()
        port = service.get("port")
        if not name or not isinstance(port, int):
            continue
        updated[f"CLAW_EVAL_{name.upper()}_URL"] = f"http://localhost:{port}"
    return updated


def _read_json_with_retry(path: Path, *, attempts: int = 6, sleep_seconds: float = 0.2) -> Dict[str, Any]:
    last_error: Exception | None = None
    for _ in range(max(1, attempts)):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError) as exc:
            last_error = exc
            time.sleep(sleep_seconds)
    assert last_error is not None
    raise last_error


def _normalize_model_name_for_env(model_like: str) -> str:
    return model_like.split("/", 1)[1] if "/" in model_like else model_like


def _model_env_key(model_like: str) -> str:
    return re.sub(r"[^A-Z0-9]", "_", _normalize_model_name_for_env(model_like).upper())


def _load_pinchbench_env_fallback() -> None:
    env_path = Path("/mnt/20t/xubuqiang/EcoClaw/TokenPilot/experiments/pinchbench/.env")
    if not env_path.exists():
        return
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("'").strip('"'))


def _openai_compat_json(*, prompt: str, model: str, timeout_seconds: float = 120.0) -> str:
    _load_pinchbench_env_fallback()
    model_key = _model_env_key(model)
    bare_model = _normalize_model_name_for_env(model)
    base_url = os.environ.get(f"PINCHBENCH_MODEL_{model_key}_BASE_URL")
    api_key = os.environ.get(f"PINCHBENCH_MODEL_{model_key}_API_KEY")
    if not base_url or not api_key:
        raise RuntimeError(f"Missing direct API env for user-agent model {model}")
    endpoint = base_url.rstrip("/") + "/chat/completions"
    payload = {
        "model": bare_model,
        "messages": [
            {"role": "system", "content": "Return plain text only."},
            {"role": "user", "content": prompt},
        ],
        "temperature": 0.7,
        "max_tokens": 1024,
    }
    req = urllib.request.Request(
        endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout_seconds) as resp:
        raw = json.loads(resp.read().decode("utf-8"))
    return str(raw["choices"][0]["message"]["content"] or "").strip()


def _patch_agent_tool_restrictions(agent_id: str, task: ClawEvalTask, config_path: Path) -> None:
    cfg = _read_json_with_retry(config_path)
    agents = cfg.setdefault("agents", {})
    entries = agents.setdefault("list", [])

    allowed_tools = sorted(set(task.declared_tools) | {"write", "edit"})
    denied_tools = [
        "read",
        "exec",
        "process",
        "browser",
        "web_search",
        "web_fetch",
        "pdf",
        "image",
        "memory_search",
        "memory_get",
        "sessions_list",
        "sessions_history",
        "session_status",
    ]

    for entry in entries:
        if entry.get("id") != agent_id:
            continue
        entry["tools"] = {
            "allow": allowed_tools,
            "deny": denied_tools,
        }
        entry.pop("skills", None)
        break

    config_path.write_text(json.dumps(cfg, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


@dataclass
class ServiceHandle:
    name: str
    process: subprocess.Popen[str]
    log_path: Path


def _http_json(url: str, method: str = "GET", timeout: float = 5.0) -> Dict[str, Any]:
    req = urllib.request.Request(url, method=method.upper())
    if method.upper() == "POST":
        req.add_header("Content-Type", "application/json")
        req.data = b"{}"
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            payload = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as exc:
        payload = exc.read().decode("utf-8", errors="replace")
        # A 4xx from a parameter-validating endpoint still proves the mock
        # service is up; only 5xx should fail readiness outright.
        if 400 <= exc.code < 500:
            try:
                return json.loads(payload)
            except json.JSONDecodeError:
                return {"raw": payload, "status_code": exc.code}
        raise
    try:
        return json.loads(payload)
    except json.JSONDecodeError:
        return {"raw": payload}


def start_task_services(
    task: ClawEvalTask,
    *,
    dataset_root: Path,
    service_code_root: Path,
    logs_dir: Path,
) -> List[ServiceHandle]:
    handles: List[ServiceHandle] = []
    logs_dir.mkdir(parents=True, exist_ok=True)
    task_source_dir = _task_source_dir(task)
    task_fixtures_dir = task_source_dir / "fixtures"
    for service in task.services:
        command = str(service.get("command") or "").strip()
        if not command:
            continue
        name = str(service.get("name") or "service")
        log_path = logs_dir / f"{name}.log"
        log_fp = log_path.open("w", encoding="utf-8")
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        env["CLAW_EVAL_DATASET_ROOT"] = str(dataset_root.resolve())
        service_env = service.get("env") or {}
        if isinstance(service_env, dict):
            for key, value in service_env.items():
                if value is None:
                    continue
                rendered = str(value)
                # Upstream task.yaml commonly uses repo-relative fixture paths.
                if "/" in rendered and not os.path.isabs(rendered):
                    rendered = str((dataset_root / rendered).resolve())
                env[str(key)] = rendered

        # Vendor mock services in this repo should resolve fixtures from the
        # active task's fixture directory instead of relying on upstream repo
        # relative defaults.
        service_name = name.lower()
        service_fixture_overrides = {
            "gmail": ("GMAIL_FIXTURES", task_fixtures_dir / "gmail" / "inbox.json"),
            "calendar": ("CALENDAR_FIXTURES", task_fixtures_dir / "calendar" / "events.json"),
            "todo": ("TODO_FIXTURES", task_fixtures_dir / "todo" / "tasks.json"),
            "contacts": ("CONTACTS_FIXTURES", task_fixtures_dir / "contacts" / "contacts.json"),
            "finance": ("FINANCE_FIXTURES", task_fixtures_dir / "finance" / "transactions.json"),
            "notes": ("NOTES_FIXTURES", task_fixtures_dir / "notes" / "meetings.json"),
            "kb": ("KB_FIXTURES", task_fixtures_dir / "kb" / "articles.json"),
            "helpdesk": ("HELPDESK_FIXTURES", task_fixtures_dir / "helpdesk" / "tickets.json"),
            "inventory": ("INVENTORY_FIXTURES", task_fixtures_dir / "inventory" / "products.json"),
            "rss": ("RSS_FIXTURES", task_fixtures_dir / "rss" / "articles.json"),
            "crm": ("CRM_FIXTURES", task_fixtures_dir / "crm" / "customers.json"),
            "config": ("CONFIG_FIXTURES", task_fixtures_dir / "config" / "integrations.json"),
            "scheduler": ("SCHEDULER_FIXTURES", task_fixtures_dir / "scheduler" / "jobs.json"),
        }
        if service_name in service_fixture_overrides:
            env_name, fixture_path = service_fixture_overrides[service_name]
            env.setdefault(env_name, str(fixture_path.resolve()))

        if service_name == "ocr" or service_name.startswith("ocr_"):
            env.setdefault("OCR_FIXTURES", str(task_fixtures_dir.resolve()))
        if service_name == "caption":
            env.setdefault("CAPTION_FIXTURES", str(task_fixtures_dir.resolve()))
        if service_name == "web":
            env.setdefault("WEB_SEARCH_FIXTURES", str((task_fixtures_dir / "web" / "search_results.json").resolve()))
            env.setdefault("WEB_FETCH_FIXTURES", str((task_fixtures_dir / "web" / "pages.json").resolve()))

        proc = subprocess.Popen(
            command,
            shell=True,
            cwd=str(service_code_root),
            stdout=log_fp,
            stderr=subprocess.STDOUT,
            text=True,
            env=env,
        )
        handles.append(ServiceHandle(name=name, process=proc, log_path=log_path))

        ready_timeout = float(service.get("ready_timeout") or 10)
        health_url = str(service.get("health_check") or "").strip()
        health_method = str(service.get("health_check_method") or "GET").strip() or "GET"
        deadline = time.time() + ready_timeout
        last_error: str | None = None
        while time.time() < deadline:
            if proc.poll() is not None:
                break
            try:
                _http_json(health_url, method=health_method, timeout=2.0)
                last_error = None
                break
            except Exception as exc:  # pragma: no cover - best effort probe
                last_error = str(exc)
                time.sleep(0.5)
        if last_error is not None:
            raise RuntimeError(f"Service {name} failed health check: {last_error}")

        reset_url = str(service.get("reset_endpoint") or "").strip()
        if reset_url:
            try:
                _http_json(reset_url, method="POST", timeout=5.0)
            except Exception as exc:  # pragma: no cover - reset is best effort
                raise RuntimeError(f"Service {name} failed reset: {exc}") from exc
    return handles


def stop_task_services(handles: List[ServiceHandle]) -> None:
    for handle in handles:
        if handle.process.poll() is None:
            handle.process.terminate()
            try:
                handle.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                handle.process.kill()
                handle.process.wait(timeout=5)


def collect_task_audit(task: ClawEvalTask) -> Dict[str, Dict[str, Any]]:
    audit: Dict[str, Dict[str, Any]] = {}
    for service in task.services:
        name = str(service.get("name") or "").strip()
        port = service.get("port")
        if not name or not port:
            continue
        audit_prefix = name
        health_url = str(service.get("health_check") or "").strip()
        if health_url:
            parsed = urlparse(health_url)
            path_bits = [bit for bit in parsed.path.split("/") if bit]
            if path_bits:
                audit_prefix = path_bits[0]
        audit_url = f"http://localhost:{port}/{audit_prefix}/audit"
        try:
            audit[name] = _http_json(audit_url, method="GET", timeout=5.0)
        except Exception:
            continue
    return audit


def _get_agent_workspace(agent_id: str, env: Dict[str, str]) -> Path | None:
    try:
        list_result = subprocess.run(
            ["openclaw", "agents", "list"],
            capture_output=True,
            text=True,
            check=False,
            env=env,
        )
        if list_result.returncode != 0:
            return None
        normalized_id = agent_id.replace(":", "-")
        lines = list_result.stdout.split("\n")
        found_agent = False
        for line in lines:
            stripped = line.strip()
            if stripped.startswith(f"- {agent_id}") or stripped.startswith(f"- {normalized_id}"):
                found_agent = True
            elif found_agent and "Workspace:" in line:
                workspace_str = line.split("Workspace:")[1].strip()
                if workspace_str.startswith("~/"):
                    workspace_str = str(Path.home() / workspace_str[2:])
                return Path(workspace_str)
            elif found_agent and line.strip().startswith("-"):
                break
        return None
    except Exception:
        return None


def _list_existing_agents(env: Dict[str, str]) -> set[str]:
    try:
        list_result = subprocess.run(
            ["openclaw", "agents", "list"],
            capture_output=True,
            text=True,
            check=False,
            env=env,
        )
    except Exception:
        return set()
    if list_result.returncode != 0:
        return set()
    existing_agents: set[str] = set()
    for line in list_result.stdout.splitlines():
        line = line.strip()
        if line.startswith("- "):
            name_part = line[2:].split()[0] if line[2:].strip() else ""
            if name_part:
                existing_agents.add(name_part)
    return existing_agents


def ensure_agent_exists(agent_id: str, model_id: str, workspace_dir: Path, config_path: Path, task: ClawEvalTask) -> None:
    workspace_dir.mkdir(parents=True, exist_ok=True)
    env = _inject_mock_service_urls(_openclaw_env(config_path), task)
    last_error = ""
    for _ in range(3):
        existing_agents = _list_existing_agents(env)
        normalized_id = agent_id.replace(":", "-")
        if agent_id in existing_agents or normalized_id in existing_agents:
            current_workspace = _get_agent_workspace(agent_id, env)
            if current_workspace is not None and current_workspace.resolve() == workspace_dir.resolve():
                _patch_agent_tool_restrictions(agent_id, task, config_path)
                return
            delete_name = normalized_id if normalized_id in existing_agents else agent_id
            delete_result = subprocess.run(
                ["openclaw", "agents", "remove", delete_name, "--yes"],
                check=False,
                capture_output=True,
                text=True,
                env=env,
            )
            if delete_result.returncode != 0:
                last_error = (delete_result.stderr or delete_result.stdout or "").strip()
                time.sleep(0.5)
                continue
            time.sleep(0.5)

        result = subprocess.run(
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
            check=False,
            capture_output=True,
            text=True,
            env=env,
        )
        if result.returncode == 0:
            _patch_agent_tool_restrictions(agent_id, task, config_path)
            return
        add_error = (result.stderr or result.stdout or "").strip()
        if "already exists" in add_error.lower():
            current_workspace = _get_agent_workspace(agent_id, env)
            if current_workspace is not None and current_workspace.resolve() == workspace_dir.resolve():
                _patch_agent_tool_restrictions(agent_id, task, config_path)
                return
        existing_agents = _list_existing_agents(env)
        if agent_id in existing_agents or normalized_id in existing_agents:
            _patch_agent_tool_restrictions(agent_id, task, config_path)
            return
        last_error = add_error
        time.sleep(0.5)
    raise RuntimeError(f"Failed to create agent {agent_id}: {last_error or 'unknown error'}")


def _sanitize_workspace(workspace_dir: Path) -> None:
    workspace_dir.mkdir(parents=True, exist_ok=True)
    git_dir = workspace_dir / ".git"
    if git_dir.exists():
        if git_dir.is_dir():
            shutil.rmtree(git_dir)
        else:
            git_dir.unlink()


def _task_source_dir(task: ClawEvalTask) -> Path:
    task_yaml = task.task_yaml_path
    if task_yaml is None:
        source = task.frontmatter.get("_source")
        if source:
            task_yaml = Path(str(source))
    if task_yaml is None:
        raise RuntimeError(f"Task source path unavailable for {task.task_id}")
    return Path(task_yaml).resolve().parent


def _dataset_root(task: ClawEvalTask) -> Path | None:
    raw = task.frontmatter.get("_dataset_root")
    if not raw:
        return None
    return Path(str(raw)).resolve()


def _asset_search_roots(task: ClawEvalTask) -> List[Path]:
    roots: List[Path] = []
    dataset_root = _dataset_root(task)
    if dataset_root is not None:
        roots.extend(
            [
                dataset_root,
                dataset_root / "general",
            ]
        )
    return roots


def _resolve_from_general_bundle(task: ClawEvalTask, rel_path: str) -> Path | None:
    dataset_root = _dataset_root(task)
    if dataset_root is not None:
        bundle_root = (dataset_root / "general").resolve()
    else:
        bundle_root = (Path(__file__).resolve().parents[1] / "dataset" / "general").resolve()
    if not bundle_root.exists():
        return None
    task_slug = task.task_id.lower()
    ext = Path(rel_path).suffix.lower()
    matches = sorted(
        path
        for path in bundle_root.iterdir()
        if path.is_file()
        and task_slug in path.name.lower()
        and (not ext or path.suffix.lower() == ext)
    )
    if matches:
        basename = Path(rel_path).name.lower()
        stem = Path(rel_path).stem.lower()
        preferred = [
            path for path in matches if basename in path.name.lower() or stem in path.name.lower()
        ]
        if len(preferred) == 1:
            return preferred[0].resolve()
        if len(matches) == 1:
            return matches[0].resolve()
    if ext == ".pdf":
        text_matches = sorted(
            path
            for path in bundle_root.iterdir()
            if path.is_file()
            and task_slug in path.name.lower()
            and path.suffix.lower() in {".txt", ".md"}
        )
        if len(text_matches) == 1:
            return text_matches[0].resolve()
    return None


def _resolve_task_asset_path(task: ClawEvalTask, rel_path: str) -> Path:
    source_dir = _task_source_dir(task)
    direct = (source_dir / rel_path).resolve()
    if direct.exists():
        return direct

    normalized = rel_path.replace("\\", "/").lstrip("./")
    stripped = normalized[len("fixtures/") :] if normalized.startswith("fixtures/") else normalized

    for root in _asset_search_roots(task):
        candidates = [
            (root / normalized).resolve(),
            (root / stripped).resolve(),
        ]
        for candidate in candidates:
            if candidate.exists():
                return candidate
        basename = Path(stripped).name
        matches = list(root.rglob(basename))
        if len(matches) == 1:
            return matches[0].resolve()

    bundle_match = _resolve_from_general_bundle(task, rel_path)
    if bundle_match is not None:
        return bundle_match

    return direct


def _inject_workspace_files(task: ClawEvalTask, workspace_dir: Path) -> None:
    file_specs: List[str] = []
    for key in ("sandbox_files", "sandbox_grader_files"):
        raw = task.frontmatter.get(key) or []
        if isinstance(raw, list):
            file_specs.extend(str(item) for item in raw if item)
    for rel_path in file_specs:
        src = _resolve_task_asset_path(task, rel_path)
        dest = (workspace_dir / rel_path).resolve()
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)


def _workspace_path_for_task_path(task_path: str, workspace_dir: Path) -> Path:
    normalized = task_path
    if normalized.startswith("/workspace/"):
        normalized = normalized[len("/workspace/") :]
    elif normalized == "/workspace":
        normalized = ""
    return (workspace_dir / normalized).resolve()


def _rewrite_workspace_refs(text: str, workspace_dir: Path) -> str:
    rewritten = text.replace("/workspace/", f"{workspace_dir}/")
    if rewritten == "/workspace":
        return str(workspace_dir)
    return rewritten


def _run_env_snapshot_command(command: str, workspace_dir: Path, timeout: int) -> subprocess.CompletedProcess[str]:
    bwrap = shutil.which("bwrap")
    if not bwrap:
        rewritten = _rewrite_workspace_refs(command, workspace_dir)
        return subprocess.run(
            rewritten,
            shell=True,
            cwd=str(workspace_dir),
            capture_output=True,
            text=True,
            timeout=max(timeout, 1),
        )
    wrapped = [
        bwrap,
        "--tmpfs",
        "/",
        "--dir",
        "/workspace",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--ro-bind",
        "/usr",
        "/usr",
        "--ro-bind",
        "/bin",
        "/bin",
        "--ro-bind",
        "/lib",
        "/lib",
        "--ro-bind",
        "/lib64",
        "/lib64",
        "--ro-bind",
        "/etc",
        "/etc",
        "--ro-bind",
        "/mnt",
        "/mnt",
        "--ro-bind",
        "/tmp",
        "/tmp",
        "--ro-bind",
        "/home",
        "/home",
        "--bind",
        str(workspace_dir),
        "/workspace",
        "--chdir",
        "/workspace",
        "bash",
        "-lc",
        command,
    ]
    return subprocess.run(
        wrapped,
        capture_output=True,
        text=True,
        timeout=max(timeout, 1),
    )


def _snapshot_file_entry(path: Path) -> Dict[str, Any]:
    mime_type, _ = mimetypes.guess_type(path.name)
    data = path.read_bytes()
    if mime_type and (mime_type.startswith("image/") or mime_type.startswith("audio/") or mime_type.startswith("video/")):
        return {
            "encoding": "base64",
            "content": base64.b64encode(data).decode("ascii"),
            "mime_type": mime_type,
        }
    try:
        text = data.decode("utf-8")
        return {
            "encoding": "utf-8",
            "content": text,
            "mime_type": mime_type or "text/plain",
        }
    except UnicodeDecodeError:
        return {
            "encoding": "base64",
            "content": base64.b64encode(data).decode("ascii"),
            "mime_type": mime_type or "application/octet-stream",
        }


def _collect_env_snapshot(task: ClawEvalTask, workspace_dir: Path) -> Dict[str, Any]:
    snapshot: Dict[str, Any] = {}
    timeout = int(((task.frontmatter.get("environment") or {}).get("env_snapshot_timeout")) or 10)

    for cmd in task.frontmatter.get("env_snapshot_commands") or []:
        command = str(cmd)
        try:
            proc = _run_env_snapshot_command(command, workspace_dir, timeout)
            snapshot[f"cmd:{command}"] = {
                "stdout": proc.stdout,
                "stderr": proc.stderr,
                "exit_code": proc.returncode,
            }
        except Exception as exc:
            snapshot[f"cmd:{command}"] = {"error": str(exc)}

    for pattern in task.frontmatter.get("env_snapshot_files") or []:
        pattern_str = str(pattern)
        resolved_pattern = str(_workspace_path_for_task_path(pattern_str, workspace_dir))
        try:
            if "*" in pattern_str or "?" in pattern_str or "[" in pattern_str:
                matches = sorted(glob(resolved_pattern))
                if not matches:
                    snapshot[f"file:{pattern_str}"] = {"error": "no matches"}
                for match in matches:
                    match_path = Path(match)
                    rel = "/" + str(match_path.relative_to(workspace_dir)).replace(os.sep, "/")
                    logical = f"/workspace{rel}"
                    snapshot[f"file:{logical}"] = _snapshot_file_entry(match_path)
            else:
                file_path = _workspace_path_for_task_path(pattern_str, workspace_dir)
                snapshot[f"file:{pattern_str}"] = _snapshot_file_entry(file_path)
        except Exception as exc:
            snapshot[f"file:{pattern_str}"] = {"error": str(exc)}

    source_dir = _task_source_dir(task)
    for rel_path in task.frontmatter.get("local_grader_files") or []:
        rel = str(rel_path)
        try:
            snapshot[f"local_file:{rel}"] = _snapshot_file_entry((source_dir / rel).resolve())
        except Exception as exc:
            snapshot[f"local_file:{rel}"] = {"error": str(exc)}

    return snapshot


def _find_latest_session_file(agent_id: str, workspace_dir: Path, config_path: Path, started_at: float) -> Path | None:
    cfg = _read_json_with_retry(config_path)
    sessions_dir: Path | None = None
    for entry in cfg.get("agents", {}).get("list", []):
        if entry.get("id") == agent_id:
            agent_dir = entry.get("agentDir")
            if agent_dir:
                sessions_dir = Path(agent_dir).resolve().parent / "sessions"
                break
    if sessions_dir is None:
        workspace_str = str(workspace_dir.resolve())
        for entry in cfg.get("agents", {}).get("list", []):
            if str(entry.get("workspace") or "") == workspace_str:
                agent_dir = entry.get("agentDir")
                if agent_dir:
                    sessions_dir = Path(agent_dir).resolve().parent / "sessions"
                    break
    if sessions_dir is None or not sessions_dir.exists():
        return None
    candidates = [p for p in sessions_dir.glob("*.jsonl") if p.stat().st_mtime >= started_at - 1]
    if not candidates:
        candidates = list(sessions_dir.glob("*.jsonl"))
    if not candidates:
        return None
    return max(candidates, key=lambda p: p.stat().st_mtime)


def _load_transcript(session_file: Path | None) -> List[Dict[str, Any]]:
    if session_file is None or not session_file.exists():
        return []
    entries: List[Dict[str, Any]] = []
    for line in session_file.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return entries


def _message_text(message: Dict[str, Any]) -> str:
    parts: List[str] = []
    for block in message.get("content") or []:
        if isinstance(block, dict) and block.get("type") == "text":
            text = str(block.get("text") or "").strip()
            if text:
                parts.append(text)
    return "\n".join(parts).strip()


def _format_user_agent_transcript(transcript: List[Dict[str, Any]]) -> str:
    lines: List[str] = []
    for entry in transcript:
        if entry.get("type") != "message":
            continue
        message = entry.get("message") or {}
        role = str(message.get("role") or "")
        if role == "system":
            continue
        text = _message_text(message)
        if not text:
            continue
        if role == "user":
            if text.startswith("[user_agent]"):
                text = text[len("[user_agent]") :].strip()
            lines.append(f"[用户]: {text}")
        elif role == "assistant":
            lines.append(f"[助手]: {text}")
    return "\n".join(lines)


def _should_continue_user_agent(task: ClawEvalTask, transcript: List[Dict[str, Any]], result: subprocess.CompletedProcess[str]) -> bool:
    user_agent_cfg = (task.frontmatter.get("user_agent") or {}) if isinstance(task.frontmatter, dict) else {}
    if not user_agent_cfg or not user_agent_cfg.get("enabled"):
        return False
    if result.returncode != 0:
        return False
    if "LLM request timed out." in (result.stdout or "") or "LLM request timed out." in (result.stderr or ""):
        return False
    for entry in reversed(transcript):
        if entry.get("type") != "message":
            continue
        message = entry.get("message") or {}
        if message.get("role") != "assistant":
            continue
        return bool(_message_text(message))
    return False


def _generate_user_agent_reply(task: ClawEvalTask, transcript: List[Dict[str, Any]]) -> str | None:
    user_agent_cfg = (task.frontmatter.get("user_agent") or {}) if isinstance(task.frontmatter, dict) else {}
    if not user_agent_cfg.get("enabled"):
        return None
    persona = str(user_agent_cfg.get("persona") or "").strip()
    if not persona:
        return None
    model = os.environ.get("CLAW_EVAL_USER_AGENT_MODEL", DEFAULT_USER_AGENT_MODEL)
    system_suffix = str(user_agent_cfg.get("system_prompt_suffix") or "").strip()
    conversation = _format_user_agent_transcript(transcript)
    prompt = (
        "你是一个模拟用户。你的任务是根据以下人设与AI助手进行对话。\n\n"
        f"## 你的人设\n{persona}\n\n"
        "## 规则\n"
        "1. 始终保持人设角色，用自然口语回复，不要暴露你是AI\n"
        "2. 根据助手的提问如实回答（基于你的人设信息）\n"
        "3. 如果助手问了你人设中没有的信息，说“不太清楚具体数字”或类似自然回复\n"
        "4. 如果你对回答满意或助手已充分回答了你的问题，输出 [DONE]\n"
        "5. 回复要简短自然，像真实用户一样（1-3句话）\n"
        f"{system_suffix}\n\n"
        f"以下是到目前为止的对话：\n\n{conversation}\n\n"
        "请根据你的人设回复助手的最新消息。如果你满意了就输出 [DONE]。"
    )
    max_retries = 6
    for attempt in range(max_retries):
        try:
            text = _openai_compat_json(prompt=prompt, model=model, timeout_seconds=120.0)
            if "[DONE]" in text:
                return None
            return text or None
        except Exception:
            if attempt == max_retries - 1:
                return None
            time.sleep(min(2 ** attempt, 8) + random.uniform(0, 0.5))
    return None


def _extract_usage(transcript: List[Dict[str, Any]]) -> Dict[str, Any]:
    totals = {
        "input_tokens": 0,
        "output_tokens": 0,
        "cache_read_tokens": 0,
        "total_tokens": 0,
        "request_count": 0,
    }
    for entry in transcript:
        if entry.get("type") != "message":
            continue
        msg = entry.get("message") or {}
        if msg.get("role") != "assistant":
            continue
        usage = msg.get("usage") or {}
        if not isinstance(usage, dict):
            usage = {}
        totals["request_count"] += 1
        totals["input_tokens"] += int(usage.get("input") or usage.get("input_tokens") or 0)
        totals["output_tokens"] += int(usage.get("output") or usage.get("output_tokens") or 0)
        totals["cache_read_tokens"] += int(usage.get("cacheRead") or usage.get("cache_read_tokens") or 0)
        totals["total_tokens"] += int(
            usage.get("totalTokens")
            or usage.get("total_tokens")
            or (int(usage.get("input") or usage.get("input_tokens") or 0) + int(usage.get("output") or usage.get("output_tokens") or 0))
        )
    return totals


def _count_audit_calls(audit_data: Dict[str, Dict[str, Any]]) -> int:
    total = 0
    for service_data in audit_data.values():
        calls = service_data.get("calls") or []
        total += len(calls)
    return total


def _collect_post_run_state(
    *,
    task: ClawEvalTask,
    agent_id: str,
    workspace_dir: Path,
    config_path: Path,
    started_at: float,
) -> Dict[str, Any]:
    session_file = _find_latest_session_file(agent_id, workspace_dir, config_path, started_at)
    transcript = _load_transcript(session_file)
    usage = _extract_usage(transcript)
    audit_data = collect_task_audit(task)
    session_mtime = session_file.stat().st_mtime if session_file and session_file.exists() else None
    session_size = session_file.stat().st_size if session_file and session_file.exists() else None
    return {
        "session_file": session_file,
        "transcript": transcript,
        "usage": usage,
        "audit_data": audit_data,
        "session_mtime": session_mtime,
        "session_size": session_size,
        "audit_call_count": _count_audit_calls(audit_data),
    }


def _wait_for_post_run_settle(
    *,
    task: ClawEvalTask,
    agent_id: str,
    workspace_dir: Path,
    config_path: Path,
    started_at: float,
    timeout_seconds: float = 12.0,
    interval_seconds: float = 1.0,
) -> Dict[str, Any]:
    deadline = time.time() + timeout_seconds
    last_state: Dict[str, Any] | None = None
    stable_rounds = 0

    while True:
        state = _collect_post_run_state(
            task=task,
            agent_id=agent_id,
            workspace_dir=workspace_dir,
            config_path=config_path,
            started_at=started_at,
        )
        fingerprint = (
            state["session_file"],
            state["session_mtime"],
            state["session_size"],
            state["audit_call_count"],
            state["usage"]["input_tokens"],
            state["usage"]["output_tokens"],
            state["usage"]["request_count"],
        )
        last_fingerprint = None
        if last_state is not None:
            last_fingerprint = (
                last_state["session_file"],
                last_state["session_mtime"],
                last_state["session_size"],
                last_state["audit_call_count"],
                last_state["usage"]["input_tokens"],
                last_state["usage"]["output_tokens"],
                last_state["usage"]["request_count"],
            )
        if fingerprint == last_fingerprint:
            stable_rounds += 1
        else:
            stable_rounds = 0
        last_state = state

        saw_activity = (
            state["audit_call_count"] > 0
            or int(state["usage"]["input_tokens"]) > 0
            or int(state["usage"]["output_tokens"]) > 0
        )
        if saw_activity and stable_rounds >= 1:
            return state
        if time.time() >= deadline:
            return state
        time.sleep(interval_seconds)


def _should_retry_execution(output: Dict[str, Any]) -> bool:
    stderr = str(output.get("stderr") or "")
    stdout = str(output.get("stdout") or "")
    retry_markers = ("LLM request timed out.", "Connection error.")
    saw_retryable_error = any(marker in stderr or marker in stdout for marker in retry_markers)
    if not saw_retryable_error:
        return False
    if _count_audit_calls(output.get("audit_data") or {}) > 0:
        return False
    usage = output.get("usage") or {}
    if int(usage.get("input_tokens") or 0) > 0 or int(usage.get("output_tokens") or 0) > 0:
        return False
    return True


def execute_task(
    task: ClawEvalTask,
    *,
    model_id: str,
    run_root: Path,
    dataset_root: Path,
    service_code_root: Path,
    config_path: Path,
    local: bool = True,
    max_attempts: int = 3,
    agent_id_override: str | None = None,
    workspace_dir_override: Path | None = None,
    session_id_override: str | None = None,
    preserve_workspace: bool = False,
    ensure_agent: bool = True,
) -> Dict[str, Any]:
    task_root = run_root / task.task_id
    workspace_dir = workspace_dir_override or (task_root / "workspace")
    logs_dir = task_root / "logs"
    task_root.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)
    last_output: Dict[str, Any] | None = None

    for attempt in range(1, max(1, max_attempts) + 1):
        service_offset = (int(time.time() * 1000) % 1000) + (attempt * 1000)
        run_task = _task_with_available_service_ports(_task_with_service_port_offset(task, service_offset))
        agent_id = agent_id_override or _make_agent_id(model_id, task.task_id)
        if ensure_agent:
            ensure_agent_exists(agent_id, model_id, workspace_dir, config_path, run_task)
        if not preserve_workspace:
            _sanitize_workspace(workspace_dir)
        else:
            workspace_dir.mkdir(parents=True, exist_ok=True)
        _inject_workspace_files(run_task, workspace_dir)

        handles: List[ServiceHandle] = []
        started_at = time.time()
        session_id = session_id_override or f"{task.task_id}_{int(started_at*1000)}"
        user_agent_cfg = (run_task.frontmatter.get("user_agent") or {}) if isinstance(run_task.frontmatter, dict) else {}
        ua_enabled = bool(user_agent_cfg.get("enabled"))
        ua_max_rounds = int(user_agent_cfg.get("max_rounds") or 0) if ua_enabled else 0
        ua_rounds = 0
        try:
            handles = start_task_services(
                run_task,
                dataset_root=dataset_root,
                service_code_root=service_code_root,
                logs_dir=logs_dir,
            )
            env = _inject_mock_service_urls(_openclaw_env(config_path), run_task)
            next_message = _task_prompt(run_task)
            combined_stdout: List[str] = []
            combined_stderr: List[str] = []
            while True:
                agent_timeout_seconds = os.environ.get("CLAW_EVAL_AGENT_TIMEOUT_SECONDS", "0").strip() or "0"
                command = [
                    "openclaw",
                    "agent",
                    "--agent",
                    agent_id,
                    "--session-id",
                    session_id,
                    "--timeout",
                    agent_timeout_seconds,
                    "--message",
                    next_message,
                ]
                if local:
                    command.append("--local")
                result = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    cwd=str(workspace_dir),
                    check=False,
                    env=env,
                )
                if result.stdout:
                    combined_stdout.append(result.stdout)
                if result.stderr:
                    combined_stderr.append(result.stderr)
                post_run_state = _wait_for_post_run_settle(
                    task=run_task,
                    agent_id=agent_id,
                    workspace_dir=workspace_dir,
                    config_path=config_path,
                    started_at=started_at,
                )
                audit_data = post_run_state["audit_data"]
                session_file = post_run_state["session_file"]
                transcript = post_run_state["transcript"]
                usage = post_run_state["usage"]
                env_snapshot = _collect_env_snapshot(run_task, workspace_dir)
                output = {
                    "task_id": task.task_id,
                    "task_name": task.task_name,
                    "category": task.category,
                    "status": "success" if result.returncode == 0 else "error",
                    "returncode": result.returncode,
                    "stdout": "".join(combined_stdout),
                    "stderr": "".join(combined_stderr),
                    "workspace": str(workspace_dir),
                    "logs_dir": str(logs_dir),
                    "session_file": str(session_file) if session_file else None,
                    "transcript_entries": len(transcript),
                    "usage": usage,
                    "audit_data": audit_data,
                    "env_snapshot": env_snapshot,
                    "attempt": attempt,
                    "user_agent_rounds": ua_rounds,
                }
                last_output = output
                (task_root / "result.json").write_text(
                    json.dumps(output, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                if not (
                    ua_enabled
                    and ua_rounds < ua_max_rounds
                    and _should_continue_user_agent(run_task, transcript, result)
                ):
                    break
                ua_reply = _generate_user_agent_reply(run_task, transcript)
                if not ua_reply:
                    break
                next_message = f"[user_agent]\n{ua_reply}"
                ua_rounds += 1
            if attempt < max_attempts and last_output is not None and _should_retry_execution(last_output):
                time.sleep(1.0)
                continue
            assert last_output is not None
            return last_output
        finally:
            stop_task_services(handles)

    assert last_output is not None
    return last_output
