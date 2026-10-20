# WorkBuddy 网关接入教程

> 这份文档讲**协议**，不给任何人的凭据、token、账号。
> 你照着它自己跑通；跑不通的地方，用 AI 读这份文档 + 你的报错去定位。
>
> 如果你根本没有 WorkBuddy 账号，直接跳到文末看 `llm-adapter.md` —— 用你自己的 OpenAI 兼容服务，比这条路干净得多。

---

## 1. 这东西是什么

WorkBuddy（国内版客户端叫 CodeBuddy）是腾讯自家的 AI 编程客户端。它背后有一套模型服务，对你本地客户端开放了一个 **OpenAI 兼容**的 HTTP 接口：

- 对话：`POST {base}/v2/chat/completions`（流式 SSE）
- 模型列表：`GET {base}/v1/models`

两个不同的出口（"flavor"）：

| flavor | 对话 base | Web origin | 说明 |
|---|---|---|---|
| `cn` | `https://copilot.tencent.com` | `https://www.workbuddy.cn` | 国内版，积分计费 |
| `global` | `https://www.workbuddy.ai` | `https://www.workbuddy.ai` | 国际版，有免费额度 |

同一份代码可以走两条路，凭据分开存、缓存也要分开 —— 两个账号的 token 互相顶掉是最容易踩的坑之一。

**本项目里有两个后端都指向这里：**

- `modelBackend: 'wbai'` —— 直接连上游，用桌面 App 登录的那 1~2 个账号。简单，但全打满就哑了。
- `modelBackend: 'wb-proxy'` —— 连你本地跑的多账号池网关（例如 `workbuddy2api-hub` 起的 `http://127.0.0.1:8788`），由网关按权重/临期积分/剩余用量挑号。抗限流能力强得多。**这一层是可选的**，没有也能跑。

---

## 2. 凭据从哪来

### 2.1 你需要准备什么

一句话：**装桌面版客户端并登录**。凭据文件是客户端登录后自己写出来的，服务端不会给你单独的 API key。

登录后这些文件出现（`%LOCALAPPDATA%` 就是当前用户目录下的 `AppData\Local`；在资源管理器的地址栏输入 `%LOCALAPPDATA%` 回车即可跳过去）：

```
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info        ← 国内版（cn）
%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop-ai.info     ← 国际版（global）
```

两个都存在说明两个版本都登录过。只有其中一个也完全够用。

### 2.2 文件里有什么

打开它会看到 JSON（**别把内容贴到任何地方**），里面大致是：

```jsonc
{
  "auth":  { "accessToken": "<加密串>", "refreshToken": "<加密串>", "domain": "...", "expiresAt": 0 },
  "account": { "uid": "...", "enterpriseId": "..." }
}
```

关键点：**`accessToken` / `refreshToken` 是加密的**，不是能直接用的 Bearer token。

### 2.3 解密这件事

加密用的是 **AES-256-GCM**，密钥不是写死在客户端里的常量，而是**从桌面端进程运行时取出来的**（At-Rest secret key）。所以：

- 你没法只靠 `workbuddy-desktop.info` 这个文件在别的机器上还原出 token；
- 必须有**能跑的桌面端**（而且必须是这台机器上登录过的那个）；
- 客户端一升级、密钥派生规则一变，解密就全废 —— 这是这条路最大的脆弱点。

本项目的做法在 `plugin/dsh-qq-whale/lib/wbai.js`：读 info 文件 → 从桌面端可执行文件取 secret → `sha256(secret)` 当 key → AES-GCM 解 envelope → 拿到真正的 token → 内存缓存（按 flavor 分开）。

**你的做法**可以是任一：

1. **直接抄本项目的 `wbai.js` 思路**（它是 MIT 之类的开源许可，随仓库发布，自己读源码最快）；
2. **用别人现成的网关**（`workbuddy2api-hub` 之类），它替你把凭据池和解密都做好了，你只需要连它的 `http://127.0.0.1:8788/v1/chat/completions`；
3. 自己抓包看客户端发的请求 —— 但 token 会过期，长期要自己刷。

### 2.4 怎么判断"我拿到了"

三个自检，全过才算拿到：

1. **文件在**：`Test-Path "$env:LOCALAPPDATA\CodeBuddyExtension\Data\Public\auth\workbuddy-desktop.info"` 返回 `True`；
2. **能解出 token**：打印解密结果的前 6 位，应该是 `eyJ`（JWT 的标准开头）。**只打印前 6 位**，别把整串打到日志里；
3. **能打通一次**：拿这个 token 发一个最小的 `GET {base}/v1/models`，返回 200 且是 JSON。

任何一步失败，先别往下走 —— 后面所有报错都会长得像"接口不对"，其实是凭据没拿到。

---

## 3. 请求长什么样

### 3.1 必带的请求头

上游不只看 `Authorization`，还看一整套"我是官方客户端"的身份头：

```
Authorization: Bearer <accessToken>
Content-Type: application/json
Accept: application/json, text/plain, */*
Origin: <origin，见 flavor 表>
Referer: <origin>/
User-Agent: WorkBuddy/<版本> WorkBuddy/<版本>
X-Requested-With: XMLHttpRequest
X-IDE-Type: WorkBuddy
X-IDE-Name: WorkBuddy
X-IDE-Version: <版本>
X-Product: SaaS
X-Conversation-ID: <每次新 UUID>
X-Conversation-Request-ID: <每次新 UUID>
X-Conversation-Message-ID: <每次新 UUID>
X-User-Id: <account.uid>            // 没有就带 X-No-User-Id: 1
X-Enterprise-Id: <enterpriseId>     // 没有就带 X-No-Enterprise-Id: 1
X-Domain: <auth.domain>             // 没有就带 X-No-Department-Info: 1
```

三个 `X-Conversation-*` 每次都换新 UUID。少一个都可能被拒（表现为 401/403，很容易误判成 token 过期）。

### 3.2 请求体

```jsonc
POST {base}/v2/chat/completions
{
  "model": "deepseek-v4.1-flash",
  "messages": [
    { "role": "system", "content": "你是一个聊天机器人。" },
    { "role": "user",   "content": "在吗" }
  ],
  "max_tokens": 1024,
  "temperature": 0.85,
  "stream": true,
  "stream_options": { "include_usage": true }
}
```

`content` 除了字符串，还能是块数组（多模态，给看图用）：

```jsonc
{
  "role": "user",
  "content": [
    { "type": "text", "text": "描述这张图" },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,<...>" } }
  ]
}
```

### 3.3 `stream_options.include_usage` 是重点

**不加这个字段，你拿不到 usage。**

加了之后，SSE 流的**最后一帧**（`choices` 为空的那个）会带：

```jsonc
{
  "id": "...",
  "choices": [],
  "usage": {
    "prompt_tokens": 812,
    "completion_tokens": 96,
    "total_tokens": 908,
    "credit": 0.06
  }
}
```

`usage.credit` 是**这一次请求精确的积分消耗**（四舍五入值）。这是全链路里唯一可信的实时计费口径 —— 见下面「常见坑」第二条。

---

## 4. 积分与 token 的量级

不同模型有不同倍率，同一次对话在不同模型上花费差好几倍。实测经验（仅供参考，随时可能变）：

| 场景 | 量级 |
|---|---|
| `deepseek-v4.1-flash`（国内版） | 约 **1.9 万 token ≈ 1 积分**（倍率约 0.06） |
| 一次普通闲聊（几百 token） | 约 0.01~0.03 分 |
| 一天聊几百句 | 通常个位数到几十积分 |

换算成另一个说法：**1 积分大致对应一两万到十万 token 这个量级**，具体落在哪一段取决于模型倍率和当时的计费规则。

**别把这个数字当合同。** 它的用途只有一个：让你在写死"日上限 X 分"之前有个数量感。真要控额度，就按下面第 2 条自己记账。

---

## 5. 常见坑（按踩到的频率排序）

### 5.1 429 限流：窗口是"按小时"的，不是"每分钟"

免费车道被限流时返回 429。它恢复得很慢 —— 本地重试几秒、几十秒通常等不到。

**所以正确姿势不是"立刻重试"，而是有层次的降级：**

1. 换 flavor（cn ↔ global）再试一次；
2. 在当前 flavor 上低频重试（本项目默认 `[4s, 9s, 18s]`）；
3. 还是不行 → 换模型 / 换出口（例如关掉免费车道，切到积分池）；
4. 再不行 → 降智接盘或直接说人话。

**别做的事**：把所有重试都设成 200ms，那只会让 429 更持久。

### 5.2 billing 接口滞后，不能用来实时拦截

这是最坑的一条。billing 查询接口：

- 返回的是**跨月周期的资源包**，不是"今天用了多少"；
- `used` 字段**滞后几十秒到几分钟**；
- 聚合粒度是**按批**，不是按请求。

所以你做不了"超了就停"的实时拦截 —— 等你从 billing 看到超了，早就超了。

**唯一可信的做法：自己按天累计 `stream_options.include_usage` 回来的 `usage.credit`。**

落盘一个 `budget.json`：

```jsonc
{ "date": "2026-10-20", "used": 12.34, "calls": 87, "notified": false }
```

- 换天（按本地时区，不是 UTC）自动归零；
- 重启不丢当天已用；
- 到上限就停，发一次通知（`notified` 标记，别每次都发）。

**开关和用量要分开存。** 用量每天清零，开关要一直记着 —— 混在一起会导致"我明明关了限制，第二天它自己又开了"。

### 5.3 "每日额度"这个概念不存在

上游只发跨月周期的资源包，没有"今日还剩多少"。所有"日上限"都是你自己在客户端侧造的概念。

想清楚你要的是哪种：

- **总预算**：不管日期，烧完这个资源包就停；
- **日上限**：每天最多花 X，超了今天就哑，明天自动恢复（**本项目用的是这个**）。

### 5.4 两个 flavor 的 token 不能互相顶掉

如果你的缓存只按"有一个 token"来存，cn 用过之后再走 global 会拿到 cn 的 token → 401。

缓存 key 必须带 flavor。同理，清缓存也要**只清这个 flavor 的**。

### 5.5 模型名的 realm 是有讲究的

同一个"名字看着差不多"的模型，可能只在某一侧有服务，或者两侧都有一侧免费一侧收费。

典型例子：某个 flash 模型在国际侧是**免费额度**、在国内侧是**收费模型**。网关按模型名猜出口时如果猜错，你不会看到报错 —— 你会**悄悄地花钱**。这类 bug 最难发现，因为没有症状。

处理办法：**显式指定出口**（本项目在请求头里按模型名钉死 `X-Realm`），不要依赖网关猜。

### 5.6 客户端升级 = 解密全废

凭据的解密规则跟着客户端版本走。客户端一升级，昨天还能跑的代码今天可能就解不开了。

缓解办法：

- 只把这条当"能用就用的加速道"，**永远保留一条不依赖它的退路**（自己的 API、或本地模型）；
- 别把业务逻辑绑在某个具体版本的请求头上。

---

## 6. 最小自检脚本思路（不给完整代码）

```
1. 读 info 文件 → 有 auth.accessToken 吗？没有就停
2. 取 secret → sha256 → 解 envelope → 有 eyJ 开头的 token 吗？没有就停
3. GET {base}/v1/models（带完整身份头）→ 200 且 JSON？不是就停
4. POST {base}/v2/chat/completions，stream:true + include_usage:true
   → 能收到 data: 帧，最后一帧有 usage → 通了
```

第 4 步拿到 `usage.credit` 之后，把这个数记进你的 `budget.json` —— 从第一天就开始记账，别等到超了才补。

---

## 如果你没有 WorkBuddy 账号

这条路就到此为止，不要硬凑。改看 **`docs/llm-adapter.md`** —— 它讲的是怎么把这个项目接到你自己的 OpenAI 兼容 API（包括本地 ollama / vLLM）。多数人用那条路更省心：没有加密凭据要解、没有客户端升级风险、也不用担心"悄悄花钱"。

---

## 排错

### 1. `未找到 WorkBuddy 凭据文件`

`%LOCALAPPDATA%\CodeBuddyExtension\Data\Public\auth\` 下没有 `.info` 文件。

- 确认装的是**桌面客户端**，不是网页版（网页版不落这个文件）；
- 确认**已经登录**（停在登录页不算）；
- 确认用的是同一个 Windows 用户账户 —— `%LOCALAPPDATA%` 是**按用户**隔离的，换个账户登录就看不到；
- 国内版和国际版是两个文件，你可能只登了一个，先确认哪个有。

### 2. `解密 token 失败` / `读取密钥失败`

- 桌面端进程必须**能跑起来**且**已登录**（密钥是从运行时取的）；
- 客户端刚升级过 —— 解密规则可能变了，这条路暂时走不通；
- 在另一台机器上跑：这台机器没登录过，**必然失败**，不是配置问题。

### 3. 401 / 403，但 token 明明刚拿到

按这个顺序查：

1. 三个 `X-Conversation-*` 是不是每次都换新 UUID？（复用同一个会被拒）
2. `X-User-Id` / `X-Enterprise-Id` / `X-Domain` 缺失时，是不是补了对应的 `X-No-*` 头？
3. `Origin` / `Referer` 是不是和 flavor 对上了？（cn 的 token 配 global 的 origin 会被拒）
4. `X-IDE-Version` 和 `User-Agent` 里的版本号是不是太旧？

### 4. 能收到流，但 `usage` 一直是 null

`stream_options: { include_usage: true }` 漏了，或者你的 SSE 解析在最后一帧就 break 了。

最后一帧的 `choices` 是**空数组**，很多解析器看到"没有 choices"就当流结束直接跳过了 —— 必须专门处理这一帧。

### 5. 429 一直好不了

- 是不是在同一个 flavor 上猛敲？先换 flavor；
- 是不是两个账号都打满了？那就是真没额度了，走降级链；
- 免费车道的窗口按小时算，别指望几十秒恢复。
