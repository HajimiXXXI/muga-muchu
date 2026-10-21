const fs = require('fs'), vm = require('vm');
const P = process.env.HOME + '/SillyTavern/public/scripts/extensions/third-party/muga-muchu/index.js';
const src = fs.readFileSync(P, 'utf8');
function load(settings, chat) {
  const calls = { update: 0, save: 0 };
  const ctx = { chat, extensionSettings: { muga_muchu: settings || {} },
    updateMessageBlock: () => calls.update++, saveChat: () => calls.save++,
    saveSettingsDebounced() {}, eventSource: { on() {} }, eventTypes: {} };
  const g = { SillyTavern: { getContext: () => ctx }, jQuery: () => {}, console, setTimeout, structuredClone, toastr: {} };
  vm.createContext(g);
  vm.runInContext(src + '\n;globalThis.__t={decodeText,decodeMessageAt,onMessageReceived,onPromptReady,getMap:()=>activeMap,setMap:(m)=>{activeMap=m;rebuildDecodeCache();}};', g);
  return { t: g.__t, calls, ctx };
}
let pass = 0, fail = 0;
const ok = (name, cond) => { cond ? pass++ : fail++; console.log((cond ? '✓ ' : '✗ ') + name); };
const S = (o) => Object.assign({ enabled: true, decodeOutput: true, markerMode: true }, o || {});

// 1 空映射 + 标记 → 仍然还原
{ const chat = [{ mes: 'a <<<PLAN>>>想<<<END>>> b' }]; const { t, calls } = load(S(), chat);
  t.decodeMessageAt(0); ok('空映射也还原标记', chat[0].mes === 'a <think>想</think> b' && calls.save === 1); }
// 2 swipes + swipe_info
{ const chat = [{ mes: '<<<PLAN>>>x', swipes: ['<<<PLAN>>>x', '<<<PLAN>>>y'], swipe_info: [{ extra: { reasoning: '<<<PLAN>>>r' } }] }];
  const { t } = load(S(), chat); t.decodeMessageAt(0);
  ok('swipes 全部还原', chat[0].swipes.every(x => x.startsWith('<think>')));
  ok('swipe_info reasoning 还原', chat[0].swipe_info[0].extra.reasoning === '<think>r'); }
// 3 reasoning
{ const chat = [{ mes: 'ok', extra: { reasoning: '<<<PLAN>>>z<<<END>>>' } }]; const { t } = load(S(), chat); t.decodeMessageAt(0);
  ok('reasoning 还原', chat[0].extra.reasoning === '<think>z</think>'); }
// 4 字符串 id
{ const chat = [{ mes: 'x' }, { mes: '<<<PLAN>>>' }]; const { t } = load(S(), chat); t.onMessageReceived('1');
  ok('字符串 id "1" 可用', chat[1].mes === '<think>'); }
// 5 关闭输出还原
{ const chat = [{ mes: '<<<PLAN>>>' }]; const { t, calls } = load(S({ decodeOutput: false }), chat); t.decodeMessageAt(0);
  ok('decodeOutput 关闭则不动', chat[0].mes === '<<<PLAN>>>' && calls.save === 0); }
// 6 没开标记且映射空
{ const chat = [{ mes: '<<<PLAN>>>' }]; const { t } = load(S({ markerMode: false }), chat); t.decodeMessageAt(0);
  ok('markerMode 关且映射空则不动', chat[0].mes === '<<<PLAN>>>'); }
// 7 变体
{ const { t } = load(S(), []); const d = t.decodeText;
  ok('<<PLAN>>', d('<<PLAN>>') === '<think>');
  ok('<<<PLAN>>', d('<<<PLAN>>') === '<think>');
  ok('<<< plan >>>', d('<<< plan >>>') === '<think>');
  ok('<<<END>>> / <<END>>', d('<<<END>>>|<<END>>') === '</think>|</think>');
  ok('四尖括号不动', d('<<<<PLAN>>>>') === '<<<<PLAN>>>>');
  ok('单尖括号不动', d('<PLAN>') === '<PLAN>');
  ok('开头位置也能还原', d('<<<PLAN>>>开头') === '<think>开头');
  ok('相邻两个', d('<<<PLAN>>><<<END>>>') === '<think></think>'); }
// 8 幂等
{ const { t } = load(S(), []); const once = t.decodeText('<<<PLAN>>>a'); ok('幂等', t.decodeText(once) === once); }
// 9 无消息/越界
{ const { t } = load(S(), []); let e = null; try { t.decodeMessageAt(5); t.onMessageReceived('abc'); t.onMessageReceived(undefined); } catch (x) { e = x; } ok('越界/非法 id 不抛错', !e); }
// 10 LRU：塞 650 条旧映射，再来一轮，旧的被淘汰、新的保留
{ const chat = [{ role: 'system', content: '请先思考一下，再深呼吸。' }, { role: 'user', content: 'hi' }];
  const { t } = load(S({ mode: 'homophone', intensity: 3, scope: { system: true, history: true, user: true } }), chat);
  const old = new Map(); for (let i = 0; i < 650; i++) old.set('旧键' + i, '原' + i); t.setMap(old);
  t.onPromptReady({ chat }); const m = t.getMap();
  ok('映射表不超过 600+当前轮', m.size <= 610); ok('不再整表清空（保留了较新旧键）', m.has('旧键649')); ok('最旧的被淘汰', !m.has('旧键0')); }
console.log(`\n${pass} 通过 / ${fail} 失败`); process.exit(fail ? 1 : 0);
