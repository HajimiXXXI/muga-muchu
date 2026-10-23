/* 上下文裁剪层（ctxTrim）回归测试
 * 用法：MUGA_INDEX=$PWD/index.js node 测试-ctx-trim.js
 */
const fs = require('fs'), vm = require('vm'), path = require('path');
const P = process.env.MUGA_INDEX || path.join(__dirname, 'index.js');
const src = fs.readFileSync(P, 'utf8');
const ctx = { chat: [], extensionSettings: { muga_muchu: {} },
    updateMessageBlock() {}, saveChat() {}, saveSettingsDebounced() {},
    eventSource: { on() {} }, eventTypes: {} };
const g = { SillyTavern: { getContext: () => ctx }, jQuery: () => {}, console, setTimeout, structuredClone, toastr: {} };
vm.createContext(g);
vm.runInContext(src + '\n;globalThis.__t={trimContext,ctxTotalChars,DEFAULTS};', g);
const { trimContext, ctxTotalChars, DEFAULTS } = g.__t;

let pass = 0, fail = 0;
const ok = (n, c) => { c ? pass++ : fail++; console.log((c ? '✓ ' : '✗ ') + n); };
const S = (o) => Object.assign({}, DEFAULTS, { ctxTrim: true, ctxTrimMax: 60000, ctxTrimKeep: 4 }, o || {});
const mk = (role, n) => ({ role, content: 'x'.repeat(n) });

/* 1 未超阈值 → 原样返回（同一引用） */
{ const ms = [mk('system', 100), mk('user', 500), mk('assistant', 500)];
  const r = trimContext(ms, S());
  ok('未超阈值不动', r === ms && r.length === 3); }

/* 2 超阈值 keep=4 → 只剩 4 条，且是最后的 */
{ const ms = [mk('system', 100)];
  for (let i = 0; i < 20; i++) ms.push(mk(i % 2 ? 'assistant' : 'user', 5000));
  const lastText = ms[ms.length - 1].content;
  const r = trimContext(ms, S());
  ok('超阈值裁到 keep 条', r.length === 4);
  ok('保留最后一条', r[r.length - 1].content === lastText);
  ok('system 不丢', r[0].role === 'system');
  ok('返回新数组', r !== ms); }

/* 3 keep=12 */
{ const ms = [mk('system', 100)];
  for (let i = 0; i < 20; i++) ms.push(mk(i % 2 ? 'assistant' : 'user', 5000));
  const r = trimContext(ms, S({ ctxTrimKeep: 12 }));
  ok('keep=12 生效', r.length === 12); }

/* 4 关闭时不动 */
{ const ms = [mk('system', 100)]; for (let i = 0; i < 20; i++) ms.push(mk('user', 5000));
  const r = trimContext(ms, S({ ctxTrim: false }));
  ok('ctxTrim=关 不动', r === ms && r.length === 21); }

/* 5 safeMode 时不动 */
{ const ms = [mk('system', 100)]; for (let i = 0; i < 20; i++) ms.push(mk('user', 5000));
  const r = trimContext(ms, S({ safeMode: true }));
  ok('安全模式不动', r === ms); }

/* 6 最后一条 user 永不被丢 */
{ const ms = [mk('system', 100)];
  for (let i = 0; i < 20; i++) ms.push(mk(i % 2 ? 'assistant' : 'user', 5000));
  ms.push(mk('assistant', 5000));
  const ui = ms.length - 1 - 1; // 倒数第二条是 user
  const r = trimContext(ms, S());
  ok('末条 user 保护', r.some(m => m === ms[ui])); }

/* 7 ctxTotalChars 只数 content 字符串 */
{ ok('字符统计', ctxTotalChars([{ content: 'abc' }, { content: 12 }, { content: null }]) === 5); }

/* 8 空数组/非数组不炸 */
{ ok('空数组安全', Array.isArray(trimContext([], S())) && trimContext(null, S()) === null); }

/* 9 keep=0 极端 → 不炸，且不把 system 丢光 */
{ const ms = [mk('system', 100)]; for (let i = 0; i < 10; i++) ms.push(mk('user', 5000));
  const r = trimContext(ms, S({ ctxTrimKeep: 0 }));
  ok('keep=0 不炸', Array.isArray(r) && r.length >= 2); }

console.log('\n' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
