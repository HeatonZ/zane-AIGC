"""Install a user profile MCP entry, skill and managed SOUL section.

Explicit --adopt-workbench-role backs up and replaces the selected profile role.

Requires PyYAML (already shipped in Hermes' Python environment). Dry-run by default.
Never edits Hermes upstream, launches chat/gateway, or starts the workbench backend.
"""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from copy import deepcopy
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
import re
from pathlib import Path
import shutil
import tempfile
import time
from urllib.parse import urlsplit
from uuid import uuid4

import yaml

ROOT = Path(__file__).resolve().parent.parent
SERVER = "zane-workbench"
START = "<!-- zane-workbench:start -->"
END = "<!-- zane-workbench:end -->"
# Exact shipped 1.0.1 content (installer normalizes source line endings to LF).
# A matching version header alone is never permission to overwrite local edits.
PREVIOUS_SKILL_DIGESTS = frozenset({
    "a3e2acbf83a91e94255a73dd6aa1009e811b4e378cd8611efe07451e5bc23370",  # exact shipped 1.1.1
    "a1308a930b4a81439e7b2a61d53f0af8ed9081db9f01fcf7a896bf1a5ad5ceb7",  # exact shipped 1.1.0
    "a4c24305dba7c39823755d9b8e2288282303996e1522a557da5c53145f894712",
    "25d345a6e01678ddb0f5bac6a3e530f6c4cec8a764a27f6c213dbca33e1fa348",  # exact CRLF source
})


def make_server(node: str, mcp_entry: Path, base_url: str) -> dict:
    parsed = urlsplit(base_url)
    if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.query or parsed.fragment:
        raise ValueError("base-url must be an HTTP(S) backend URL, without query or fragment")
    return {
        "command": str(Path(node).resolve()).replace("\\", "/"),
        "args": [str(mcp_entry.resolve()).replace("\\", "/")],
        "env": {"ZANE_BASE_URL": base_url.rstrip("/"), "ZANE_MCP_TIMEOUT_MS": "45000"},
        "enabled": True, "connect_timeout": 30, "timeout": 60,
        "tools": {"resources": True, "prompts": True},
    }


def merge_config(original: bytes, server: dict) -> bytes:
    """Insert one block using YAML source marks; keep every unrelated byte intact."""
    text = original.decode("utf-8-sig")
    config = yaml.safe_load(text)
    if not isinstance(config, dict):
        raise ValueError("profile config must be a YAML mapping")
    servers = config.get("mcp_servers", {})
    if not isinstance(servers, dict):
        raise ValueError("mcp_servers must be a block mapping; please resolve its existing value first")
    document = yaml.compose(text)
    entries = [(key, value) for key, value in document.value if key.value == "mcp_servers"]
    if len(entries) > 1:
        raise ValueError("duplicate top-level mcp_servers keys; refusing ambiguous configuration")
    if SERVER in servers:
        if servers[SERVER] != server:
            raise ValueError("zane-workbench already exists with different settings; not overwriting user configuration")
        return original
    eol = "\r\n" if "\r\n" in text else "\n"
    block = yaml.safe_dump({SERVER: server}, allow_unicode=True, sort_keys=False)
    indented = "".join("  " + line + eol for line in block.splitlines())
    if entries:
        key, mapping = entries[0]
        if not isinstance(mapping, yaml.MappingNode) or mapping.flow_style:
            raise ValueError("mcp_servers must use block-style YAML for byte-preserving installation")
        # Anchored/aliased mappings can affect other config branches: do not mutate them.
        header = text.splitlines()[key.start_mark.line]
        if not re.fullmatch(r"mcp_servers:\s*(?:#.*)?", header.strip()):
            raise ValueError("mcp_servers header has a tag/anchor; refusing shared or tagged mappings")
        lines = text.splitlines(keepends=True)
        index = mapping.end_mark.line
        # Keep top-level section comments with the following section, not the inserted entry.
        while index > mapping.start_mark.line and (not lines[index - 1].strip() or lines[index - 1].startswith("#")):
            index -= 1
        if index and not lines[index - 1].endswith(("\n", "\r")):
            lines[index - 1] += eol
        lines.insert(index, indented)
        proposed = "".join(lines)
    else:
        proposed = text + ("" if text.endswith(("\n", "\r")) else eol) + "mcp_servers:" + eol + indented
    expected = deepcopy(config)
    expected.setdefault("mcp_servers", {})[SERVER] = server
    if yaml.safe_load(proposed) != expected:
        raise ValueError("YAML validation failed: changes are not confined to the new MCP entry")
    bom = b"\xef\xbb\xbf" if original.startswith(b"\xef\xbb\xbf") else b""
    return bom + proposed.encode("utf-8")


def merge_soul(original: bytes | None, section: str, *, profile_name: str | None = None, adopt_workbench_role: bool = False) -> bytes:
    text = (original or b"").decode("utf-8-sig")
    if text.count(START) != text.count(END) or text.count(START) > 1:
        raise ValueError("SOUL managed section markers are incomplete/duplicated")
    eol = "\r\n" if "\r\n" in text else "\n"
    if adopt_workbench_role:
        if not profile_name or "\n" in profile_name or "\r" in profile_name:
            raise ValueError("a valid profile name is required to adopt the workbench role")
        # Explicit opt-in replaces the old role, regardless of the selected profile name.
        text = (ROOT / "examples/hermes/workbench-role.md").read_text(encoding="utf-8-sig")
        text = text.replace("{{profile_name}}", profile_name).replace("\r\n", "\n").replace("\n", eol)
    section = section.strip().replace("\r\n", "\n").replace("\n", eol)
    if START in text:
        start = text.index(START)
        end = text.index(END) + len(END)
        if end <= start:
            raise ValueError("SOUL managed section markers are reversed")
        proposed = text[:start] + section + text[end:]
    else:
        proposed = text.rstrip("\r\n") + eol + eol + section + eol
    bom = b"\xef\xbb\xbf" if original and original.startswith(b"\xef\xbb\xbf") else b""
    return bom + proposed.encode("utf-8")


@contextmanager
def config_lock(path: Path, timeout: float = 10):
    """Same first-byte advisory lock used by the installed profile config publisher."""
    with path.open("a+b") as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"0")
            handle.flush()
        deadline = time.monotonic() + timeout
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt
                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl
                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError:
                if time.monotonic() >= deadline:
                    raise RuntimeError("profile config is being updated; retry later") from None
                time.sleep(0.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def atomic_write(path: Path, data: bytes):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix="." + path.name + ".", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(data)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def read_optional(path: Path) -> bytes | None:
    return path.read_bytes() if path.is_file() else None


def install(profile: Path, server: dict, *, apply: bool = False, adopt_workbench_role: bool = False) -> dict:
    profile = profile.resolve(strict=True)
    if "hermes-agent" in [part.casefold() for part in profile.parts]:
        raise ValueError("Hermes upstream is read-only; supply a user profile home")
    paths = [profile / "config.yaml", profile / "SOUL.md", profile / "skills/zane-workbench/SKILL.md"]
    for path in [*paths, profile / "backups", profile / "config.yaml.evolution-director.lock"]:
        if path.resolve() != path or not path.is_relative_to(profile):
            raise ValueError("refusing redirected profile files or directories")
    if not paths[0].is_file():
        raise ValueError("profile config.yaml is missing; refusing to invent a new profile")
    with config_lock(profile / "config.yaml.evolution-director.lock"):
        before = {p: read_optional(p) for p in paths}
        skill = (ROOT / "examples/hermes/zane-workbench/SKILL.md").read_text(encoding="utf-8-sig").encode("utf-8")
        if before[paths[2]] not in (None, skill) and sha256(before[paths[2]]).hexdigest() not in PREVIOUS_SKILL_DIGESTS:
            raise ValueError("profile zane-workbench skill has local edits; not overwriting")
        after = {
            paths[0]: merge_config(before[paths[0]], server),
            paths[1]: merge_soul(before[paths[1]], (ROOT / "examples/hermes/workbench-soul-section.md").read_text(encoding="utf-8-sig"), profile_name=profile.name, adopt_workbench_role=adopt_workbench_role),
            paths[2]: skill,
        }
        changes = [p for p in paths if before[p] != after[p]]
        result = {"profileHome": str(profile), "applied": apply, "adoptWorkbenchRole": adopt_workbench_role, "changedFiles": [str(p) for p in changes], "backupDirectory": None, "processesRestarted": False}
        if not apply or not changes:
            return result
        # Check all planned inputs again before touching any file (no stale-config publication).
        if any(read_optional(p) != before[p] for p in paths):
            raise RuntimeError("profile changed during installation; rerun the dry-run")
        backup = profile / "backups" / ("zane-workbench-" + datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex[:8])
        backup.mkdir(parents=True)
        manifest = {"server": SERVER, "files": []}
        for p in changes:
            relative = p.relative_to(profile)
            manifest["files"].append({"path": relative.as_posix(), "existed": before[p] is not None})
            if before[p] is not None:
                target = backup / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(before[p])
        (backup / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        result["backupDirectory"] = str(backup)
        # Publish the skill and instructions first; enable the MCP config last.
        for p in [paths[2], paths[1], paths[0]]:
            if p in changes:
                if read_optional(p) != before[p]:
                    raise RuntimeError("profile changed during publication; backups retained at " + str(backup))
                atomic_write(p, after[p])
        return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile-home", required=True, type=Path)
    parser.add_argument("--base-url", default="http://127.0.0.1:8799")
    parser.add_argument("--node", default=shutil.which("node"))
    parser.add_argument("--apply", action="store_true", help="write after validation; default is dry-run")
    parser.add_argument("--adopt-workbench-role", action="store_true", help="explicitly replace the selected profile SOUL with a flexible workbench business role; backs up the previous role")
    args = parser.parse_args()
    try:
        entry = ROOT / "dist-server/mcp/index.js"
        if not args.node or not Path(args.node).is_file() or not entry.is_file():
            raise ValueError("Node executable / compiled MCP entry missing; run npm run build:server first")
        result = install(args.profile_home, make_server(args.node, entry, args.base_url), apply=args.apply, adopt_workbench_role=args.adopt_workbench_role)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc), "processesRestarted": False}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
