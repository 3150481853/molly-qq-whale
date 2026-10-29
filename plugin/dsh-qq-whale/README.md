# dsh-qq-whale

**A personable QQ channel for DeepSeek Harness.** One fixed persona across sessions, the built-in Jasmine memory system, sticker fights, optional voice, and a local web console that shows what she is doing right now.

`dsh-qq-whale`（中文名「蓝色大肥鱼」）把一只有人设的 QQ 机器人挂进 DeepSeek Harness。人设由你自己写，记忆与表情包存在你自己机器上，长期记忆由内置的「茉莉花记忆系统」负责。

---

## What it actually does

- **QQ I/O over OneBot 11, on SnowLuma.** Connects to SnowLuma's OneBot 11 WebSocket (forward or reverse WS) and speaks in both group and private chats.
- **One persona, held across sessions.** The persona is plain text at `persona/core.md` (shipped as `core.example.md`; the plugin falls back to a built-in default when the file is absent). No fine-tuning, no prompt spaghetti — you write the character sheet.
- **Jasmine memory system（茉莉花记忆系统）.** A built-in long-term memory stack: seven memory shards, RRF recall, a memory graph with two-hop diffusion, weekly letters and a token ledger. Conversations and facts stay under your data directory (`memory/`), encrypted at rest when a key file is supplied. Nothing is uploaded anywhere by this plugin itself.
- **Stickers.** Learns and re-uses images from a local sticker directory; matching is local.
- **Voice (optional).** Sends voice messages when a TTS/ASR endpoint is configured; silently disabled otherwise.
- **Local web console.** A small HTTP panel (default `127.0.0.1:19392`) showing recent messages, memory state, sticker library and runtime health.

Everything above degrades gracefully: with no SnowLuma backend, no voice service and no persona file, the plugin still loads and reports itself as degraded instead of crashing the host.

## Install

```bash
dsh plugin --profile desktop add dsh-qq-whale
```

Then add the mount patch to your profile's `cordis.patch.yml` (the package ships `cordis.patch.yml`; this is what `dsh.bundle.patch` points at):

```yaml
- insert:
    - id: dsh-qq-whale
      name: dsh-qq-whale
```

Restart the host. Installing from the repository instead of npm also works:

```bash
dsh plugin --profile desktop add "github:3150481853/molly-qq-whale#path:/plugin/dsh-qq-whale"
```

## Configure

Runtime configuration is not read from a file inside this package — pass it through the profile's `cordis.patch.yml`. Shape (see `config/cordis.patch.example.yml` in the repository):

```yaml
- id: dsh-qq-whale
  name: dsh-qq-whale
  config:
    onebot:
      ws: ws://127.0.0.1:3001
      token: ${ONEBOT_TOKEN}
      selfId: "111111111"
    console:
      host: 127.0.0.1
      port: 19392
      token: ${CONSOLE_TOKEN}
    plugin:
      memoryDir: ${MOLLY_ROOT}/data/qq-whale/memory
      stickerDir: ${MOLLY_ROOT}/data/qq-whale/stickers
    # 茉莉花记忆系统（Jasmine memory system）：记忆/账本/周信都落在 dataDir 下
    jasmine:
      dataDir: ${MOLLY_ROOT}/data/qq-whale
```

Only `onebot.ws` is really required to start talking. Everything else has a default; an empty config gives you a loaded-but-idle plugin rather than an error.

## Requirements

- DeepSeek Harness with the plugin host (`@deepseek-ai/dsh-*` 0.2.x is what this release was tested against).
- Node.js 20+ (the host's own runtime is fine).
- A QQ account driven by [SnowLuma](https://github.com/snowluma/snowluma)'s OneBot 11 backend — this plugin does not log into QQ by itself.

**No npm dependencies.** This package uses Node built-ins only, deliberately: a plugin installed into someone's host should not drag a dependency tree into it.

## Not included

The repository ships sample configuration and an example persona only. Real memory databases, sticker libraries, persona files and credentials stay on the operator's machine and are gitignored.

## License

MIT. See `LICENSE` in the repository root.

---

## 中文

`dsh-qq-whale` 是给 DeepSeek Harness 用的 QQ 通道插件：一个人设、内置「茉莉花记忆系统」、一个表情包库，外加一个能看见她此刻在干什么的本地控制台。

- 通过 SnowLuma 的 OneBot 11 收发群聊与私聊消息（插件本身不登录 QQ）；
- 长期记忆由内置的「茉莉花记忆系统」负责：七类记忆分片、RRF 融合召回、两跳识海图、每周周信、token 账本；
- 人设写在 `persona/core.md`（包里只带 `core.example.md` 与内置默认人设，缺文件自动降级）；
- 记忆与表情包落在你自己的数据目录，本插件不做任何外传；
- 语音为可选能力，没配 TTS/ASR 服务就自动关闭；
- 控制台默认 `127.0.0.1:19392`。

安装：

```bash
dsh plugin --profile desktop add dsh-qq-whale
```

装完仍需在 profile 的 `cordis.patch.yml` 里写上 `- insert: [{ id: dsh-qq-whale, name: dsh-qq-whale }]`，重启宿主后生效。配置直接从 `cordis.patch.yml` 的 `config` 传进去，包内不读配置文件。

零 npm 依赖——只用 Node 内置模块。
