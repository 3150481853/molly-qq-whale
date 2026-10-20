/** 单独测「模型抽记忆」这一步：把引擎里那段 prompt 原样拿出来跑，看模型到底回什么 */
import { WorkBuddyGateway } from 'file:///C:/Users/example/.dsh/profiles/desktop/node_modules/dsh-qq-whale/lib/wbai.js'

const logger = (level, msg) => console.log(`${level}: ${msg}`)
const gw = new WorkBuddyGateway({ logger, model: 'deepseek-v4.1-flash' })

const said = [
  '今天加班到十点，累死了',
  '领导又临时改需求，改第八遍了',
  '周末本来想去爬山的，估计要泡汤',
  '不过我家那只猫倒是挺开心的，一直在我键盘上趴着',
].join('\n')

const system = [
  '你在帮一只叫 Molly 的鲸鱼娘整理记忆。',
  '下面是某个人在 QQ 上说过的话。请挑出**以后还用得上**的事实，一行一条。',
  '',
  '只记这几类：',
  '- 他的身份/名字/职业/住哪/养什么',
  '- 他的喜好与雷点（爱吃什么、讨厌什么）',
  '- 他遇到过的事、当下的处境（加班、生病、考试、搬家）',
  '- 他明确的承诺或计划（说好周末一起、要去做某事）',
  '',
  '不要记：寒暄、语气词、你无法确定的内容、重复的东西。',
  '最多 3 条，每条不超过 25 字，写成"他……"或"他喜欢……"这样的第三人称短句。',
  '一条都不值得记就只输出两个字：无',
].join('\n')

const t0 = Date.now()
const res = await gw.chat({
  system,
  messages: [{ role: 'user', content: said }],
  maxTokens: 200,
  temperature: 0.3,
})
console.log(`耗时 ${Date.now() - t0}ms`)
console.log('ok =', res.ok)
console.log('error =', res.error)
console.log('code =', res.code)
console.log('--- text ---')
console.log(JSON.stringify(res.text))
