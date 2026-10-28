/**
 * 茉莉花（Jasmine）记忆系统
 *
 * 给长期陪伴型 Agent 用的记忆底座，零依赖、纯 Node ESM。
 * 八个模块互相独立，可以整包用，也可以只拿一件：
 *
 *   store    双卡存储（衰减卡 + 原始账）
 *   recall   RRF 两路召回
 *   decay    衰减 / 归档策略（纯函数）
 *   verify   出口核对层（P0-1）
 *   compact  上下文压缩提醒（P0-2）
 *   letter   每周一封信（P0-3）
 *   ledger   token 账本（P1-5）
 *   signal   群聊四档信号（P1-6）
 */

export { JasmineStore, similarity, weekStart } from './src/store.mjs'

export {
  KINDS,
  KIND_ALIASES,
  WEIGHT_FLOOR,
  WEIGHT_MIN,
  WEIGHT_MAX,
  WEIGHT_DEFAULT,
  ARCHIVABLE_KINDS,
  ARCHIVE_IDLE_DAYS,
  DECAY_STEP_DAYS,
  DECAY_STEP,
  GRACE_ACTIVE_DAYS,
  normalizeKind,
  clampWeight,
  effectiveWeight,
  isArchivable,
  applyHit,
  weekIndexOf,
  weekKeyOf,
} from './src/decay.mjs'

export {
  RRF_K,
  ARM_WEIGHTS,
  terms,
  keywordScore,
  fuseRecall,
  applyCharBudget,
} from './src/recall.mjs'

export {
  verifyReply,
  buildConstraint,
  detectRepeat,
  detectSycophancy,
  charCosine,
  fourGrams,
  DIMENSION_WEIGHTS,
  REPEAT_THRESHOLDS,
} from './src/verify.mjs'

export {
  evaluateCompaction,
  buildReminder,
  estimateTokens,
  GROWTH_TOKENS,
  PRESSURE_RATIO,
  URGENT_RATIO,
  MIN_RECLAIM_TOKENS,
} from './src/compact.mjs'

export {
  buildLetter,
  buildLetterPrompt,
  cleanModelLetter,
  shouldWriteLetter,
  currentWeekKey,
  letterEntry,
  pickFacts,
  weekRangeText,
} from './src/letter.mjs'

export { TokenLedger, PURPOSES, EMPTY_PRICES } from './src/ledger.mjs'

export { scoreSignal, shouldSpeak, SIGNAL_WEIGHTS, CONTINUE_WINDOW_MS, CONTINUE_MAX_CHARS } from './src/signal.mjs'
