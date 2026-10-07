"""Offline regression tests for Hermes profile installation and result adaptation."""
from __future__ import annotations

import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import unittest
from unittest.mock import patch
from hashlib import sha256

import yaml

ROOT = Path(__file__).resolve().parent.parent


def load_script(name):
    spec = importlib.util.spec_from_file_location(name.replace("-", "_"), ROOT / "scripts" / (name + ".py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


installer = load_script("install-hermes-workbench")
probe = load_script("check-hermes-workbench")
SERVER = installer.make_server("C:/node/node.exe", ROOT / "dist-server/mcp/index.js", "http://127.0.0.1:8799")
SECTION = (ROOT / "examples/hermes/workbench-soul-section.md").read_text(encoding="utf-8-sig")


class HermesWorkbenchTests(unittest.TestCase):
    def test_catalogue_reads_all_pages_and_rejects_mixed_revision(self):
        calls = []
        def read(name, parameters=None):
            calls.append((name, parameters))
            return {"workspaceRevision": 7, "scenes": ["second"] if parameters else ["first"], "total": 2, "hasMore": not bool(parameters), **({} if parameters else {"nextCursor": "next"})}
        items, page = probe.read_catalog(read, "list_scenes", "scenes", "workspaceRevision")
        self.assertEqual(items, ["first", "second"])
        self.assertEqual(page["workspaceRevision"], 7)
        self.assertEqual(calls[1][1], {"cursor": "next"})
        def changed(name, parameters=None):
            value = read(name, parameters)
            if parameters: value["workspaceRevision"] = 8
            return value
        with self.assertRaisesRegex(RuntimeError, "changed during"):
            probe.read_catalog(changed, "list_scenes", "scenes", "workspaceRevision")


    def test_preserve_existing_config_bytes_and_comments(self):
        prefix = b"# original\r\nmodel: old-model\r\nmcp_servers:\r\n  davinci-resolve:\r\n    command: python\r\n    env:\r\n      TEST_PRIVATE_VALUE: preserve-me\r\n"
        suffix = b"# platform selection\r\nplatform_toolsets:\r\n  discord: [connections, hermes-discord, kanban]\r\n"
        old = prefix + suffix
        new = installer.merge_config(old, SERVER)
        self.assertTrue(new.startswith(prefix))
        self.assertTrue(new.endswith(suffix))
        parsed = yaml.safe_load(new)
        del parsed["mcp_servers"][installer.SERVER]
        self.assertEqual(parsed, yaml.safe_load(old))

    def test_append_missing_mcp(self):
        old = "# 中文说明\nmodel: unchanged\n".encode()
        new = installer.merge_config(old, SERVER)
        self.assertTrue(new.startswith(old))
        self.assertEqual(yaml.safe_load(new)["mcp_servers"][installer.SERVER], SERVER)

    def test_idempotent_and_preserve_bom(self):
        new = installer.merge_config(b"\xef\xbb\xbfmodel: unchanged\r\n", SERVER)
        self.assertTrue(new.startswith(b"\xef\xbb\xbf"))
        self.assertEqual(installer.merge_config(new, SERVER), new)

    def test_refuse_custom_entry(self):
        old = yaml.safe_dump({"mcp_servers": {installer.SERVER: {"command": "custom"}}}).encode()
        with self.assertRaisesRegex(ValueError, "not overwriting"):
            installer.merge_config(old, SERVER)

    def test_refuse_ambiguous_or_shared_mappings(self):
        duplicate_matching = b"mcp_servers:\n  a: {}\n" + yaml.safe_dump({"mcp_servers": {installer.SERVER: SERVER}}, sort_keys=False).encode()
        for old in [duplicate_matching, b"mcp_servers: {}\n", b"mcp_servers: &shared\n  old: {}\ncopy: *shared\n", b"mcp_servers:\n  a: {}\nmcp_servers:\n  b: {}\n"]:
            with self.subTest(old=old):
                with self.assertRaises(ValueError):
                    installer.merge_config(old, SERVER)

    def test_default_install_preserves_original_role_verbatim(self):
        old = "# 原来的profile\r\n1. 只有真实 POST /prompt 拿到ID才报提交\r\n\r\n其他职责保持\r\n".encode()
        new = installer.merge_soul(old, SECTION, profile_name="comfyui-dev")
        self.assertTrue(new.startswith(old))
        self.assertEqual(installer.merge_soul(new, SECTION, profile_name="comfyui-dev"), new)
        self.assertEqual(new.decode().count(installer.START), 1)

    def test_explicit_workbench_role_replaces_old_business_for_any_profile(self):
        original = ("# ComfyUI 开发测试环境\nPOST /prompt；共用8188；LoRA；0.4MP；aixg；code profile\n" + SECTION).encode()
        for name in ("comfyui-dev", "business-agent"):
            with self.subTest(profile=name):
                changed = installer.merge_soul(original, SECTION, profile_name=name, adopt_workbench_role=True)
                self.assertTrue(changed.decode().startswith("# " + name + " — 工作台业务协作者"))
                for old in ("ComfyUI", "POST /prompt", "8188", "LoRA", "0.4MP", "aixg", "code profile"):
                    self.assertNotIn(old, changed.decode())
                self.assertIn("不把职责限定", changed.decode())
                self.assertEqual(changed.decode().count(installer.START), 1)
                self.assertEqual(installer.merge_soul(changed, SECTION, profile_name=name, adopt_workbench_role=True), changed)

    def test_adopt_role_preserves_bom_and_crlf(self):
        original = b"\xef\xbb\xbf# old\r\n"
        changed = installer.merge_soul(original, SECTION, profile_name="business-agent", adopt_workbench_role=True)
        self.assertTrue(changed.startswith(b"\xef\xbb\xbf"))
        self.assertNotIn(b"\n", changed.replace(b"\r\n", b""))
        with self.assertRaises(ValueError):
            installer.merge_soul(original, SECTION, adopt_workbench_role=True)

    def test_refuse_invalid_soul_markers(self):
        for text in [installer.START, installer.END + "\n" + installer.START]:
            with self.assertRaises(ValueError):
                installer.merge_soul(text.encode(), SECTION)

    def with_profile(self, callback):
        temporary = Path(tempfile.mkdtemp(prefix="zane-hermes-test-")).resolve()
        try:
            (temporary / "config.yaml").write_text("model: unchanged\nmcp_servers:\n  davinci-resolve:\n    command: python\n", encoding="utf-8")
            (temporary / "SOUL.md").write_text("# 原profile\n", encoding="utf-8")
            (temporary / ".env").write_bytes(b"untouched-user-env")
            callback(temporary)
        finally:
            if temporary.parent != Path(tempfile.gettempdir()).resolve() or not temporary.name.startswith("zane-hermes-test-"):
                raise RuntimeError("refusing unexpected test cleanup")
            shutil.rmtree(temporary)

    def test_apply_backup_idempotency_and_unrelated_files(self):
        def verify(profile):
            old_config = (profile / "config.yaml").read_bytes()
            plan = installer.install(profile, SERVER)
            self.assertEqual(len(plan["changedFiles"]), 3)
            self.assertEqual((profile / "config.yaml").read_bytes(), old_config)
            receipt = installer.install(profile, SERVER, apply=True)
            self.assertFalse(receipt["processesRestarted"])
            backup = Path(receipt["backupDirectory"])
            self.assertEqual((backup / "config.yaml").read_bytes(), old_config)
            manifest = json.loads((backup / "manifest.json").read_text(encoding="utf-8"))
            self.assertFalse(next(file for file in manifest["files"] if file["path"].endswith("SKILL.md"))["existed"])
            self.assertEqual((profile / ".env").read_bytes(), b"untouched-user-env")
            self.assertEqual(installer.install(profile, SERVER, apply=True)["changedFiles"], [])
        self.with_profile(verify)

    def test_do_not_overwrite_local_skill(self):
        def verify(profile):
            old_config = (profile / "config.yaml").read_bytes()
            skill = profile / "skills/zane-workbench/SKILL.md"
            skill.parent.mkdir(parents=True)
            skill.write_text("custom-user-skill", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "local edits"):
                installer.install(profile, SERVER, apply=True)
            self.assertEqual((profile / "config.yaml").read_bytes(), old_config)
        self.with_profile(verify)

    def test_explicit_role_change_backs_up_old_soul_and_keeps_config(self):
        def verify(profile):
            installer.install(profile, SERVER, apply=True)
            old_config = (profile / "config.yaml").read_bytes()
            old_soul = (profile / "SOUL.md").read_bytes()
            plan = installer.install(profile, SERVER, adopt_workbench_role=True)
            self.assertEqual(plan["changedFiles"], [str(profile / "SOUL.md")])
            self.assertEqual((profile / "SOUL.md").read_bytes(), old_soul)
            receipt = installer.install(profile, SERVER, apply=True, adopt_workbench_role=True)
            self.assertEqual((Path(receipt["backupDirectory"]) / "SOUL.md").read_bytes(), old_soul)
            self.assertEqual((profile / "config.yaml").read_bytes(), old_config)
            self.assertEqual(installer.install(profile, SERVER, apply=True, adopt_workbench_role=True)["changedFiles"], [])
        self.with_profile(verify)

    def test_only_exact_known_shipped_skill_is_upgraded(self):
        def verify(profile):
            installer.install(profile, SERVER, apply=True)
            old = b"known-shipped-skill\n"
            skill = profile / "skills/zane-workbench/SKILL.md"
            skill.write_bytes(old)
            with patch.object(installer, "PREVIOUS_SKILL_DIGESTS", {sha256(old).hexdigest()}):
                skill.write_bytes(old + b"local-edit")
                with self.assertRaisesRegex(ValueError, "local edits"):
                    installer.install(profile, SERVER, apply=True)
                skill.write_bytes(old)
                receipt = installer.install(profile, SERVER, apply=True)
            self.assertEqual((Path(receipt["backupDirectory"]) / "skills/zane-workbench/SKILL.md").read_bytes(), old)
            self.assertEqual(skill.read_bytes(), (ROOT / "examples/hermes/zane-workbench/SKILL.md").read_text(encoding="utf-8-sig").encode())
        self.with_profile(verify)

    def test_business_result_unwraps_hermes_dual_emit(self):
        data = {"ok": True, "data": {"contractVersion": "1.0.0"}}
        self.assertEqual(probe.unpack_result(json.dumps({"result": json.dumps(data)}), business=True), data["data"])
        self.assertEqual(probe.unpack_result({"structuredContent": data, "result": "explanation"}, business=True), data["data"])
        with self.assertRaises(RuntimeError):
            probe.unpack_result({"error": "HTTP404"}, business=True)

    def test_audit_only_current_published_self_profile_nodes(self):
        def version(id, profile):
            return {"id": id, "workflow": {"steps": [{"id": "node", "hermesProfile": profile, "promptTemplate": "must-not-print"}]}}
        ws = {"sceneVersions": {"s": {"publishedVersionId": "current", "versions": [version("old", "comfyui-dev"), version("current", "aixg")]}}}
        self.assertEqual(probe.inspect_profile_nodes(ws, "comfyui-dev"), [])
        ws["sceneVersions"]["s"]["versions"][1] = version("current", "comfyui")
        self.assertEqual(probe.inspect_profile_nodes(ws, "comfyui-dev"), [], "production executor is not the dev controller")
        ws["sceneVersions"]["s"]["versions"][1] = version("current", "comfyui-dev")
        self.assertEqual(probe.inspect_profile_nodes(ws, "comfyui-dev"), [{"sceneId": "s", "versionId": "current", "stepId": "node", "profile": "comfyui-dev"}])

    def test_installer_config_matches_checked_in_example(self):
        example = yaml.safe_load((ROOT / "examples/mcp/hermes.yaml").read_text(encoding="utf-8-sig"))["mcp_servers"][installer.SERVER]
        expected = installer.make_server(example["command"], Path(example["args"][0]), example["env"]["ZANE_BASE_URL"])
        self.assertEqual(example, expected)


if __name__ == "__main__":
    unittest.main(verbosity=2)
