"""Offline source checks for the direct Brain gateway integration."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
required = ['lib/brain-service.js', 'lib/brain-tool.js', 'lib/brain-store.js']
for name in required:
    assert (ROOT / name).is_file(), f'Missing Brain module: {name}'
for path in (ROOT / 'lib').glob('*.js'):
    source = path.read_text(encoding='utf-8')
    for old in ['@deepseek-ai/dsh-subagent', 'agents.create', 'agentPresets.mount',
                'prepareContinuable', 'TabbitBrainProvider', 'subagent_tabbit']:
        assert old not in source, f'Legacy child-agent integration {old} in {path.name}'
source = (ROOT / 'lib/brain-tool.js').read_text(encoding='utf-8')
assert "name: 'tabbit_brain'" in source
assert 'runtime.jobs.start' in source
service = (ROOT / 'lib/brain-service.js').read_text(encoding='utf-8')
assert '/v1/chat/completions' in service
assert 'X-Brain-Conversation-Id' in service
print('PASS direct Brain integration; no child-agent provider or preset dependency')
print('Version:', json.loads((ROOT / 'package.json').read_text(encoding='utf-8'))['version'])
