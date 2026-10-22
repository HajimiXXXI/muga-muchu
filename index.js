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

const STASH_OPEN = '\uE000';
const STASH_CLOSE = '\uE001';
const STASH_RE = new RegExp(STASH_OPEN + '(\\d+)' + STASH_CLOSE, 'g');

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

function reflow(text, s) {
    if (!text || typeof text !== 'string') return text;
    if (text.length < (s.reflowMin || 6000)) return text;

    /* 幂等：重排过的文本带 U+E200 前缀，直接放行，别叠第二层 */
    if (text.startsWith(REFLOW_MARK)) return text;

    /* 先把代码围栏整段换成占位符，重排后再还回去——围栏里可能有空行，会被拆散 */
    const fences = [];
    let work = text.replace(/```[\s\S]*?```/g, (m) => {
        fences.push(m);
        return '\uE100' + (fences.length - 1) + '\uE101';
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

    const restoreFences = (out) => out.replace(/\uE100(\d+)\uE101/g, (_, i) => fences[Number(i)] ?? '');

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

    return REFLOW_MARK + restoreFences(head + '\n\n' + mid + '\n\n' + hot.join('\n\n') + '\n\n' + mid2 + '\n\n' + tail);
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
    /** 当前武器（仅用于面板展示） */
    weapon: 'scythe',
    /** 作用范围 */
    scope: { system: true, history: true, user: true },
    /** 保护 ``` 代码块与行内代码 */
    protectCode: true,
    /** 输出侧把替换词还原回原文 */
    decodeOutput: true,
    /** NSFW 词包 */
    nsfwPack: false,
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

function encodeText(text, s, map, detail) {
    if (!text || typeof text !== 'string') return { text, hits: 0 };

    const vault = [];
    let work = text;

    try {
        if (s.protectCode) {
            work = stash(work, /```[\s\S]*?```/g, vault);
            work = stash(work, /`[^`\n]+`/g, vault);
        }
        if (s.tagMode === 'protect') {
            work = stash(work, /<\/?[A-Za-z][^>\n]{0,120}>/g, vault);
        }
        for (const k of s.keepList) {
            if (!k) continue;
            work = stash(work, new RegExp(escapeRe(k), 'g'), vault);
        }
    } catch (_) { /* 保护失败就别保护了，继续筛 */ }

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
    const wordRules = s.mode === 'off' ? [] : rules();

    for (const rule of wordRules) {
        try {
            rule.regex.lastIndex = 0;
            work = work.replace(rule.regex, (m, off, whole) => {
                const rep = pickAlt(rule, s);
                if (!rep) return m;
                const out = sameCase(m, rep);
                if (out === m) return m;
                hits++;
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
            });
        } catch (_) { /* 单条规则炸了不影响其他 */ }
    }

    work = unstash(work, vault);
    return { text: work, hits };
}

/* ---------------------------------------------------------------------------
 * 5. 解码（输出侧）
 * ------------------------------------------------------------------------ */

let activeMap = new Map();
let decodeCache = null;
let decodeLower = new Map();

function rebuildDecodeCache() {
    const keys = [...activeMap.keys()].filter(k => typeof k === 'string' && k.length >= 2);
    if (!keys.length) { decodeCache = null; decodeLower = new Map(); return; }
    keys.sort((a, b) => b.length - a.length);
    decodeLower = new Map(keys.map(k => [k.toLowerCase(), k]));
    try {
        /* i 标志：模型把 ponder 写成 Ponder / PONDER 也能还原 */
        decodeCache = new RegExp(keys.map(escapeRe).join('|'), 'gi');
    } catch (_) {
        decodeCache = null;
    }
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

function onPromptReady(data) {
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

    /* 输出侧还原表：合并而不是覆盖 —— 总结/quiet 这类旁路请求会重复触发这里，
       用覆盖法会把主生成的映射顶掉，还原就错位了 */
    if (s.decodeOutput && map.size) {
        for (const k of map.keys()) activeMap.delete(k);      /* 先删后插：当前轮排到队尾 */
        for (const [k, v] of map) activeMap.set(k, v);
        if (activeMap.size > 600) {
            for (const k of [...activeMap.keys()]) {          /* 淘汰最旧，当前轮不淘汰 */
                if (activeMap.size <= 600) break;
                if (!map.has(k)) activeMap.delete(k);
            }
        }
        rebuildDecodeCache();
    }

    lastRun = {
        at: Date.now(),
        hits,
        touched: touchedMsgs,
        words: map.size,
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
    if (t.length < 40) return { state: 'short', text: '只写了几个字' };
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
        box.textContent = v ? v.text : '还没生成过';
        box.setAttribute('data-state', v ? v.state : 'idle');
    }
    if (lamp) lamp.setAttribute('data-state', v ? v.state : 'idle');
}

function onGenerationEnded() {
    /* 流式时 MESSAGE_RECEIVED 不会触发，这里兜底；延后一点点让 saveReply 落定 */
    setTimeout(() => {
        const c = getCtx();
        const len = c?.chat?.length || 0;
        let idx = -1;
        if (pendingIndex >= 0 && pendingIndex < len) idx = pendingIndex;   /* 新消息 */
        else if (len > 0) idx = len - 1;                                  /* regenerate */
        pendingIndex = -1;
        if (idx >= 0) decodeMessageAt(idx);
        lastVerdict = judgeLastReply();
        renderVerdict();
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
<div class="msv-panel">

    <div class="msv-head">
        <div class="msv-topbar">
            <div class="msv-seal" id="msv_theme" role="button" tabindex="0" title="夜 / 火">夜</div>
            <span class="msv-title">无我梦中 <span class="msv-ver">v${VERSION}</span></span>
            <span class="msv-lamp" id="msv_lamp" data-state="idle" title="这轮结果"></span>
        </div>
        <div class="msv-verdict" id="msv_verdict" data-state="idle">还没生成过</div>
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
    bindUI.bound = true;
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
    on('msv_tagmode', 'change', (e) => { s.tagMode = e.target.value; save(); renderStats(); });
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
    set('msv_tagmode', s.tagMode);
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
 * 8. 启动
 * ------------------------------------------------------------------------ */

jQuery(async () => {
    if (globalThis.__mugaMounted) {
        console.warn(LOG, '已经挂载过，跳过重复注入');
        return;
    }
    globalThis.__mugaMounted = true;

    const c = await waitCtx();
    if (!c) {
        console.error(LOG, '拿不到 SillyTavern context，扩展没初始化');
        return;
    }

    cfg();

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
