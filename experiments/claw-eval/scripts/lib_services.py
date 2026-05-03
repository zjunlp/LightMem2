from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
from typing import Callable, Dict, Iterable, List, Optional, Sequence, Set

from lib_tasks import ClawEvalTask


# Task -> capability/tool names should stay benchmark-facing.
# Capability/tool -> plugin ids is adapter-facing.
TOOL_NAME_TO_PLUGIN_IDS: Dict[str, List[str]] = {
    "gmail_search": ["claw-eval-mock-tools-gmail"],
    "gmail_send": ["claw-eval-mock-tools-gmail"],
    "gmail_list_messages": ["claw-eval-mock-tools-gmail"],
    "gmail_get_message": ["claw-eval-mock-tools-gmail"],
    "gmail_save_draft": ["claw-eval-mock-tools-gmail"],
    "gmail_send_message": ["claw-eval-mock-tools-gmail"],
    "calendar_search": ["claw-eval-mock-tools-calendar"],
    "calendar_create": ["claw-eval-mock-tools-calendar"],
    "calendar_list_events": ["claw-eval-mock-tools-calendar"],
    "calendar_get_event": ["claw-eval-mock-tools-calendar"],
    "calendar_create_event": ["claw-eval-mock-tools-calendar"],
    "calendar_delete_event": ["claw-eval-mock-tools-calendar"],
    "calendar_get_user_events": ["claw-eval-mock-tools-calendar"],
    "todo_list": ["claw-eval-mock-tools-todo"],
    "todo_create": ["claw-eval-mock-tools-todo"],
    "todo_list_tasks": ["claw-eval-mock-tools-todo"],
    "todo_get_task": ["claw-eval-mock-tools-todo"],
    "todo_create_task": ["claw-eval-mock-tools-todo"],
    "todo_update_task": ["claw-eval-mock-tools-todo"],
    "todo_delete_task": ["claw-eval-mock-tools-todo"],
    "contacts_lookup": ["claw-eval-mock-tools-contacts"],
    "contacts_search": ["claw-eval-mock-tools-contacts"],
    "contacts_get": ["claw-eval-mock-tools-contacts"],
    "contacts_send_message": ["claw-eval-mock-tools-contacts"],
    "finance_quote": ["claw-eval-mock-tools-finance"],
    "finance_get_transaction": ["claw-eval-mock-tools-finance"],
    "finance_list_transactions": ["claw-eval-mock-tools-finance"],
    "finance_report_submit": ["claw-eval-mock-tools-finance"],
    "finance_submit_report": ["claw-eval-mock-tools-finance"],
    "notes_get": ["claw-eval-mock-tools-notes"],
    "notes_write": ["claw-eval-mock-tools-notes"],
    "notes_list": ["claw-eval-mock-tools-notes"],
    "notes_share": ["claw-eval-mock-tools-notes"],
    "kb_search": ["claw-eval-mock-tools-kb"],
    "kb_get_article": ["claw-eval-mock-tools-kb"],
    "kb_update_article": ["claw-eval-mock-tools-kb"],
    "helpdesk_search": ["claw-eval-mock-tools-helpdesk"],
    "helpdesk_list_tickets": ["claw-eval-mock-tools-helpdesk"],
    "helpdesk_get_ticket": ["claw-eval-mock-tools-helpdesk"],
    "helpdesk_update_ticket": ["claw-eval-mock-tools-helpdesk"],
    "helpdesk_close_ticket": ["claw-eval-mock-tools-helpdesk"],
    "inventory_lookup": ["claw-eval-mock-tools-inventory"],
    "inventory_get_item": ["claw-eval-mock-tools-inventory"],
    "inventory_list_items": ["claw-eval-mock-tools-inventory"],
    "inventory_get_product": ["claw-eval-mock-tools-inventory"],
    "inventory_list_products": ["claw-eval-mock-tools-inventory"],
    "inventory_create_order": ["claw-eval-mock-tools-inventory"],
    "rss_fetch": ["claw-eval-mock-tools-rss"],
    "rss_get_feed": ["claw-eval-mock-tools-rss"],
    "rss_get_article": ["claw-eval-mock-tools-rss"],
    "rss_list_feeds": ["claw-eval-mock-tools-rss"],
    "rss_list_articles": ["claw-eval-mock-tools-rss"],
    "rss_publish": ["claw-eval-mock-tools-rss"],
    "crm_lookup": ["claw-eval-mock-tools-crm"],
    "crm_list_customers": ["claw-eval-mock-tools-crm"],
    "crm_get_customer": ["claw-eval-mock-tools-crm"],
    "crm_export_report": ["claw-eval-mock-tools-crm"],
    "caption_describe_image": ["claw-eval-mock-tools"],
    "ocr_extract_text": ["claw-eval-mock-tools"],
    "config_list_integrations": ["claw-eval-mock-tools"],
    "config_get_integration": ["claw-eval-mock-tools"],
    "config_update_integration": ["claw-eval-mock-tools"],
    "config_notify": ["claw-eval-mock-tools"],
    "scheduler_create": ["claw-eval-mock-tools-scheduler"],
    "scheduler_create_job": ["claw-eval-mock-tools-scheduler"],
    "scheduler_delete_job": ["claw-eval-mock-tools-scheduler"],
    "scheduler_get_job": ["claw-eval-mock-tools-scheduler"],
    "scheduler_list_jobs": ["claw-eval-mock-tools-scheduler"],
    "scheduler_job_history": ["claw-eval-mock-tools-scheduler"],
    "scheduler_update_job": ["claw-eval-mock-tools-scheduler"],
    # web-backed tasks will likely need a different runtime path later.
    "web_search": [],
    "web_fetch": [],
    "Bash": [],
}

SERVICE_NAME_TO_PLUGIN_IDS: Dict[str, List[str]] = {
    "gmail": ["claw-eval-mock-tools-gmail"],
    "calendar": ["claw-eval-mock-tools-calendar"],
    "todo": ["claw-eval-mock-tools-todo"],
    "contacts": ["claw-eval-mock-tools-contacts"],
    "finance": ["claw-eval-mock-tools-finance"],
    "notes": ["claw-eval-mock-tools-notes"],
    "kb": ["claw-eval-mock-tools-kb"],
    "helpdesk": ["claw-eval-mock-tools-helpdesk"],
    "inventory": ["claw-eval-mock-tools-inventory"],
    "rss": ["claw-eval-mock-tools-rss"],
    "crm": ["claw-eval-mock-tools-crm"],
    "caption": ["claw-eval-mock-tools"],
    "ocr": ["claw-eval-mock-tools"],
    "ocr_paper": ["claw-eval-mock-tools"],
    "ocr_t50": ["claw-eval-mock-tools"],
    "ocr_t51": ["claw-eval-mock-tools"],
    "ocr_t52": ["claw-eval-mock-tools"],
    "ocr_t53": ["claw-eval-mock-tools"],
    "ocr_t54": ["claw-eval-mock-tools"],
    "ocr_t55": ["claw-eval-mock-tools"],
    "ocr_t56": ["claw-eval-mock-tools"],
    "ocr_t57": ["claw-eval-mock-tools"],
    "ocr_t58": ["claw-eval-mock-tools"],
    "ocr_t59": ["claw-eval-mock-tools"],
    "config": ["claw-eval-mock-tools"],
    "scheduler": ["claw-eval-mock-tools-scheduler"],
    "web_real": [],
}


@dataclass
class PluginResolution:
    required_plugins: List[str]
    unresolved_tools: List[str]
    unresolved_services: List[str]


@dataclass
class PluginInstallPlan:
    plugin_root: Path
    required_plugins: List[str]
    missing_plugin_ids: List[str]
    install_commands: List[str]
    enable_commands: List[str]
    disable_commands: List[str]
    unresolved_tools: List[str]
    unresolved_services: List[str]


@dataclass
class PluginActivationPlan:
    required_plugins: List[str]
    backup_path: Path
    plugin_root: Path
    enable_plugin_ids: List[str]
    disable_plugin_ids: List[str]


def resolve_required_plugins(tasks: Iterable[ClawEvalTask]) -> PluginResolution:
    required: Set[str] = set()
    unresolved_tools: Set[str] = set()
    unresolved_services: Set[str] = set()

    for task in tasks:
        for tool_name in task.declared_tools:
            plugin_ids = TOOL_NAME_TO_PLUGIN_IDS.get(tool_name)
            if plugin_ids is None:
                unresolved_tools.add(tool_name)
                continue
            required.update(pid for pid in plugin_ids if pid)

        for service in task.services:
            service_name = str(service.get("name") or "").strip()
            if not service_name:
                continue
            plugin_ids = SERVICE_NAME_TO_PLUGIN_IDS.get(service_name)
            if plugin_ids is None:
                unresolved_services.add(service_name)
                continue
            required.update(pid for pid in plugin_ids if pid)

    return PluginResolution(
        required_plugins=sorted(required),
        unresolved_tools=sorted(unresolved_tools),
        unresolved_services=sorted(unresolved_services),
    )


def summarize_plugin_closure(tasks: Iterable[ClawEvalTask]) -> Dict[str, object]:
    task_list = list(tasks)
    resolution = resolve_required_plugins(task_list)
    return {
        "task_count": len(task_list),
        "required_plugins": resolution.required_plugins,
        "required_plugin_count": len(resolution.required_plugins),
        "unresolved_tools": resolution.unresolved_tools,
        "unresolved_services": resolution.unresolved_services,
    }


def build_plugin_install_plan(
    tasks: Iterable[ClawEvalTask],
    plugin_root: Path,
) -> PluginInstallPlan:
    resolution = resolve_required_plugins(tasks)
    plugin_root = plugin_root.resolve()

    missing_plugin_ids: List[str] = []
    install_commands: List[str] = []
    enable_commands: List[str] = []
    disable_commands: List[str] = []

    for plugin_id in resolution.required_plugins:
        plugin_dir = plugin_root / plugin_id
        manifest_path = plugin_dir / "openclaw.plugin.json"
        if not manifest_path.exists():
            missing_plugin_ids.append(plugin_id)
            continue
        install_commands.append(f"# ensure plugin available on load path: {plugin_dir}")
        enable_commands.append(f"# enable plugin entry {plugin_id}")

    # Conservative default: disable known mock plugins not needed by this run.
    all_known_plugin_ids = sorted(
        {
            pid
            for ids in TOOL_NAME_TO_PLUGIN_IDS.values()
            for pid in ids
            if pid
        }
        | {
            pid
            for ids in SERVICE_NAME_TO_PLUGIN_IDS.values()
            for pid in ids
            if pid
        }
    )
    required_set = set(resolution.required_plugins)
    for plugin_id in all_known_plugin_ids:
        if plugin_id not in required_set:
            disable_commands.append(f"# disable plugin entry {plugin_id}")

    return PluginInstallPlan(
        plugin_root=plugin_root,
        required_plugins=resolution.required_plugins,
        missing_plugin_ids=missing_plugin_ids,
        install_commands=install_commands,
        enable_commands=enable_commands,
        disable_commands=disable_commands,
        unresolved_tools=resolution.unresolved_tools,
        unresolved_services=resolution.unresolved_services,
    )


def build_plugin_activation_plan(
    required_plugin_ids: Sequence[str],
    plugin_root: Path,
    config_path: Path,
    backup_path: Optional[Path] = None,
) -> PluginActivationPlan:
    config_path = config_path.resolve()
    if backup_path is None:
        backup_path = config_path.with_suffix(config_path.suffix + ".bak.claw_eval")
    backup_path = backup_path.resolve()

    required_plugins = sorted({plugin_id for plugin_id in required_plugin_ids if plugin_id})
    known_plugin_ids = sorted(
        {
            pid
            for ids in TOOL_NAME_TO_PLUGIN_IDS.values()
            for pid in ids
            if pid
        }
        | {
            pid
            for ids in SERVICE_NAME_TO_PLUGIN_IDS.values()
            for pid in ids
            if pid
        }
    )

    return PluginActivationPlan(
        required_plugins=required_plugins,
        backup_path=backup_path,
        plugin_root=plugin_root.resolve(),
        enable_plugin_ids=required_plugins,
        disable_plugin_ids=[
            plugin_id for plugin_id in known_plugin_ids if plugin_id not in set(required_plugins)
        ],
    )


def _all_known_claw_eval_plugin_ids() -> Set[str]:
    return {
        pid
        for ids in TOOL_NAME_TO_PLUGIN_IDS.values()
        for pid in ids
        if pid
    } | {
        pid
        for ids in SERVICE_NAME_TO_PLUGIN_IDS.values()
        for pid in ids
        if pid
    }


def _sanitize_claw_eval_plugin_state(raw: Dict[str, object]) -> Dict[str, object]:
    """Strip stale claw-eval plugin state from an OpenClaw config snapshot.

    This keeps unrelated plugins (for example tokenpilot/feishu/qwen auth)
    intact, while removing any previous claw-eval run-scoped allowlist/entry
    residue before we create a backup for the next run.
    """
    known_plugin_ids = _all_known_claw_eval_plugin_ids()
    plugins = raw.setdefault("plugins", {})

    allow = plugins.get("allow")
    if isinstance(allow, list):
        plugins["allow"] = [plugin_id for plugin_id in allow if plugin_id not in known_plugin_ids]

    entries = plugins.get("entries")
    if isinstance(entries, dict):
        for plugin_id in list(entries.keys()):
            if plugin_id in known_plugin_ids:
                entries.pop(plugin_id, None)

    return raw


def ensure_plugins_installed(
    plugin_ids: Sequence[str],
    plugin_root: Path,
    runner: Optional[Callable[[str], object]] = None,
) -> List[str]:
    plugin_root = plugin_root.resolve()
    commands: List[str] = []
    for plugin_id in sorted({pid for pid in plugin_ids if pid}):
        plugin_dir = plugin_root / plugin_id
        manifest_path = plugin_dir / "openclaw.plugin.json"
        if not manifest_path.exists():
            raise FileNotFoundError(f"Missing plugin manifest for {plugin_id}: {manifest_path}")
        cmd = f"openclaw plugins install '{plugin_dir}' --force"
        commands.append(cmd)
        if runner is not None:
            runner(cmd)
    return commands


def activate_plugins_for_run(
    required_plugin_ids: Sequence[str],
    plugin_root: Path,
    config_path: Path,
    runner: Optional[Callable[[str], object]] = None,
    backup_path: Optional[Path] = None,
) -> PluginActivationPlan:
    plan = build_plugin_activation_plan(required_plugin_ids, plugin_root, config_path, backup_path)
    if runner is None:
        return plan

    config_path = config_path.resolve()
    raw = json.loads(config_path.read_text(encoding="utf-8"))
    raw = _sanitize_claw_eval_plugin_state(raw)
    plan.backup_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    plugins = raw.setdefault("plugins", {})
    plugins["enabled"] = True
    allow = plugins.setdefault("allow", [])
    if not isinstance(allow, list):
        allow = []
    allow = [plugin_id for plugin_id in allow if plugin_id not in _all_known_claw_eval_plugin_ids()]
    for plugin_id in plan.enable_plugin_ids:
        if plugin_id not in allow:
            allow.append(plugin_id)
    plugins["allow"] = allow

    load = plugins.setdefault("load", {})
    paths = load.setdefault("paths", [])
    root_str = str(plan.plugin_root)
    if root_str not in paths:
        paths.append(root_str)

    entries = plugins.setdefault("entries", {})
    for plugin_id in plan.enable_plugin_ids:
        entry = entries.setdefault(plugin_id, {})
        entry["enabled"] = True
    for plugin_id in plan.disable_plugin_ids:
        entries.pop(plugin_id, None)

    config_path.write_text(json.dumps(raw, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return plan


def restore_plugins_after_run(
    activation_plan: PluginActivationPlan,
    config_path: Path,
    runner: Optional[Callable[[str], object]] = None,
) -> str:
    restore_cmd = f"cp '{activation_plan.backup_path}' '{config_path.resolve()}'"
    if runner is not None:
        runner(restore_cmd)
    return restore_cmd
