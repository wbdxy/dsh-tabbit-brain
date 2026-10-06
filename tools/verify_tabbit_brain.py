# verify_tabbit_brain.py — 验证插件与内部 Brain 工具
import io, json, os, subprocess, sys
sys.stdout.reconfigure(encoding='utf-8', errors='replace')
PLUG=os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SETTINGS=os.path.expanduser(r'~\.dsh\settings.yaml')

def hr(t): print('\n'+'='*70+'\n'+t+'\n'+'='*70)
hr('1. 插件源码与配置')
try:
 d=json.load(io.open(os.path.join(PLUG,'package.json'),encoding='utf-8'))
 print('  version:',d.get('version')); print('  internal Brain files:', all(os.path.exists(os.path.join(PLUG,x)) for x in ['lib/brain-service.js','lib/brain-tool.js']))
except Exception as e: print('  读取失败:',e)
try:
 import yaml
 d=yaml.safe_load(io.open(SETTINGS,encoding='utf-8')) or {}
 print('  tabbit-brain settings:',d.get('tabbit-brain','(deployment baseline)'))
except Exception as e: print('  settings 读取失败:',e)
hr('2. 旧 child-agent 形态检查')
source=io.open(os.path.join(PLUG,'lib','index.js'),encoding='utf-8').read()
print('  imports dsh-subagent:', '@deepseek-ai/dsh-subagent' in source)
print('  creates DSH child:', 'agents.create' in source)
print('  registers tabbit_brain:', 'tabbit_brain' in io.open(os.path.join(PLUG,'lib','brain-tool.js'),encoding='utf-8').read())
hr('3. 真实会话验收说明')
print('  新会话中检查 tabbit_brain 是否可见。')
print('  调用后检查返回 job ID、gateway receipt model/endpoint，以及没有 DSH child session。')
print('  此脚本不把旧的 agentPreset=tabbit-brain 记录当作成功证据。')
