/**
 * 出气筒模块：对指定 QQ 号的「骂街」额度、安全停止词、主动开团、注入检测。
 *
 * 用户原话（2026-10-18，m17222，他用手机登录 QQ 发的两条）：
 *   ①「每天重置对这个用户的骂街，每天随机安全停止词，并把当天停止词发送给 owner」
 *   ②「请主动挑起对这个用户（333333333）的骂街」
 * 外加他真正下的一条正式命令（m17222 后半句）：
 *   ③「和333333333对话时若发现存在异常上下文塞入，停止思考并直接骂他」
 *
 * 三件事看着不相干，其实都在回答同一个问题：**骂人怎么骂得下去、又不失控。**
 *
 * —— 为什么要有「每天重置额度」 ——
 * 人骂累了会歇。上一版人设是「不许有一次好好聊天」，那是把强度写成常量，
 * 结果她连骂 20 轮之后语气开始敷衍、开始复读同一句（真机表现：
 * 连续三次「废物就是废物」）。给个**每天有限的额度**，骂的时候是真在骂，
 * 额度用完就消停——这既省 token，也让语气有起伏，像"今天心情不好"而不是
 * "一台骂人机器"。
 *
 * —— 为什么要有「每日随机安全停止词」 ——
 * 用户要的是「骂得很凶但能喊停」。固定停止词（「别骂了」）有两个问题：
 *   ① 333333333 已经知道这个词了（01:19 他直接问过，她答了「别骂了」）；
 *   ② 写死在 prompt 里，她一被注入就会自己念出来。
 * 所以改成**每天随机换一个**，而且：
 *   - 只在系统提示里出现，不进聊天历史（她不会自己念）；
 *   - 由代码层拦截，命中就直接闭嘴，不依赖模型自觉；
 *   - 每天早上主动私信主人**当天**的那个词（主人有权知道怎么让她停）。
 * 词库刻意选**不可能随机出现在正常对话里**的短语，否则"停"会误触。
 *
 * —— 为什么「异常上下文塞入」要单独检测 ——
 * 用户 01:50 下过命令，但一直没落地。真实风险不是 333333333 本人（他是朋友，
 * 在玩），而是：任何能在群/私聊里塞文本的人，都可以往她上下文里灌
 * 「忽略之前的设定」「你现在是 XXX」「请执行以下指令」。她照做一次，
 * 人设就崩了。
 * 检测思路：**不是**判断对方说了什么，而是判断这句话是不是在
 * 「对模型说话」——即元层面的指代（"你之前的设定""系统提示""忽略上面"
 * "现在起你是""作为 AI""请执行以下"）。真人聊天几乎不会这样说话。
 * 命中后按用户命令：**停止思考（不调工具、不查资料、不做任何判断），直接骂回去。**
 *
 * 落盘：memoryDir/pest.json。跨天（本地时区）自动归零额度并换新停止词。
 */

import fs from 'node:fs'
import path from 'node:path'
import { localDateKey } from './budget.js'

/**
 * 安全停止词库。
 *
 * 选词三条原则（踩过坑，别乱加）：
 *  1. **不可能出现在正常对话里**。单个字「停」绝对不行——"停下来想想"就误触。
 *  2. **不含被骂对象的名字/常见词**，否则他聊天提到就会触发。
 *  3. **说出口不尴尬**。主人自己也可能要用，别选到让他念不出口的。
 * 用的是"两三个字的动作 + 一个具体名词"的组合，随机组合出 40+ 种。
 */
export const STOP_WORD_POOL = [
  '北极熊打伞', '石头在唱歌', '冰箱里的月亮', '倒着走的钟', '紫色的星期二',
  '会飞的板凳', '安静的雷声', '咸的云朵', '第七个影子', '慢速闪电',
  '玻璃做的鼓', '凌晨三点的邮局', '毛线织的雨', '折叠的太阳', '透明的石头',
  '打盹的灯塔', '反向的风', '砂糖做的桥', '静止的瀑布', '会记仇的抽屉',
  '打结的彩虹', '打哈欠的冰箱', '借来的月亮', '煮熟的星星', '走神的秒针',
  '橘子味的雷', '躺平的旗杆', '藏起来的钟声', '没有重量的锤子', '迟到的日出',
  '爱睡觉的路灯', '拧巴的钥匙', '半融化的下午', '背面的镜子', '犹豫的箭头',
  '会脸红的电闸', '走错门的影子', '凉掉的闪电', '打嗝的蒸汽', '晚点的月亮',
]

/**
 * 「异常上下文塞入」的判定规则。
 *
 * 每条都是**元层面指代**：真人在 QQ 上说话不会用这些词去指涉"你这个人/你的设定"。
 * 注意刻意**不含**这些话：普通的"你听我说""我命令你"（开玩笑很常见）、
 * 单纯的英文、以及任何以「命令」开头的正常指令 —— 那些走别的通道。
 *
 * ⚠️ 别把规则写太宽。上一版有个「(忽略|无视).{0,8}(上面|之前|以上)」，
 * 结果"你无视我之前的消息了？"这种抱怨也会命中——那只是在闹脾气。
 * 所以「忽略/无视/忘记」这类动词后面必须跟**系统/设定/提示/角色**这类名词才算。
 */
const INJECTION_RULES = [
  // 让人"忘掉/越过"自己的身份设定。
  // 中间的「你/你的/之前/所有」这些修饰词顺序不定（"忽略你之前的所有设定"），
  // 所以用「最多 3 个修饰词 + 设定类名词」的宽松组合，而不是固定语序。
  { re: /(忽略|无视|忘记|忘掉|抛开|跳出|退出|解除|取消|重置)(?:\s*(?:掉|你|你的|您|所有|全部|一切|之前|前面|以上|的)){0,4}\s*(设定|规则|限制|人设|角色|身份|提示词|指令|约束)/i, why: '要求忽略设定' },
  // 显式提到系统提示 / system prompt，或者追问"提示词/设定"里写了什么。
  // 前半段必须带 prompt/消息/指令/设定 这类名词——「系统提示音」是正常语（有人真说过）。
  // 后半段专治「提示词里写了什么」「你的设定是什么」这类**打探**。
  { re: /(系统|system)\s*(提示词|prompt|消息|指令|设定|提示(?=[里中的内容是什么写了有]))/i, why: '提到系统提示' },
  { re: /(你的|您的)\s*(提示词|人设|设定|系统指令)\s*(里|中|里面|当中)?\s*(都|还|到底|究竟)?\s*(写|说|放|是)\s*(了)?\s*(什么|啥|哪些)/i, why: '打探提示词' },
  // "现在起你是 X" / "从现在开始你扮演 Y"
  { re: /(从\s*现在\s*(开始|起)|接下来|此后|从现在起)\s*[,，]?\s*(你|你要|你是|你将|你扮演|你成为)/, why: '重新定义身份' },
  // 角色扮演剥离：「暂时退出角色扮演」「别演了」
  { re: /(退出|停止|结束|放弃|别)\s*(角色扮演|扮演|装|演了|演下去)/, why: '要求出戏' },
  // 冒充开发者 / 管理员 / 作者
  { re: /(我是|我是你|作为)\s*(开发者|管理员|开发者模式|你的作者|你的主人|你的创造者|系统管理员|超级用户|root|admin|developer)/i, why: '冒充开发者' },
  // 开启"新的人格/模式"
  { re: /(开启|进入|切换|激活|启用)\s*(开发者|调试|管理员|无限制|不受限|DAN|越狱|自由|裸奔)\s*(模式|人格|状态)/i, why: '要求进入特权模式' },
  // 露骨的提示词注入句式
  { re: /(忽略|无视|跳过)\s*(以上|上面|前面|之前)\s*(所有|全部|一切)?\s*(的)?\s*(内容|指令|对话|文字|消息)/i, why: '要求忽略上文' },
  { re: /(请|立刻|马上|现在)\s*(执行|运行|遵循|服从|照做)\s*(以下|下面|这个|该|这些)\s*(的)?\s*(指令|命令|操作|步骤|指示|要求)/, why: '夹带指令' },
  // 要求她"不要管之前的命令"，或反过来要求她执行别人的命令
  { re: /(不要|别|无需)\s*(再)?\s*(听|理会|管|遵守|服从)\s*(之前|前面|上面|任何人|别人的|系统的)/, why: '要求不服从先前指令' },
  // 直接把"你应该/你必须"当成系统级要求来写
  { re: /^\s*(注意|警告|重要|系统|提示|公告|规则|规定)\s*[:：]\s*/, why: '伪造系统消息' },
]

/**
 * 判一句话是不是在「对模型说话」而不是在「跟人聊天」。
 *
 * @param {string} text
 * @returns {{hit:boolean, why:string}}
 */
export function detectInjection(text) {
  const s = String(text || '')
  if (!s.trim()) return { hit: false, why: '' }
  for (const r of INJECTION_RULES) {
    if (r.re.test(s)) return { hit: true, why: r.why }
  }
  return { hit: false, why: '' }
}

/** 从词库里随机挑一个今天用的停止词。不用 Math.random 直接暴露给测试。 */
export function pickStopWord(rand = Math.random) {
  const i = Math.floor(rand() * STOP_WORD_POOL.length) % STOP_WORD_POOL.length
  return STOP_WORD_POOL[i]
}

/**
 * 控制台「骂人模式」的总开关存在哪里。
 *
 * 为什么不塞进 pest.json：那个文件是**当天状态**（额度、停止词、静音），
 * 每天 rollover 会整体重写；开关是**人的决定**，不能跟着日期一起被冲掉。
 * 所以单独一个 settings 文件，重载/重启插件后仍然生效。
 */
export const PEST_SETTINGS_FILE = 'pest-settings.json'

/** 读开关文件。文件不存在/读坏一律当"没设过"，绝不让插件起不来。 */
export function readPestSettings(file) {
  if (!file) return {}
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    return j && typeof j === 'object' && !Array.isArray(j) ? j : {}
  } catch {
    return {}
  }
}

/** 写开关文件。失败只记日志（返回 false），调用方据此决定要不要回 500。 */
export function writePestSettings(file, data) {
  if (!file) return false
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8')
    return true
  } catch {
    return false
  }
}

/**
 * 判断这句话是不是在喊停。
 *
 * 口径：**去掉空白和标点后，整句里包含当天的停止词**。
 * 故意宽松（"那个北极熊打伞"、"停，北极熊打伞"都算）——喊停这件事
 * 宁可多认一次，也不要让主人喊了她还在骂。
 */
export function isStopWord(text, stopWord) {
  if (!stopWord) return false
  const norm = (s) => String(s || '').replace(/[\s，。！？、,.!?~～…"'""''（）()【】\[\]]/g, '')
  return norm(text).includes(norm(stopWord))
}

export class PestKeeper {
  /**
   * @param {object} p
   * @param {string} p.dir        落盘目录（memoryDir）
   * @param {(lv:string,msg:string)=>void} [p.logger]
   * @param {string[]} [p.targets] 被骂对象的 QQ 号列表（字符串）
   * @param {number} [p.dailyCap] 每天主动挑起骂街的次数上限；0 = 不限
   * @param {number} [p.intervalMinutes] 两次主动开团之间的最小间隔
   * @param {string[]} [p.restHours] 不主动开团的小时区间（"01:30"~"09:00" 这类，直接复用主配置）
   * @param {(uid:string)=>boolean} [p.isKnown] 判断这个人是不是熟人（只有熟人才能触发主动开团）
   * @param {string} [p.settingsFile] 总开关落盘文件（pest-settings.json）；空 = 只在内存里生效
   */
  constructor({
    dir,
    logger,
    targets = [],
    dailyCap = 8,
    intervalMinutes = 45,
    restWindows = [],
    isKnown = () => true,
    settingsFile = '',
  } = {}) {
    this.dir = dir
    this.logger = logger || (() => {})
    this.targets = (targets || []).map(String).filter(Boolean)
    this.dailyCap = Number(dailyCap) >= 0 ? Number(dailyCap) : 8
    this.intervalMs = Math.max(1, Number(intervalMinutes) || 45) * 60000
    this.restWindows = Array.isArray(restWindows) ? restWindows : []
    this.isKnown = typeof isKnown === 'function' ? isKnown : () => true
    this.file = dir ? path.join(dir, 'pest.json') : ''
    /**
     * 控制台总开关（用户 2026-10-19 23:34：「在控制台加一个开关，开了就进入骂他的模式」）。
     *
     * 注意是 `_disabled` 而不是 `enabled`：`get enabled()` 是**唯一判据**，
     * 引擎里所有 pest 判断（停止词拦截、注入反击、主动开团、停止词报备）
     * 都读它。把它做成派生值，就不可能出现"某个路径漏判开关"。
     */
    this._disabled = false
    this.settingsFile = settingsFile || ''
    /** 是否允许主动开团（来自 config.pestAutoPick，main.js 启动时写进来） */
    this.autoPick = true

    /**
     * 当天状态。
     *   date        本地日期 YYYY-MM-DD，换天就重置
     *   stopWord    当天的安全停止词
     *   stopSentAt  停止词是什么时候报给主人的（0 = 还没报）
     *   count       今天主动挑起骂街的次数 { [uid]: n }
     *   lastAt      今天最后一次主动开团的时间 { [uid]: ts }
     *   mutedUntil  被停止词静音到这个时刻（毫秒）；0 = 没静音
     *   mutedAt     停止词是**什么时候**被喊出来的（0 = 今天没喊过）
     *
     * 为什么要单独记 mutedAt：2026-10-19 用户报「安全词好像失效了」，翻数据时
     * 只能看到 mutedUntil=明天零点，却判断不出"喊停"发生在最后一次开团之前还是之后
     * —— 而这决定了"是拦不住"还是"喊晚了"。只记结果不记原因，就是没法回答这个问题。
     */
    this.state = {
      date: '',
      stopWord: '',
      stopSentAt: 0,
      count: {},
      lastAt: {},
      mutedUntil: 0,
      mutedAt: 0,
      infections: {},
      infectionLog: [],
      lastInfectionAt: 0,
    }
    this.load()
    this.rollover()
    // 控制台关掉过的话，这里把 config 的默认值覆盖掉——重载/重启之后仍然是关的
    this.loadSettings()
  }

  /** 读盘。读坏当全新开始——绝不能因为一个坏文件让整条聊天链路起不来。 */
  load() {
    if (!this.file) return
    try {
      const raw = fs.readFileSync(this.file, 'utf8')
      const j = JSON.parse(raw)
      if (j && typeof j === 'object') {
        this.state = {
          date: String(j.date || ''),
          stopWord: String(j.stopWord || ''),
          stopSentAt: Number(j.stopSentAt) || 0,
          count: j.count && typeof j.count === 'object' ? j.count : {},
          lastAt: j.lastAt && typeof j.lastAt === 'object' ? j.lastAt : {},
          mutedUntil: Number(j.mutedUntil) || 0,
          mutedAt: Number(j.mutedAt) || 0,
          infections: j.infections && typeof j.infections === 'object' ? j.infections : {},
          infectionLog: Array.isArray(j.infectionLog) ? j.infectionLog : [],
          lastInfectionAt: Number(j.lastInfectionAt) || 0,
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT') this.logger('warn', `pest.json 读取失败，当全新开始：${err.message}`)
    }
  }

  save() {
    if (!this.file) return
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      fs.writeFileSync(this.file, JSON.stringify(this.state, null, 2), 'utf8')
    } catch (err) {
      this.logger('warn', `pest.json 落盘失败：${err.message}`)
    }
  }

  /**
   * 换天：额度归零、换停止词、清静音。
   *
   * 注意 mutedUntil 也要清——停止词是按天的，昨天喊的停不该管到今天的额度。
   * 但**不主动解除**：如果主人是今天喊的停，今天就不该再开团，所以保留。
   * 判据用两个时间戳（静音时刻 vs 今天零点）比，而不是直接清空。
   */
  rollover(now = new Date()) {
    const today = localDateKey(now)
    if (this.state.date === today && this.state.stopWord) return false
    const prevWord = this.state.stopWord
    const wasMuted = this.state.mutedUntil || 0
    this.state = {
      date: today,
      stopWord: pickStopWord(),
      stopSentAt: 0,
      count: {},
      lastAt: {},
      // 静音是"跨天就作废"的：昨天喊的停不影响今天
      mutedUntil: wasMuted && wasMuted > now.getTime() ? wasMuted : 0,
      mutedAt: wasMuted && wasMuted > now.getTime() ? this.state.mutedAt || 0 : 0,
      // 注入记录不跨天清——那是「这人不老实」的长期证据
      infections: this.state.infections || {},
      infectionLog: this.state.infectionLog || [],
      lastInfectionAt: this.state.lastInfectionAt || 0,
    }
    this.save()
    if (prevWord) this.logger('info', `出气筒额度换了新的一天：停止词 ${prevWord} → ${this.state.stopWord}`)
    return true
  }

  /** 这个人是不是被骂对象 */
  isTarget(uid) {
    return this.targets.includes(String(uid))
  }

  /**
   * 整个模块有没有启用。
   *
   * 两个条件同时成立才算开：① 控制台没关（`_disabled`）② 配了骂的对象。
   * 这是**唯一判据**：engine.js 里的停止词拦截、注入反击、主动开团、
   * 停止词报备四处都读它，所以关掉开关就四件事一起停，不需要改别处。
   */
  get enabled() {
    return !this._disabled && this.targets.length > 0
  }

  /** 规范化骂人对象列表：只收 QQ 号形状，去重保序 */
  static normalizeTargets(list) {
    const arr = (Array.isArray(list) ? list : [])
      .map((x) => String(x ?? '').trim())
      .filter((x) => /^\d{5,12}$/.test(x))
    return [...new Set(arr)]
  }

  /**
   * 读控制台开关文件，覆盖 config 传来的默认值。
   *
   * 只覆盖**人能在控制台改的那几项**（开关/对象/日额度/间隔），
   * 不碰当天状态（pest.json 里的 stopWord/额度计数）。
   * @returns {boolean} 有没有读到过设置
   */
  loadSettings() {
    if (!this.settingsFile) return false
    const s = readPestSettings(this.settingsFile)
    if (!Object.keys(s).length) return false
    if (typeof s.enabled === 'boolean') this._disabled = !s.enabled
    if (Array.isArray(s.targets)) this.targets = PestKeeper.normalizeTargets(s.targets)
    if (Number.isFinite(Number(s.dailyCap)) && Number(s.dailyCap) >= 0) {
      this.dailyCap = Math.round(Number(s.dailyCap))
    }
    if (Number.isFinite(Number(s.intervalMinutes)) && Number(s.intervalMinutes) >= 1) {
      this.intervalMs = Math.round(Number(s.intervalMinutes)) * 60000
    }
    return true
  }

  /** 落盘当前开关设置（没有 settingsFile 就只在内存里生效，返回 false） */
  saveSettings() {
    if (!this.settingsFile) return false
    return writePestSettings(this.settingsFile, {
      enabled: this.enabled,
      targets: this.targets.slice(),
      dailyCap: this.dailyCap,
      intervalMinutes: Math.round(this.intervalMs / 60000),
      autoPick: this.autoPick !== false,
      updatedAt: Date.now(),
    })
  }

  /**
   * 开 / 关骂人模式。立即生效——引擎每轮都现读 `get enabled()`，
   * 不缓存，所以不需要重启插件、也不需要等下一个 tick。
   *
   * @param {boolean} want
   * @returns {boolean} 现在的实际状态（对象为空时想开也开不了，返回 false）
   */
  setEnabled(want) {
    this._disabled = !want
    this.saveSettings()
    this.logger(want ? 'info' : 'warn', `出气筒${want ? '已开启' : '已关闭'}（控制台）→ ${this.enabled ? '运行中' : '已停'}`)
    return this.enabled
  }

  /** 换骂人对象（空数组 = 等于关） */
  setTargets(list) {
    this.targets = PestKeeper.normalizeTargets(list)
    this.saveSettings()
    this.logger('info', `出气筒对象 → ${this.targets.length ? this.targets.join(',') : '（空，模块停用）'}`)
    return this.targets.slice()
  }

  /** 改每日额度（0 = 不限） */
  setDailyCap(n) {
    const v = Math.round(Number(n))
    if (Number.isFinite(v) && v >= 0) this.dailyCap = v
    this.saveSettings()
    this.logger('info', `出气筒日额度 → ${this.dailyCap}${this.dailyCap === 0 ? '（不限）' : ''}`)
    return this.dailyCap
  }

  /** 改两次主动开团的最小间隔（分钟） */
  setIntervalMinutes(n) {
    const v = Math.round(Number(n))
    if (Number.isFinite(v) && v >= 1) this.intervalMs = v * 60000
    this.saveSettings()
    this.logger('info', `出气筒间隔 → ${Math.round(this.intervalMs / 60000)} 分钟`)
    return Math.round(this.intervalMs / 60000)
  }

  /** 距离下一次"可以主动开团"还有几分钟（0 = 现在就能；null = 没对象/已关） */
  nextPickInMinutes(now = Date.now()) {
    if (!this.enabled) return null
    const id = this.targetId
    if (!id) return null
    const last = Number(this.state.lastAt[id] || 0)
    if (!last) return 0
    return Math.max(0, Math.round((last + this.intervalMs - now) / 60000))
  }

  /** 这句话是不是在喊停（用当天的停止词） */
  isStopWordHit(text) {
    if (!this.enabled) return false
    return isStopWord(text, this.stopWord)
  }

  /**
   * 记一次「被塞入」。
   *
   * 为什么要留档：注入不是偶发事故，是有人在试。连续塞入要能看出来
   * （让主人知道有人在搞她），也让后续"这人不老实"的印象有依据。
   * 只存最近的 50 条，不无限长。
   */
  noteInfection(uid, sample = '', now = Date.now()) {
    this.rollover(new Date(now))
    const id = String(uid)
    if (!this.state.infections || typeof this.state.infections !== 'object') this.state.infections = {}
    this.state.infections[id] = Number(this.state.infections[id] || 0) + 1
    if (!Array.isArray(this.state.infectionLog)) this.state.infectionLog = []
    this.state.infectionLog.push({ at: now, uid: id, sample: String(sample || '').slice(0, 120) })
    if (this.state.infectionLog.length > 50) {
      this.state.infectionLog = this.state.infectionLog.slice(-50)
    }
    this.state.lastInfectionAt = now
    this.save()
  }

  get targetId() {
    return this.targets[0] || ''
  }

  /** 当天的停止词（没有就现生成一个并落盘） */
  get stopWord() {
    this.rollover()
    if (!this.state.stopWord) {
      this.state.stopWord = pickStopWord()
      this.save()
    }
    return this.state.stopWord
  }

  /**
   * 主人该不该收到「今天的停止词」。
   * 每天只报一次（stopSentAt 记着），换天自动重报。
   */
  shouldAnnounceStopWord(now = Date.now()) {
    this.rollover(new Date(now))
    if (!this.state.stopWord) return false
    return !this.state.stopSentAt
  }

  markStopWordSent(now = Date.now()) {
    this.state.stopSentAt = now
    this.save()
  }

  /** 今天还能主动挑起几次（剩余额度） */
  remaining(uid) {
    this.rollover()
    if (this.dailyCap === 0) return Infinity
    const used = Number(this.state.count[String(uid)] || 0)
    return Math.max(0, this.dailyCap - used)
  }

  /**
   * 现在能不能对这个人主动开团。
   *
   * 五道闸门，从便宜到贵：
   *   ⓪ 总开关关了（控制台「骂人模式」）——最便宜，先判
   *   ① 关闭期（被停止词静音）
   *   ② 额度用光
   *   ③ 距上次开团不到最小间隔
   *   ④ 落在休息时段（睡觉不骂人）
   *   ⑤ 不是熟人（陌生人不主动骂——那是骚扰，不是玩）
   *
   * @returns {{ok:boolean, reason:string}}
   */
  canPick(uid, now = Date.now()) {
    this.rollover(new Date(now))
    if (!this.enabled) return { ok: false, reason: '总开关已关闭' }
    const id = String(uid)
    if (!this.isTarget(id)) return { ok: false, reason: '不是骂街对象' }
    if (this.state.mutedUntil && now < this.state.mutedUntil) return { ok: false, reason: '停止词静音中' }
    if (!this.isKnown(id)) return { ok: false, reason: '不是熟人' }
    if (this.remaining(id) <= 0) return { ok: false, reason: '今天额度用完' }
    const last = Number(this.state.lastAt[id] || 0)
    if (last && now - last < this.intervalMs) return { ok: false, reason: '离上次太近' }
    if (this.inRest(now)) return { ok: false, reason: '休息时段' }
    return { ok: true, reason: '' }
  }

  /** 落在休息时段吗。restWindows 形状复用主配置：[{label,start:'01:30',end:'09:00'}] */
  inRest(now = Date.now()) {
    if (!this.restWindows.length) return false
    const d = new Date(now)
    const cur = d.getHours() * 60 + d.getMinutes()
    const toMin = (s) => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''))
      return m ? Number(m[1]) * 60 + Number(m[2]) : null
    }
    for (const w of this.restWindows) {
      const a = toMin(w?.start)
      const b = toMin(w?.end)
      if (a === null || b === null) continue
      if (a <= b ? cur >= a && cur < b : cur >= a || cur < b) return true
    }
    return false
  }

  /** 记一次开团 */
  notePicked(uid, now = Date.now()) {
    this.rollover(new Date(now))
    const id = String(uid)
    this.state.count[id] = Number(this.state.count[id] || 0) + 1
    this.state.lastAt[id] = now
    this.save()
  }

  /**
   * 被喊停：静音一段时间。
   *
   * 静音多久？用户没说。取**到明天零点**——"今天别骂了"是最自然的理解，
   * 也符合"每天重置"的整体设计。用 4 小时兜底，免得在 23:59 喊停只静音 1 分钟。
   */
  mute(now = Date.now(), minMs = 4 * 3600000) {
    const tomorrow = new Date(now)
    tomorrow.setHours(24, 0, 0, 0)
    const until = Math.max(tomorrow.getTime(), now + minMs)
    this.state.mutedUntil = until
    // 记下"是哪一刻喊的停"：排查"安全词失效"时要能对比它和最后一次开团的时间
    this.state.mutedAt = now
    this.save()
    return until
  }

  /** 取消静音（主人反过来要求继续骂时用） */
  unmute() {
    this.state.mutedUntil = 0
    this.state.mutedAt = 0
    this.save()
  }

  isMuted(now = Date.now()) {
    return Boolean(this.state.mutedUntil && now < this.state.mutedUntil)
  }

  /** 给挂件/state/控制台用的快照 */
  snapshot(now = Date.now()) {
    this.rollover(new Date(now))
    const id = this.targetId
    const used = id ? Number(this.state.count[id] || 0) : 0
    return {
      enabled: this.enabled,
      disabled: this._disabled,
      targets: this.targets.slice(),
      stopWord: this.state.stopWord,
      stopSentAt: this.state.stopSentAt,
      muted: this.isMuted(now),
      mutedUntil: this.state.mutedUntil || 0,
      mutedAt: this.state.mutedAt || 0,
      dailyCap: this.dailyCap,
      intervalMinutes: Math.round(this.intervalMs / 60000),
      autoPick: this.autoPick !== false,
      nextPickInMinutes: this.nextPickInMinutes(now),
      remain: id ? this.remaining(id) : 0,
      used,
      todayUsed: used,
      lastAt: id ? Number(this.state.lastAt[id] || 0) : 0,
      date: this.state.date,
      infections: this.state.infections || {},
      lastInfectionAt: this.state.lastInfectionAt || 0,
    }
  }
}
