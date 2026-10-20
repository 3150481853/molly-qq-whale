# Molly 控制台 —— 视觉规范（浅色 / Notion 系）

> 来源：`VoltAgent/awesome-design-md` 的 **Notion** DESIGN.md（`design-md/notion/DESIGN.md`）。
> 已按「仪表盘」场景裁剪：去掉营销页的 hero / pricing，只保留可复用的 token 与组件规则。
> 前端**必须**只引用本文件的 CSS 变量，不要自己发明颜色。

## 0. 一句话风格

> 白纸 + 暖灰分隔线 + 一个紫色主按钮 + 粉彩状态卡。安静、可读、不发光。

这是**浅色**主题，**不做深色**（用户明确要浅色调；两套主题维护成本翻倍，先不做）。

## 1. 颜色（直接抄成 `:root` 变量）

```css
:root{
  /* 画布与表面 */
  --canvas:        #ffffff;   /* 页面底色、卡片底 */
  --surface:       #f6f5f4;   /* 侧边栏、次级区块 */
  --surface-soft:  #fafaf9;   /* 更安静的区块分隔 */
  --hairline:      #e5e3df;   /* 1px 边框、主分隔线 */
  --hairline-soft: #ede9e4;   /* 更弱的分隔线 */
  --hairline-strong:#c8c4be;  /* 输入框边框 */

  /* 文字（四级，别多用） */
  --ink:      #1a1a1a;  /* 主标题、关键数字 */
  --charcoal: #37352f;  /* 正文（Notion 签名暖炭色） */
  --slate:    #5d5b54;  /* 次级说明 */
  --steel:    #787671;  /* 三级信息、单位、时间戳 */
  --stone:    #a4a097;  /* 弱标签 */
  --muted:    #bbb8b1;  /* 禁用、占位符 */

  /* 主操作（唯一强调色） */
  --primary:         #5645d4;
  --primary-pressed: #4534b3;
  --on-primary:      #ffffff;

  /* 语义色 */
  --success: #1aae39;
  --warning: #dd5b00;
  --error:   #e03131;
  --link:    #0075de;

  /* 粉彩卡（状态卡/统计卡用，别用于正文大块） */
  --tint-sky:      #dcecfa;
  --tint-mint:     #d9f3e1;
  --tint-lavender: #e6e0f5;
  --tint-peach:    #ffe8d4;
  --tint-rose:     #fde0ec;
  --tint-yellow:   #fef7d6;
  --tint-cream:    #f8f5e8;
  --tint-gray:     #f0eeec;

  /* 圆角 */
  --r-sm: 6px;
  --r-md: 8px;    /* 按钮、输入框 */
  --r-lg: 12px;   /* 卡片 */
  --r-full: 9999px; /* 状态胶囊、badge */

  /* 间距（4px 基数） */
  --s-1: 4px; --s-2: 8px; --s-3: 12px; --s-4: 16px;
  --s-5: 20px; --s-6: 24px; --s-7: 32px; --s-8: 40px;

  /* 阴影（浅色下极克制） */
  --shadow-1: 0 1px 2px rgba(15,15,15,.04);
  --shadow-2: 0 4px 12px rgba(15,15,15,.08);
  --shadow-3: 0 16px 48px -8px rgba(15,15,15,.16);

  /* 字体 */
  --font: "Inter", -apple-system, "Segoe UI", system-ui, "Microsoft YaHei", sans-serif;
  --font-mono: ui-monospace, "Cascadia Mono", Consolas, monospace;
}
```

## 2. 排版

| 用途 | 大小/字重 | 说明 |
|---|---|---|
| 页面标题 | 22px / 600 | `--ink`，字距 -0.2px |
| 卡片标题 | 15px / 600 | `--charcoal` |
| 正文 | 13px / 400 | `--charcoal`，行高 1.55 |
| 次级说明 | 12px / 400 | `--slate` |
| 弱信息/时间戳 | 12px / 500 | `--steel` |
| 关键数字 | 26px / 600 | `--ink`，**必须** `--font-mono` + `font-variant-numeric: tabular-nums` |
| 单位后缀 | 12px / 500 | `--steel`，紧贴数字右侧 |
| 微标签（全大写） | 11px / 600 | `--stone`，`letter-spacing:1px` |

**禁止**：字号 < 11px；正文用 600 字重；数字不用等宽（会让刷新时数字跳动）。

## 3. 组件规则

### 按钮
- 主按钮：`background: var(--primary); color: var(--on-primary); border-radius: var(--r-md); padding: 8px 14px; font-size:13px; font-weight:500;` 无边框
- 次按钮：透明底 + `1px solid var(--hairline-strong)` + `--ink` 文字
- 危险按钮（会踢掉登录/重启进程）：`background:#fff; border:1px solid var(--error); color:var(--error)`，hover 时 `background:var(--error); color:#fff`
- **禁用态**：`background:var(--hairline); color:var(--muted); cursor:not-allowed`
- 圆角一律 8px（**不是胶囊**）；只有状态胶囊/badge 用 `--r-full`

### 卡片
```css
.card{
  background:var(--canvas);
  border:1px solid var(--hairline);
  border-radius:var(--r-lg);
  padding:var(--s-5);
}
```
- 默认**不加阴影**，靠 1px 边框分层（Notion 的平铺哲学）
- 只有浮层（日志抽屉、二次确认弹窗）用 `--shadow-3`

### 输入框
`height:36px; border:1px solid var(--hairline-strong); border-radius:var(--r-md); background:var(--canvas);`
聚焦：`border:2px solid var(--primary)`（注意：用 `outline` 补偿 1px 位移，避免布局抖动）

### 状态胶囊（在线/离线/告警）
```css
.pill{border-radius:var(--r-full); padding:3px 10px; font-size:11px; font-weight:600}
.pill-ok  {background:var(--tint-mint); color:var(--success)}
.pill-warn{background:var(--tint-peach); color:var(--warning)}
.pill-bad {background:var(--tint-rose); color:var(--error)}
.pill-idle{background:var(--tint-gray); color:var(--steel)}
```

### 导航（左侧）
- 宽 200px，`background:var(--surface)`，右边框 `1px solid var(--hairline)`
- 未选中：`color:var(--steel)`，13px/400
- 选中：`background:var(--canvas)` + `box-shadow:inset 3px 0 0 var(--primary)` + `color:var(--ink)` + 500 字重
- 每项高 34px，左侧内边距 14px

### 表格
- 表头：12px/600 `--steel`，底部 `1px solid var(--hairline)`
- 行：`padding:10px 0`，行间 `1px solid var(--hairline-soft)`
- 行 hover：`background:var(--surface-soft)`（这是**唯一**允许的 hover 背景变化）

## 4. 布局

- 顶栏高 52px，白底，底部 `1px solid var(--hairline)`
- 内容区最大宽 1440px，内边距 24px
- 卡片网格：`display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:16px`
- 目标窗口 1280×860，最小 1024×700，**不允许横向滚动条**

## 5. Do / Don't

**Do**
- 用粉彩卡区分不同模块（记忆=lavender，表情=mint，预算=sky，守护=cream）
- 数字用等宽 + tabular-nums
- 用 1px 边框代替阴影分层
- 危险操作写明后果（「会踢掉当前 QQ 登录」）

**Don't**
- 不要用紫色做正文或大面积背景（只做按钮/选中态）
- 不要用胶囊按钮
- 不要发光/霓虹/玻璃拟态
- 不要深色主题
- 不要引入外部字体/CDN（离线可用）
- 不要给静态卡片加阴影
