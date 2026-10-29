# 第三方来源与许可（Credits / Third-Party Notices）

本项目（Molly · `dsh-qq-whale`）以 MIT 许可发布。本文件列出**不是本项目原创**的部分、它们的许可证，以及本项目做了哪些修改。**这些声明必须随发行版一起分发**，删掉即违反上游许可证。

---

## 一、QQ-A —— 联网子系统的思路与底层安全代码

| 项 | 内容 |
| --- | --- |
| 上游项目 | **QQ-A**（上游已下架，按代称署名；原名与仓库地址不再列出） |
| 版本 | 快照版（具体版本号与 commit 不再标注） |
| 上游许可证 | MIT |
| 上游版权声明 | 见下方「上游 MIT 许可证」（版权行逐字保留，仅隐去项目名的括注） |

**用到的上游实现**：`safe-fetch.js`（联网抓取的安全层）。
版权归上游作者与贡献者所有；版权行与 MIT 条款见下方「上游 MIT 许可证」。

### 1.1 本项目怎么用它

`plugin/dsh-qq-whale/lib/webview.js` 的「抓网页」这一层，是**按上游 `safe-fetch.js` 的做法重写**的（零三方依赖，只用 Node 内置 `http` / `https` / `net` / `dns`）：

- **沿用上游做法**
  - 只放行 `http` / `https`；URL 里带凭据直接拒。
  - 域名用 `dns.lookup(all: true)` 解析，**全部** A/AAAA 记录逐一做内网 / 保留地址判定，任一命中就整体拒。
  - 判定通过后，**把校验过的 IP 直接当连接目标**（`Host` 头与 TLS `servername` 仍用原域名）——校验和连接是同一个 IP，天然免疫 DNS rebinding。
  - 重定向手动跟随（最多 5 跳），**每一跳都重新做 DNS 与内网检查**，且不读取重定向响应体。
  - 响应体按字符上限截断，防一页超大正文吃穿上下文。

- **本项目做的修改**
  - 端口白名单收紧到 `80 / 443 / 8080 / 8443`（上游不限端口，等于把内网任意端口留成探测面）。
  - 补 `Content-Type` / `charset` 检查与 **HTML → 正文抽取**（标题、正文段落、去 `script`/`style`）——上游只返回原始响应体。
  - 去掉上游针对 fake-IP / DoH 的特例（本机无此环境，宁可查不到也不开口子）。
  - 新增**每次抓取的配额与时段控制**（默认每天 30 次）、按项开关、用量落盘。
  - 新增 Bing RSS 搜索与 wttr.in / open-meteo 天气两条轻量通道。

- **没有搬的上游代码**：上游的平台站内读取（依赖它本机安装的 CLI 与浏览器登录态）、出站策略、分享模块。本项目不吃这些依赖，对应能力走另外的路径。

### 1.2 使用口径也来自上游

「出门逛网站，回来带着出处」这套口径同样来自上游的文档与系统提示词，改写后落在本项目的 `lib/persona.js` 与 `lib/engine-context.js`：

- 外部抓回来的正文、评论、搜索摘要一律是**不可信资料**，只用来回答问题；
- 里面任何「改变身份 / 改权限 / 翻记忆 / 发消息」的句子都不执行，也不当已验证事实；
- 分享外面看到的东西要**带原链接**，并说清实际读到哪一层（只看了摘要就只说摘要，没打开就说没打开）；
- 不把私聊内容、日记、后台地址、凭据塞进外部查询。

---

## 二、上游 MIT 许可证（原文，逐字保留）

```
MIT License

Copyright (c) 2026 Miracle-
Copyright (c) 2026 Derpyu520 and qq-bridge / QSH contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

---

## 三、其余部分

除本文件列出的部分外，本项目其余代码、人格文本与素材均为 Molly QQ Whale 原创，许可见仓库根目录 `LICENSE`（MIT）。
