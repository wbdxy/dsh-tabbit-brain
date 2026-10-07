"""Isolated tests for the read-only direct Brain gateway setup checker."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import re
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "setup.mjs"

class SetupTests(unittest.TestCase):
    def fixture(self):
        temp = tempfile.TemporaryDirectory(prefix="tabbit-setup-test-")
        self.addCleanup(temp.cleanup)
        home = Path(temp.name)
        (home / "settings.yaml").write_text("sentinel: preserve\n", encoding="utf-8")
        (home / ".agent-presets" / "main").mkdir(parents=True)
        (home / ".agent-presets" / "main" / "agent.cordis.yml").write_text("sentinel\n", encoding="utf-8")
        return home

    def run_setup(self, home, *args, env_extra=None):
        env = dict(os.environ, DSH_HOME=str(home))
        if env_extra:
            env.update(env_extra)
        return subprocess.run(
            ["node", str(SCRIPT), *args],
            env=env, text=True, encoding="utf-8", capture_output=True, timeout=20,
        )

    def snapshot(self, home):
        return {str(p.relative_to(home)): p.read_bytes() for p in home.rglob("*") if p.is_file()}

    def test_help_lists_read_only_contract(self):
        result = self.run_setup(self.fixture(), "--help")
        self.assertEqual(result.returncode, 0, result.stderr)
        for flag in ("--help", "--base-url", "--api-key-env", "--models", "--dry-run", "--yes", "--check-gateway"):
            self.assertIn(flag, result.stdout)
        for old in ("--provider", "--preset-id", "--mount-preset", "--write-settings", "--force", "--api-key", "--profile"):
            self.assertIsNone(re.search(rf"(?<![\\w-]){re.escape(old)}(?:\\s|$)", result.stdout), old)

    def test_default_and_dry_run_are_offline_and_read_only(self):
        home = self.fixture()
        before = self.snapshot(home)
        for args in ((), ("--dry-run",), ("--yes",), ("--dry-run", "--yes")):
            with self.subTest(args=args):
                result = self.run_setup(home, *args)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(before, self.snapshot(home))
                self.assertNotIn("settings.yaml", result.stdout.lower())

    def test_old_options_fail_explicitly_without_mutation(self):
        for option in ("--provider", "--preset-id", "--mount-preset", "--write-settings", "--force", "--api-key", "--profile"):
            home = self.fixture()
            before = self.snapshot(home)
            value = "legacy" if option not in ("--write-settings", "--force") else None
            args = (option,) if value is None else (option, value)
            result = self.run_setup(home, *args)
            self.assertNotEqual(result.returncode, 0, option)
            self.assertIn("removed", (result.stderr + result.stdout).lower(), option)
            self.assertEqual(before, self.snapshot(home))

    def test_env_key_is_used_without_leaking_value(self):
        home = self.fixture()
        secret = "fixture-secret-value"
        result = self.run_setup(home, "--api-key-env", "FIXTURE_BRAIN_KEY", "--yes", env_extra={"FIXTURE_BRAIN_KEY": secret})
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertIn("FIXTURE_BRAIN_KEY", result.stdout)

    def test_models_are_only_checked_when_gateway_check_is_explicit(self):
        home = self.fixture()
        result = self.run_setup(home, "--models", "MODEL_A,MODEL_B", "--base-url", "http://127.0.0.1:1/v1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("not checked", result.stdout.lower())

        checked = self.run_setup(home, "--check-gateway", "--models", "MODEL_A", "--base-url", "http://127.0.0.1:1/v1")
        self.assertNotEqual(checked.returncode, 0)
        self.assertIn("gateway", (checked.stderr + checked.stdout).lower())

    def test_check_gateway_does_not_start_gateway(self):
        home = self.fixture()
        before = self.snapshot(home)
        result = self.run_setup(home, "--check-gateway", "--base-url", "http://127.0.0.1:1/v1", "--yes", env_extra={"FIXTURE_BRAIN_KEY": "fixture-key", "TABBIT_API_KEY": "fixture-key"})
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("start", (result.stdout + result.stderr).lower())
        self.assertEqual(before, self.snapshot(home))

    def test_url_rejects_remote_and_embedded_credentials(self):
        for url in ("https://example.com", "http://key:secret@127.0.0.1:8787", "file:///tmp/x"):
            result = self.run_setup(self.fixture(), "--base-url", url)
            self.assertNotEqual(result.returncode, 0, url)
            self.assertNotIn("secret", result.stdout + result.stderr)

    def test_explicit_gateway_request_and_model_matching(self):
        requests = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                requests.append((self.path, self.headers.get("Authorization")))
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"data": [{"id": "MODEL_A"}]}).encode())
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        home = self.fixture()
        before = self.snapshot(home)
        url = f"http://127.0.0.1:{server.server_port}/v1"
        secret = "fixture-secret-value"
        for model, code in (("MODEL_A", 0), ("MISSING_MODEL", 1)):
            result = self.run_setup(home, "--check-gateway", "--base-url", url,
                "--models", model, "--api-key-env", "FIXTURE_BRAIN_KEY",
                env_extra={"FIXTURE_BRAIN_KEY": secret})
            self.assertEqual(result.returncode, code, result.stdout + result.stderr)
            self.assertNotIn(secret, result.stdout + result.stderr)
        self.assertEqual(requests, [("/v1/models", f"Bearer {secret}")] * 2)
        self.assertEqual(before, self.snapshot(home))

if __name__ == "__main__":
    unittest.main()
