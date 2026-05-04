#!/usr/bin/env python3
"""Claw-Eval benchmark adapter entrypoint.

Current scope:
- load task.yaml tasks
- select a suite
- resolve required mock-tool plugins
- optionally install / activate / restore the plugin closure for a run

Task execution and grader bridging remain separate follow-up steps.
"""

from __future__ import annotations

import argparse
import json
import os
import secrets
import signal
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from lib_agent import ensure_agent_exists, execute_task
from lib_grading import grade_execution_result
from lib_services import (
    activate_plugins_for_run,
    build_plugin_install_plan,
    cleanup_claw_eval_plugin_state,
    restore_plugins_after_run,
    summarize_plugin_closure,
)
from lib_tasks import ClawEvalTaskLoader


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="TokenPilot claw-eval adapter scaffold")
    default_openclaw_home = (
        os.environ.get("TOKENPILOT_OPENCLAW_HOME")
        or os.environ.get("ECOCLAW_OPENCLAW_HOME")
        or str(Path.home())
    )
    parser.add_argument("--tasks-dir", default=str(Path(__file__).resolve().parents[1] / "dataset" / "tasks"))
    parser.add_argument("--suite", default="all")
    parser.add_argument("--phase", choices=["full", "generate", "eval"], default="full")
    parser.add_argument("--session-mode", choices=["isolated", "continuous"], default="isolated")
    parser.add_argument("--model", default=None)
    parser.add_argument("--judge", default=None)
    parser.add_argument("--parallel", type=int, default=1)
    parser.add_argument("--output-dir", default=str(Path(__file__).resolve().parents[1] / "save" / "isolated"))
    parser.add_argument(
        "--plugin-root",
        default=str(Path(__file__).resolve().parents[1] / "plugins"),
        help="Directory containing claw-eval mock-tool OpenClaw plugins",
    )
    parser.add_argument(
        "--openclaw-config-path",
        default=os.environ.get(
            "OPENCLAW_CONFIG_PATH",
            str(Path(default_openclaw_home) / ".openclaw" / "openclaw.json"),
        ),
        help="OpenClaw config path used when enabling/disabling plugins",
    )
    parser.add_argument(
        "--apply-plugin-plan",
        action="store_true",
        help="Actually install/enable required plugins for the selected suite",
    )
    parser.add_argument(
        "--execute-tasks",
        action="store_true",
        help="Run selected tasks after applying the plugin plan",
    )
    parser.add_argument(
        "--max-tasks",
        type=int,
        default=0,
        help="Optional limit for selected tasks during pilot execution",
    )
    return parser.parse_args()


def _resolve_openclaw_config_path(config_arg: str) -> Path:
    raw = Path(config_arg).expanduser()
    if raw.exists():
        return raw.resolve()

    configured_home = (
        os.environ.get("TOKENPILOT_OPENCLAW_HOME")
        or os.environ.get("ECOCLAW_OPENCLAW_HOME")
    )
    if configured_home:
        fallback = Path(configured_home).expanduser() / ".openclaw" / "openclaw.json"
        if fallback.exists():
            return fallback.resolve()

    return raw.resolve()


def run_shell(command: str) -> None:
    subprocess.run(command, shell=True, check=True)


def _parse_bool_env(name: str, default: bool | None = None) -> bool | None:
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() in {"1", "true", "yes", "on"}


def _clear_tokenpilot_runtime_settings(config_path: Path) -> dict[str, object]:
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    plugins = raw.setdefault("plugins", {})
    slots = plugins.setdefault("slots", {})
    if slots.get("contextEngine") == "layered-context":
        slots["contextEngine"] = "legacy"
    config_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "tokenpilot_enabled": True,
        "contextEngine": slots.get("contextEngine"),
    }


def _should_enable_tokenpilot_runtime(execution_model: str) -> bool:
    explicit = _parse_bool_env("TOKENPILOT_RUNTIME_ENABLED")
    if explicit is not None:
        return explicit
    return execution_model.startswith("tokenpilot/")


def _apply_tokenpilot_runtime_settings(config_path: Path, *, execution_model: str) -> dict[str, object]:
    if not _should_enable_tokenpilot_runtime(execution_model):
        return _clear_tokenpilot_runtime_settings(config_path)

    raw = json.loads(config_path.read_text(encoding="utf-8"))

    enable_reduction = _parse_bool_env("TOKENPILOT_ENABLE_REDUCTION")
    enable_eviction = _parse_bool_env("TOKENPILOT_ENABLE_EVICTION")
    estimator_enabled = _parse_bool_env("TOKENPILOT_TASK_STATE_ESTIMATOR_ENABLED")

    if enable_reduction is None and enable_eviction is None and estimator_enabled is None:
        return {}

    plugins = raw.setdefault("plugins", {})
    plugins["enabled"] = True
    allow = plugins.setdefault("allow", [])
    if not isinstance(allow, list):
        allow = []
    if "tokenpilot" not in allow:
        allow.append("tokenpilot")
    plugins["allow"] = allow
    slots = plugins.setdefault("slots", {})
    slots["contextEngine"] = "layered-context"
    entries = plugins.setdefault("entries", {})
    tokenpilot_entry = entries.setdefault("tokenpilot", {})
    tokenpilot_entry["enabled"] = True

    tokenpilot_cfg = tokenpilot_entry.setdefault("config", {})
    tokenpilot_cfg["enabled"] = True
    tokenpilot_cfg["proxyAutostart"] = True
    modules = tokenpilot_cfg.setdefault("modules", {})
    modules.setdefault("policy", True)
    modules.setdefault("stabilizer", True)
    if enable_reduction is not None:
        modules["reduction"] = enable_reduction
    if enable_eviction is not None:
        modules["eviction"] = enable_eviction

    reduction = tokenpilot_cfg.setdefault("reduction", {})
    reduction["engine"] = "layered"
    reduction["triggerMinChars"] = int(
        os.environ.get("TOKENPILOT_REDUCTION_TRIGGER_MIN_CHARS", reduction.get("triggerMinChars", 2200))
    )
    reduction["maxToolChars"] = int(
        os.environ.get("TOKENPILOT_REDUCTION_MAX_TOOL_CHARS", reduction.get("maxToolChars", 1200))
    )
    passes = reduction.setdefault("passes", {})
    for env_name, field, fallback in (
        ("TOKENPILOT_REDUCTION_PASS_REPEATED_READ_DEDUP", "repeatedReadDedup", True),
        ("TOKENPILOT_REDUCTION_PASS_TOOL_PAYLOAD_TRIM", "toolPayloadTrim", False),
        ("TOKENPILOT_REDUCTION_PASS_HTML_SLIMMING", "htmlSlimming", True),
        ("TOKENPILOT_REDUCTION_PASS_EXEC_OUTPUT_TRUNCATION", "execOutputTruncation", True),
        ("TOKENPILOT_REDUCTION_PASS_AGENTS_STARTUP_OPTIMIZATION", "agentsStartupOptimization", True),
    ):
        passes[field] = _parse_bool_env(env_name, bool(passes.get(field, fallback)))

    eviction = tokenpilot_cfg.setdefault("eviction", {})
    if enable_eviction is not None:
        eviction["enabled"] = enable_eviction
    eviction["policy"] = os.environ.get("TOKENPILOT_EVICTION_POLICY", str(eviction.get("policy", "lru")))
    eviction["minBlockChars"] = int(
        os.environ.get("TOKENPILOT_EVICTION_MIN_BLOCK_CHARS", eviction.get("minBlockChars", 256))
    )
    eviction["replacementMode"] = os.environ.get(
        "TOKENPILOT_EVICTION_REPLACEMENT_MODE",
        str(eviction.get("replacementMode", "pointer_stub")),
    )

    estimator = tokenpilot_cfg.setdefault("taskStateEstimator", {})
    if estimator_enabled is not None:
        estimator["enabled"] = estimator_enabled
    estimator["batchTurns"] = int(
        os.environ.get("TOKENPILOT_TASK_STATE_ESTIMATOR_BATCH_TURNS", estimator.get("batchTurns", 3))
    )
    estimator["evictionLookaheadTurns"] = int(
        os.environ.get(
            "TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_LOOKAHEAD_TURNS",
            estimator.get("evictionLookaheadTurns", 3),
        )
    )
    estimator["inputMode"] = os.environ.get(
        "TOKENPILOT_TASK_STATE_ESTIMATOR_INPUT_MODE",
        str(estimator.get("inputMode", "sliding_window")),
    )
    estimator["lifecycleMode"] = os.environ.get(
        "TOKENPILOT_TASK_STATE_ESTIMATOR_LIFECYCLE_MODE",
        str(estimator.get("lifecycleMode", "decoupled")),
    )
    estimator["evictionPromotionPolicy"] = os.environ.get(
        "TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_POLICY",
        str(estimator.get("evictionPromotionPolicy", "fifo")),
    )
    estimator["evictionPromotionHotTailSize"] = int(
        os.environ.get(
            "TOKENPILOT_TASK_STATE_ESTIMATOR_EVICTION_PROMOTION_HOT_TAIL_SIZE",
            estimator.get("evictionPromotionHotTailSize", 1),
        )
    )
    if "TOKENPILOT_TASK_STATE_ESTIMATOR_REQUEST_TIMEOUT_MS" in os.environ:
        estimator["requestTimeoutMs"] = int(os.environ["TOKENPILOT_TASK_STATE_ESTIMATOR_REQUEST_TIMEOUT_MS"])

    config_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {
        "reduction": modules.get("reduction"),
        "eviction": modules.get("eviction"),
        "estimator": estimator.get("enabled"),
        "contextEngine": slots.get("contextEngine"),
    }


def _default_service_code_root() -> Path:
    configured = os.environ.get("CLAW_EVAL_SOURCE_ROOT")
    if configured:
        return Path(configured).expanduser().resolve()
    return (Path(__file__).resolve().parents[1] / "vendor").resolve()


def _available_provider_models(config_path: Path) -> set[str]:
    if not config_path.exists():
        return set()
    try:
        cfg = json.loads(config_path.read_text(encoding="utf-8"))
    except Exception:
        return set()
    available: set[str] = set()
    providers = ((cfg.get("models") or {}).get("providers") or {})
    for provider_name, provider_cfg in providers.items():
        for model in provider_cfg.get("models") or []:
            model_id = str(model.get("id") or "").strip()
            if model_id:
                available.add(f"{provider_name}/{model_id}")
    return available


def _resolve_model_id(requested_model: str | None, config_path: Path, *, purpose: str) -> str:
    model = (requested_model or "").strip()
    if not model:
        model = "ecoclaw/gpt-5.4-mini" if purpose == "execution" else "tokenpilot/gpt-5.4-mini"
    if "/" in model:
        return model

    available = _available_provider_models(config_path)
    for provider in ("ecoclaw", "tokenpilot", "dica", "gmn"):
        candidate = f"{provider}/{model}"
        if candidate in available:
            return candidate
    return model


def _synchronize_run_tool_allowlist(config_path: Path, tasks, known_task_tools) -> list[str]:
    required_tools = sorted(
        {
            tool_name
            for task in tasks
            for tool_name in task.declared_tools
            if tool_name
        }
    )
    known_tool_set = {tool_name for tool_name in known_task_tools if tool_name}
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    tools = raw.setdefault("tools", {})
    allow = tools.setdefault("allow", [])
    if not isinstance(allow, list):
        allow = []
        tools["allow"] = allow

    baseline_allow = [tool_name for tool_name in allow if tool_name not in known_tool_set]
    tools["allow"] = baseline_allow + required_tools

    if tools["allow"] != allow:
        config_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return required_tools


def main() -> None:
    args = parse_args()
    tasks_dir = Path(args.tasks_dir)
    loader = ClawEvalTaskLoader(tasks_dir)
    all_tasks = loader.load_all_tasks()
    selected = loader.select_tasks(all_tasks, args.suite)
    all_declared_tools = sorted(
        {
            tool_name
            for task in all_tasks
            for tool_name in task.declared_tools
            if tool_name
        }
    )
    closure = summarize_plugin_closure(selected)
    install_plan = build_plugin_install_plan(selected, Path(args.plugin_root))
    config_path = _resolve_openclaw_config_path(args.openclaw_config_path)
    output_dir = Path(args.output_dir)
    dataset_root = tasks_dir.parent
    service_code_root = _default_service_code_root()
    for task in selected:
        task.frontmatter["_dataset_root"] = str(dataset_root.resolve())
    execution_model = _resolve_model_id(args.model, config_path, purpose="execution")
    judge_model = _resolve_model_id(args.judge, config_path, purpose="judge")

    print("claw-eval adapter")
    print(f"tasks_dir={tasks_dir}")
    print(f"suite={args.suite}")
    print(f"phase={args.phase}")
    print(f"session_mode={args.session_mode}")
    print(f"model={execution_model}")
    print(f"judge={judge_model}")
    print(f"parallel={args.parallel}")
    print(f"output_dir={output_dir}")
    print(f"dataset_root={dataset_root}")
    print(f"service_code_root={service_code_root}")
    print(f"plugin_root={args.plugin_root}")
    print(f"openclaw_config_path={config_path}")
    print(f"apply_plugin_plan={args.apply_plugin_plan}")
    print(f"execute_tasks={args.execute_tasks}")
    print(f"max_tasks={args.max_tasks}")
    print(f"loaded_tasks={len(all_tasks)}")
    print(f"selected_tasks={len(selected)}")
    print(f"required_plugins={closure['required_plugins']}")
    print(f"unresolved_tools={closure['unresolved_tools']}")
    print(f"unresolved_services={closure['unresolved_services']}")
    print(f"missing_plugin_ids={install_plan.missing_plugin_ids}")
    print(f"install_commands={len(install_plan.install_commands)}")
    print(f"enable_commands={len(install_plan.enable_commands)}")
    print(f"disable_commands={len(install_plan.disable_commands)}")

    if install_plan.missing_plugin_ids:
        raise SystemExit(
            f"Missing plugin manifests for: {', '.join(install_plan.missing_plugin_ids)}"
        )

    activation_plan = None
    cleanup_context: dict[str, object] = {
        "done": False,
    }

    def _cleanup_plugin_state() -> None:
        if cleanup_context.get("done"):
            return
        try:
            if activation_plan is not None and activation_plan.backup_path.exists():
                restore_cmd = restore_plugins_after_run(
                    activation_plan,
                    config_path,
                    runner=run_shell,
                )
                print(f"[restore] {restore_cmd}")
            cleanup_cmd = cleanup_claw_eval_plugin_state(
                config_path,
                Path(args.plugin_root),
                runner=run_shell,
            )
            print(f"[cleanup] {cleanup_cmd}")
        finally:
            cleanup_context["done"] = True

    def _handle_signal(signum, _frame) -> None:
        print(f"[signal] received {signum}, restoring OpenClaw config")
        _cleanup_plugin_state()
        raise SystemExit(128 + int(signum))

    previous_sigint = signal.getsignal(signal.SIGINT)
    previous_sigterm = signal.getsignal(signal.SIGTERM)
    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)
    should_apply_plan = args.apply_plugin_plan or args.execute_tasks
    if should_apply_plan:
        cleanup_cmd = cleanup_claw_eval_plugin_state(
            config_path,
            Path(args.plugin_root),
            runner=run_shell,
        )
        print(f"[cleanup-pre] {cleanup_cmd}")
        activation_plan = activate_plugins_for_run(
            install_plan.required_plugins,
            Path(args.plugin_root),
            config_path,
            runner=None,
        )
        try:
            for cmd in install_plan.install_commands:
                print(f"[install-plan] {cmd}")
            activation_plan = activate_plugins_for_run(
                install_plan.required_plugins,
                Path(args.plugin_root),
                config_path,
                runner=run_shell,
                backup_path=activation_plan.backup_path,
            )
            run_tools = _synchronize_run_tool_allowlist(config_path, selected, all_declared_tools)
            if run_tools:
                print(f"[tools] run-scoped allow entries: {run_tools}")
            runtime_patch = _apply_tokenpilot_runtime_settings(config_path, execution_model=execution_model)
            if runtime_patch:
                print(f"[tokenpilot] runtime patch applied: {runtime_patch}")
            print("[status] plugin plan applied")
            if args.execute_tasks:
                output_dir.mkdir(parents=True, exist_ok=True)
                timestamp = datetime.now(timezone.utc).strftime("run_%Y%m%d_%H%M%S_%f")[:-3]
                run_id = f"{timestamp}_{secrets.token_hex(2)}"
                run_root = output_dir / run_id
                run_root.mkdir(parents=True, exist_ok=True)
                selected_tasks = selected[: args.max_tasks] if args.max_tasks > 0 else selected
                if args.session_mode == "continuous" and args.parallel != 1:
                    raise SystemExit("--session-mode continuous requires --parallel 1")
                print(f"[run] executing {len(selected_tasks)} tasks under {run_root}")
                results = []
                shared_agent_id = None
                shared_workspace = None
                shared_session_id = None
                if args.session_mode == "continuous":
                    model_slug = execution_model.replace("/", "-").replace(":", "-")
                    shared_agent_id = f"ce-{model_slug}-{run_id}-serial"
                    shared_workspace = run_root / "_continuous" / "workspace"
                    shared_session_id = f"ce-continuous-{int(datetime.now(timezone.utc).timestamp() * 1000)}"
                    if selected_tasks:
                        ensure_agent_exists(
                            shared_agent_id,
                            execution_model,
                            shared_workspace,
                            config_path,
                            selected_tasks[0],
                        )
                for task in selected_tasks:
                    print(f"[task] {task.task_id} ({task.category})")
                    result = execute_task(
                        task,
                        model_id=execution_model,
                        run_root=run_root,
                        dataset_root=dataset_root,
                        service_code_root=service_code_root,
                        config_path=config_path,
                        local=True,
                        agent_id_override=shared_agent_id,
                        workspace_dir_override=shared_workspace,
                        session_id_override=shared_session_id,
                        preserve_workspace=(args.session_mode == "continuous"),
                        ensure_agent=not (args.session_mode == "continuous"),
                    )
                    grade = grade_execution_result(
                        task_yaml_path=task.task_yaml_path,
                        execution_result=result,
                        judge_model=judge_model,
                    )
                    result["grading"] = grade.to_dict()
                    result_path = run_root / task.task_id / "result.json"
                    result_path.write_text(
                        json.dumps(result, ensure_ascii=False, indent=2),
                        encoding="utf-8",
                    )
                    print(
                        f"[task-result] {task.task_id} status={result['status']} "
                        f"requests={result['usage']['request_count']} "
                        f"input={result['usage']['input_tokens']} "
                        f"cache={result['usage']['cache_read_tokens']} "
                        f"score={grade.task_score}"
                    )
                    results.append(result)
                summary_path = run_root / "summary.json"
                summary_path.write_text(
                    json.dumps(results, ensure_ascii=False, indent=2),
                    encoding="utf-8",
                )
                print(f"[run] summary saved to {summary_path}")
        finally:
            _cleanup_plugin_state()
            signal.signal(signal.SIGINT, previous_sigint)
            signal.signal(signal.SIGTERM, previous_sigterm)
    else:
        print("[dry-run] plugin plan not applied")


if __name__ == "__main__":
    main()
