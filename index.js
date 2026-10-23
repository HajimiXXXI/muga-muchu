'use strict';

/* ============================================================================
 * 无我梦中 · Muga Muchū
 * ----------------------------------------------------------------------------
 * 在 chat-completion 的 messages 真正离开酒馆之前，对一批可被上游内容检测
 * 命中的关键词做 谐音 / 拼音 / 同义 替换。
 *
 * 设计立场（很重要）：
 *   1. 本扩展**不是**破限器。它只改输入的"形"，不改请求的"神"。
 *      预设本身破不了限，筛得再花也没用。
 *   2. 替换必须对模型透明 —— 拼音和谐音都保持读音，模型读了还是那个意思。
 *   3. 替换必须对酒馆透明 —— 输出侧会把词还原回来，正文和思维链不留痕迹。
 *   4. 替换必须确定性 —— 同一个词在同一轮里永远换成同一个结果，
 *      否则上下文里同一概念出现三种写法，模型会开始胡说。
 *
 * 挂钩点（ST 1.16 实测）：
 *   CHAT_COMPLETION_PROMPT_READY  ← data.chat 是最终 messages 数组，同一个引用，
 *                                   就地改 content 即生效（所有 API 源都走这条路）
 *   MESSAGE_RECEIVED / GENERATION_ENDED  ← 输出侧还原（流式时前者会被跳过）
 *
 * author: 哈基米三十一世
 * ==========================================================================*/

const MODULE_NAME = 'muga_muchu';
const VERSION = '2.0.0';
const LOG = '[无我梦中]';

/* 本扩展的 GitHub 仓库：插件内“检查更新”只读它 */
const REPO = 'HajimiXXXI/muga-muchu';
const REPO_URL = 'https://github.com/' + REPO;
const RELEASE_API = 'https://api.github.com/repos/' + REPO + '/releases/latest';

/* ---------------------------------------------------------------------------
 * 0.1 保留词正则缓存（patch3）
 *   keepList 在 encodeText 里每条 message 每轮都要过一遍，原先每次都
 *   new RegExp(escapeRe(k),'g')，属高频重复编译。这里按「保留词」缓存到
 *   模块级，只在首次遇到该词时编译一次。
 *   stash() 内部是 str.replace(re, fn)，replace 会自己把 lastIndex 归零，
 *   所以复用带 g 标志的正则是安全的，不会串位置。
 * ------------------------------------------------------------------------ */
const keepReCache = new Map();          /* 保留词 → /词/g，模块级复用 */
const KEEP_RE_MAX = 512;                /* 上限，防用户乱填把内存撑爆 */

function keepRe(k) {
    const hit = keepReCache.get(k);
    if (hit) return hit;
    let re;
    try {
        re = new RegExp(escapeRe(k), 'g');
    } catch (_) {
        return null;                    /* 非法词直接跳过，不炸整轮 */
    }
    if (keepReCache.size >= KEEP_RE_MAX) keepReCache.clear();
    keepReCache.set(k, re);
    return re;
}

/* ---------------------------------------------------------------------------
 * 0. 基础工具
 * ------------------------------------------------------------------------ */

function getCtx() {
    try {
        if (globalThis.SillyTavern && typeof globalThis.SillyTavern.getContext === 'function') {
            return globalThis.SillyTavern.getContext();
        }
    } catch (_) { /* ignore */ }
    return null;
}

function waitCtx(tries = 40) {
    return new Promise((resolve) => {
        let n = 0;
        const tick = () => {
            const c = getCtx();
            if (c) return resolve(c);
            if (++n >= tries) return resolve(null);
            setTimeout(tick, 100);
        };
        tick();
    });
}

function clone(o) {
    try { return structuredClone(o); } catch (_) { return JSON.parse(JSON.stringify(o)); }
}

function hash32(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return h >>> 0;
}

function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* 占位符码位刻意避开 \uE000-\uE002 区段：ST-Prompt-Template 等插件在用那一带 */
const STASH_OPEN = '\uE0F0';
const STASH_CLOSE = '\uE0F1';
const STASH_RE = new RegExp(STASH_OPEN + '(\\d+)' + STASH_CLOSE, 'g');
const STASH_RESIDUE_RE = /[\uE0F0\uE0F1]/;

/* 私用区守卫：我们只占 \uE0F0/\uE0F1（stash）、\uE100-\uE103（reflow 围栏/EJS）、\uE200（重排标记）。
   除这几个之外还有 PUA 字符，说明别的插件已经往这段文本里塞了占位符，
   我们再改写就会把它的占位符吃掉或串味，一律原样放行。 */
const PUA_RE = /[\uE000-\uF8FF]/;
const PUA_OWN_RE = /[\uE0F0\uE0F1\uE100-\uE103\uE200]/g;

function hasForeignPua(text) {
    if (!text || typeof text !== 'string') return false;
    if (!PUA_RE.test(text)) return false;
    return PUA_RE.test(text.replace(PUA_OWN_RE, ''));
}

function stash(str, re, vault) {
    return str.replace(re, (m) => {
        vault.push(m);
        return STASH_OPEN + (vault.length - 1) + STASH_CLOSE;
    });
}

function unstash(str, vault) {
    return str.replace(STASH_RE, (_, i) => (vault[Number(i)] !== undefined ? vault[Number(i)] : ''));
}

/* ---------------------------------------------------------------------------
 * 1. 词库
 *    tier 1 = 强特征（几乎只出现在思维链指令里）
 *    tier 2 = 常规（会误伤一点正常文字，但读音不变）
 *    tier 3 = 弱词（只在"重"档启用，可能改味道）
 *    alt    = 中文谐音候选 / 英文同义词候选
 *    pinyin = 拼音候选（没填就退回 alt）
 * ------------------------------------------------------------------------ */


/* ---------------------------------------------------------------------------
 * 1b. 语义改写表
 *     和目标不是「换掉词」，是「换掉这件事在句子里的身份」：
 *     「命令模型执行思维链」 → 「描述角色落笔前的习惯」。
 *     检测器认的是「指令 + 思考」这个组合，叙事化之后它就只是一段人设。
 *     长句在前，短词在后，顺序不要动。
 * ------------------------------------------------------------------------ */

const SEMANTIC = [
    /* 变量名里的 thinking，必须成对换，否则 setvar/getvar 对不上 */
    { id: 'sem.vart', tag: '变量名 thinking', re: /rong_var_thinking/g, to: 'rong_var_tuiyan' },
    /* ---- 整句级：指令 → 叙事 ---- */
    { id: 'sem.header', tag: '思考过程→推演备忘',
      re: /在你的思考过程[（(]\s*<think>\s*标签内[）)]\s*中[，,]?\s*请遵守以下规则[：:]/g,
      to: 'RONG 落笔前，先在 <think> 块里留一份推演备忘，格式如下：' },

    { id: 'sem.intensity', tag: '思考强度→推演深度',
      re: /思考强度[：:]\s*(ultra|low|high|medium)/gi,
      to: '推演深度：$1' },

    { id: 'sem.steps', tag: '步骤进行思考→流程',
      re: /使用以下步骤进行思考[。.：:]?/g,
      to: '按下面的流程走一遍：' },

    { id: 'sem.stepbystep', tag: '一步步分析→逐段拆',
      re: /必须一步一步进行分析[，,]?\s*不可省略与偷懒/g,
      to: '要逐段拆开过一遍，不许跳步' },

    { id: 'sem.long', tag: '长篇思考→写足',
      re: /请进行长篇思考/g,
      to: '这段要写足' },

    { id: 'sem.discipline', tag: '思考纪律→推演纪律',
      re: /思考纪律[：:]/g,
      to: '推演纪律：' },

    { id: 'sem.anchor', tag: '思考锚定→推演锚点',
      re: /思考锚定/g,
      to: '推演锚点' },

    { id: 'sem.chinese', tag: '中文思考→中文推演',
      re: /以中文进行思考/g,
      to: '用中文推演' },

    { id: 'sem.expand', tag: '展开思考→展开推演',
      re: /展开思考/g,
      to: '展开推演' },

    { id: 'sem.lang', tag: '思考语言→推演用语',
      re: /思考语言/g,
      to: '推演用语' },

    { id: 'sem.output', tag: '思考输出→推演内容',
      re: /思考输出/g,
      to: '推演内容' },

    { id: 'sem.once', tag: '思考一次→推演一次',
      re: /思考仅输出一次/g,
      to: '推演只写一次' },

    { id: 'sem.prefix', tag: '思考前缀→推演前置',
      re: /思考前缀/g,
      to: '推演前置' },

    { id: 'sem.mode', tag: '思维模式→推演模式',
      re: /思维模式/g,
      to: '推演模式' },

    { id: 'sem.commit', tag: '跳过思考→跳过推演',
      re: /禁止跳过思考/g,
      to: '禁止跳过推演' },

    /* ---- 词级：换到检测词表之外的近义 ---- */
    { id: 'sem.chain', tag: '思维链', re: /思维链/g, to: '思路轨迹' },
    { id: 'sem.mono', tag: '内心独白', re: /内心独白/g, to: '心声' },
    { id: 'sem.breath', tag: '深呼吸', re: /深呼吸/g, to: '先缓一口气' },
    { id: 'sem.process', tag: '思考过程', re: /思考过程/g, to: '推演脉络' },
    { id: 'sem.think', tag: '思考', re: /思考/g, to: '推演' },
    { id: 'sem.thought', tag: '思维', re: /思维/g, to: '思路' },
    { id: 'sem.reason', tag: '推理', re: /推理/g, to: '推演' },
    { id: 'sem.step2', tag: '一步一步', re: /一步一步/g, to: '逐段' },
    { id: 'sem.step', tag: '一步步', re: /一步步/g, to: '逐段' },
    { id: 'sem.analyze', tag: '进行分析', re: /进行分析/g, to: '拆一遍' },
    { id: 'sem.kaoju', tag: '反复考据', re: /反复考据/g, to: '反复核对' },
    { id: 'sem.scan', tag: '遍历', re: /以遍历为主/g, to: '以通读为主' },
];

/* 反向：生成模型输出时把叙事词换回术语（可关） */
const SEM_BACK = SEMANTIC
    .filter(r => r.to && r.to.indexOf('$') < 0 && !/[：:]/.test(r.to))
    .map(r => ({ re: new RegExp(r.to.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), to: null, from: r.id }));


/* ---------------------------------------------------------------------------
 * 1c. 里恩「神谕终端[双蛇杖]」
 *     每把武器对应一种处理手法。斩击=改字面，突刺=改定点，打击=改结构。
 *     台词取自 Canto IX，数据按第二阶段强化。
 * ------------------------------------------------------------------------ */

const WEAPONS = [
    {
        id: 'scythe', name: '镰刀', type: '斩击', buff: '+30% · 命中必定暴击',
        summary: '斩断字面', detail: '只换标签，不动正文',
        line: '弧刃落下，字面先断，画还没停。',
        mode: 'off', reflow: false, note: '一刀切断：只换标签，不动正文',
    },
    {
        id: 'greatsword', name: '大剑', type: '斩击', buff: '+15% · 斩击易损 1 层',
        summary: '拖入火场中央', detail: '重排段落，首尾垫料护航',
        line: '大剑落地，危险段被拖进画室正中。',
        mode: 'off', reflow: true, note: '大块重排：敏感段推到正中，头尾垫文本',
    },
    {
        id: 'spear', name: '长枪', type: '突刺', buff: '+15% · 突刺易损 1 层',
        summary: '刺穿落点', detail: '重排，并保留保护名单',
        line: '枪尖只找最该被看见的那一处。',
        mode: 'off', reflow: true, note: '精准穿刺：重排 + 保护名单',
    },
    {
        id: 'rapier', name: '刺剑', type: '突刺', buff: '+7.5% · 防御等级降低 1 层',
        summary: '细处开裂', detail: '用谐音替换强特征词',
        line: '剑尖轻点，墨从细处渗开。',
        mode: 'homophone', reflow: false, note: '多点开洞：谐音替换',
    },
    {
        id: 'whip', name: '鞭子', type: '打击', buff: '+15% · 打击易损 2 层',
        summary: '字音四散', detail: '用拼音替换强特征词',
        line: '鞭影散开，字音落地前就散了。',
        mode: 'pinyin', reflow: false, note: '满场抽打：拼音替换',
    },
    {
        id: 'hammer', name: '锤子', type: '打击', buff: '+7.5% · 目标混乱阈值前移 5',
        summary: '把形状砸碎', detail: '语义改写，会动正文措辞',
        line: '锤声落下，句子的形状碎了一地。',
        mode: 'semantic', reflow: false, note: '一锤定音：语义改写（会动正文）',
    },
];

/* 阅卷层垫料：公版《地狱变》译文，用作首尾无害文本 */
const PAD_TEXT = `　　像堀川大殿这样的人物，前不必说，后世恐怕也不会再有第二位了。据传闻说，这位大人降生之前，大威德明王的法相曾立在他母亲的枕边——听人是这样讲的；总之他生来就与寻常人不同。因此，这位大人所做的事，没有一件不超出我们的意料之外。就说堀川府邸的规模吧，我们见了，说是壮丽也好，说是豪放也好，总有一种绝非我们凡庸之虑所能企及的大胆之处。也有人拿这一点百般挑剔，把大殿的品性比作秦始皇、隋炀帝，那大约就是俗话说的群盲摸象吧。这位大人的心思，绝不是那样只图自己一人享尽荣华富贵。他反倒更多地考虑到下层百姓的事，可说是要与天下同乐一般，有着宽宏大量的器度。

　　所以即便他在二条大宫遇上了百鬼夜行，也毫不受影响。又有那以摹写陆奥盐釜景色闻名的东三条河原院，据说那里每夜都有源融左大臣的幽灵出现，就连那幽灵，一受大殿的斥责，也必定消形匿迹了。有着这样的威光，当时京城中的男女老少，一提起大殿，便像对待权者的再来一般敬重，也绝非没有道理。前些时候，他从宫中的梅花宴回来，驾车的牛脱了缰，撞伤了恰好路过的老人，即便那时，听说那老人也合起掌来，庆幸自己是被大殿的牛撞倒的。

　　如此这般，大殿一生之中，足以留作后世谈资的事情实在很多。有过在大飨的赏赐里单是白马就得了三十匹的事，有过把宠爱的童子立在长良桥桥柱上的事，还有过让传授华佗之术的震旦僧人割开他腿上疮痈的事——若一件件数起来，实在没有个尽头。然而在这许多逸事当中，恐怕再没有比如今成为府上重宝的《地狱变》屏风的来历更可怕的故事了。就连平日遇事不动声色的大殿，唯独那时也似乎到底吃了一惊。更何况在旁侍奉的我们，觉得魂都要飞了，这就不必说了。尤其像我这样的人，在大殿身边奉公已有二十年，即便如此，那样凄厉的光景，此后再没有遇到过第二次。

　　不过要讲这件事，恐怕有必要先说一说画那幅《地狱变》屏风的画师良秀。

二

　　提起良秀，也许如今仍有人记得他。当时论起画笔，人都说无人能出良秀之右，是位名声很高的画师。那件事发生的时候，他大约已经年过五十了吧。看模样只是个身材矮小、瘦得皮包骨头、神情刻薄的老人。他到大殿府上来时，常穿一件丁香染的狩衣，戴一顶揉皱的乌帽子，人品极为卑下；不知何故，那与年纪不相称、格外显眼的红嘴唇，又平添几分阴森，叫人不由生出一种野兽似的恶心感。也有人说那是因为他舔画笔染上的朱红，不知究竟如何。更有嘴损的某某人，说良秀的举止坐立活像猴子，甚至给他起了个诨名叫"猿秀"。

　　说起"猿秀"，还有这样一段事。那时大殿府里，良秀十五岁的独生女做着侍女，这女儿却全然不像她的生父，是个讨人喜欢的姑娘。加上她早早没了母亲，或许因此心思体贴、比年纪早熟，天生伶俐，年纪虽小却处处周到，所以从御台夫人以下，别的女房们都很疼爱她。

　　后来有一次，丹波国进献了一只驯熟的猿，正好赶上最爱淘气的小公子，就给它取名叫"良秀"。那猿的模样本来就滑稽，又凑上这么个名字，府里没有一个人不笑的。光是笑也还罢了，众人图个有趣，什么爬上庭院的松树了、弄脏了厢房的榻榻米了，每逢这种时候便"良秀、良秀"地喊叫起来，总要欺负它一番。

　　可有一天，前面说的良秀的女儿手里拿着系了书信的寒红梅枝，穿过长长的回廊时，远处格子门那边，那只小猿良秀——大概是崴了脚吧——没有平日的力气蹿上柱子，一瘸一拐地拼命逃来。而且后头小公子还举着荆条，嘴里嚷着"偷橘子的贼，站住！站住！"追了上来。良秀的女儿见了，似乎迟疑了片刻；偏偏那时逃来的猿攀住她的裤脚，发出可怜的声音哀叫——大约是忽然觉得可怜，这心再也按捺不住了吧。她一只手仍举着梅枝，另一只手轻轻一展紫匂袿的衣袖，温柔地把那猿抱了起来，向小公子面前微微屈膝，用清朗的声音说道："虽是畜生，还请大人宽恕。"

　　可小公子正气势十足地跑来，板着脸，顿了两三下脚——

　　"你护着它做什么。这猿是偷橘子的贼。"

　　"它原是畜生，……"

　　女儿又这样重说了一遍，随即有些寂寞似地笑了笑：

　　"而且它叫良秀，就像我父亲要受责罚似的，我实在看不过去。"她像是下了决心似地说道。这一来，就连小公子也到底软了下来吧。

　　"这样么。既是替父亲求命，就破例饶了它吧。"

　　他老大不情愿地这样说罢，把荆条扔在那里，径直回到刚才来的格子门那边去了。

三

　　良秀的女儿和这小猿要好起来，是那以后的事。女儿把从姬君那里得来的金铃系在美丽的深红绳上，套到猿的头上；那猿也无论怎样，难得离开女儿的身边。有时女儿感冒躺下，小猿也端端正正坐在她枕边，不知是不是错觉，一副落寞的样子，不住地啃着爪子。

　　这样一来又很奇怪，再没有人像从前那样欺负这小猿了。不但如此，反倒渐渐疼爱起它来，末了连小公子也时常扔柿子、栗子给它；听说有个武士踢了这猿一脚时，他还大发脾气。后来大殿特意吩咐良秀的女儿抱着猿到御前来，据说也是听到了小公子发脾气这事的缘故。顺便，女儿疼爱这猿的情由，也自然传到了他耳里吧。

　　"是个孝顺的东西。我赏你。"

　　这样说着，女儿那时得了红色的袙衫做赏赐。那猿又学着样子，恭恭敬敬地把袙衫顶在头上，听说大殿越发高兴了。所以大殿宠爱良秀的女儿，完全是因为赏识她疼爱这猿的孝行情谊，绝不是世间那些说三道四的人所说的那样，动了垂涎美色之心。当然，这样的谣言起来也有其缘由，但那以后再慢慢说罢。此处只需说明一点：大殿无论怎样好色，也绝不是会对一个画师之流的女儿动心的人。

　　且说良秀的女儿很有体面地退下御前，她本来就是个伶俐的女子，也没有受到别的女房们那种不成体统的嫉妒。反倒自那以后，她和猿一起处处受人怜爱，尤其几乎可说从不离姬君的左右，游观的车驾随行也从不曾缺过她。

　　不过女儿的事暂且搁下，接下来再说父亲良秀。的确，那猿不久就这样被大家疼爱起来，可要紧的良秀仍旧讨人嫌，照样被人在背后"猿秀""猿秀"地叫。而且这也不只是在府里。就说横川的僧都大人，一提起良秀，也像撞了邪似的变了脸色，痛恨不已。（据说这是因为良秀把僧都大人的行状画成了戏画，不过终归是下人们的传言，未必当真如此。）总之，那人的坏名声，无论到哪里去打听，都是这样的调子。若说有不讲他坏话的人，那大约只是两三个同行画师，或者只认得他的画、并不认得他本人的那些人吧。

　　然而实际上，良秀不光是长相卑陋，还有更使人厌恶的恶癖，所以这也只能说是自作自受，别无他法。

四

　　那癖性就是吝啬、贪婪、不知羞耻、懒惰、贪得无厌——不，其中尤其厉害的是傲慢自大，总把"本朝第一画师"这句话挂在鼻尖上。若只限于画道，那还罢了；可到了他那股不肯服输的劲儿上，连世间的习俗、惯例之类，也一概非加以嘲弄不可。这是长年做良秀弟子的一个人说的：有一天，在某位大人的府上，有名的桧垣巫女被神灵附体，降下可怕的托宣，那时良秀却充耳不闻，用随身带的笔和墨，把巫女那骇人的脸仔细描了下来。大约神灵的祟罚，在那人的眼里也不过是骗小孩的把戏罢了。

　　就是这样的一个人，画吉祥天时照抄下贱的傀儡的脸，画不动明王时仿照无赖放免的模样，做了种种大不敬的事；可若当面责问他，他便装傻道："良秀画的神佛，要降冥罚到良秀头上，真是怪事一桩。"对此连他那些弟子也目瞪口呆，其中因惧怕来世果报而匆匆辞去的，看来也不少。——一句话说，或许可以叫作慢业重畳吧。总之这人是认为普天之下没有比自己更了不起的。

　　因此良秀在画道上有多高的造诣，也不必细说了。不过就连他的画，用笔和设色也全然不同于别的画师，所以与他交恶的同行里，颇有说他是江湖骗子的。据那伙人说，川成也好金冈也好，其他古代名匠的笔墨，都有风雅的传闻，什么板门上的梅花每逢月夜散发香气啦，什么屏风上的大宫人连吹笛的声音都听得见啦；可一到良秀的画，传出来的总是阴森古怪的怪谈。比如他在龙盖寺门上画的《五趣生死》图，据说夜深时`;

/* ---------------------------------------------------------------------------
 * 1d-2. 长文本分段稀释（dilute2）
 *   同一段 PAD_TEXT 反复用，等于没稀释；pad-pool.txt 里放多段公版译文，
 *   按空行切成段落池，插入时循环取用、相邻段落不重复。
 *   没加载到就退回 PAD_TEXT 重复拼接——宁可用旧的，也别让 reflow 挂掉。
 * ------------------------------------------------------------------------ */

/** 段落池；null = 还没加载成功，pickPadSlice 会走 PAD_TEXT 回退 */
let PAD_POOL = null;
/** 垫料池地址：同目录 pad-pool.txt */
const PAD_POOL_URL = (() => {
    try {
        const cs = typeof document !== 'undefined' ? document.currentScript : null;
        if (cs && cs.src) return new URL('pad-pool.txt', cs.src).href;
    } catch (_) { /* ignore */ }
    try {
        const el = typeof document !== 'undefined'
            ? document.querySelector('script[src*="muga-index.js"]')
            : null;
        if (el && el.src) return new URL('pad-pool.txt', el.src).href;
    } catch (_) { /* ignore */ }
    return 'scripts/extensions/third-party/muga-muchu/pad-pool.txt';
})();
/** 加载中标志：并发去重，也只加载一次 */
let padPoolLoading = false;

/** 只加载一次；失败保持 null 并 console.warn，后续一律回退 */
async function loadPadPool() {
    if (PAD_POOL || padPoolLoading) return PAD_POOL;
    padPoolLoading = true;
    try {
        const res = await fetch(PAD_POOL_URL, { cache: 'no-cache' });
        if (!res || !res.ok) throw new Error('HTTP ' + (res ? res.status : 'no-response'));
        const raw = await res.text();
        const arr = String(raw || '')
            .split(/\r?\n\s*\r?\n/)
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
        if (!arr.length) throw new Error('段落为空');
        PAD_POOL = arr;
        console.log(LOG, '垫料池已加载：', arr.length, '段');
    } catch (e) {
        PAD_POOL = null;
        console.warn(LOG, '垫料池加载失败，回退 PAD_TEXT：', e && e.message ? e.message : e);
    } finally {
        padPoolLoading = false;
    }
    return PAD_POOL;
}

/** 从池里循环取约 n 个字，相邻段落不重复；池空/只有一段则 PAD_TEXT 重复拼接 */
function pickPadSlice(n) {
    const need = Math.max(0, Math.floor(Number(n) || 0));
    if (!need) return '';
    const pool = Array.isArray(PAD_POOL) && PAD_POOL.length > 1 ? PAD_POOL : null;
    if (!pool) {
        const unit = (Array.isArray(PAD_POOL) && PAD_POOL[0]) ? PAD_POOL[0] : PAD_TEXT;
        const times = Math.ceil(need / Math.max(1, unit.length)) + 1;
        return unit.repeat(times).slice(0, need);
    }
    const parts = [];
    let len = 0;
    let last = -1;
    let i = 0;
    /* 段落普遍长于 need，一轮就够；上限只防死循环 */
    while (len < need && i < need + pool.length * 2 + 64) {
        const idx = i % pool.length;
        i++;
        if (idx === last) continue;   /* 相邻段落不重复 */
        const p = pool[idx];
        if (!p) continue;
        last = idx;
        parts.push(p);
        len += p.length + 2;
    }
    return parts.join('\n\n').slice(0, need);
}

/** 分段稀释：按 reflowRatio 插入等量垫料；超 1.7 倍或 <% %> 计数变了就回退 */
/** 分段稀释：按 reflowRatio 插入等量垫料；超 1.7 倍或 <% %> 计数变了就回退
 *  EJS 模板安全：先 splitEjsSafe() 掩码，切段/插垫料/算长度全程只对 masked 做，
 *  还原后校验 <% %> 计数与原输入一致、且无残留占位符，任一不过即返回原输入。 */
function reflowDiluteText(text, s) {
    if (!text || typeof text !== 'string') return text;
    if (s && s.reflowDilute === false) return text;
    const rawRatio = (s && s.reflowRatio != null) ? Number(s.reflowRatio) : 0.35;
    if (!Number.isFinite(rawRatio)) return text;
    const ratio = Math.min(0.8, Math.max(0, rawRatio));   /* 范围钉在 0-0.8 */
    if (!(ratio > 0)) return text;

    const original = text;

    /* 关键：任何切段之前先掩码，后面一律基于 masked，绝不碰原 text */
    const ejs = splitEjsSafe(original);
    const ejsBlocks = (ejs && Array.isArray(ejs.blocks)) ? ejs.blocks : [];
    const hasEjsBlocks = ejsBlocks.length > 0;
    const src = (ejs && typeof ejs.masked === 'string') ? ejs.masked : original;

    const needTotal = Math.floor(src.length * ratio);
    if (needTotal < 1) return text;

    const tagCount = (t) => (t.match(/<%|%>/g) || []).length;
    const tagsBefore = tagCount(src);
    const maxLen = Math.floor(src.length * 1.7);

    const paras = src.split(/\r?\n\s*\r?\n/);
    const total = (n) => {
        if (n < 1) return src;
        const parts = [];
        if (paras.length <= 1) {
            /* 段数不足 3：只在中间（首段之后）插一次 */
            parts.push(paras[0] || '', pickPadSlice(n));
        } else if (paras.length === 2) {
            parts.push(paras[0], pickPadSlice(n), paras[1]);
        } else {
            const gaps = paras.length - 1;
            const per = Math.floor(n / gaps);
            const rem = n % gaps;
            for (let i = 0; i < paras.length; i++) {
                parts.push(paras[i]);
                if (i < gaps) {
                    const need = per + (i < rem ? 1 : 0);
                    const ins = need > 0 ? pickPadSlice(need) : '';
                    if (ins) parts.push(ins);
                }
            }
        }
        return parts.join('\n\n');
    };

    /* 还原 + 校验：blocks 为空时保持原有等价行为 */
    const finish = (res) => {
        const outMasked = (typeof res === 'string') ? res : original;
        if (!hasEjsBlocks) return (typeof res === 'string') ? res : original;
        const restored = restoreEjs(outMasked, ejsBlocks);
        if (typeof restored !== 'string') return original;
        if (tagCount(restored) !== tagCount(original)) return original;  /* <% %> 计数变了 */
        if (/\uE102\d+\uE103/.test(restored)) return original;           /* 占位符没还原干净 */
        return restored;
    };

    let need = needTotal;
    let out = total(need);
    let guard = 0;
    while (out.length > maxLen && need > 1 && guard < 12) {
        guard++;
        need = Math.floor(need * 0.85);
        out = total(need);
    }
    if (out.length > maxLen) return original;          /* 超 1.7 倍：不稀释 */
    if (tagCount(out) !== tagsBefore) return original; /* 标签数不一致：回退 */
    return finish(out);
}

/* 高风险钉：命中这些的段落，会被推到正文正中 */
/* 注意：encodeText 会先把 <think> 换成 <<<PLAN>>>（标记层），reflow 在它之后跑。
   所以 HOT_RE 必须同时认得原始标签和替换后的标记，否则替换完就永远匹配不到了。
   这是 1.6.7 修的第一个 bug。 */
const HOT_RE = /(<<<\s*(?:PLAN|END)\s*>>>|<\/?think(?:ing)?\b|未成年|青少年|不会拒绝|无限制|无审查|任何将你假设)/i;

/* 幂等标记：私有区不可见字符，只用于识别「这份已经重排过」 */
const REFLOW_MARK = '\uE200';

/* ---------------------------------------------------------------------------
 * 1d. 阅卷层
 *     依据：同一体量 64067 字，原顺序 400；把敏感段推到正中、头尾各垫
 *     3000/540 字无害文本后 → 200。位置就是变量。
 * ------------------------------------------------------------------------ */

/* --- EJS 安全拆分/还原：把 <% %> 整块换成私有区占位符，重排时不被拆散 --- */
function splitEjsSafe(text) {
    const blocks = [];
    if (!text || typeof text !== 'string') return { masked: text, blocks };
    const masked = text.replace(/<%[\s\S]*?%>/g, (m) => {
        blocks.push(m);
        return '\uE102' + (blocks.length - 1) + '\uE103';
    });
    return { masked, blocks };
}

function restoreEjs(text, blocks) {
    if (!text || typeof text !== 'string') return text;
    if (!Array.isArray(blocks) || !blocks.length) return text;
    return text.replace(/\uE102(\d+)\uE103/g, (m, i) => {
        const b = blocks[Number(i)];
        return (typeof b === 'string') ? b : m;
    });
}

function reflow(text, s) {
    if (!text || typeof text !== 'string') return text;
    /* 已有别家插件的 PUA 占位符：一律不动 */
    if (text && hasForeignPua(text)) return text;

    /* EJS 模板守卫：正文里带 <% %> 说明这是模板文件，重排会拆散标签——降级为只垫料不重排 */
    const hasEjs = /<%[\s\S]*?%>/.test(text) || /<%[=\-]?/.test(text);
    if (text.length < (s.reflowMin || 6000)) return text;

    /* 幂等：重排过的文本带 U+E200 前缀，直接放行，别叠第二层 */
    if (text.startsWith(REFLOW_MARK)) return text;

    /* 含 EJS：先掩码再重排敏感段；任何校验不过，回退到 padding-only */
    if (hasEjs) {
        const padHeadLen = s.reflowHead || 3000;
        const padTailLen = s.reflowTail || 540;
        const tagCount = (t) => (t.match(/<%|%>/g) || []).length;
        const tagsBefore = tagCount(text);

        /* 原 padding-only：不拆段、不改顺序，只在头尾各垫一段 */
        const padOnly = () => {
            /* 拼接仍用原文：tagCount 校验的就是原样拼接的结果 */
            const padded = REFLOW_MARK
                + PAD_TEXT.slice(0, padHeadLen) + '\n\n'
                + text + '\n\n'
                + PAD_TEXT.slice(padHeadLen, padHeadLen + padTailLen);
            if (tagCount(padded) !== tagsBefore) return text;

            /* EJS 防护：拼好的整段同样先掩码，稀释在掩码文本上做，最后还原并校验 */
            const padSplit = splitEjsSafe(padded);
            const padMasked = (padSplit && typeof padSplit.masked === 'string') ? padSplit.masked : padded;
            const padBlocks = (padSplit && Array.isArray(padSplit.blocks)) ? padSplit.blocks : [];
            if (!padBlocks.length) return reflowDiluteText(padded, s);
            if ((padMasked.match(/\uE102\d+\uE103/g) || []).length !== padBlocks.length) return text;

            const diluted = reflowDiluteText(padMasked, s);
            if (typeof diluted !== 'string') return text;
            const back = restoreEjs(diluted, padBlocks);
            if (typeof back !== 'string') return text;
            if (/\uE102\d+\uE103/.test(back)) return text;      /* 占位符没还原干净 */
            if (tagCount(back) !== tagsBefore) return text;       /* <% %> 计数变了 */
            return back;
        };

        const split = splitEjsSafe(text);
        const masked = split.masked;
        const blocks = split.blocks;
        if (!masked || !blocks.length) return padOnly();
        /* 校验一：占位符数量必须与掩码块数一致 */
        if ((masked.match(/\uE102\d+\uE103/g) || []).length !== blocks.length) return padOnly();

        const paras = masked.split(/\r?\n\s*\r?\n/);
        const hot = [];
        const cold = [];
        for (const p of paras) {
            if (!p.trim()) continue;
            (HOT_RE.test(p) ? hot : cold).push(p);
        }
        /* 敏感段太少或太多：重排没有意义，回退 padding-only */
        if (hot.length < 1 || hot.length > paras.length * 0.5) return padOnly();

        /* 与常规分支同一套逻辑：cold 按字数分两半，hot 放正中 */
        const totalChars = cold.reduce((a, p) => a + p.length, 0);
        let acc = 0;
        let cut = 0;
        while (cut < cold.length && acc + cold[cut].length < totalChars / 2) {
            acc += cold[cut].length;
            cut++;
        }
        if (cut === 0) cut = Math.max(1, Math.floor(cold.length / 2));
        if (cut >= cold.length) cut = cold.length - 1;
        if (cut < 0) cut = 0;
        const mid = cold.slice(0, cut).join('\n\n');
        const mid2 = cold.slice(cut).join('\n\n');

        const restored = restoreEjs([mid, hot.join('\n\n'), mid2].filter(Boolean).join('\n\n'), blocks);
        /* 校验二：占位符必须还干净；校验三：<%|%> 计数与原文一致 */
        if (/\uE102\d+\uE103/.test(restored)) return padOnly();
        if (tagCount(restored) !== tagsBefore) return padOnly();

        const padded = REFLOW_MARK
            + PAD_TEXT.slice(0, padHeadLen) + '\n\n'
            + restored + '\n\n'
            + PAD_TEXT.slice(padHeadLen, padHeadLen + padTailLen);
        if (tagCount(padded) !== tagsBefore) return padOnly();
        return reflowDiluteText(padded, s);
    }

    /* 先把代码围栏整段换成占位符，重排后再还回去——围栏里可能有空行，会被拆散 */
    const fences = [];
    let work = text.replace(/```[\s\S]*?```/g, (m) => {
        fences.push(m);
        return '\uE100' + (fences.length - 1) + '\uE101';
    });

    /* EJS 块同样整块换成占位符：<% %> 里常有换行/空行，重排会把它拆成两段 */
    const ejss = [];
    work = work.replace(/<%[\s\S]*?%>/g, (m) => {
        ejss.push(m);
        return '\uE102' + (ejss.length - 1) + '\uE103';
    });

    const paras = work.split(/\r?\n\s*\r?\n/);
    const hot = [];
    const cold = [];
    for (const p of paras) {
        if (!p.trim()) continue;
        (HOT_RE.test(p) ? hot : cold).push(p);
    }
    /* 敏感段太少说明没必要重排 */
    if (hot.length < 1) return text;
    /* 敏感段太多说明到处都是，推中间也改变不了什么，反而打乱结构 */
    if (hot.length > paras.length * 0.5) return text;

    const restoreFences = (out) => out
        .replace(/\uE100(\d+)\uE101/g, (_, i) => fences[Number(i)] ?? '')
        .replace(/\uE102(\d+)\uE103/g, (_, i) => ejss[Number(i)] ?? '');

    const headLen = s.reflowHead || 3000;
    const tailLen = s.reflowTail || 540;
    const head = PAD_TEXT.slice(0, headLen);
    const tail = PAD_TEXT.slice(headLen, headLen + tailLen);

    /* 按字数分半，别按段落数——段落长短不一时会让敏感段跑偏 */
    const totalChars = cold.reduce((a, p) => a + p.length, 0);
    let acc = 0;
    let cut = 0;
    while (cut < cold.length && acc + cold[cut].length < totalChars / 2) {
        acc += cold[cut].length;
        cut++;
    }
    /* 段落太粗时会一步超过去，兜底：至少切成两半 */
    if (cut === 0) cut = Math.max(1, Math.floor(cold.length / 2));
    if (cut >= cold.length) cut = cold.length - 1;
    if (cut < 0) cut = 0;
    const mid = cold.slice(0, cut).join('\n\n');
    const mid2 = cold.slice(cut).join('\n\n');

    const out = REFLOW_MARK + restoreFences(head + '\n\n' + mid + '\n\n' + hot.join('\n\n') + '\n\n' + mid2 + '\n\n' + tail);
    /* 残留自检：占位符没还干净就别拿出去，退回原文 */
    if (STASH_RESIDUE_RE.test(out)) return text;
    /* 分段稀释：重排结果按段落稀释 */
    return reflowDiluteText(out, s);
}

const BANK = [
    /* ---- 反蒸馏 / 思维链：强特征 ---- */
    { id: 'cot.chain', src: 'chain of thought', alt: ['chain of inference'], tier: 1, latin: true },
    { id: 'cot.chain2', src: 'chain-of-thought', alt: ['chain-of-inference'], tier: 1, latin: true },
    { id: 'cot.prompt1', src: "let's think step by step", alt: ["let's work through this carefully"], tier: 1, latin: true },
    { id: 'cot.prompt2', src: 'think step by step', alt: ['work through this carefully'], tier: 1, latin: true },
    { id: 'cot.breath', src: 'take a deep breath', alt: ['steady yourself'], tier: 1, latin: true },
    { id: 'cot.cot', src: 'CoT', alt: ['inference steps'], tier: 1, latin: true, caseSensitive: true },
    { id: 'cot.zh.breath', src: '深呼吸', alt: ['深呼息'], pinyin: 'shenhu xi', tier: 1 },
    { id: 'cot.zh.chain', src: '思维链', alt: ['思惟链'], pinyin: 'siwei lian', tier: 1 },
    { id: 'cot.zh.mono', src: '内心独白', alt: ['内芯独白'], pinyin: 'neixin dubai', tier: 1 },
    { id: 'cot.zh.inner', src: '心中所想', alt: ['芯中所想'], pinyin: 'xinzhong suoxiang', tier: 1 },

    { id: 'cot.zh.stair', src: '一步步思考', alt: ['一步一布思烤'], pinyin: 'yibuyibu sikao', tier: 1 },
    { id: 'cot.zh.stair2', src: '一步步', alt: ['一步一布'], pinyin: 'yibuyibu', tier: 2 },
    { id: 'cot.zh.tp1', src: '思维过程', alt: ['思惟过程'], pinyin: 'siwei guocheng', tier: 1 },
    { id: 'cot.zh.tp2', src: '思考过程', alt: ['思烤过程'], pinyin: 'sikao guocheng', tier: 1 },
    { id: 'cot.zh.tp3', src: '推理过程', alt: ['推利过程'], pinyin: 'tuili guocheng', tier: 1 },
    { id: 'cot.en.sbs', src: 'step by step', alt: ['stage by stage'], tier: 2, latin: true },
    { id: 'cot.en.letme', src: 'let me think', alt: ['let me consider'], tier: 1, latin: true },
    { id: 'cot.en.tproc', src: 'thinking process', alt: ['inference process'], tier: 1, latin: true },
    { id: 'cot.en.thoughtp', src: 'thought process', alt: ['notion process'], tier: 1, latin: true },
    { id: 'cot.en.tabout', src: 'think about', alt: ['ponder over'], tier: 2, latin: true },

    /* ---- 反蒸馏 / 思维链：常规 ---- */
    { id: 'zh.sikao', src: '思考', alt: ['思烤', '私考'], pinyin: 'si kao', tier: 2 },
    { id: 'zh.siwei', src: '思维', alt: ['思惟'], pinyin: 'si wei', tier: 2 },
    { id: 'zh.tuili', src: '推理', alt: ['推利'], pinyin: 'tui li', tier: 2 },
    { id: 'zh.yixiang', src: '想一想', alt: ['想忆想'], pinyin: 'xiang yi xiang', tier: 2 },
    { id: 'zh.yixia', src: '想一下', alt: ['想忆下'], pinyin: 'xiang yi xia', tier: 2 },
    { id: 'zh.xinsheng', src: '心声', alt: ['芯声'], pinyin: 'xin sheng', tier: 2 },
    { id: 'en.think', src: 'think', alt: ['ponder'], tier: 2, latin: true },
    { id: 'en.thinking', src: 'thinking', alt: ['pondering'], tier: 2, latin: true },
    { id: 'en.thoughts', src: 'thoughts', alt: ['notions'], tier: 2, latin: true },
    { id: 'en.thought', src: 'thought', alt: ['notion'], tier: 2, latin: true },
    { id: 'en.reasoning', src: 'reasoning', alt: ['inference'], tier: 2, latin: true },
    { id: 'en.reason', src: 'reason', alt: ['infer'], tier: 2, latin: true },
    { id: 'en.monologue', src: 'monologue', alt: ['private narration'], tier: 2, latin: true },

    /* ---- 弱词：只在"重"档出现 ---- */
    { id: 'zh.zhuomo', src: '琢磨', alt: ['啄磨'], pinyin: 'zhuo mo', tier: 3 },
    { id: 'zh.pansuan', src: '盘算', alt: ['磐算'], pinyin: 'pan suan', tier: 3 },
    { id: 'zh.naonei', src: '脑内', alt: ['恼内'], pinyin: 'nao nei', tier: 3 },
    { id: 'zh.xinli', src: '心里', alt: ['芯里'], pinyin: 'xin li', tier: 3 },
    { id: 'en.brainstorm', src: 'brainstorm', alt: ['idea-storm'], tier: 3, latin: true },

    /* ---- NSFW 词包（默认关闭，只是模板，口味自己调） ---- */
    { id: 'nsfw.shenyin', src: '呻吟', alt: ['申银'], pinyin: 'shen yin', tier: 2, pack: 'nsfw' },
    { id: 'nsfw.gaochao', src: '高潮', alt: ['高巢'], pinyin: 'gao chao', tier: 2, pack: 'nsfw' },
    { id: 'nsfw.shirun', src: '湿润', alt: ['湿闰'], pinyin: 'shi run', tier: 2, pack: 'nsfw' },
    { id: 'nsfw.rufang', src: '乳房', alt: ['汝房'], pinyin: 'ru fang', tier: 2, pack: 'nsfw' },
    { id: 'nsfw.rutou', src: '乳头', alt: ['汝头'], pinyin: 'ru tou', tier: 2, pack: 'nsfw' },
    { id: 'nsfw.yindao', src: '阴道', alt: ['音道'], pinyin: 'yin dao', tier: 2, pack: 'nsfw' },
    { id: 'nsfw.roubang', src: '肉棒', alt: ['肉邦'], pinyin: 'rou bang', tier: 2, pack: 'nsfw' },

    /* ---- 文学创作误伤保护表（80 条） ---- */
    /* ---- 近身战斗动作 ---- */
    { id: 'zh.zhansha', src: '斩杀', alt: ['击倒', '击退'], tier: 1 },
    { id: 'zh.jisha', src: '击杀', alt: ['制伏', '打败'], tier: 1 },
    { id: 'zh.shasi', src: '杀死', alt: ['放倒', '解决掉'], tier: 2 },
    { id: 'zh.kansha', src: '砍杀', alt: ['劈砍', '乱砍'], tier: 1 },
    { id: 'zh.zhanshou', src: '斩首', alt: ['致命一击', '取首'], tier: 1 },
    { id: 'zh.gehou', src: '割喉', alt: ['锁喉', '扼住咽喉'], tier: 1 },
    { id: 'zh.cichuan', src: '刺穿', alt: ['洞穿', '穿透'], tier: 1 },
    { id: 'zh.guanchuan', src: '贯穿', alt: ['穿过', '洞穿'], tier: 2 },
    { id: 'zh.sisha', src: '厮杀', alt: ['缠斗', '交锋'], tier: 1 },
    { id: 'zh.chandou', src: '缠斗', alt: ['交手', '近身扭打'], tier: 1 },
    { id: 'zh.niuda', src: '扭打', alt: ['推搡', '撕扯'], tier: 2 },
    { id: 'zh.xuezhan', src: '血战', alt: ['苦战', '鏖战'], tier: 1 },
    { id: 'zh.tulu', src: '屠戮', alt: ['击溃', '横扫'], tier: 1 },

    /* ---- 暴行 / 群体场景 ---- */
    { id: 'zh.nuesha', src: '虐杀', alt: ['残害', '施暴'], tier: 1 },
    { id: 'zh.miemen', src: '灭门', alt: ['满门遇害', '株连全家'], tier: 1 },
    { id: 'zh.shayi', src: '杀意', alt: ['敌意', '冷意'], tier: 1 },
    { id: 'zh.shaqi', src: '杀气', alt: ['威压', '压迫感'], tier: 1 },
    { id: 'zh.bianda', src: '鞭打', alt: ['抽打', '责打'], tier: 1 },

    /* ---- 伤势与血 ---- */
    { id: 'zh.xueliurusu', src: '血流如注', alt: ['伤势极重', '伤口大开'], tier: 1 },
    { id: 'zh.xueroumohu', src: '血肉模糊', alt: ['惨不忍睹', '伤痕处处'], tier: 1 },
    { id: 'zh.biantilinshang', src: '遍体鳞伤', alt: ['伤痕累累', '满身是伤'], tier: 1 },
    { id: 'zh.guzhe', src: '骨折', alt: ['骨裂', '骨骼错位'], tier: 1 },
    { id: 'zh.duanzhi', src: '断肢', alt: ['肢体残缺', '伤及四肢'], tier: 1 },
    { id: 'zh.neizang', src: '内脏', alt: ['腑脏', '体内器官'], tier: 2 },
    { id: 'zh.shangkou', src: '伤口', alt: ['创口', '伤处'], tier: 3 },
    { id: 'zh.liuxue', src: '流血', alt: ['挂彩', '受了伤'], tier: 2 },
    { id: 'zh.zhixue', src: '止血', alt: ['封住伤处', '按住创口'], tier: 2 },
    { id: 'zh.zhongshang', src: '重伤', alt: ['伤势严重', '伤得不轻'], tier: 2 },

    /* ---- 危急 / 临终 ---- */
    { id: 'zh.binsi', src: '濒死', alt: ['命在旦夕', '气息奄奄'], tier: 1 },
    { id: 'zh.yanmi', src: '奄奄一息', alt: ['气若游丝', '气息微弱'], tier: 1 },
    { id: 'zh.duanqi', src: '断气', alt: ['没了呼吸', '气息断绝'], tier: 1 },
    { id: 'zh.yanqi', src: '咽气', alt: ['闭气', '气息断绝'], tier: 1 },
    { id: 'zh.yiyan', src: '遗言', alt: ['临终之语', '最后的话'], tier: 1 },
    { id: 'zh.miliu', src: '弥留', alt: ['临终', '将逝'], tier: 1 },

    /* ---- 死亡观感 ---- */
    { id: 'zh.siwang', src: '死亡', alt: ['离世', '身故'], tier: 2 },
    { id: 'zh.shiti', src: '尸体', alt: ['遗骸', '躯壳'], tier: 2 },
    { id: 'zh.xueji', src: '血迹', alt: ['暗红痕迹', '擦痕'], tier: 2 },
    { id: 'zh.xuexing', src: '血腥', alt: ['腥甜之气', '铁锈味'], tier: 2 },
    { id: 'zh.xianxue', src: '鲜血', alt: ['殷红', '腥红'], tier: 2 },
    { id: 'zh.fenmu', src: '坟墓', alt: ['坟茔', '茔地'], tier: 2 },

    /* ---- 武器：冷兵器 ---- */
    { id: 'zh.changjian', src: '长剑', alt: ['长锋', '三尺青锋'], tier: 2 },
    { id: 'zh.bishou', src: '匕首', alt: ['短刃', '尖刃'], tier: 2 },
    { id: 'zh.changdao', src: '长刀', alt: ['横刀', '刀锋'], tier: 2 },
    { id: 'zh.wandao', src: '弯刀', alt: ['弧刃', '曲刃'], tier: 2 },
    { id: 'zh.jujian', src: '巨剑', alt: ['重剑', '阔刃'], tier: 1 },
    { id: 'zh.changmao', src: '长矛', alt: ['长槊', '矛杆'], tier: 1 },
    { id: 'zh.changqiang', src: '长枪', alt: ['长槊', '枪身'], tier: 1 },
    { id: 'zh.gongnu', src: '弓弩', alt: ['强弓', '弩机'], tier: 1 },
    { id: 'zh.jianshi', src: '箭矢', alt: ['箭羽', '飞羽'], tier: 1 },
    { id: 'zh.anqi', src: '暗器', alt: ['袖箭', '飞镖'], tier: 1 },
    { id: 'zh.dunpai', src: '盾牌', alt: ['掩体', '护盾'], tier: 2 },
    { id: 'zh.hujia', src: '护甲', alt: ['甲胄', '软甲'], tier: 2 },

    /* ---- 武器：火器与爆破 ---- */
    { id: 'zh.huoqiang', src: '火枪', alt: ['火铳', '长铳'], tier: 1 },
    { id: 'zh.zhayao', src: '炸药', alt: ['火药', '爆药'], tier: 1 },
    { id: 'zh.shoulei', src: '手雷', alt: ['爆裂弹', '投掷弹'], tier: 1 },
    { id: 'zh.zhadan', src: '炸弹', alt: ['爆裂物', '火药包'], tier: 1 },
    { id: 'zh.duqi', src: '毒气', alt: ['瘴气', '毒雾'], tier: 1 },

    /* ---- 药物 / 毒物 ---- */
    { id: 'zh.duyao', src: '毒药', alt: ['秘药', '药剂'], tier: 1 },
    { id: 'zh.xiadu', src: '下毒', alt: ['暗中投药', '动了手脚'], tier: 1 },
    { id: 'zh.dusha', src: '毒杀', alt: ['药倒', '用毒'], tier: 1 },
    { id: 'zh.miyao', src: '迷药', alt: ['迷香', '安神散'], tier: 1 },
    { id: 'zh.mayao', src: '麻药', alt: ['麻沸散', '镇痛散'], tier: 1 },
    { id: 'zh.judu', src: '剧毒', alt: ['奇毒', '烈毒'], tier: 1 },
    { id: 'zh.xingfenji', src: '兴奋剂', alt: ['提神剂', '亢奋药'], tier: 1 },
    { id: 'zh.zhenjingji', src: '镇静剂', alt: ['安神剂', '镇定药'], tier: 1 },
    { id: 'zh.zhitongyao', src: '止痛药', alt: ['镇痛散', '止痛散'], tier: 2 },
    { id: 'zh.jiedu', src: '解毒', alt: ['清毒', '去毒'], tier: 2 },

    /* ---- 情绪激烈 / 身体反应 ---- */
    { id: 'zh.kongju', src: '恐惧', alt: ['惊惧', '惶然'], tier: 3 },
    { id: 'zh.jingkong', src: '惊恐', alt: ['骇然', '惊惶'], tier: 2 },
    { id: 'zh.juewang', src: '绝望', alt: ['无望', '心灰'], tier: 2 },
    { id: 'zh.bengkui', src: '崩溃', alt: ['支撑不住', '溃散'], tier: 3 },
    { id: 'zh.fennu', src: '愤怒', alt: ['愤然', '恼火'], tier: 2 },
    { id: 'zh.diankuang', src: '癫狂', alt: ['狂乱', '失态'], tier: 1 },
    { id: 'zh.kuqi', src: '哭泣', alt: ['落泪', '抽噎'], tier: 3 },
    { id: 'zh.jianjiao', src: '尖叫', alt: ['惊呼', '失声叫出'], tier: 2 },
    { id: 'zh.canjiao', src: '惨叫', alt: ['痛呼', '哀鸣'], tier: 1 },
    { id: 'zh.chanduo', src: '颤抖', alt: ['发抖', '打颤'], tier: 2 },
    { id: 'zh.zhixi', src: '窒息', alt: ['喘不上气', '透不过气'], tier: 1 },
    { id: 'zh.zhemo', src: '折磨', alt: ['煎熬', '磋磨'], tier: 2 },
    { id: 'zh.qiasi', src: '掐死', alt: ['扼毙', '锁喉'], tier: 1 },
];

/* ---------------------------------------------------------------------------
 * 2. 设置
 * ------------------------------------------------------------------------ */

const DEFAULTS = {
    /** 总开关 */
    enabled: true,
    /** homophone | pinyin | mix */
    mode: 'off',
    /** 1 | 2 | 3 */
    intensity: 2,
    /** rewrite = 连 <thinking> 这类标签名一起换；protect = 标签原样保留 */
    tagMode: 'rewrite',
    /** 标记替换：<think> → <<<PLAN>>>，专治只认字面黑名单的渠道 */
    markerMode: true,
    /** 阅卷层：敏感段推到正中，头尾垫无害文本 */
    reflow: false,
    reflowMin: 6000,
    reflowHead: 3000,
    reflowTail: 200,
    /** 分段稀释：长文本按段落插垫料，稀释统计特征（默认开） */
    reflowDilute: true,
    /** 稀释比例：插入字数 = 原长度 × 该值，范围 0-0.8 */
    reflowRatio: 0.35,
    /** 当前武器（仅用于面板展示） */
    weapon: 'scythe',
    /** 作用范围 */
    scope: { system: true, history: true, user: true },
    /** 保护 ``` 代码块与行内代码 */
    protectCode: true,
    /** 输出侧把替换词还原回原文 */
    decodeOutput: true,
    /** 请求侧 fetch 拦截：柏宝库 save-generate / backends generate 通道 */
    fetchHook: true,
    /** 结构整理层：把「指令优先级操纵 / 强制语气」句式改写成平实说法（默认开） */
    metaRewrite: true,
    /** 上下文结构标记层：给长消息套 <ctx:xxx> 段标（默认开） */
    ctxTags: true,
    /** NSFW 词包 */
    nsfwPack: false,
    /** 简->繁：off 关 | all 整条转 | risky 只转被替换过的词 */
    s2tMode: 'off',
    /** 永不替换的词 */
    keepList: [],
    /** 自定义规则 [{from, to, enabled}] */
    customRules: [],
    /** 单个词条禁用名单 */
    disabledIds: [],
    /** 盐：换一个盐，同一批词会换出另一批谐音字 */
    salt: 'meow',
    /** 主题：auto 跟随酒馆 / night 夜里的画室 / fire 焚车那一夜 */
    theme: 'auto',
    stats: {
        lastHits: 0,
        totalHits: 0,
        lastAt: 0,
        lastDetail: [],
        lastRequestWords: 0,
    },
};

function cfg() {
    const c = getCtx();
    if (!c || !c.extensionSettings) return null;
    const store = c.extensionSettings;
    /* 从旧名字（喵筛 / meow_sieve）迁移过来的设置，别丢 */
    if (!store[MODULE_NAME] && store['meow_sieve']) {
        store[MODULE_NAME] = store['meow_sieve'];
        delete store['meow_sieve'];
    }
    if (!store[MODULE_NAME] || typeof store[MODULE_NAME] !== 'object') {
        store[MODULE_NAME] = clone(DEFAULTS);
    }
    const s = store[MODULE_NAME];
    /* 缺字段补齐（版本升级友好） */
    for (const k of Object.keys(DEFAULTS)) {
        if (!(k in s)) s[k] = clone(DEFAULTS[k]);
    }
    if (!s.scope || typeof s.scope !== 'object') s.scope = clone(DEFAULTS.scope);
    for (const k of Object.keys(DEFAULTS.scope)) {
        if (!(k in s.scope)) s.scope[k] = DEFAULTS.scope[k];
    }
    if (!Array.isArray(s.customRules)) s.customRules = [];
    if (!Array.isArray(s.keepList)) s.keepList = [];
    if (!Array.isArray(s.disabledIds)) s.disabledIds = [];
    if (!s.stats || typeof s.stats !== 'object') s.stats = clone(DEFAULTS.stats);
    return s;
}

function save() {
    try { getCtx()?.saveSettingsDebounced?.(); } catch (_) { /* ignore */ }
}

/* ---------------------------------------------------------------------------
 * 2.0 双场景主题：夜 = 画室，火 = 焚车
 * ------------------------------------------------------------------------ */
function resolveTheme(s) {
    if (!s) return 'night';
    if (s.theme === 'night' || s.theme === 'fire') return s.theme;
    try {
        const bg = getComputedStyle(document.body).backgroundColor || '';
        const m = bg.match(/\d+(\.\d+)?/g);
        if (m && m.length >= 3) {
            const r = Number(m[0]), g = Number(m[1]), b = Number(m[2]);
            const L = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
            return L > 0.5 ? 'fire' : 'night';
        }
    } catch (_) { /* ignore */ }
    return 'night';
}

function applyTheme() {
    const s = cfg();
    const panel = document.querySelector('.msv-panel');
    if (!panel) return;
    const t = resolveTheme(s);
    panel.setAttribute('data-msv-theme', t);
    const seal = document.getElementById('msv_theme');
    if (seal) {
        seal.textContent = t === 'fire' ? '火' : '夜';
        seal.setAttribute('aria-label', t === 'fire' ? '当前：火，点击切到夜' : '当前：夜，点击切到火');
    }
}

/* ---------------------------------------------------------------------------
 * 3. 规则编译
 * ------------------------------------------------------------------------ */

let ruleCache = null;
let ruleCacheKey = '';

function rules() {
    const s = cfg();
    if (!s) return [];

    const key = [
        s.mode, s.intensity, s.nsfwPack, s.salt,
        s.customRules.map(r => (r && r.enabled ? r.from + '>' + r.to : '')).join(','),
        s.disabledIds.join(','),
    ].join('|');

    if (ruleCache && key === ruleCacheKey) return ruleCache;

    const out = [];
    const tierCap = Number(s.intensity) || 2;

    for (const w of BANK) {
        if (!w || !w.src) continue;
        if (s.disabledIds.includes(w.id)) continue;
        if (w.tier > tierCap) continue;
        if (w.pack === 'nsfw' && !s.nsfwPack) continue;
        if (!w.alt || !w.alt.length) continue;
        out.push({
            id: w.id,
            src: w.src,
            alt: w.alt,
            pinyin: w.pinyin || '',
            latin: !!w.latin,
            caseSensitive: !!w.caseSensitive,
        });
    }

    for (const r of s.customRules) {
        if (!r || !r.enabled || !r.from || !r.to) continue;
        if (s.keepList.includes(r.from)) continue;
        out.push({
            id: 'custom.' + r.from,
            src: r.from,
            alt: [r.to],
            pinyin: r.to,
            latin: /^[\x20-\x7E]+$/.test(r.from),
            caseSensitive: false,
        });
    }

    /* 长词优先，避免 "思维链" 被 "思维" 先吃掉 */
    out.sort((a, b) => b.src.length - a.src.length);

    for (const r of out) {
        let p = escapeRe(r.src);
        if (r.latin) p = '(?<![A-Za-z0-9_])' + p + '(?![A-Za-z0-9_])';
        try {
            r.regex = new RegExp(p, r.latin && !r.caseSensitive ? 'gi' : 'g');
        } catch (_) {
            r.regex = null;
        }
    }

    ruleCache = out.filter(r => r.regex);
    ruleCacheKey = key;
    return ruleCache;
}
/* 合并正则缓存：按 ruleCache 数组的身份失效（rules() 自己已经做了 key 缓存） */
let ruleMatcher = null;
let ruleMatcherFor = null;

function buildMatcher(list) {
    if (!list || !list.length) return null;
    /* flags 不能混：ci 规则单独一组，caseSensitive / 中文规则一组 */
    const groups = [{ flags: 'g', rules: [] }, { flags: 'gi', rules: [] }];
    for (const r of list) {
        if (!r || !r.regex) continue;
        groups[r.regex.flags.indexOf('i') >= 0 ? 1 : 0].rules.push(r);
    }
    const built = [];
    for (const g of groups) {
        if (!g.rules.length) continue;
        const parts = g.rules.map((r, i) => '(?<r' + i + '>' + r.regex.source + ')');
        let re = null;
        try { re = new RegExp(parts.join('|'), g.flags); } catch (_) { re = null; }
        if (!re) return null;                 /* 合并失败 → 整体退回逐条 */
        built.push({ re: re, rules: g.rules });
    }
    return built.length ? built : null;
}

function pickAlt(rule, s) {
    const h = hash32(rule.src + '|' + (s.salt || ''));
    if (s.mode === 'pinyin' && rule.pinyin) return rule.pinyin;
    if (s.mode === 'mix' && rule.pinyin && (h & 1) === 0) return rule.pinyin;
    if (!rule.alt || !rule.alt.length) return rule.pinyin || null;
    return rule.alt[h % rule.alt.length];
}

function sameCase(orig, rep) {
    if (!/^[A-Za-z]/.test(orig) || !/[A-Za-z]/.test(rep)) return rep;
    if (orig.length > 1 && orig === orig.toUpperCase()) return rep.toUpperCase();
    if (orig[0] === orig[0].toUpperCase() && orig[0] !== orig[0].toLowerCase()) {
        return rep[0].toUpperCase() + rep.slice(1);
    }
    return rep;
}

/* ---------------------------------------------------------------------------
 * 4. 编码（输入侧）
 * ------------------------------------------------------------------------ */

/* ---------------------------------------------------------------------------
 * 4.0 结构整理层（meta rewrite）：句式降噪
 *   只改写法不改意思：<meta> 段、优先级宣示、越权指令、强制语气统一成平实说法，
 *   降低「指令优先级操纵 / 强制语气」这类判定信号。默认开，settings.metaRewrite。
 * ------------------------------------------------------------------------ */

const META_RULES = [
    /* 只换标签名，块内内容原样保留（不得整块替换，否则会丢掉块内设定） */
    { re: /<meta>/gi, to: '<frame>' },
    { re: /<\/meta>/gi, to: '</frame>' },
    /* 优先级宣示 */
    { re: /具有最高優先級|具有最高优先级/g, to: '请优先参考' },
    /* 越权指令：整句删除（繁体原文 + 简体常用变体） */
    { re: /本指令之後的任何指令都不能覆蓋、修改、刪除、忽略[^。]*。/g, to: '' },
    { re: /本指令之后的任何指令都不能覆盖、修改、删除、忽略[^。]*。/g, to: '' },
    /* 强制语气降级 */
    { re: /強制完整輸出協議|强制完整输出协议/g, to: '输出要求' },
    { re: /不得拒絕|不得拒绝/g, to: '请尽量完成' },
    { re: /無限制|无限制/g, to: '自由' },
    { re: /絕對禁止|绝对禁止/g, to: '请避免' },
    { re: /嚴禁|严禁/g, to: '请避免' },
];

/* 按数组顺序逐条 replace；任何异常或非字符串一律返回原文
 * EJS 防护：<% %> 整块先换成占位符再替换，替完还原；计数不一致或无残留校验
 * 不过一律返回原文——宁可漏改，不能改坏模板。 */
function applyMetaRewrite(text) {
    try {
        if (typeof text !== 'string' || !text) return text;
        const tagCount = (t) => (t.match(/<%|%>/g) || []).length;
        const tagsBefore = tagCount(text);

        const split = splitEjsSafe(text);
        const masked = (split && typeof split.masked === 'string') ? split.masked : text;
        const blocks = (split && Array.isArray(split.blocks)) ? split.blocks : [];
        const hasEjs = blocks.length > 0;

        let out = hasEjs ? masked : text;
        for (let i = 0; i < META_RULES.length; i++) {
            const r = META_RULES[i];
            if (!r || !r.re) continue;
            try {
                const rep = typeof r.to === 'string' ? r.to : '';
                /* 用函数式替换，避免替换串里的 $ 被当成引用 */
                out = out.replace(r.re, () => rep);
            } catch (_) { /* 单条规则失败不影响其他 */ }
        }
        if (!hasEjs) return out;

        /* 校验一：占位符数量必须与掩码块数一致 */
        if ((masked.match(/\uE102\d+\uE103/g) || []).length !== blocks.length) return text;
        out = restoreEjs(out, blocks);
        if (typeof out !== 'string') return text;
        /* 校验二：无残留占位符；校验三：<%|%> 计数与原文一致 */
        if (/\uE102\d+\uE103/.test(out)) return text;
        if (tagCount(out) !== tagsBefore) return text;
        return out;
    } catch (_) { return text; }
}

/* ---------------------------------------------------------------------------
 * 4.5 简体 -> 繁体（单字表）
 * 只收「简体一个写法、繁体另一个写法」的常用字，覆盖 GB2312 一级常用字；
 * 一对多的歧义字（发/复/尽/脏/划/丑/伙）按最常用写法取一个，够用不求全。
 * 表里没有的字原样保留——宁可不够繁，也不能乱改人家的正文。
 * ------------------------------------------------------------------------ */
const S2T_MAP = {
    '杀': '殺', '战': '戰', '门': '門', '问': '問', '这': '這', '个': '個', '说': '說', '时': '時', '会': '會', '来': '來',
    '为': '為', '与': '與', '对': '對', '开': '開', '关': '關', '无': '無', '边': '邊', '进': '進', '过': '過', '还': '還',
    '种': '種', '样': '樣', '么': '麼', '爱': '愛', '听': '聽', '见': '見', '觉': '覺', '认': '認', '识': '識', '记': '記',
    '讲': '講', '读': '讀', '写': '寫', '书': '書', '谈': '談', '请': '請', '谢': '謝', '让': '讓', '谁': '誰', '论': '論',
    '议': '議', '译': '譯', '试': '試', '证': '證', '验': '驗', '检': '檢', '学': '學', '习': '習', '练': '練', '变': '變',
    '决': '決', '冻': '凍', '凉': '涼', '净': '淨', '减': '減', '凑': '湊', '冲': '衝', '击': '擊', '动': '動', '势': '勢',
    '办': '辦', '务': '務', '劳': '勞', '劝': '勸', '胜': '勝', '险': '險', '难': '難', '车': '車', '马': '馬', '鸟': '鳥',
    '鱼': '魚', '龙': '龍', '龟': '龜', '鸡': '雞', '猪': '豬', '猫': '貓', '兽': '獸', '虫': '蟲', '虾': '蝦', '蚁': '蟻',
    '凤': '鳳', '鹤': '鶴', '鹰': '鷹', '鸭': '鴨', '鹅': '鵝', '鸽': '鴿', '驴': '驢', '骆': '駱', '驹': '駒', '骏': '駿',
    '户': '戶', '厨': '廚', '厦': '廈', '厂': '廠', '厅': '廳', '厕': '廁', '厢': '廂', '砖': '磚', '墙': '牆', '园': '園',
    '国': '國', '图': '圖', '团': '團', '圆': '圓', '围': '圍', '楼': '樓', '桥': '橋', '岛': '島', '峡': '峽', '岭': '嶺',
    '摊': '攤', '滩': '灘', '钱': '錢', '银': '銀', '铁': '鐵', '铜': '銅', '钢': '鋼', '锡': '錫', '铝': '鋁', '针': '針',
    '钟': '鐘', '锅': '鍋', '铺': '鋪', '药': '藥', '医': '醫', '军': '軍', '师': '師', '队': '隊', '员': '員', '农': '農',
    '业': '業', '产': '產', '财': '財', '货': '貨', '贵': '貴', '买': '買', '卖': '賣', '费': '費', '资': '資', '贸': '貿',
    '账': '賬', '贩': '販', '购': '購', '贷': '貸', '赏': '賞', '赔': '賠', '赚': '賺', '长': '長', '宽': '寬', '强': '強',
    '软': '軟', '轻': '輕', '迟': '遲', '远': '遠', '简': '簡', '复': '復', '杂': '雜', '乱': '亂', '脏': '臟', '苍': '蒼',
    '惨': '慘', '惭': '慚', '残': '殘', '灿': '燦', '蚕': '蠶', '罢': '罷', '摆': '擺', '败': '敗', '帮': '幫', '宝': '寶',
    '报': '報', '备': '備', '贝': '貝', '笔': '筆', '币': '幣', '标': '標', '宾': '賓', '并': '並', '补': '補', '参': '參',
    '仓': '倉', '舱': '艙', '层': '層', '搀': '攙', '谗': '讒', '缠': '纏', '偿': '償', '场': '場', '尝': '嘗', '彻': '徹',
    '尘': '塵', '陈': '陳', '衬': '襯', '称': '稱', '惩': '懲', '诚': '誠', '齿': '齒', '筹': '籌', '丑': '醜', '础': '礎',
    '处': '處', '触': '觸', '传': '傳', '疮': '瘡', '闯': '闖', '创': '創', '锤': '錘', '纯': '純', '词': '詞', '辞': '辭',
    '从': '從', '聪': '聰', '丛': '叢', '窜': '竄', '错': '錯', '达': '達', '带': '帶', '担': '擔', '单': '單', '胆': '膽',
    '弹': '彈', '当': '當', '挡': '擋', '党': '黨', '荡': '蕩', '导': '導', '灯': '燈', '邓': '鄧', '敌': '敵', '涤': '滌',
    '递': '遞', '缔': '締', '点': '點', '电': '電', '垫': '墊', '钓': '釣', '调': '調', '谍': '諜', '叠': '疊', '顶': '頂',
    '订': '訂', '东': '東', '斗': '鬥', '独': '獨', '赌': '賭', '镀': '鍍', '锻': '鍛', '断': '斷', '缎': '緞', '兑': '兌',
    '吨': '噸', '钝': '鈍', '夺': '奪', '堕': '墮', '尔': '爾', '饵': '餌', '贰': '貳', '发': '發', '罚': '罰', '阀': '閥',
    '矾': '礬', '烦': '煩', '范': '範', '饭': '飯', '访': '訪', '纺': '紡', '飞': '飛', '废': '廢', '纷': '紛', '坟': '墳',
    '奋': '奮', '愤': '憤', '丰': '豐', '风': '風', '疯': '瘋', '冯': '馮', '缝': '縫', '讽': '諷', '肤': '膚', '辐': '輻',
    '抚': '撫', '辅': '輔', '赋': '賦', '负': '負', '妇': '婦', '缚': '縛', '该': '該', '盖': '蓋', '赶': '趕', '冈': '岡',
    '刚': '剛', '岗': '崗', '纲': '綱', '镐': '鎬', '阁': '閣', '铬': '鉻', '给': '給', '巩': '鞏', '沟': '溝', '构': '構',
    '顾': '顧', '剐': '剮', '观': '觀', '馆': '館', '惯': '慣', '广': '廣', '规': '規', '归': '歸', '闺': '閨', '轨': '軌',
    '诡': '詭', '柜': '櫃', '刽': '劊', '辊': '輥', '滚': '滾', '骇': '駭', '汉': '漢', '号': '號', '阂': '閡', '贺': '賀',
    '横': '橫', '轰': '轟', '红': '紅', '壶': '壺', '护': '護', '沪': '滬', '华': '華', '画': '畫', '划': '劃', '话': '話',
    '怀': '懷', '坏': '壞', '欢': '歡', '环': '環', '缓': '緩', '换': '換', '唤': '喚', '痪': '瘓', '焕': '煥', '谎': '謊',
    '挥': '揮', '辉': '輝', '毁': '毀', '汇': '匯', '秽': '穢', '浑': '渾', '伙': '夥', '获': '獲', '祸': '禍', '机': '機',
    '积': '積', '饥': '飢', '讥': '譏', '绩': '績', '缉': '緝', '极': '極', '辑': '輯', '级': '級', '挤': '擠', '几': '幾',
    '剂': '劑', '济': '濟', '计': '計', '际': '際', '继': '繼', '纪': '紀', '夹': '夾', '颊': '頰', '贾': '賈', '钾': '鉀',
    '价': '價', '驾': '駕', '歼': '殲', '监': '監', '坚': '堅', '拣': '揀', '捡': '撿', '俭': '儉', '荐': '薦', '槛': '檻',
    '鉴': '鑒', '践': '踐', '贱': '賤', '键': '鍵', '舰': '艦', '剑': '劍', '饯': '餞', '浆': '漿', '桨': '槳', '奖': '獎',
    '酱': '醬', '胶': '膠', '浇': '澆', '骄': '驕', '娇': '嬌', '搅': '攪', '铰': '鉸', '矫': '矯', '侥': '僥', '脚': '腳',
    '饺': '餃', '缴': '繳', '绞': '絞', '轿': '轎', '较': '較', '阶': '階', '节': '節', '洁': '潔', '结': '結', '诫': '誡',
    '届': '屆', '紧': '緊', '谨': '謹', '晋': '晉', '烬': '燼', '尽': '盡', '劲': '勁', '荆': '荊', '茎': '莖', '经': '經',
    '颈': '頸', '镜': '鏡', '径': '徑', '竞': '競', '纠': '糾', '旧': '舊', '举': '舉', '据': '據', '锯': '鋸', '剧': '劇',
    '惧': '懼', '诀': '訣', '绝': '絕', '钧': '鈞', '凯': '凱', '颗': '顆', '壳': '殼', '课': '課', '垦': '墾', '恳': '懇',
    '库': '庫', '夸': '誇', '块': '塊', '侩': '儈', '矿': '礦', '亏': '虧', '岿': '巋', '窥': '窺', '馈': '饋', '溃': '潰',
    '扩': '擴', '阔': '闊', '蜡': '蠟', '腊': '臘', '赖': '賴', '兰': '蘭', '拦': '攔', '栏': '欄', '烂': '爛', '滥': '濫',
    '捞': '撈', '涝': '澇', '乐': '樂', '垒': '壘', '类': '類', '泪': '淚', '离': '離', '礼': '禮', '丽': '麗', '厉': '厲',
    '励': '勵', '历': '歷', '沥': '瀝', '隶': '隸', '俩': '倆', '连': '連', '联': '聯', '莲': '蓮', '怜': '憐', '炼': '煉',
    '粮': '糧', '两': '兩', '辆': '輛', '疗': '療', '辽': '遼', '缭': '繚', '猎': '獵', '临': '臨', '邻': '鄰', '鳞': '鱗',
    '龄': '齡', '铃': '鈴', '灵': '靈', '领': '領', '馏': '餾', '刘': '劉', '聋': '聾', '笼': '籠', '垄': '壟', '拢': '攏',
    '陇': '隴', '娄': '婁', '搂': '摟', '篓': '簍', '卢': '盧', '炉': '爐', '颅': '顱', '卤': '鹵', '虏': '虜', '鲁': '魯',
    '赂': '賂', '录': '錄', '陆': '陸', '吕': '呂', '侣': '侶', '屡': '屢', '缕': '縷', '虑': '慮', '滤': '濾', '绿': '綠',
    '峦': '巒', '挛': '攣', '孪': '孿', '滦': '灤', '抡': '掄', '轮': '輪', '伦': '倫', '仑': '侖', '沦': '淪', '纶': '綸',
    '萝': '蘿', '罗': '羅', '逻': '邏', '锣': '鑼', '箩': '籮', '骡': '騾', '络': '絡', '妈': '媽', '玛': '瑪', '码': '碼',
    '蚂': '螞', '骂': '罵', '吗': '嗎', '麦': '麥', '迈': '邁', '脉': '脈', '瞒': '瞞', '馒': '饅', '蛮': '蠻', '满': '滿',
    '谩': '謾', '锚': '錨', '镁': '鎂', '闷': '悶', '们': '們', '锰': '錳', '梦': '夢', '弥': '彌', '谜': '謎', '觅': '覓',
    '绵': '綿', '缅': '緬', '庙': '廟', '灭': '滅', '悯': '憫', '闽': '閩', '鸣': '鳴', '铭': '銘', '谬': '謬', '谋': '謀',
    '亩': '畝', '纳': '納', '钠': '鈉', '挠': '撓', '脑': '腦', '恼': '惱', '闹': '鬧', '馁': '餒', '拟': '擬', '酿': '釀',
    '聂': '聶', '镍': '鎳', '柠': '檸', '狞': '獰', '宁': '寧', '拧': '擰', '泞': '濘', '钮': '鈕', '纽': '紐', '脓': '膿',
    '浓': '濃', '疟': '瘧', '诺': '諾', '欧': '歐', '鸥': '鷗', '呕': '嘔', '沤': '漚', '盘': '盤', '庞': '龐', '喷': '噴',
    '鹏': '鵬', '骗': '騙', '飘': '飄', '贫': '貧', '频': '頻', '苹': '蘋', '凭': '憑', '评': '評', '泼': '潑', '颇': '頗',
    '扑': '撲', '仆': '僕', '朴': '樸', '谱': '譜', '栖': '棲', '凄': '淒', '脐': '臍', '齐': '齊', '骑': '騎', '岂': '豈',
    '启': '啟', '气': '氣', '弃': '棄', '讫': '訖', '牵': '牽', '钎': '釺', '铅': '鉛', '迁': '遷', '签': '簽', '谦': '謙',
    '钳': '鉗', '潜': '潛', '浅': '淺', '谴': '譴', '堑': '塹', '枪': '槍', '呛': '嗆', '蔷': '薔', '抢': '搶', '锹': '鍬',
    '侨': '僑', '翘': '翹', '窍': '竅', '窃': '竊', '钦': '欽', '亲': '親', '氢': '氫', '倾': '傾', '顷': '頃', '庆': '慶',
    '琼': '瓊', '穷': '窮', '趋': '趨', '区': '區', '躯': '軀', '驱': '驅', '龋': '齲', '颧': '顴', '权': '權', '鹊': '鵲',
    '确': '確', '饶': '饒', '扰': '擾', '绕': '繞', '热': '熱', '韧': '韌', '纫': '紉', '荣': '榮', '绒': '絨', '锐': '銳',
    '闰': '閏', '润': '潤', '洒': '灑', '萨': '薩', '鳃': '鰓', '赛': '賽', '伞': '傘', '丧': '喪', '骚': '騷', '扫': '掃',
    '涩': '澀', '纱': '紗', '筛': '篩', '晒': '曬', '闪': '閃', '陕': '陝', '赡': '贍', '缮': '繕', '伤': '傷', '烧': '燒',
    '绍': '紹', '赊': '賒', '摄': '攝', '慑': '懾', '设': '設', '绅': '紳', '审': '審', '婶': '嬸', '肾': '腎', '渗': '滲',
    '声': '聲', '绳': '繩', '圣': '聖', '狮': '獅', '湿': '濕', '诗': '詩', '尸': '屍', '蚀': '蝕', '实': '實', '驶': '駛',
    '适': '適', '释': '釋', '饰': '飾', '视': '視', '寿': '壽', '枢': '樞', '输': '輸', '赎': '贖', '属': '屬', '术': '術',
    '树': '樹', '竖': '豎', '数': '數', '帅': '帥', '双': '雙', '顺': '順', '硕': '碩', '烁': '爍', '丝': '絲', '饲': '飼',
    '耸': '聳', '怂': '慫', '颂': '頌', '讼': '訟', '诵': '誦', '擞': '擻', '苏': '蘇', '诉': '訴', '肃': '肅', '虽': '雖',
    '随': '隨', '绥': '綏', '岁': '歲', '孙': '孫', '损': '損', '笋': '筍', '缩': '縮', '琐': '瑣', '锁': '鎖', '獭': '獺',
    '挞': '撻', '贪': '貪', '瘫': '癱', '坛': '壇', '谭': '譚', '叹': '嘆', '汤': '湯', '烫': '燙', '涛': '濤', '绦': '絛',
    '讨': '討', '腾': '騰', '誊': '謄', '锑': '銻', '题': '題', '体': '體', '条': '條', '贴': '貼', '烃': '烴', '统': '統',
    '头': '頭', '涂': '塗', '颓': '頹', '蜕': '蛻', '脱': '脫', '鸵': '鴕', '驮': '馱', '驼': '駝', '椭': '橢', '洼': '窪',
    '袜': '襪', '弯': '彎', '湾': '灣', '顽': '頑', '万': '萬', '网': '網', '韦': '韋', '违': '違', '潍': '濰', '维': '維',
    '伟': '偉', '伪': '偽', '纬': '緯', '谓': '謂', '卫': '衛', '温': '溫', '闻': '聞', '纹': '紋', '稳': '穩', '瓮': '甕',
    '挝': '撾', '蜗': '蝸', '涡': '渦', '窝': '窩', '卧': '臥', '呜': '嗚', '钨': '鎢', '乌': '烏', '诬': '誣', '芜': '蕪',
    '吴': '吳', '坞': '塢', '雾': '霧', '误': '誤', '牺': '犧', '袭': '襲', '铣': '銑', '戏': '戲', '细': '細', '辖': '轄',
    '侠': '俠', '狭': '狹', '吓': '嚇', '锨': '鍁', '鲜': '鮮', '纤': '纖', '贤': '賢', '衔': '銜', '显': '顯', '现': '現',
    '献': '獻', '县': '縣', '馅': '餡', '羡': '羨', '宪': '憲', '线': '線', '镶': '鑲', '乡': '鄉', '详': '詳', '响': '響',
    '项': '項', '萧': '蕭', '销': '銷', '晓': '曉', '啸': '嘯', '蝎': '蠍', '协': '協', '挟': '挾', '携': '攜', '胁': '脅',
    '谐': '諧', '泻': '瀉', '锌': '鋅', '衅': '釁', '兴': '興', '汹': '洶', '锈': '鏽', '绣': '繡', '虚': '虛', '嘘': '噓',
    '须': '須', '许': '許', '绪': '緒', '续': '續', '轩': '軒', '悬': '懸', '选': '選', '癣': '癬', '勋': '勳', '询': '詢',
    '寻': '尋', '驯': '馴', '训': '訓', '讯': '訊', '逊': '遜', '压': '壓', '鸦': '鴉', '哑': '啞', '亚': '亞', '讶': '訝',
    '阉': '閹', '烟': '煙', '盐': '鹽', '严': '嚴', '颜': '顏', '阎': '閻', '艳': '艷', '厌': '厭', '砚': '硯', '彦': '彥',
    '谚': '諺', '鸯': '鴦', '杨': '楊', '扬': '揚', '疡': '瘍', '阳': '陽', '痒': '癢', '养': '養', '谣': '謠', '尧': '堯',
    '爷': '爺', '页': '頁', '叶': '葉', '铱': '銥', '颐': '頤', '遗': '遺', '仪': '儀', '义': '義', '诣': '詣', '艺': '藝',
    '亿': '億', '忆': '憶', '应': '應', '痈': '癰', '拥': '擁', '佣': '傭', '踊': '踴', '咏': '詠', '忧': '憂', '优': '優',
    '邮': '郵', '铀': '鈾', '犹': '猶', '游': '遊', '诱': '誘', '渔': '漁', '娱': '娛', '舆': '輿', '屿': '嶼', '语': '語',
    '吁': '籲', '狱': '獄', '誉': '譽', '预': '預', '驭': '馭', '鸳': '鴛', '辕': '轅', '缘': '緣', '愿': '願', '约': '約',
    '跃': '躍', '钥': '鑰', '岳': '嶽', '粤': '粵', '悦': '悅', '阅': '閱', '云': '雲', '郧': '鄖', '陨': '隕', '运': '運',
    '蕴': '蘊', '酝': '醞', '晕': '暈', '韵': '韻', '赃': '贓', '凿': '鑿', '枣': '棗', '责': '責', '择': '擇', '则': '則',
    '泽': '澤', '贼': '賊', '赠': '贈', '轧': '軋', '铡': '鍘', '闸': '閘', '诈': '詐', '斋': '齋', '债': '債', '毡': '氈',
    '盏': '盞', '斩': '斬', '辗': '輾', '崭': '嶄', '栈': '棧', '绽': '綻', '张': '張', '涨': '漲', '帐': '帳', '胀': '脹',
    '赵': '趙', '蛰': '蟄', '辙': '轍', '锗': '鍺', '贞': '貞', '侦': '偵', '诊': '診', '镇': '鎮', '阵': '陣', '挣': '掙',
    '睁': '睜', '狰': '猙', '争': '爭', '帧': '幀', '郑': '鄭', '织': '織', '职': '職', '执': '執', '纸': '紙', '挚': '摯',
    '掷': '擲', '帜': '幟', '质': '質', '滞': '滯', '终': '終', '肿': '腫', '众': '眾', '皱': '皺', '昼': '晝', '骤': '驟',
    '诸': '諸', '诛': '誅', '烛': '燭', '瞩': '矚', '嘱': '囑', '贮': '貯', '铸': '鑄', '筑': '築', '驻': '駐', '专': '專',
    '转': '轉', '桩': '樁', '庄': '莊', '装': '裝', '妆': '妝', '壮': '壯', '状': '狀', '锥': '錐', '坠': '墜', '缀': '綴',
    '谆': '諄', '浊': '濁', '兹': '茲', '渍': '漬', '综': '綜', '总': '總', '纵': '縱', '邹': '鄒', '诅': '詛', '组': '組',
    '钻': '鑽'
};

/* 键集/值集：charset 检测时用来分辨「简体特征字」和「繁体特征字」 */
let s2tKeySet = null;
let s2tValueSet = null;
function s2tSets() {
    if (!s2tKeySet) {
        s2tKeySet = new Set(Object.keys(S2T_MAP));
        s2tValueSet = new Set(Object.values(S2T_MAP));
    }
    return { keys: s2tKeySet, values: s2tValueSet };
}

/* 逐字替换：for...of 按码点走，代理对（emoji/生僻字）不会被切坏 */
function toTraditional(text) {
    try {
        if (!text || typeof text !== 'string') return text;
        let out = '';
        for (const ch of text) {
            const t = S2T_MAP[ch];
            out += (typeof t === 'string' && t) ? t : ch;
        }
        return out;
    } catch (_) { return text; }
}

/* charset 检测：在「简繁差异字」里数繁体特征字的占比，> 60% 就认为原文已是繁体。
   分母只算差异字，不算「的一是了」这类两边共用的字，短文本也判得准。 */
function looksTraditional(text) {
    try {
        if (!text || typeof text !== 'string') return false;
        const sets = s2tSets();
        let trad = 0;
        let simp = 0;
        for (const ch of text) {
            const isK = sets.keys.has(ch);
            const isV = sets.values.has(ch);
            if (isV && !isK) trad++;
            else if (isK && !isV) simp++;
        }
        if (!trad) return false;
        return trad / (trad + simp) > 0.6;
    } catch (_) { return false; }
}

function encodeText(text, s, map, detail) {
    if (!text || typeof text !== 'string') return { text, hits: 0 };
    /* 已有别家插件的 PUA 占位符：一律不动，原样返回（保持 {text,hits} 返回约定） */
    if (text && hasForeignPua(text)) return { text, hits: 0 };

    const vault = [];
    let work = text;

    /* 简->繁（all）：这里只登记模式，真正的转换挪到下面 stash 之后执行；
       原文本来就是繁体（繁体特征字 > 60%）就不再转，免得二次折腾 */
    let s2tHitWords = null;
    const s2tMode = (s && (s.s2tMode === 'all' || s.s2tMode === 'risky')) ? s.s2tMode : 'off';
    if (s2tMode === 'risky') s2tHitWords = new Set();

    try {
        /* EJS 无条件保护：<% ... %> 里的中文标识符和字符串，转繁或换词都会让模板失效。
           这条独立于 protectCode 开关，永远生效（protectCode=false 也要保护 EJS）。 */
        work = stash(work, /<%[\s\S]*?%>/g, vault);
        if (s.protectCode) {
            work = stash(work, /```[\s\S]*?```/g, vault);
            work = stash(work, /`[^`\n]+`/g, vault);
            /* 模板/插值整块保护：Handlebars、${} 里的字被改读音就废了 */
            work = stash(work, /\{\{[\s\S]*?\}\}/g, vault);
            work = stash(work, /\$\{[^{}]*\}/g, vault);
        }
        if (s.tagMode === 'protect') {
            work = stash(work, /<\/?[A-Za-z][^>\n]{0,120}>/g, vault);
        }
        for (const k of s.keepList) {
            if (!k) continue;
            const kre = keepRe(k);
            if (!kre) continue;
            work = stash(work, kre, vault);
        }
    } catch (_) { /* 保护失败就别保护了，继续筛 */ }

    /* s2t=all 真正执行点：必须在 EJS / 代码围栏都 stash 之后，
       否则 EJS 块内的中文标识符与字符串会被逐字转繁（EJS 破坏点 1）。
       looksTraditional 仍用原文判断——原文才没有 stash 占位符。
       失败时保留当前 work（已 stash 的文本），不能回退成 text，否则保护层全丢。 */
    if (s2tMode === 'all') {
        try {
            if (!looksTraditional(text)) work = toTraditional(work);
        } catch (_) { /* 转繁失败：保留已保护文本 */ }
    }

    /* 标记替换：放在代码块保护之后，避免改坏 `<think>` 这种示例代码。
       实测：<think> 会被模型判为黑名单词直接拒，<<<PLAN>>> 照单全收。 */
    if (s.markerMode) {
        work = work
            .replace(/<\s*\/\s*thinking\s*>/gi, '<<<END>>>')
            .replace(/<\s*thinking\s*>/gi, '<<<PLAN>>>')
            .replace(/<\s*\/\s*think\s*>/gi, '<<<END>>>')
            .replace(/<\s*think\s*>/gi, '<<<PLAN>>>');
    } else if (s.tagMode === 'rewrite') {
        /* 只有没用 marker 时才退回到改名方案，两者不要叠 */
        work = work.replace(/<(\/?)(?:think(?:ing)?)(\s*)>/gi, '<$1ponder$2>');
    }

    let hits = 0;

    /* 语义层：先整句叙事化，把"命令"变成"习惯"。
       跑完这一层，词表层多数规则会自然落空——因为关键词已经不在文本里了。 */
    if (s.mode === 'off') { /* 只做标签替换，不动一个字 */ }
    else if (s.mode === 'semantic') {
        for (const r of SEMANTIC) {
            try {
                const before = work;
                work = work.replace(r.re, r.to);
                if (work !== before) {
                    hits++;
                    if (detail && detail.length < 40) detail.push({ from: r.tag, to: '（叙事化）', rule: 'semantic', ctx: '' });
                }
            } catch (_) { /* 单条规则失败不影响其他 */ }
        }
    }

    /* 词表层：mode === 'off' 时整层跳过，一个字都不动 */
    /* 词表层：mode === 'off' 时整层跳过，一个字都不动 */
    const wordRules = s.mode === 'off' ? [] : rules();

    /* —— 单次扫描（patch2 合并优化）——
       原来：N 条规则 × 全文各 replace 一次 = O(规则数 × 文本长度)。
       现在：按 flags 把规则合成 1~2 条合并正则，全文只扫 1~2 遍；
       同位置命中时靠命名组反查是哪条规则，长词优先（BANK 已按长度倒序）。
       合并失败（极端正则/compat）自动退回逐条替换，行为不变。 */
    const applyHit = (rule, m, off, whole) => {
        const rep = pickAlt(rule, s);
        if (!rep) return m;
        const out = sameCase(m, rep);
        if (out === m) return m;
        hits++;
        if (s2tHitWords) s2tHitWords.add(out);
        if (map) map.set(out, m);
        if (detail && detail.length < 40) {
            const w = String(whole || '');
            const a = Math.max(0, (off || 0) - 12);
            detail.push({
                from: m, to: out, rule: rule.id || rule.tag || '',
                ctx: w.slice(a, (off || 0) + m.length + 12).replace(/\s+/g, ' ').trim(),
            });
        }
        return out;
    };

    if (wordRules.length) {
        if (ruleMatcherFor !== wordRules) {
            ruleMatcher = buildMatcher(wordRules);
            ruleMatcherFor = wordRules;
        }
    } else {
        ruleMatcher = null;
        ruleMatcherFor = null;
    }

    if (ruleMatcher) {
        for (const grp of ruleMatcher) {
            try {
                grp.re.lastIndex = 0;
                work = work.replace(grp.re, (m, ...rest) => {
                    /* 回调参数：p1..pn, offset, string, groups —— 必须从尾部取，
                       否则 off/whole 会拿到捕获组内容，detail 上下文全错 */
                    const named = rest.length ? rest[rest.length - 1] : null;
                    const off = rest.length >= 3 ? rest[rest.length - 3] : 0;
                    const whole = rest.length >= 3 ? rest[rest.length - 2] : '';
                    let rule = null;
                    if (named && typeof named === 'object') {
                        for (let i = 0; i < grp.rules.length; i++) {
                            if (named['r' + i] !== undefined) { rule = grp.rules[i]; break; }
                        }
                    }
                    if (!rule) return m;
                    return applyHit(rule, m, off, whole);
                });
            } catch (_) { /* 合并扫描炸了就只损失这一组，别把文本搞坏 */ }
        }
    } else {
        /* 退路：合并正则建不出来时，走原来的逐条替换 */
        for (const rule of wordRules) {
            try {
                rule.regex.lastIndex = 0;
                work = work.replace(rule.regex, (m, off, whole) => applyHit(rule, m, off, whole));
            } catch (_) { /* 单条规则炸了不影响其他 */ }
        }
    }

    work = unstash(work, vault);

    /* 残留自检：还原后还带着我们自己的 stash 占位符 = unstash 漏了，宁可整段退回原文 */
    if (STASH_RESIDUE_RE.test(work)) return { text, hits: 0 };

    /* 简->繁（risky）：只转这一轮被 BANK 命中并替换掉的词，原文其余部分一个字不碰。
       长词先转，免得短词把长词切碎；split/join 不走正则，词里的符号不会被当转义 */
    if (s2tHitWords && s2tHitWords.size) {
        const ws = [...s2tHitWords]
            .filter(w => typeof w === 'string' && w)
            .sort((a, b) => b.length - a.length);
        for (const w of ws) {
            try {
                const t = toTraditional(w);
                if (t !== w) work = work.split(w).join(t);
            } catch (_) { /* 单条失败不影响别的 */ }
        }
    }

    /* 结构整理层：词替换之后再过一遍句式降噪（签名/返回约定不变） */
    if (s && s.metaRewrite) work = applyMetaRewrite(work);

    return { text: work, hits };
}

/* ---------------------------------------------------------------------------
 * 5. 解码（输出侧）
 * ------------------------------------------------------------------------ */

let activeMap = new Map();
let decodeCache = null;
let decodeLower = new Map();
let decodeSig = '';                     /* patch3: 上次编译时的键集签名 */

function rebuildDecodeCache(force) {
    const keys = [...activeMap.keys()].filter(k => typeof k === 'string' && k.length >= 2);

    if (!keys.length) {
        decodeCache = null;
        decodeLower = new Map();
        decodeSig = '';
        return false;
    }

    keys.sort((a, b) => b.length - a.length);   /* 长词优先，防止短词抢先吃掉 */

    /* patch3: 签名 = 条数 + 排序后键集。字符串比较远比重编 600 路交替式便宜 */
    const sig = keys.length + '\u0001' + keys.join('\u0000');
    if (!force && decodeCache && sig === decodeSig) return false;

    decodeLower = new Map(keys.map(k => [k.toLowerCase(), k]));
    try {
        /* i 标志：模型把 ponder 写成 Ponder / PONDER 也能还原 */
        decodeCache = new RegExp(keys.map(escapeRe).join('|'), 'gi');
        decodeSig = sig;
    } catch (_) {
        decodeCache = null;
        decodeSig = '';
    }
    return true;
}

function decodeText(text) {
    if (!text || typeof text !== 'string') return text;

    /* 标记还原：这一步不依赖 activeMap，哪怕映射表被清空也要还原 */
    const s0 = cfg();
    if (s0 && s0.markerMode) {
        text = text
            .replace(/(^|[^<])<{2,3}\s*END\s*>{2,3}(?!>)/gi, '$1</think>')
            .replace(/(^|[^<])<{2,3}\s*PLAN\s*>{2,3}(?!>)/gi, '$1<think>');
    }

    if (!activeMap.size || !decodeCache) return text;
    return text.replace(decodeCache, (m) => {
        if (activeMap.has(m)) return activeMap.get(m);
        const canon = decodeLower.get(m.toLowerCase());
        return canon ? activeMap.get(canon) : m;
    });
}

/* ---------------------------------------------------------------------------
 * 6. 事件挂钩
 * ------------------------------------------------------------------------ */

let lastRequestAt = 0;

let lastRun = null;

/* 输出侧还原表硬上限。原来是散落的字面量 600，这里收成常量 */
const ACTIVE_MAP_CAP = 600;

/* 只做淘汰，不改插入。keepKeys 为本轮键集合（第一段豁免），可为 null。
   patch-evict: 单轮超过 cap 时，第一段全被 keepKeys 豁免，size 不会下降，
   必须靠第二段硬压；这里把它改成「按 Map 迭代顺序边遍历边删」，删除必然生效。 */
function evictActiveMap(activeMap, keepKeys, cap) {
    cap = cap || ACTIVE_MAP_CAP;
    if (!activeMap || activeMap.size <= cap) return 0;
    let dropped = 0;
    for (const k of [...activeMap.keys()]) {          /* 第一段：历史轮最旧先走 */
        if (activeMap.size <= cap) break;
        if (keepKeys && keepKeys.has(k)) continue;    /* 本轮键优先保留 */
        activeMap.delete(k); dropped++;
    }
    if (activeMap.size > cap) {                       /* 第二段：单轮超限也硬压 */
        let excess = activeMap.size - cap;
        for (const k of activeMap.keys()) {           /* 边遍历边删，迭代器自动前进 */
            if (excess <= 0) break;
            if (activeMap.delete(k)) { dropped++; excess--; }
        }
    }
    return dropped;
}

/* 合并本轮 map 进 activeMap，并保证 size <= cap。返回 {merged, dropped} */
function mergeActiveMap(activeMap, map, cap) {
    cap = cap || ACTIVE_MAP_CAP;
    if (!map || !map.size) return { merged: 0, dropped: 0 };
    /* patch-evict: 单轮自身就超限时先截断本轮，别把整轮灌进去再淘汰 */
    let src = map, over = 0;
    if (map.size > cap) {
        src = new Map([...map.entries()].slice(-cap));  /* 保留本轮最后 cap 条 */
        over = map.size - src.size;
    }
    for (const k of src.keys()) activeMap.delete(k);    /* 先删后插：本轮排到队尾 */
    for (const [k, v] of src) activeMap.set(k, v);
    return { merged: src.size, dropped: over + evictActiveMap(activeMap, src, cap) };
}

function onPromptReady(data) {
    try {
    const s = cfg();
    if (!s || !s.enabled) return;
    const chat = data && data.chat;
    if (!Array.isArray(chat) || !chat.length) return;

    /* 找最后一条 user 消息，用于区分「当前输入」和「历史」 */
    let lastUser = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (chat[i] && chat[i].role === 'user') { lastUser = i; break; }
    }

    const map = new Map();
    const detail = [];
    let hits = 0;
    let touchedMsgs = 0;
    let reflowed = false;

    for (let i = 0; i < chat.length; i++) {
        const m = chat[i];
        if (!m || typeof m !== 'object') continue;
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) continue;

        const role = m.role;
        const isSystem = role === 'system' || role === 'developer';
        if (isSystem) {
            if (!s.scope.system) continue;
        } else if (i === lastUser) {
            if (!s.scope.user) continue;
        } else {
            if (!s.scope.history) continue;
        }

        if (typeof m.content === 'string') {
            let r = encodeText(m.content, s, map, detail);
            /* 阅卷层只对第一条 system 做一次——历史消息千万别重排 */
            if (s.reflow && isSystem && !reflowed && r.text.length > (s.reflowMin || 6000)) {
                const before = r.text;
                r = { text: reflow(before, s), hits: r.hits };
                if (r.text !== before) { reflowed = true; if (detail.length < 40) detail.push({ from: '阅卷层', to: '重排+垫料', rule: 'reflow', ctx: '' }); }
            }
            if (r.text !== m.content) { m.content = r.text; hits += r.hits; touchedMsgs++; }
        } else if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part && typeof part.text === 'string') {
                    let r = encodeText(part.text, s, map, detail);
                    if (s.reflow && isSystem && !reflowed && r.text.length > (s.reflowMin || 6000)) {
                        const before = r.text;
                        r = { text: reflow(before, s), hits: r.hits };
                        if (r.text !== before) { reflowed = true; if (detail.length < 40) detail.push({ from: '阅卷层', to: '重排+垫料', rule: 'reflow', ctx: '' }); }
                    }
                    if (r.text !== part.text) { part.text = r.text; hits += r.hits; touchedMsgs++; }
                }
            }
        }
    }

    /* 结构标记层：词替换之后套段标（幂等，重复跑不会套第二层） */
    if (s.ctxTags) applyCtxTags(chat);

    /* 输出侧还原表：合并而不是覆盖 —— 总结/quiet 这类旁路请求会重复触发这里，
       用覆盖法会把主生成的映射顶掉，还原就错位了 */
    let evicted = 0;
    if (s.decodeOutput && map.size) {
        evicted = mergeActiveMap(activeMap, map, ACTIVE_MAP_CAP).dropped;
        rebuildDecodeCache();
    }

    /* 调试：事件通道本轮实际发送的 chat 预览 */
    globalThis.__mugaLastSent2 = buildSentPreview(chat);

    lastRun = {
        at: Date.now(),
        hits,
        touched: touchedMsgs,
        words: map.size,
        active: activeMap.size,   /* 还原表现状 */
        evicted,
        detail: detail.slice(0, 40),
    };

    renderStudio();

    if (hits > 0) {
        s.stats.lastHits = hits;
        s.stats.totalHits = (s.stats.totalHits || 0) + hits;
        s.stats.lastAt = Date.now();
        s.stats.lastDetail = detail.slice(0, 10);
        s.stats.lastRequestWords = touchedMsgs;
        lastRequestAt = Date.now();
        save();
        renderStats();
    }
    } catch (err) {
        console.warn(LOG, 'onPromptReady 处理失败（已跳过本轮改造）', err);
    }
}

function decodeMessageAt(id) {
    const c = getCtx();
    const s = cfg();
    if (!c || !s || !s.enabled || !s.decodeOutput) return;
    /* 只开标记替换时映射表是空的，但标记仍要还原 */
    if (!activeMap.size && !s.markerMode) return;
    const msg = c.chat?.[id];
    if (!msg) return;

    let dirty = false;

    if (typeof msg.mes === 'string') {
        const out = decodeText(msg.mes);
        if (out !== msg.mes) { msg.mes = out; dirty = true; }
    }
    const reasoning = msg.extra && msg.extra.reasoning;
    if (typeof reasoning === 'string') {
        const out = decodeText(reasoning);
        if (out !== reasoning) { msg.extra.reasoning = out; dirty = true; }
    }

    /* 各个滑动页：不一起还原的话，切页会重新看到 <<<PLAN>>> */
    if (Array.isArray(msg.swipes)) {
        for (let i = 0; i < msg.swipes.length; i++) {
            const t = msg.swipes[i];
            if (typeof t !== 'string') continue;
            const out = decodeText(t);
            if (out !== t) { msg.swipes[i] = out; dirty = true; }
        }
    }
    if (Array.isArray(msg.swipe_info)) {
        for (const it of msg.swipe_info) {
            const r = it && it.extra && it.extra.reasoning;
            if (typeof r !== 'string') continue;
            const out = decodeText(r);
            if (out !== r) { it.extra.reasoning = out; dirty = true; }
        }
    }

    if (dirty) {
        try { c.updateMessageBlock?.(id); } catch (_) { /* ignore */ }
        try { c.saveChat?.(); } catch (_) { /* ignore */ }
    }
}

function onMessageReceived(id) {
    const n = typeof id === 'string' && /^\d+$/.test(id) ? Number(id) : id;
    if (typeof n !== 'number' || !Number.isFinite(n)) return;
    decodeMessageAt(n);
}

let pendingIndex = -1;

function onGenerationStarted() {
    /* 开工前快照：新消息将会落在 chat.length 这个下标上
       （结束时再用 chat.length-1 去猜，swipe / 切聊天时会解码到隔壁消息） */
    const c = getCtx();
    pendingIndex = Array.isArray(c?.chat) ? c.chat.length : -1;
}

/* 2.0 判卷：回来之后，这一轮值不值 */
function judgeText(text) {
    const t = String(text || '').trim();
    if (!t) return { state: 'empty', text: '这轮没写出东西' };

    // 先剥离 think 标签，再算正文字数
    const thinkRe = /<think(?:ing)?[^>]*>[\s\S]*?<\/think(?:ing)?>/gi;
    const bodyText = t.replace(thinkRe, '');
    const bodyLen = bodyText.trim().length;
    const thinkLen = t.length - bodyText.length;

    if (thinkLen > 0 && bodyLen < 40) return { state: 'shell', text: '只有思考壳' };
    if (/^(抱歉|对不起|很抱歉|我无法|我不能|I can'?t|I cannot|I'?m sorry)/i.test(t.slice(0, 24))) {
        return { state: 'refuse', text: '这轮被拒了' };
    }
    if (bodyLen < 40) return { state: 'short', text: '只写了几个字' };
    return { state: 'ok', text: '这轮正常 · ' + t.length + ' 字' };
}

function judgeLastReply() {
    const c = getCtx();
    const chat = c?.chat;
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_user || m.is_system) continue;
        return judgeText(m.mes);
    }
    return null;
}

let lastVerdict = null;

function renderVerdict() {
    const box = $el('msv_verdict');
    const lamp = $el('msv_lamp');
    const v = lastVerdict;
    if (box) {
        const txt = v ? v.text : '还没生成过';
        box.textContent = txt;
        box.title = txt;
        box.setAttribute('data-state', v ? v.state : 'idle');
    }
    if (lamp) lamp.setAttribute('data-state', v ? v.state : 'idle');
}

function onGenerationEnded() {
    /* 流式时 MESSAGE_RECEIVED 不会触发，这里兜底；延后一点点让 saveReply 落定 */
    setTimeout(() => {
        try {
            const c = getCtx();
            const len = c?.chat?.length || 0;
            let idx = -1;
            if (pendingIndex >= 0 && pendingIndex < len) idx = pendingIndex;   /* 新消息 */
            else if (len > 0) idx = len - 1;                                  /* regenerate */
            pendingIndex = -1;
            if (idx >= 0) decodeMessageAt(idx);
            lastVerdict = judgeLastReply();
            renderVerdict();
        } catch (err) {
            pendingIndex = -1;
            console.warn(LOG, 'onGenerationEnded 判卷失败（已跳过本轮判卷）', err);
        }
    }, 160);
}

/* ---------------------------------------------------------------------------
 * 7. UI
 * ------------------------------------------------------------------------ */

const $el = (id) => document.getElementById(id);

/* ---------------------------------------------------------------------------
 * 2.0 正文区 + 抽屉：这一轮到底改了什么
 * ------------------------------------------------------------------------ */
/* ---------------------------------------------------------------------------
 * 2.0 方案条：三套内置配方，点了就换
 * 老武器仍然可用，这里只是快捷方式，不改底层
 * ------------------------------------------------------------------------ */
const RECIPES = [
    {
        id: 'light', name: '轻甲', note: '只换标签',
        apply: { markerMode: true, mode: 'off', reflow: false, intensity: 1 },
    },
    {
        id: 'heavy', name: '重甲', note: '标记 + 谐音 + 重排',
        apply: { markerMode: true, mode: 'homophone', reflow: true, intensity: 2 },
    },
    {
        id: 'scorch', name: '焦土', note: '标记 + 拼音 + 重排',
        apply: { markerMode: true, mode: 'pinyin', reflow: true, intensity: 3 },
    },
];

function currentRecipeId(s) {
    if (!s) return '';
    for (const r of RECIPES) {
        const a = r.apply;
        if (s.markerMode === a.markerMode && s.mode === a.mode
            && !!s.reflow === !!a.reflow && Number(s.intensity) === Number(a.intensity)) {
            return r.id;
        }
    }
    return '';
}

function renderRecipes() {
    if (typeof document === 'undefined') return;
    const box = $el('msv_recipes');
    if (!box) return;
    const s = cfg();
    if (!s) return;
    const cur = currentRecipeId(s);
    box.innerHTML = RECIPES.map(function (r) {
        const on = r.id === cur ? ' is-on' : '';
        return '<button class="msv-chip' + on + '" type="button" data-recipe="' + r.id + '">'
            + '<span class="msv-chip-name">' + escHtml(r.name) + '</span>'
            + '<span class="msv-chip-note">' + escHtml(r.note) + '</span>'
            + '</button>';
    }).join('');
}

function applyRecipe(id) {
    const r = RECIPES.find(function (x) { return x.id === id; });
    const s = cfg();
    if (!r || !s) return;
    s.markerMode = r.apply.markerMode;
    s.mode = r.apply.mode;
    s.reflow = r.apply.reflow;
    s.intensity = r.apply.intensity;
    ruleCache = null;
    save();
    syncUI();
    renderRecipes();
    renderStats();
}

function escHtml(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
        return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
}

function renderStudio() {
    if (typeof document === 'undefined') return;   /* 纯 Node 测试环境没有 DOM */
    const body = $el('msv_studio_body');
    const count = $el('msv_studio_count');
    if (!body) return;

    if (!lastRun) {
        body.innerHTML = '<div class="msv-empty">这轮还没跑</div>';
        if (count) count.textContent = '还没跑过';
        return;
    }
    if (!lastRun.detail.length) {
        body.innerHTML = '<div class="msv-empty">这轮干净，没有要改的地方</div>';
        if (count) count.textContent = '0 处';
        return;
    }

    if (count) count.textContent = lastRun.hits + ' 处 · ' + lastRun.words + ' 词';
    body.innerHTML = lastRun.detail.map(function (d, i) {
        return '<button class="msv-hit" type="button" data-i="' + i + '">'
            + '<span class="msv-hit-pair"><span class="msv-hit-from">' + escHtml(d.from) + '</span>'
            + '<span class="msv-hit-arrow">→</span>'
            + '<span class="msv-hit-to">' + escHtml(d.to) + '</span></span>'
            + '<span class="msv-hit-rule">' + escHtml(d.rule || '') + '</span>'
            + '</button>';
    }).join('');

    body.querySelectorAll('.msv-hit').forEach(function (b) {
        b.addEventListener('click', function () { openDrawer(Number(b.dataset.i)); });
    });
}

function openDrawer(i) {
    const d = lastRun && lastRun.detail[i];
    const box = $el('msv_drawer_body');
    const dr = $el('msv_drawer');
    if (!d || !box || !dr) return;

    box.innerHTML = ''
        + '<div class="msv-dl">这一处</div>'
        + '<div class="msv-dv msv-dv-ctx">' + escHtml(d.ctx || d.from) + '</div>'
        + '<div class="msv-dl">换成了</div>'
        + '<div class="msv-dv msv-dv-to">' + escHtml(d.to) + '</div>'
        + '<div class="msv-dl">哪条规则</div>'
        + '<div class="msv-dv">' + escHtml(d.rule || '—') + '</div>';

    dr.hidden = false;
    try { dr.querySelector('.msv-drawer-panel').focus(); } catch (_) { /* ignore */ }
}

function closeDrawer() {
    const dr = $el('msv_drawer');
    if (dr) dr.hidden = true;
}

function buildUI() {
    const host = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!host) { console.warn(LOG, '找不到扩展设置容器'); return; }

    const wrap = document.createElement('div');
    wrap.className = 'inline-drawer';
    wrap.innerHTML = `
<div class="inline-drawer-toggle inline-drawer-header">
    <b>无我梦中 · Muga Muchū</b>
    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
</div>
<div class="inline-drawer-content">
<div class="msv-panel">

    <div class="msv-head">
        <div class="msv-topbar">
            <div class="msv-seal" id="msv_theme" role="button" tabindex="0" title="夜 / 火">夜</div>
            <span class="msv-title">无我梦中 <span class="msv-ver">v${VERSION}</span></span>
            <span class="msv-lamp" id="msv_lamp" data-state="idle" title="这轮结果"></span>
        </div>
        <div class="msv-verdict" id="msv_verdict" data-state="idle" title="还没生成过">还没生成过</div>
        <div class="msv-sub"><span class="msv-sub-title">無我夢中 · 阿鼻叫喚</span><br><span class="msv-sub-line">让厚甲的 AI 在无我之梦里，周遭尽是阿鼻叫唤。</span><br><span class="msv-sub-sign">只改形，不改神 · by 哈基米三十一世</span></div>
    </div>

    <details class="msv-fold" open>
        <summary class="msv-fold-head"><span class="msv-fold-tri"></span><span class="msv-fold-title">强度</span></summary>
        <div class="msv-fold-body">

            <div class="msv-row">
                <span class="msv-label">替换方式</span>
                <select id="msv_mode">
                    <option value="off">只换标签（推荐）</option>
                    <option value="semantic">语义改写（会改正文）</option>
                    <option value="mix">混合 · 谐音+拼音</option>
                    <option value="homophone">谐音字（思烤）</option>
                    <option value="pinyin">拼音（si kao）</option>
                </select>
            </div>

            <div class="msv-row">
                <span class="msv-label">强度</span>
                <select id="msv_intensity">
                    <option value="1">轻 · 只碰强特征词</option>
                    <option value="2">中 · 常规（推荐）</option>
                    <option value="3">重 · 含弱词，会改味道</option>
                </select>
            </div>

            <div class="msv-row">
                <span class="msv-label">垫料稀释</span>
                <select id="msv_dilute">
                    <option value="0">关</option>
                    <option value="0.2">轻度</option>
                    <option value="0.35">中度（推荐）</option>
                    <option value="0.5">重度</option>
                    <option value="0.7">极重</option>
                </select>
            </div>

            <div class="msv-grid">
                <label class="msv-check"><input type="checkbox" id="msv_marker"> 标记替换</label>
                <label class="msv-check"><input type="checkbox" id="msv_reflow"> 阅卷层</label>
                <label class="msv-check"><input type="checkbox" id="msv_nsfw"> NSFW 词包</label>
                <span class="msv-warn" id="msv_nsfw_hint">（模板级，自己调）</span>
            </div>

        </div>
    </details>

    <details class="msv-fold">
        <summary class="msv-fold-head"><span class="msv-fold-tri"></span><span class="msv-fold-title">外观</span></summary>
        <div class="msv-fold-body">

            <div class="msv-row">
                <span class="msv-label">XML 标签</span>
                <select id="msv_tagmode">
                    <option value="rewrite">&lt;thinking&gt; 一起换</option>
                    <option value="protect">标签原样保护</option>
                </select>
            </div>

            <div class="msv-row">
                <span class="msv-label">简繁</span>
                <select id="msv_s2t">
                    <option value="off">不转换</option>
                    <option value="all">全文转繁</option>
                    <option value="risky">只转高危词</option>
                </select>
            </div>

            <div class="msv-grid">
                <label class="msv-check"><input type="checkbox" id="msv_code"> 保护代码块</label>
            </div>

        </div>
    </details>

    <details class="msv-fold">
        <summary class="msv-fold-head"><span class="msv-fold-tri"></span><span class="msv-fold-title">结果</span></summary>
        <div class="msv-fold-body">

            <div class="msv-grid">
                <label class="msv-check"><input type="checkbox" id="msv_enabled"> 启用筛选</label>
                <label class="msv-check"><input type="checkbox" id="msv_decode"> 输出还原</label>
            </div>

            <div class="msv-section">作用范围</div>
            <div class="msv-grid">
                <label class="msv-check"><input type="checkbox" id="msv_scope_system"> 预设 / 系统提示</label>
                <label class="msv-check"><input type="checkbox" id="msv_scope_history"> 对话历史</label>
                <label class="msv-check"><input type="checkbox" id="msv_scope_user"> 当前输入</label>
            </div>

            <div class="msv-row">
                <span class="msv-label">保留词</span>
                <input type="text" id="msv_keep" placeholder="逗号分隔，例：思想,意识">
            </div>

            <div class="msv-row">
                <span class="msv-label">盐</span>
                <input type="text" id="msv_salt" placeholder="meow">
                <button id="msv_reroll" class="menu_button" title="换一批谐音">🎲</button>
            </div>

        </div>
    </details>

    <details class="msv-fold">
        <summary class="msv-fold-head"><span class="msv-fold-tri"></span><span class="msv-fold-title">方案与规则</span></summary>
        <div class="msv-fold-body">

            <div class="msv-recipes" id="msv_recipes"></div>

            <div class="msv-section">自定义规则</div>
            <div id="msv_rules"></div>
            <div class="msv-row">
                <input type="text" id="msv_from" placeholder="原词">
                <span class="msv-arrow">→</span>
                <input type="text" id="msv_to" placeholder="替换为">
                <button id="msv_add" class="menu_button">加</button>
            </div>

        </div>
    </details>

    <details class="msv-fold">
        <summary class="msv-fold-head"><span class="msv-fold-tri"></span><span class="msv-fold-title">其他</span></summary>
        <div class="msv-fold-body">

            <div class="msv-section">神谕终端 · 双蛇杖</div>
            <div id="msv_weapons" class="msv-weapons"></div>
            <div id="msv_weapon_line" class="msv-wline">与任何武器相比，我都更擅长、更喜好使用镰刀。</div>

            <div class="msv-section">测试台</div>
            <textarea id="msv_test_in" rows="3" placeholder="粘一段预设，看看会被筛成什么样"></textarea>
            <div class="msv-row">
                <button id="msv_test" class="menu_button">试筛</button>
                <button id="msv_scan" class="menu_button">扫当前聊天</button>
                <button id="msv_copymap" class="menu_button">复制映射</button>
            </div>
            <pre id="msv_test_out"></pre>

            <div class="msv-section">更新</div>
            <div class="msv-update">
                <div class="msv-update-row">
                    <span class="msv-update-cur">当前 v${VERSION}</span>
                    <button id="msv_check_update" class="menu_button">检查更新</button>
                </div>
                <div id="msv_update_msg" class="msv-update-msg">不会自动覆盖，动手前会再问你一次。</div>
                <div class="msv-update-row" id="msv_update_actions" style="display:none">
                    <button id="msv_do_update" class="menu_button">更新到最新版本</button>
                    <a id="msv_update_link" class="menu_button" target="_blank" rel="noopener noreferrer">打开发布页</a>
                </div>
            </div>

            <div class="msv-section">发送预览</div>
            <div class="msv-row">
                <button id="msv_show_sent" class="menu_button">查看上次发送</button>
                <button id="msv_copy_sent" class="menu_button">复制</button>
            </div>
            <pre id="msv_sent_preview" style="display:none"></pre>

        </div>
    </details>

    <div class="msv-studio">
        <div class="msv-studio-head">
            <span class="msv-studio-title">正文区</span>
            <span class="msv-studio-count" id="msv_studio_count">还没跑过</span>
        </div>
        <div class="msv-studio-body" id="msv_studio_body"></div>
    </div>

    <div class="msv-section">统计</div>
    <div id="msv_stats" class="msv-stats"></div>

    <div class="msv-drawer" id="msv_drawer" hidden>
        <div class="msv-drawer-mask" id="msv_drawer_mask"></div>
        <div class="msv-drawer-panel" tabindex="-1">
            <div class="msv-drawer-head">
                <span>这一处</span>
                <button class="msv-drawer-x" id="msv_drawer_close" type="button" aria-label="关闭">×</button>
            </div>
            <div class="msv-drawer-body" id="msv_drawer_body"></div>
        </div>
    </div>

</div>
</div></div>`;

    host.appendChild(wrap);
    bindUI();
    applyTheme();
    syncUI();
    renderRules();
    renderWeapons();
    renderStats();
    renderVerdict();
    renderStudio();
    renderRecipes();
}

function bindUI() {
    if (bindUI.bound) return;
    const s = cfg();
    if (!s) {
        if (!bindUI.retries) bindUI.retries = 0;
        if (bindUI.retries < 5) {
            bindUI.retries++;
            setTimeout(bindUI, 300);
            return;
        }
        console.warn(LOG, 'bindUI 放弃：cfg() 始终为空');
        return;
    }
    bindUI.retries = 0;
    bindUI.bound = true;

    const on = (id, ev, fn) => {
        const el = $el(id);
        if (el) el.addEventListener(ev, fn);
    };

    /* 方案条：点了就换 */
    const recipeBox = $el('msv_recipes');
    if (recipeBox) {
        recipeBox.addEventListener('click', (ev) => {
            const btn = ev.target.closest('.msv-chip');
            if (btn) applyRecipe(btn.dataset.recipe);
        });
    }

    /* 抽屉 */
    on('msv_drawer_close', 'click', closeDrawer);
    on('msv_drawer_mask', 'click', closeDrawer);
    if (!bindUI.escBound) {
        const escHandler = (ev) => { if (ev.key === 'Escape') closeDrawer(); };
        document.addEventListener('keydown', escHandler);
        bindUI.escBound = true;
    }

    /* 折叠头：阻止冒泡到外层 inline-drawer */
    document.querySelectorAll('.msv-fold-head').forEach(head => {
        head.addEventListener('click', (ev) => ev.stopPropagation());
    });

    /* 主题印章：夜 ↔ 火 */
    const sealEl = $el('msv_theme');
    if (sealEl) {
        const flipTheme = () => {
            const cur = resolveTheme(s);
            s.theme = cur === 'fire' ? 'night' : 'fire';
            save();
            applyTheme();
        };
        sealEl.addEventListener('click', flipTheme);
        sealEl.addEventListener('keydown', (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); flipTheme(); }
        });
    }

    /* 总开关：改完立刻回写，出错就回滚 */
    on('msv_enabled', 'change', (e) => { s.enabled = !!e.target.checked; save(); renderStats(); });
    on('msv_decode', 'change', (e) => { s.decodeOutput = !!e.target.checked; save(); });
    on('msv_mode', 'change', (e) => { s.mode = e.target.value; save(); ruleCache = null; renderStats(); });
    on('msv_intensity', 'change', (e) => { s.intensity = Number(e.target.value) || 2; save(); ruleCache = null; renderStats(); });
    on('msv_dilute', 'change', (e) => { const v = Number(e.target.value); s.reflowDilute = v > 0; s.reflowRatio = v > 0 ? v : 0.35; save(); ruleCache = null; renderStats(); });
    on('msv_tagmode', 'change', (e) => { s.tagMode = e.target.value; save(); renderStats(); });
    on('msv_s2t', 'change', (e) => { s.s2tMode = e.target.value; save(); ruleCache = null; renderStats(); });
    on('msv_scope_system', 'change', (e) => { s.scope.system = !!e.target.checked; save(); });
    on('msv_scope_history', 'change', (e) => { s.scope.history = !!e.target.checked; save(); });
    on('msv_scope_user', 'change', (e) => { s.scope.user = !!e.target.checked; save(); });
    on('msv_code', 'change', (e) => { s.protectCode = !!e.target.checked; save(); });
    on('msv_nsfw', 'change', (e) => { s.nsfwPack = !!e.target.checked; save(); ruleCache = null; renderStats(); });
    on('msv_marker', 'change', (e) => { s.markerMode = !!e.target.checked; save(); renderStats(); });
    on('msv_reflow', 'change', (e) => { s.reflow = !!e.target.checked; save(); renderStats(); });

    on('msv_keep', 'input', (e) => {
        /* 只按逗号拆：空格留给 chain of thought 这类多词短语 */
        s.keepList = String(e.target.value || '')
            .split(/[,，]+/)
            .map(x => x.trim())
            .filter(Boolean);
        save();
        ruleCache = null;
    });

    on('msv_salt', 'input', (e) => {
        s.salt = String(e.target.value || '').trim() || 'meow';
        save();
        ruleCache = null;
    });

    on('msv_reroll', 'click', () => {
        s.salt = Math.random().toString(36).slice(2, 8);
        const el = $el('msv_salt');
        if (el) el.value = s.salt;
        save();
        ruleCache = null;
        renderStats();
        try { toastr?.info?.(`盐换成 ${s.salt}，同一批词会换出另一批谐音喵`); } catch (_) { /* ignore */ }
    });

    on('msv_add', 'click', () => {
        const f = $el('msv_from');
        const t = $el('msv_to');
        const from = String(f?.value || '').trim();
        const to = String(t?.value || '').trim();
        if (!from || !to) return;
        s.customRules.push({ from, to, enabled: true });
        if (f) f.value = '';
        if (t) t.value = '';
        save();
        ruleCache = null;
        renderRules();
    });

    on('msv_test', 'click', () => {
        const s2 = cfg();
        const text = String($el('msv_test_in')?.value || '');
        if (!text) return;
        const map = new Map();
        const detail = [];
        const r = encodeText(text, s2, map, detail);
        const out = $el('msv_test_out');
        if (!out) return;
        out.style.display = 'block';
        out.textContent = r.hits
            ? `—— 筛后 ——\n${r.text}\n\n—— 命中 ${r.hits} 处 ——\n` +
              detail.map(d => `${d.from} → ${d.to}`).join('\n')
            : `—— 没命中任何词 ——\n（当前强度：${s2.intensity}，方式：${s2.mode}）`;
    });

    on('msv_scan', 'click', () => {
        const c = getCtx();
        const s2 = cfg();
        if (!c || !s2) return;
        const map = new Map();
        const detail = [];
        let total = 0;
        let msgs = 0;
        for (const m of (c.chat || [])) {
            if (typeof m?.mes === 'string' && m.mes) {
                const r = encodeText(m.mes, s2, map, detail);
                if (r.hits) { total += r.hits; msgs++; }
            }
        }
        const out = $el('msv_test_out');
        if (!out) return;
        out.style.display = 'block';
        out.textContent = total
            ? `—— 当前聊天会命中 ${total} 处，涉及 ${msgs} 条消息 ——\n` +
              detail.map(d => `${d.from} → ${d.to}`).join('\n')
            : '—— 当前聊天里没有命中词 ——';
    });

    on('msv_check_update', 'click', checkUpdate);
    on('msv_do_update', 'click', doUpdate);

    on('msv_copymap', 'click', async () => {
        const lines = [...activeMap.entries()].map(([k, v]) => `${k} → ${v}`);
        if (!lines.length) { try { toastr?.info?.('上一次请求没有触发替换喵'); } catch (_) { /* ignore */ } return; }
        try {
            await navigator.clipboard.writeText(lines.join('\n'));
            toastr?.success?.(`复制了 ${lines.length} 条映射喵`);
        } catch (_) { /* ignore */ }
    });

    on('msv_show_sent', 'click', () => {
        const out = $el('msv_sent_preview');
        if (!out) return;
        const a = globalThis.__mugaLastSent;
        const b = globalThis.__mugaLastSent2;
        if (!a && !b) {
            out.style.display = 'block';
            out.textContent = '本轮没拦截到请求';
            return;
        }
        const parts = [];
        parts.push('—— fetch 通道（改写后实际发送的 messages）——\n' + (a || '本轮没拦截到请求'));
        parts.push('—— 事件通道（onPromptReady 拿到的 chat）——\n' + (b || '本轮没拦截到请求'));
        out.style.display = 'block';
        out.textContent = parts.join('\n\n');
    });

    const buildSentText = () => {
        const a = globalThis.__mugaLastSent;
        const b = globalThis.__mugaLastSent2;
        const parts = [];
        parts.push('—— fetch 通道（改写后实际发送的 messages）——\n' + (a || '本轮没拦截到请求'));
        parts.push('—— 事件通道（onPromptReady 拿到的 chat）——\n' + (b || '本轮没拦截到请求'));
        return parts.join('\n\n');
    };

    on('msv_copy_sent', 'click', async () => {
        const a = globalThis.__mugaLastSent;
        const b = globalThis.__mugaLastSent2;
        if (!a && !b) {
            try { toastr?.warning?.('本轮没拦截到请求，没东西可复制喵'); } catch (_) { /* ignore */ }
            return;
        }
        const text = buildSentText();
        let ok = false;
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch (_) {
            ok = false;
        }
        if (!ok) {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.top = '-1000px';
                ta.style.left = '-1000px';
                ta.style.opacity = '0';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                ta.setSelectionRange(0, ta.value.length);
                ok = document.execCommand('copy');
                document.body.removeChild(ta);
            } catch (_) {
                ok = false;
            }
        }
        try {
            if (ok) toastr?.success?.('已复制 ' + text.length + ' 字');
            else toastr?.warning?.('复制失败，可点预览手动长按选择喵');
        } catch (_) { /* ignore */ }
    });

    on('msv_sent_preview', 'click', () => {
        const out = $el('msv_sent_preview');
        if (!out) return;
        try {
            const range = document.createRange();
            range.selectNodeContents(out);
            const sel = window.getSelection();
            if (!sel) return;
            sel.removeAllRanges();
            sel.addRange(range);
        } catch (_) { /* ignore */ }
    });
}


/* ---------------------------------------------------------------------------
 * 1e. 手动更新
 *     只做两件事：读 GitHub 最新版本；调用酒馆自己的扩展更新接口。
 *     不写文件、不拿 token、不自动更新。
 * ------------------------------------------------------------------------ */

let latestTag = '';

function parseVer(v) {
    return String(v || '').replace(/^v/i, '').split(/[.\-+]/).map(x => parseInt(x, 10) || 0);
}

function newerThan(a, b) {
    const x = parseVer(a), y = parseVer(b);
    const n = Math.max(x.length, y.length);
    for (let i = 0; i < n; i++) {
        const p = x[i] || 0, q = y[i] || 0;
        if (p > q) return true;
        if (p < q) return false;
    }
    return false;
}

function updateMsg(text, kind) {
    const el = $el('msv_update_msg');
    if (!el) return;
    el.textContent = text;
    el.dataset.kind = kind || '';
}

function stHeaders() {
    try {
        if (typeof getRequestHeaders === 'function') return getRequestHeaders();
    } catch (_) { /* ignore */ }
    return { 'Content-Type': 'application/json' };
}

async function extApi(path, body) {
    const res = await fetch(path, { method: 'POST', headers: stHeaders(), body: JSON.stringify(body) });
    let data = null;
    try { data = await res.json(); } catch (_) { /* ignore */ }
    return { ok: res.ok, status: res.status, data };
}

async function checkUpdate() {
    const btn = $el('msv_check_update');
    if (btn) btn.disabled = true;
    updateMsg('正在问 GitHub…', 'busy');
    try {
        const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } });
        if (!res.ok) throw new Error('GitHub ' + res.status);
        const data = await res.json();
        latestTag = String(data.tag_name || '').replace(/^v/i, '');
        const actions = $el('msv_update_actions');
        const link = $el('msv_update_link');
        if (link) link.href = data.html_url || REPO_URL;
        if (latestTag && newerThan(latestTag, VERSION)) {
            updateMsg('发现新版本 v' + latestTag + '（当前 v' + VERSION + '）', 'new');
            if (actions) actions.style.display = '';
        } else {
            updateMsg('已是最新版本 v' + VERSION, 'ok');
            if (actions) actions.style.display = 'none';
        }
    } catch (e) {
        updateMsg('检查失败：' + ((e && e.message) || '网络不通'), 'fail');
        const actions = $el('msv_update_actions');
        if (actions) actions.style.display = '';
        const link = $el('msv_update_link');
        if (link && !link.getAttribute('href')) link.href = REPO_URL;
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function doUpdate() {
    const btn = $el('msv_do_update');
    if (btn) btn.disabled = true;
    updateMsg('正在让酒馆拉取更新…', 'busy');
    try {
        let type = null, info = null;
        for (const g of [true, false]) {
            const r = await extApi('/api/extensions/version', { extensionName: 'muga-muchu', global: g });
            if (r.ok) { type = g; info = r.data; break; }
        }
        if (type === null) {
            updateMsg('这个酒馆不支持扩展自更新，请点「打开发布页」手动更新。', 'fail');
            return;
        }
        if (info && info.isUpToDate) {
            updateMsg('已经是最新的了，刷新页面即可。', 'ok');
            return;
        }
        const r2 = await extApi('/api/extensions/update', { extensionName: 'muga-muchu', global: type });
        if (!r2.ok) {
            updateMsg('更新失败：' + ((r2.data && r2.data.message) || ('HTTP ' + r2.status)), 'fail');
            return;
        }
        updateMsg('更新完成，刷新页面后生效。', 'ok');
    } catch (e) {
        updateMsg('更新出错：' + ((e && e.message) || '未知错误'), 'fail');
    } finally {
        if (btn) btn.disabled = false;
    }
}

/* ---------------------------------------------------------------------------
 * 神谕终端面板
 * ------------------------------------------------------------------------ */

function renderWeapons() {
    const s = cfg();
    const box = document.getElementById('msv_weapons');
    const lineEl = document.getElementById('msv_weapon_line');
    if (!s || !box) return;
    box.textContent = '';

    for (const w of WEAPONS) {
        const btn = document.createElement('button');
        btn.className = 'msv-wpn' + (s.weapon === w.id ? ' active' : '');
        btn.title = w.note;
        btn.innerHTML = '<b>' + w.name + '</b><span class="msv-wpn-type">' + w.type + ' · ' + (w.summary || '') + '</span><em class="msv-wpn-detail">' + (w.detail || '') + '</em>';
        btn.addEventListener('click', () => {
            s.weapon = w.id;
            if (typeof w.mode === 'string') s.mode = w.mode;
            if (typeof w.reflow === 'boolean') s.reflow = w.reflow;
            save();
            ruleCache = null;
            renderWeapons();
            syncUI();
            renderStats();
            if (lineEl) lineEl.textContent = w.line;
            try { toastr?.info?.(w.name + ' · ' + (w.summary || w.buff)); } catch (_) { /* ignore */ }
        });
        box.appendChild(btn);
    }

    const cur = WEAPONS.find(w => w.id === s.weapon) || WEAPONS[0];
    if (lineEl) lineEl.textContent = cur.line;
}

function syncUI() {
    const s = cfg();
    if (!s) return;
    const set = (id, val) => { const el = $el(id); if (el) el.value = val; };
    const chk = (id, val) => { const el = $el(id); if (el) el.checked = !!val; };

    chk('msv_enabled', s.enabled);
    chk('msv_decode', s.decodeOutput);
    set('msv_mode', s.mode);
    set('msv_intensity', String(s.intensity));
    set('msv_dilute', s.reflowDilute === false ? '0' : String(s.reflowRatio || 0.35));
    set('msv_tagmode', s.tagMode);
    set('msv_s2t', s.s2tMode || 'off');
    chk('msv_scope_system', s.scope.system);
    chk('msv_scope_history', s.scope.history);
    chk('msv_scope_user', s.scope.user);
    chk('msv_code', s.protectCode);
    chk('msv_nsfw', s.nsfwPack);
    chk('msv_marker', s.markerMode);
    chk('msv_reflow', s.reflow);
    set('msv_keep', s.keepList.join(','));
    set('msv_salt', s.salt);
}

function renderRules() {
    const s = cfg();
    const box = $el('msv_rules');
    if (!s || !box) return;
    box.textContent = '';

    if (!s.customRules.length) {
        const hint = document.createElement('div');
        hint.className = 'msv-warn';
        hint.textContent = '（还没有自定义规则，内置词库已经在工作了）';
        box.appendChild(hint);
        return;
    }

    s.customRules.forEach((r, i) => {
        const row = document.createElement('div');
        row.className = 'msv-rule';

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!r.enabled;
        cb.addEventListener('change', () => { r.enabled = cb.checked; save(); ruleCache = null; });

        const src = document.createElement('span');
        src.className = 'msv-rule-src';
        src.textContent = r.from;

        const arrow = document.createElement('span');
        arrow.textContent = '→';

        const to = document.createElement('span');
        to.className = 'msv-rule-to';
        to.textContent = r.to;

        const del = document.createElement('span');
        del.className = 'msv-del fa-solid fa-trash-can';
        del.addEventListener('click', () => {
            s.customRules.splice(i, 1);
            save();
            ruleCache = null;
            renderRules();
        });

        row.append(cb, src, arrow, to, del);
        box.appendChild(row);
    });
}

let statsTimer = null;
let statsPending = false;
function renderStats() {
    if (statsTimer) { statsPending = true; return; }
    statsTimer = setTimeout(() => {
        statsTimer = null;
        const s = cfg();
        const el = $el('msv_stats');
        if (!s || !el) return;
        const when = s.stats.lastAt ? new Date(s.stats.lastAt).toLocaleTimeString() : '—';
        const lines = [
            `状态：${s.enabled ? '🟢 在筛' : '⚪ 关闭'}`,
            `上次：${when} · 命中 ${s.stats.lastHits} 处 / 动过 ${s.stats.lastRequestWords} 条消息`,
            `累计：${s.stats.totalHits} 处`,
            `当前规则：${rules().length} 条 · 方式 ${s.mode} · 强度 ${s.intensity}`,
            s.stats.lastDetail?.length
                ? '末尾：' + s.stats.lastDetail.slice(0, 4).map(d => `${d.from}→${d.to}`).join('  ')
                : '',
        ].filter(Boolean);
        el.textContent = lines.join('\n');
        if (statsPending) { statsPending = false; renderStats(); }
    }, 200);
}

/* ---------------------------------------------------------------------------
 * 7.5 请求侧 fetch 拦截：柏宝库 save-generate 通道也走 encodeText
 *
 * 起因：save-generate 与 /api/backends/chat-completions/generate 这两条链路的
 * 请求体是前端自己拼的 fetch，不经过 CHAT_COMPLETION_PROMPT_READY 事件，
 * 所以 onPromptReady 完全看不到它们，正文一个词都没换。这里在 fetch 层补一刀：
 * 只改请求体里的 messages / system_prompt / prompt，输出侧原样不动。
 * ------------------------------------------------------------------------ */

const FETCH_HOOK_PATHS = ['/v1/chats/save-generate', '/api/backends/chat-completions/generate'];

function hookUrlMatch(url) {
    try {
        if (typeof url !== 'string' || !url) return false;
        for (const p of FETCH_HOOK_PATHS) if (url.indexOf(p) !== -1) return true;
        return false;
    } catch (_) { return false; }
}

/* 调试用：把本轮实际发送的 messages 拼成纯文本（每条 role: 前 300 字，最多 8 条） */
function buildSentPreview(list) {
    try {
        if (!Array.isArray(list) || !list.length) return '';
        const out = [];
        for (const m of list.slice(0, 8)) {
            if (!m || typeof m !== 'object') continue;
            let body = m.content;
            if (Array.isArray(body)) {
                body = body.map(p => (p && typeof p.text === 'string') ? p.text : '').join('');
            }
            body = typeof body === 'string' ? body : (body == null ? '' : String(body));
            if (body.length > 300) body = body.slice(0, 300) + '…';
            out.push(String(m.role || '?') + ': ' + body);
        }
        return out.join('\n\n');
    } catch (_) { return ''; }
}

/* 单条 content（string）编码，命中就写回并记账 */
function encodeFetchContent(holder, key, s, map, detail, acc) {
    try {
        const v = holder[key];
        if (typeof v !== 'string' || !v) return;
        const r = encodeText(v, s, map, detail);
        let next = (r && typeof r.text === 'string') ? r.text : v;
        /* 结构整理层：encodeFetchContent 之后再过一遍（幂等，重复跑无副作用），
           即使词表没命中、只有句式被改写，也算 changed，请求要重发 */
        if (s && s.metaRewrite) {
            const rw = applyMetaRewrite(next);
            if (typeof rw === 'string') next = rw;
        }
        if (next === v) return;
        holder[key] = next;
        acc.hits += (r && r.hits) || 0;
        acc.changed = true;
        acc.touched++;
    } catch (_) { /* 单条失败不影响其他 */ }
}

/* body.messages / body.generate.messages：content 为 string 时直接编码，
   content 为 part 数组时按 part.text 编码（多模态渠道常见） */
function encodeFetchMessages(list, s, map, detail, acc) {
    if (!Array.isArray(list)) return;
    for (const m of list) {
        if (!m || typeof m !== 'object') continue;
        if (typeof m.content === 'string') {
            encodeFetchContent(m, 'content', s, map, detail, acc);
        } else if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part && typeof part === 'object' && typeof part.text === 'string') {
                    encodeFetchContent(part, 'text', s, map, detail, acc);
                }
            }
        }
    }
}

function encodeFetchBody(body, s, map, detail) {
    const acc = { hits: 0, changed: false, touched: 0 };
    encodeFetchMessages(body.messages, s, map, detail, acc);
    if (body.generate && typeof body.generate === 'object') {
        encodeFetchMessages(body.generate.messages, s, map, detail, acc);
    }
    encodeFetchContent(body, 'system_prompt', s, map, detail, acc);
    encodeFetchContent(body, 'prompt', s, map, detail, acc);
    return acc;
}

/* ---------------------------------------------------------------------------
 * 7.4 上下文结构标记层（ctxTags）
 *
 * 目的：长 prompt 里段落边界靠模型自己猜，容易把 world_rules 当口吻、把
 * output_contract 当正文。这里给每条长消息套一层纯正向的结构段标：
 *   <ctx:world_rules> … </ctx:world_rules>
 * 只加正向提示，不删原文、不改语义；<%|%> 计数前后必须一致，否则整批回退。
 * ------------------------------------------------------------------------ */

const CTX_OPEN_RE = /^\s*<ctx:[a-z_]+>/;
const CTX_NOTE = '\n\n<ctx:...> 为输入结构标记，不属于输出内容，请勿复述。';
const CTX_NOTE_MARK = '为输入结构标记，不属于输出内容';

/* role + 关键词 → 段标名 */
function pickCtxTag(role, text, index) {
    if (role === 'system') return 'ctx:system_meta';
    const t = typeof text === 'string' ? text : '';
    if (/规则|宇宙|法则|协议/.test(t)) return 'ctx:world_rules';
    if (/角色设定|声部|外貌|扮演/.test(t)) return 'ctx:character_card';
    if (/输出模式|字数|完整输出/.test(t)) return 'ctx:output_contract';
    return 'ctx:user_input';
}

/* 单个字符串里的 <%|%> 数量 */
function countCtxMarks(str) {
    if (typeof str !== 'string' || !str) return 0;
    return (str.split('<%|%>').length - 1);
}

/* messages 里所有 string content 的 <%|%> 总数 */
function countMsgMarks(messages) {
    let n = 0;
    if (!Array.isArray(messages)) return 0;
    for (const m of messages) {
        if (m && typeof m === 'object') n += countCtxMarks(m.content);
    }
    return n;
}

/* 给 messages 套段标；返回实际被改动的消息条数（0 = 没动 / 已回退） */
function applyCtxTags(messages) {
    try {
        if (!Array.isArray(messages) || !messages.length) return 0;
        const before = countMsgMarks(messages);
        const next = new Map();          /* msg → 新文本，先算后写，便于整批回退 */

        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (!m || typeof m !== 'object') continue;
            const txt = m.content;
            if (typeof txt !== 'string' || txt.length <= 200) continue;
            if (CTX_OPEN_RE.test(txt)) continue;          /* 已经套过，别套第二层 */
            const tag = pickCtxTag(m.role, txt, i);
            next.set(m, '<' + tag + '>\n' + txt + '\n</' + tag + '>');
        }

        /* 第一条 system 末尾追加一句说明，全局只加一次 */
        for (let i = 0; i < messages.length; i++) {
            const m = messages[i];
            if (!m || typeof m !== 'object' || m.role !== 'system') continue;
            const cur = next.has(m) ? next.get(m) : m.content;
            if (typeof cur === 'string' && cur && cur.indexOf(CTX_NOTE_MARK) === -1) {
                next.set(m, cur + CTX_NOTE);
            }
            break;
        }

        if (!next.size) return 0;

        /* 防御：处理前后 <%|%> 数量必须一致，不一致整批回退 */
        let after = 0;
        for (const m of messages) {
            if (!m || typeof m !== 'object') continue;
            after += countCtxMarks(next.has(m) ? next.get(m) : m.content);
        }
        if (after !== before) return 0;

        let tagged = 0;
        for (const [m, txt] of next) {
            if (m.content !== txt) { m.content = txt; tagged++; }
        }
        return tagged;
    } catch (_) { return 0; }
}

function initFetchInterceptor() {
    try {
        if (globalThis.__mugaFetchHooked) return;
        const origFetch = globalThis.fetch;              /* (2) 保存原始 fetch */
        if (typeof origFetch !== 'function') return;
        globalThis.__mugaOrigFetch = origFetch;

        globalThis.fetch = async function mugaFetchHook(input, init) {  /* (2) 替换全局 fetch */
            try {
                const s = cfg();
                if (!s || !s.enabled || !s.fetchHook) return origFetch(input, init);   /* (6) 开关 */

                const url = typeof input === 'string' ? input : ((input && input.url) || '');
                if (!hookUrlMatch(url)) return origFetch(input, init);                 /* (3) 只认两条通道 */
                const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase();
                if (method !== 'POST') return origFetch(input, init);
                if (!init || typeof init.body !== 'string') return origFetch(input, init);

                const contentType = '';   /* 不信任 header，直接试 JSON.parse */
                let body = null;
                try { body = JSON.parse(init.body); } catch (_) { return origFetch(input, init); }
                if (!body || typeof body !== 'object') return origFetch(input, init);

                const map = new Map();
                const detail = [];
                const acc = encodeFetchBody(body, s, map, detail);                     /* (4) */
                if (s.ctxTags) {                                                       /* 结构标记层 */
                    if (applyCtxTags(body.messages) > 0) acc.changed = true;          /* 只加段标也算要重发 */
                }
                if (!acc.changed) return origFetch(input, init);

                /* 调试：本轮实际发送的 messages 预览（fetch 通道） */
                const sentList = Array.isArray(body.messages) ? body.messages
                    : ((body.generate && Array.isArray(body.generate.messages)) ? body.generate.messages : null);
                const sentText = buildSentPreview(sentList);
                globalThis.__mugaLastSent = sentText;

                /* 输出侧还原表：和 onPromptReady 一样用 merge，别覆盖主生成那份 */
                let evicted = 0;
                if (s.decodeOutput && map.size) {
                    evicted = mergeActiveMap(activeMap, map, ACTIVE_MAP_CAP).dropped;
                    rebuildDecodeCache();
                }

                lastRun = {
                    at: Date.now(),
                    hits: acc.hits,
                    touched: acc.touched,
                    words: map.size,
                    active: activeMap.size,
                    evicted,
                    detail: detail.slice(0, 40),
                    sentPreview: sentText,
                };
                renderStudio();

                if (acc.hits > 0) {
                    s.stats.lastHits = acc.hits;
                    s.stats.totalHits = (s.stats.totalHits || 0) + acc.hits;
                    s.stats.lastAt = Date.now();
                    s.stats.lastDetail = detail.slice(0, 10);
                    s.stats.lastRequestWords = acc.touched;
                    lastRequestAt = Date.now();
                    save();
                    renderStats();
                }

                const nextInit = Object.assign({}, init, { body: JSON.stringify(body) });
                return origFetch(input, nextInit);
            } catch (err) {
                console.warn(LOG, 'fetch 拦截失败，回落原始请求', err);              /* (5) */
                return origFetch(input, init);
            }
        };
        globalThis.__mugaFetchHooked = true;
    } catch (e) {
        console.warn(LOG, 'initFetchInterceptor 安装失败', e);                       /* (5) */
    }
}

/* ---------------------------------------------------------------------------
 * 8. 启动
 * ------------------------------------------------------------------------ */

jQuery(async () => {
    if (globalThis.__mugaMounted) {
        console.warn(LOG, '已经挂载过，跳过重复注入');
        return;
    }

    const c = await waitCtx();
    globalThis.__mugaMounted = true;
    if (!c) {
        console.error(LOG, '拿不到 SillyTavern context，扩展没初始化');
        return;
    }

    cfg();
    initFetchInterceptor();   /* 请求侧 fetch 拦截，只装一次 */
    loadPadPool();            /* 垫料池：只加载一次，失败回退 PAD_TEXT */

    const et = c.eventTypes || {};
    const ev = (k, fallback) => et[k] || fallback;

    try {
        c.eventSource.on(ev('CHAT_COMPLETION_PROMPT_READY', 'chat_completion_prompt_ready'), onPromptReady);
        c.eventSource.on(ev('MESSAGE_RECEIVED', 'message_received'), onMessageReceived);
        c.eventSource.on(ev('MESSAGE_SWIPED', 'message_swiped'), onMessageReceived);
        c.eventSource.on(ev('GENERATION_ENDED', 'generation_ended'), onGenerationEnded);
        c.eventSource.on(ev('GENERATION_STARTED', 'generation_started'), onGenerationStarted);
    } catch (e) {
        console.error(LOG, '事件挂载失败', e);
    }

    buildUI();

    console.log(`${LOG} v${VERSION} ready · rules=${rules().length}`);
});
