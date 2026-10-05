# settings_live_test.py — 验证 tabbit-brain 设置项是否即时生效
#
# 做法：往 settings.yaml 写一个与部署基线不同的 agentModel，
#       然后委派一次，再看 trace.log 是否记录了新值。
import io
import json
import os
import shutil
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

SETTINGS = os.path.expanduser(r'~\.dsh\settings.yaml')
MODE = sys.argv[1] if len(sys.argv) > 1 else 'set'

import yaml

data = yaml.safe_load(io.open(SETTINGS, encoding='utf-8')) or {}

if MODE == 'set':
    bak = SETTINGS + '.bak-livetest-' + time.strftime('%Y%m%d-%H%M%S')
    shutil.copyfile(SETTINGS, bak)
    print('备份:', os.path.basename(bak))
    data['tabbit-brain'] = {
        'agentModel': 'GLM-5.3',
        'warnPromptChars': 1234,
    }
    io.open(SETTINGS, 'w', encoding='utf-8', newline='\n').write(
        yaml.safe_dump(data, allow_unicode=True, sort_keys=False))
    print('已写入 tabbit-brain 段:', json.dumps(data['tabbit-brain'], ensure_ascii=False))

elif MODE == 'restore':
    baks = sorted([f for f in os.listdir(os.path.dirname(SETTINGS))
                   if f.startswith('settings.yaml.bak-livetest-')])
    if not baks:
        print('没有备份可恢复')
        sys.exit(1)
    src = os.path.join(os.path.dirname(SETTINGS), baks[-1])
    shutil.copyfile(src, SETTINGS)
    print('已从', baks[-1], '恢复')

elif MODE == 'show':
    print('当前 tabbit-brain 段:', json.dumps(data.get('tabbit-brain'), ensure_ascii=False))
    print('顶层键:', list(data.keys()))

# 校验
try:
    d2 = yaml.safe_load(io.open(SETTINGS, encoding='utf-8'))
    print('YAML 校验通过，顶层键数:', len(d2))
except Exception as e:
    print('YAML 校验失败:', e)
