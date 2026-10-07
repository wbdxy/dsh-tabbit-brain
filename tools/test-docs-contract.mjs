// Offline prose contracts only; passing checks do not establish runtime acceptance.
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pairs = [['README.md', 'README.zh.md'], ['SETUP.md', 'SETUP.zh.md'], ['REVERSE-PROXY.md', 'REVERSE-PROXY.zh.md']];
const tools = ['tabbit_brain', 'tabbit_brain_list', 'tabbit_brain_read', 'tabbit_brain_archive', 'tabbit_brain_delete', 'tabbit_brain_status', 'tabbit_brain_reset'];
let passed = 0, failed = 0;
function check(label, condition) {
  if (condition) { passed++; process.stdout.write(`PASS ${label}\n`); }
  else { failed++; process.stderr.write(`FAIL ${label}\n`); }
}
const all = (text, ...patterns) => patterns.every(p => typeof p === 'string' ? text.includes(p) : p.test(text));
// Restrict protocol claims to their owning sections; keywords elsewhere are insufficient.
function signingKeyContract(text, zh) {
  const section = text.match(/### 2\.2[^\n]*\n([\s\S]*?)\n---/)?.[1] ?? '';
  const required = zh
    ? [/固定 key[^\n]*直接使用/, /未固定[^\n]*请求驱动[^\n]*10 分钟[^\n]*TTL/, /不是后台定时器/, /成功[^\n]*空正文[^\n]*`DEFAULT_SIGN_KEY`/, /获取失败[^\n]*传播错误[^\n]*无 catch/]
    : [/configured fixed key[^\n]*used directly/i, /Without a fixed key[^\n]*request-driven[^\n]*10-minute TTL/i, /not a background timer/i, /successful[^\n]*empty body[^\n]*`DEFAULT_SIGN_KEY`/i, /fetch failure[^\n]*propagates[^\n]*no catch/i];
  return all(section, ...required) && !/fall back[^\n]*fetch fails|fetch fails[^\n]*fall back|失败才回落|拉取失败[^\n]*回落/i.test(text);
}
function signedRequestContract(text, zh) {
  const section = text.match(/## (?:3\.|三、)[^\n]*\n([\s\S]*?)\n---/)?.[1] ?? '';
  const required = zh
    ? [/签名的 chat\/models 请求/, /`POST \/panel\/session`[^\n]*无 body[^\n]*`GET \/panel\/\{id\}\/data`/, /仅[^\n]*`Cookie`[^\n]*`Accept`[^\n]*`Origin`[^\n]*`Referer`/, /不带[^\n]*Content-Type[^\n]*签名[^\n]*指纹/, /`GET \/chat\/sign-key`[^\n]*不签名/, /COS[^\n]*`PUT`[^\n]*不使用[^\n]*签名\/指纹头/]
    : [/signed chat\/models requests/i, /`POST \/panel\/session`[^\n]*no body[^\n]*`GET \/panel\/\{id\}\/data`/i, /only[^\n]*`Cookie`[^\n]*`Accept`[^\n]*`Origin`[^\n]*`Referer`/i, /no[^\n]*Content-Type[^\n]*signature[^\n]*fingerprint/i, /`GET \/chat\/sign-key`[^\n]*not signed/i, /COS[^\n]*`PUT`[^\n]*does not use[^\n]*signature\/fingerprint headers/i];
  return all(section, ...required) && !/Signs each request|Every request carries|给每个请求签|每个请求要带/.test(text);
}
for (const pair of pairs) {
  const texts = pair.map(name => readFileSync(resolve(root, name), 'utf8'));
  const depths = text => [...text.matchAll(/^(#{1,6})\s+/gm)].map(m => m[1].length).join(',');
  check(`${pair[0]}: bilingual headings`, depths(texts[0]) === depths(texts[1]));
  pair.forEach((name, i) => {
    const text = texts[i];
    check(`${name}: no obsolete contracts`, !/memory-only|lost on DSH restart|Child agents are excluded|subagent_tabbit|chat_session_id` cannot be new|chat_session_id` 不能是新的|separate-preset|独立预设/.test(text));
    check(`${name}: no personal Windows paths`, !/[A-Z]:[\\/]Users[\\/][^\\/\s]+/i.test(text));
    if (pair[0] === 'README.md') {
      check(`${name}: seven tools`, tools.every(t => text.includes('`' + t + '`')));
      check(`${name}: required description`, all(text, /requires[^\n]*`description`|`description`[^\n]*必填/i));
      check(`${name}: persistent SQLite`, all(text, 'state/brain.sqlite', /SQLite/, /restart|重启/i));
      check(`${name}: independent child ownership`, all(text, /ordinary child|普通子代理/i, /own owner|自己的 owner/i, /independent history|历史独立/i));
      check(`${name}: distinct job identifiers`, all(text, 'jobId', 'brainJobId', /separate|distinct|不同|独立/i));
      check(`${name}: seq pagination`, all(text, '`seq`', '`before`', /minimum|min\(|最小/i) && !/returned `before`|返回的 `before`/.test(text));
      check(`${name}: local reset retains remote`, all(text, /reset/, /local history only|仅清空本地历史/i, /retain[^\n]*remote|保留远端/i));
    } else {
      check(`${name}: scoped ledger and provenance`, all(text, 'X-Brain-Conversation-Id', 'state/brain-session-map.json', 'accountKey', 'baseURL', 'created', 'pool', 'legacy', 'unverified'));
      check(`${name}: empty-session HTTP contract`, all(text, 'POST /panel/session', 'GET /panel/id/data', /ID[^\n]*(match|匹配)|匹配[^\n]*ID/i, /empty|为空/i));
      check(`${name}: deployment evidence boundary`, all(text, /(?:production[^\n]*(pending|not[^\n]*deployed)|not[^\n]*deployed[^\n]*production|生产部署[^\n]*(待|未|pending)|尚未[^\n]*生产部署|local deployment[^\n]*(accepted|验收)|本机部署[^\n]*(已|通过)[^\n]*(验收|accepted))/i, /(?:capability|能力)[^\n]*(?:separate|分层|unverified|未作为|not accepted|未验证)/i));
      check(`${name}: Brain create no pool fallback`, all(text, /Brain[^\n]*create|Brain[^\n]*创建/i, /no[^\n]*pool fallback|not fall back[^\n]*pool|不[^\n]*(fallback|回退)[^\n]*池/i));
      check(`${name}: explicit Brain fixture compatibility`, all(text, /Brain[^\n]*(compatibility|兼容)/i, /explicit|显式/i, /fixture/i));
      check(`${name}: operational legacy list pool`, all(text, /legacy[^\n]*(operational|可运行)/i, /list-pool|列表池/i));
      if (pair[0] === 'SETUP.md') check(`${name}: fail closed preserves state`, all(text, '409', /fail.closed/i, /new state path|新的 state 路径/i, /preserve[^\n]*state[^\n]*history|保留[^\n]*state[^\n]*history/i));
    }
    if (pair[0] === 'REVERSE-PROXY.md') {
      const zh = name.endsWith('.zh.md');
      check(`${name}: signing key failure vs empty success`, signingKeyContract(text, zh));
      check(`${name}: signed request scope and wire exceptions`, signedRequestContract(text, zh));
      const badFailure = text.replace(/fetch failure[^\n]*|获取失败[^\n]*/i, zh ? '获取失败才回落到 DEFAULT_SIGN_KEY。' : 'Fetch failure falls back to DEFAULT_SIGN_KEY.');
      check(`${name}: rejects HTTP-failure fallback fixture`, !signingKeyContract(badFailure, zh));
      const badScope = text.replace(/signed chat\/models requests|签名的 chat\/models 请求/i, zh ? '每个请求要带这些头' : 'Every request carries these headers');
      check(`${name}: rejects universal signed-headers fixture`, !signedRequestContract(badScope, zh));
    }
    if (pair[0] !== 'SETUP.md') {
      check(`${name}: text roles not native guarantee`, all(text, '[System]', /textual|文本/i, /native|原生/i));
      check(`${name}: hidden memory not proven absent`, all(text, /hidden account memory|隐藏账号记忆/i, /unproven|not[^\n]*proven|尚未证明/i));
    }
  });
}
process.stdout.write(`${passed} passed; ${failed} failed (documentation only)\n`);
if (failed) process.exitCode = 1;
