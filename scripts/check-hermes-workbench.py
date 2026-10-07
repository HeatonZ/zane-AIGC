"""Read-only acceptance using the installed Hermes MCP registration and dispatch path.

Starts ONLY the configured zane-workbench stdio child in this short-lived process.
Uses a temporary Hermes home for logs/cache, never starts chat/gateway or calls a model.
"""
from __future__ import annotations

import argparse
from copy import deepcopy
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile

import yaml

SERVER = "zane-workbench"
UTILITIES = ("list_resources", "read_resource", "list_prompts", "get_prompt")
READS = {"get_workspace_status", "get_workbench", "list_scenes", "get_scene", "list_capabilities", "get_workspace", "get_scene_draft", "list_option_presets", *UTILITIES}


def read_catalog(read, operation: str, items_key: str, revision_key: str):
    """Collect a read-only catalogue; never treat its first page as the full set."""
    first = read(operation)
    items = list(first[items_key])
    page = first
    seen = set()
    while page.get("hasMore"):
        cursor = page.get("nextCursor")
        if not cursor or cursor in seen:
            raise RuntimeError("invalid catalogue pagination: " + operation)
        seen.add(cursor)
        page = read(operation, {"cursor": cursor})
        if page.get(revision_key) != first.get(revision_key):
            raise RuntimeError("catalogue changed during read-only diagnosis: " + operation)
        items.extend(page[items_key])
    if "total" in first and first["total"] != len(items):
        raise RuntimeError("incomplete catalogue: " + operation)
    return items, first


def unpack_result(raw, *, business: bool = False):
    payload = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(payload, dict) or "error" in payload:
        raise RuntimeError(str(payload.get("error", "invalid Hermes tool result")) if isinstance(payload, dict) else "invalid Hermes tool result")
    if not business:
        return payload
    payload = payload.get("structuredContent", payload.get("result", payload))
    if isinstance(payload, str):
        payload = json.loads(payload)
    if not isinstance(payload, dict) or not payload.get("ok"):
        raise RuntimeError("workbench returned an unsuccessful or incompatible result")
    return payload["data"]


def inspect_profile_nodes(workspace: dict, profile_name: str) -> list[dict]:
    """Summarise ONLY published self-profile nodes, never print input/prompt contents."""
    found = []
    for scene_id, record in workspace.get("sceneVersions", {}).items():
        version = next((v for v in record.get("versions", []) if v.get("id") == record.get("publishedVersionId")), None)
        if not version:
            continue
        def visit(value):
            if isinstance(value, dict):
                if value.get("hermesProfile") == profile_name:
                    found.append({"sceneId": scene_id, "versionId": version["id"], "stepId": value.get("id"), "profile": profile_name})
                for child in value.values():
                    visit(child)
            elif isinstance(value, list):
                for child in value:
                    visit(child)
        visit(version.get("workflow", {}))
    return found


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile-home", type=Path, required=True)
    parser.add_argument("--hermes-source", type=Path, required=True, help="installed, read-only hermes-agent checkout")
    parser.add_argument("--base-url", help="override only for this probe; does not change profile configuration")
    parser.add_argument("--expected-project", type=Path)
    parser.add_argument("--discovery-only", action="store_true", help="tools/resources/prompts only; does not assert backend readiness")
    args = parser.parse_args()
    result = {"ok": False, "profileHome": str(args.profile_home.resolve()), "toolDiscoveryPassed": False, "backendChecked": False, "generationExecuted": False, "processesRestarted": False}
    temporary = None
    shutdown = None
    try:
        profile = args.profile_home.resolve(strict=True)
        source = args.hermes_source.resolve(strict=True)
        if not (source / "tools/mcp_tool.py").is_file():
            raise ValueError("hermes-source is not the installed Hermes source checkout")
        config = yaml.safe_load((profile / "config.yaml").read_text(encoding="utf-8-sig"))
        server = deepcopy(config.get("mcp_servers", {}).get(SERVER))
        if not isinstance(server, dict):
            raise ValueError("profile has no zane-workbench MCP entry")
        if args.base_url:
            server["env"] = {**(server.get("env") or {}), "ZANE_BASE_URL": args.base_url}
        result["baseUrl"] = (server.get("env") or {}).get("ZANE_BASE_URL", "http://127.0.0.1:8799")
        # Do not let SDK logs/cache touch the real profile; only load the selected MCP config.
        temporary = Path(tempfile.mkdtemp(prefix="zane-hermes-probe-")).resolve()
        os.environ["HERMES_HOME"] = str(temporary)
        os.environ["PYTHONDONTWRITEBYTECODE"] = "1"
        sys.dont_write_bytecode = True
        sys.path.insert(0, str(source))
        skills_config = config.get("skills") or {}
        # Copy only disable selections, not credentials or unrelated profile settings.
        probe_config = {"mcp_servers": {SERVER: server}, "skills": {k: skills_config[k] for k in ("disabled", "platform_disabled") if k in skills_config}}
        (temporary / "config.yaml").write_text(yaml.safe_dump(probe_config), encoding="utf-8")
        skill_path = profile / "skills/zane-workbench/SKILL.md"
        if not skill_path.is_file():
            raise ValueError("profile zane-workbench skill is missing; install the profile integration first")
        copied_skill = temporary / "skills/zane-workbench/SKILL.md"
        copied_skill.parent.mkdir(parents=True)
        copied_skill.write_bytes(skill_path.read_bytes())
        from tools.mcp_tool_discovery import register_mcp_servers
        from tools.mcp_tool_lifecycle import shutdown_mcp_servers
        from tools.mcp_tool_schema import mcp_prefixed_tool_name
        from tools.mcp_tool_common import mcp_server_enabled
        from tools.registry import registry
        from hermes_cli.tools_config import _merge_mcp_servers
        from tools.skills_tool import skill_view, _is_skill_disabled
        shutdown = shutdown_mcp_servers
        if not mcp_server_enabled(server):
            raise ValueError("zane-workbench MCP is disabled in this profile")
        # Confirm platform lists do not hide the newly configured server (no mutation/discovery).
        for platform in ("cli", "discord"):
            if _is_skill_disabled("zane-workbench", platform):
                raise ValueError("zane-workbench skill is disabled for " + platform + "; preserving that user selection")
            selected = (config.get("platform_toolsets") or {}).get(platform, [])
            enabled = _merge_mcp_servers(config, selected, set(selected), True)
            if SERVER not in enabled:
                raise ValueError(platform + " toolset selection excludes zane-workbench; merge it with the existing MCP selections")
        names = set(register_mcp_servers({SERVER: server}))
        required = ["get_workbench", "list_scenes", "get_scene", "prepare_scene", "submit_scene", "wait_run", "review_run", "preview_rerun", "rerun", "create_scene", "get_scene_draft", "update_scene_draft", "validate_scene_draft", "publish_scene", "restore_scene_draft", "delete_scene", "list_option_presets", "save_option_preset", "delete_option_preset", "get_run_outputs", "get_step_result", *UTILITIES]
        if any(mcp_prefixed_tool_name(SERVER, name) not in names for name in required):
            raise RuntimeError("Hermes did not register all required workbench and resource/prompt tools")
        result.update({"toolDiscoveryPassed": True, "hermesRegisteredToolCount": len(names), "businessToolCount": len(names) - len(UTILITIES), "toolPrefix": mcp_prefixed_tool_name(SERVER, "get_workbench").removesuffix("get_workbench"), "platformToolsets": ["cli", "discord"]})

        def read(name: str, parameters=None):
            if name not in READS:
                raise ValueError("probe cannot dispatch a mutating/execution tool")
            return unpack_result(registry.dispatch(mcp_prefixed_tool_name(SERVER, name), parameters or {}), business=name not in UTILITIES)

        resources = read("list_resources")["resources"]
        guide = read("read_resource", {"uri": "zane://guide"})["result"]
        openapi = json.loads(read("read_resource", {"uri": "zane://openapi"})["result"])
        prompts = read("list_prompts")["prompts"]
        messages = read("get_prompt", {"name": "operate-workbench", "arguments": {"goal": "只读检查，不创建运行"}})["messages"]
        if "AI 工作台操作手册" not in guide or openapi.get("openapi") != "3.1.0" or not messages:
            raise RuntimeError("resources/prompts were not preserved through the Hermes MCP adapter")
        skill = unpack_result(skill_view("zane-workbench", preprocess=False))
        if not skill.get("success") or "mcp__zane_workbench__" not in skill.get("content", ""):
            raise RuntimeError("installed profile skill is not readable by Hermes skill_view")
        result.update({"resourceCount": len(resources), "promptCount": len(prompts), "guideReadable": True, "skillReadable": True})
        if args.discovery_only:
            result.update({"ok": True, "next": "工具发现通过不代表后台可执行；继续进行后台只读检查。"})
        else:
            result["backendChecked"] = True
            workbench = read("get_workbench")
            authority = read("get_workspace_status")
            scenes, scene_page = read_catalog(read, "list_scenes", "scenes", "workspaceRevision")
            capabilities, _ = read_catalog(read, "list_capabilities", "capabilities", "revision")
            if authority["workspaceRevision"] != scene_page["workspaceRevision"]:
                raise RuntimeError("workspace changed during read-only diagnosis; rerun before takeover")
            published = [scene for scene in scenes if scene.get("publishedVersionId")]
            catalogue_matches = {mcp_prefixed_tool_name(SERVER, op["name"]) for op in workbench.get("operations", [])} == names - {mcp_prefixed_tool_name(SERVER, utility) for utility in UTILITIES}
            ready = catalogue_matches and workbench.get("contractVersion") == openapi.get("info", {}).get("version") and all(workbench.get("worker", {}).get(k) for k in ("ready", "accepting")) and workbench.get("projectConfigured") and bool(published)
            if args.expected_project and Path(workbench.get("projectDirectory") or "").resolve() != args.expected_project.resolve():
                raise RuntimeError("backend project directory does not match --expected-project")
            published_snapshots = {scene["sceneId"]: read("get_scene", {"sceneId": scene["sceneId"], "versionId": scene["publishedVersionId"]}) for scene in published}
            self_nodes = inspect_profile_nodes({"sceneVersions": {scene_id: {"publishedVersionId": snapshot["versionId"], "versions": [{"id": snapshot["versionId"], "workflow": snapshot["workflow"]}]} for scene_id, snapshot in published_snapshots.items()}}, profile.name)
            result.update({"ok": bool(ready), "contractVersion": workbench.get("contractVersion"), "workspaceRevision": scene_page["workspaceRevision"], "authority": authority["authority"], "sceneCount": len(scenes), "worker": workbench.get("worker"), "projectConfigured": workbench.get("projectConfigured"), "projectDirectory": workbench.get("projectDirectory"), "publishedSceneCount": len(published), "capabilityCount": len(capabilities), "selfProfileNodes": self_nodes})
            if published:
                snapshot = published_snapshots[published[0]["sceneId"]]
                if not snapshot.get("inputSchema") or not snapshot.get("inputExamples"):
                    raise RuntimeError("published scene has no AI input contract")
                draft = read("get_scene_draft", {"sceneId": published[0]["sceneId"]})
                if len(draft.get("revision", "")) != 64:
                    raise RuntimeError("single scene draft has no content revision")
                read("list_option_presets", {"limit": 1})
                if not snapshot.get("versionId"):
                    raise RuntimeError("published scene snapshot could not be read")
            result["next"] = "在新会话中先加载 zane-workbench；真实生成仍须用户授权。" if ready else "后台须兼容、worker就绪、配置目标项目并至少发布一个场景。"
            if self_nodes:
                result["selfProfileWarning"] = "发布流程包含当前 profile 节点：节点仅返回结果，不能再次提交/恢复/审核工作台运行。"
    except Exception as exc:
        result["error"] = str(exc)
        result["next"] = "若返回404/HTML，安排升级实际后台；不要用重投任务或重启Gateway代替诊断。"
    finally:
        if shutdown:
            try:
                shutdown(timeout=10)
            except Exception as exc:
                result.update({"ok": False, "cleanupError": str(exc)})
        if temporary:
            # Only the exact directory created above; never production/profile/source data.
            if temporary.parent != Path(tempfile.gettempdir()).resolve() or not temporary.name.startswith("zane-hermes-probe-"):
                raise RuntimeError("refusing to remove an unexpected probe directory")
            shutil.rmtree(temporary)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
