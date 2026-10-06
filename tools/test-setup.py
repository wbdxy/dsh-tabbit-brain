"""Isolated CLI regression tests; never touch the real DSH home."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]

class SetupTests(unittest.TestCase):
    def fixture(self, settings):
        temp = tempfile.TemporaryDirectory(prefix='tabbit-setup-test-')
        self.addCleanup(temp.cleanup)
        home = Path(temp.name)
        (home / 'profiles' / 'desktop').mkdir(parents=True)
        preset = home / '.agent-presets' / 'main'
        preset.mkdir(parents=True)
        (preset / 'agent.cordis.yml').write_text('[]\n', encoding='utf-8')
        (home / 'settings.yaml').write_text(settings, encoding='utf-8')
        return home

    def run_setup(self, home, *extra):
        env = dict(os.environ, DSH_HOME=str(home))
        return subprocess.run(['node', str(ROOT / 'scripts/setup.mjs'), '--yes',
            '--mount-preset', 'main', '--models', 'MODEL_A,MODEL_B',
            '--base-url', 'http://127.0.0.1:1/v1', *extra],
            env=env, text=True, encoding='utf-8', capture_output=True, timeout=20)

    def snapshot(self, home):
        return {str(p.relative_to(home)): p.read_bytes() for p in home.rglob('*') if p.is_file()}

    def test_dry_run_writes_nothing(self):
        home = self.fixture('agent-presets:\n  default: main\n')
        before = self.snapshot(home)
        result = self.run_setup(home, '--dry-run', '--write-settings')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(before, self.snapshot(home), 'dry-run changed files')

    def test_provider_nested_and_existing_preserved(self):
        for initial in ['other: 7\n', 'llm-pi-ai: {}\nother: 7\n',
                'llm-pi-ai:\n  providers:\n    existing:\n      baseURL: https://example.com/v1\nother: 7\n']:
            with self.subTest(initial=initial):
                home = self.fixture(initial)
                result = self.run_setup(home, '--write-settings')
                self.assertEqual(result.returncode, 0, result.stderr)
                data = yaml.safe_load((home / 'settings.yaml').read_text(encoding='utf-8'))
                self.assertIn('tabbit-local', data['llm-pi-ai']['providers'])
                self.assertEqual(data['other'], 7)
                if 'existing:' in initial:
                    self.assertEqual(data['llm-pi-ai']['providers']['existing']['baseURL'], 'https://example.com/v1')
                tool = yaml.safe_load((home / '.agent-presets/main/agent.cordis.yml').read_text(encoding='utf-8'))
                self.assertEqual(tool, [], 'setup must not modify main presets')
                self.assertFalse((home / '.agent-presets/tabbit-brain').exists(), 'no child preset required')
                before = self.snapshot(home)
                again = self.run_setup(home, '--write-settings')
                self.assertEqual(again.returncode, 0, again.stderr)
                self.assertEqual(before, self.snapshot(home), 'second run was not idempotent')

    def test_invalid_yaml_is_non_mutating(self):
        for initial in ['llm-pi-ai: [\n', 'llm-pi-ai:\n  providers: wrong-type\n']:
            home = self.fixture(initial)
            before = self.snapshot(home)
            result = self.run_setup(home, '--write-settings')
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(before, self.snapshot(home))

if __name__ == '__main__':
    unittest.main()
