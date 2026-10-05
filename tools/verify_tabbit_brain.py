# verify_tabbit_brain.py — 重启 DSH 后验证自建 provider 与 settings 段
#
# 用途：阶段二（配置进 settings）改动后，重启 DSH 再跑这个脚本确认三件事
#   1. 插件加载了（trace.log 出现注册记录）
#   2. settings 命名空间 tabbit-brain 已注册（设置界面能看到）
#   3. 子代理确实挂的是 tabbit-brain 预设（而不是继承父级 router-standard）
#
# 用法：python verify_tabbit_brain.py
import io
import json
import os
import sys
import time

sys.stdout.reconfigure(encoding='utf-8', errors='replace')

# 插件目录：由脚本自身位置推导（tools/ 的上一级）。
# 不写死路径 —— 写死只在一台机器上成立。
PLUG = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TRACE = os.path.join(PLUG, 'trace.log')
SETTINGS = os.path.expanduser(r'~\.dsh\settings.yaml')
SESSIONS = os.path.expanduser(r'~\.dsh\sessions')


def hr(t):
    print('\n' + '=' * 70)
    print(t)
    print('=' * 70)


hr('1. 插件是否加载（trace.log）')
if os.path.exists(TRACE):
    lines = io.open(TRACE, encoding='utf-8', errors='replace').read().splitlines()
    print(f'  ✓ trace.log 存在，共 {len(lines)} 行')
    for l in lines[-8:]:
        print('   ', l)
    if any('settings section' in l or 'registered' in l for l in lines):
        print('  ✓ 插件 apply() 已运行（有注册记录）')
else:
    print('  ✗ trace.log 不存在 —— 插件还没加载过，请确认 DSH 已重启')

hr('2. settings 命名空间')
try:
    import yaml
    d = yaml.safe_load(io.open(SETTINGS, encoding='utf-8')) or {}
    ns = d.get('tabbit-brain')
    if ns:
        print('  ✓ settings.yaml 有 tabbit-brain 段（用户已改过）:')
        print('   ', json.dumps(ns, ensure_ascii=False))
    else:
        print('  · settings.yaml 还没有 tabbit-brain 段')
        print('    → 正常：默认值走部署基线，只有用户改过才落盘')
        print('    → 去 DSH 设置界面找 "tabbit-brain" 分组，改一项再存，这里就会出现')
    print('  顶层键:', list(d.keys()))
except Exception as e:
    print('  读取 settings.yaml 失败:', e)

hr('3. 最近子代理会话挂的预设')
print('  （委派一次 subagent_tabbit 后再跑本步才有数据）')
try:
    import glob
    import subprocess
    files = []
    for root, _dirs, names in os.walk(SESSIONS):
        for n in names:
            if n == 'session.v3.jsonl.zstd':
                p = os.path.join(root, n)
                files.append((os.path.getmtime(p), p))
    files.sort(reverse=True)
    print(f'  扫描到 {len(files)} 个会话文件，检查最近 4 个：')

    js = r'''
import { readFileSync } from 'node:fs'
import zlib from 'node:zlib'
const buf = readFileSync(process.argv[2])
const MAGIC = Buffer.from([0x28,0xb5,0x2f,0xfd])
let text = ''
try { text = zlib.zstdDecompressSync(buf).toString('utf8') } catch {}
if (text.length < 300) {
  const offs = []
  for (let i = 0; i + 4 <= buf.length; i++) if (buf.compare(MAGIC, 0, 4, i, i+4) === 0) offs.push(i)
  offs.push(buf.length)
  for (let k = 0; k + 1 < offs.length; k++) {
    try { text += zlib.zstdDecompressSync(buf.subarray(offs[k], offs[k+1])).toString('utf8') } catch {}
  }
}
const preset = [...new Set([...text.matchAll(/"agentPreset"\s*:\s*"([^"]+)"/g)].map(x=>x[1]))]
const origin = [...new Set([...text.matchAll(/"origin"\s*:\s*"([^"]+)"/g)].map(x=>x[1]))]
const parent = text.match(/"parentSession"\s*:\s*"([^"]+)"/)
console.log(JSON.stringify({ chars: text.length, preset, origin, parent: parent ? parent[1].slice(0,12) : null }))
'''
    probe = os.path.join(os.environ.get('TEMP', '.'), '_vb_probe.mjs')
    io.open(probe, 'w', encoding='utf-8').write(js)
    for mt, p in files[:4]:
        try:
            out = subprocess.run(['node', probe, p], capture_output=True, text=True, timeout=60)
            info = json.loads((out.stdout or '{}').strip().splitlines()[-1])
            tag = 'subagent' in (info.get('origin') or [])
            mark = '★' if tag else ' '
            print(f'  {mark} {os.path.basename(os.path.dirname(p))[:40]:42} '
                  f'preset={",".join(info.get("preset") or []) or "(无)":16} '
                  f'origin={",".join(info.get("origin") or []) or "-":10} chars={info.get("chars")}')
            if tag and info.get('preset') == ['tabbit-brain']:
                print('      → ✓ 这条子代理会话挂的是 tabbit-brain，符合预期')
        except Exception as e:
            print('   ', p, '解析失败:', e)
except Exception as e:
    print('  扫描失败:', e)

hr('判定标准')
print('  · 步骤 1 有 trace.log 且含 "registered"  → 插件已加载')
print('  · 步骤 2 能在设置界面看到 tabbit-brain 分组 → 阶段二生效')
print('  · 步骤 3 标 ★ 的子代理会话 preset=tabbit-brain → 核心链路正常')
