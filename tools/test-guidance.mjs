import assert from 'node:assert/strict';
import { apply, Config } from '../lib/index.js';

function guidance(style) {
  let section;
  const ctx = {
    agents: { list: () => [] },
    on() {},
    inject() {},
    effect(fn) { fn(); },
    systemPrompt: { section(value) { section = value; return () => {}; } },
  };
  apply(ctx, { ...Config(), delegationStyle: style, gatewayAutoStart: false });
  return section.text();
}
const standard = guidance('standard');
for (const phrase of ['external thinking partner', 'independent perspective', 'multi-file',
  'alternative explanations', 'counterexamples', 'draft', 'completion review',
  'without waiting for the user', 'model', 'jobId', 'brainJobId']) {
  assert.ok(standard.includes(phrase), `Missing guidance contract: ${phrase}`);
}
assert.ok(standard.includes('main agent remains responsible'));
assert.equal(guidance('off'), '');
assert.ok(guidance('aggressive').startsWith(standard));
assert.ok(guidance('aggressive').length > standard.length);
console.log('PASS guidance purpose, triggers, ownership, routing and styles');
