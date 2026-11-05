# 唱歌请求补丁（2026-11-05）

## 症状

群里手打「@Molly 唱歌 无人之岛」后，Molly 先发一条三四秒的语音，之后再没有歌；只有真正点选 QQ 的 @ 时才会唱歌。

## 根因

`engine.js` 的 `maybeSing` 门禁只放行 `SCENE_PRIVATE` / `SCENE_MENTION`：

```js
if (scene !== SCENE_PRIVATE && scene !== SCENE_MENTION) return false
```

手打的「@Molly」只是普通文本，消息里没有 `CQ:at` 段，scene 就是普通群聊，于是被直接挡掉，请求落到普通聊天链路：模型嘴上答应「行，等我去扒」，这句话又被 `maybeVoice`（`voiceChance: 0.35`）随机读成三四秒语音——看起来像「先读 4 秒」，实际根本没进点歌程序。

## 改动

运行目录：`${HOME}\.dsh\profiles\desktop\node_modules\dsh-qq-whale\lib\`
源码目录：`${MOLLY_ROOT}\qq-whale\plugin\dsh-qq-whale\lib\`（两份内容一致，改前各留 `.bak-singfix-20261105-1132` / `-1135`）

1. `engine.js` `maybeSing`：识别「手打 @昵称」，并把 `@Molly` / `@茉莉` / `@小鱼` 等前缀剥掉。

```js
const textStr = String(text || '').trim()
const handAt = /^(?:@|＠)\s*(?:molly|茉莉|莫莉|小鱼|小莫|小茉莉)/iu.test(textStr)
if (scene !== SCENE_PRIVATE && scene !== SCENE_MENTION && !handAt) return false
const raw = textStr
  .replace(/^(?:@我|@全体成员)\s*/u, '')
  .replace(/^(?:@|＠)\s*(?:molly|茉莉|莫莉|小鱼|小莫|小茉莉)[\s,，:：、]*/iu, '')
  .trim()
```

2. 预告文案：`两三分钟` → `五六分钟`（实测 110 秒那首从 10:55:18 到 11:01:45 共 6 分钟）。
3. `singing.js` `parseSingRequest`：动词表加 `点歌` / `唱一下` / `唱一遍`；量词清理支持 `一下 / 一遍 / 一次 / 一回`；书名号洗掉后用 `bare` 返回（原来把「《无人之岛》」整串丢给 B 站搜索）。

## 自测

| 输入 | 结果 |
| --- | --- |
| `唱歌 无人之岛` | `{song:"",requested:"无人之岛"}` |
| `点歌 无人之岛` | `requested:"无人之岛"` |
| `唱一下 无人之岛` | `requested:"无人之岛"` |
| `唱一遍《无人之岛》` | `requested:"无人之岛"` |
| `唱歌 小星星` | `{song:"小星星"}` |
| `唱歌 一半一半` | `requested:"一半一半"` |
| `1` / `今天天气不错` | `null`（不抢话） |

`node --check` 两个文件均退出 0。

## 生效

插件代码常驻 DSH 宿主进程，没有热重载，**必须重启 DSH**。2026-11-05 11:40 重启后 `plugins.reloadAt = 1793850001448`、`loaded` 8 个模块、`failed` 空、QQ `online`。

## 验证方法

群里直接手打 `@Molly 唱歌 无人之岛`（不用真点 at），应先回「五六分钟，别催」，5–6 分钟后出歌。

干跑接口（不发言）：`POST http://127.0.0.1:1546/dsh-qq-whale/sing/test`，body `{"dryRun":true,"song":"无人之岛"}`。
注意 `{"dryRun":false,...}` 会真的走整条链路并往 QQ 发言。