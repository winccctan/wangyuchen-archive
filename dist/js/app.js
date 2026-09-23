// 王语晨补档站 - 前端逻辑
const DATA = { meta: null, messages: [], live: [], performances: [], social: [], perfCuts: null, liveCuts: null };
// 按月分键加载状态：ALL_MONTHS 为降序月份列表（最新在前），loadedMonths 记录已拉取的月份
let ALL_MONTHS = [];
let loadedMonths = new Set();
// 数据接口基址：主站（idol.wyc0518.cc）同源直连；备份站（GitHub Pages）与本地预览走线上 Worker。
// Worker 的数据接口已开 CORS（access-control-allow-origin: *），故跨域也能读同一份 KV 数据，
// 备份站因此不必再等 git 提交，也能显示最新补档。
const API_BASE = /(^|\.)wyc0518\.cc$/.test(location.hostname) ? '' : 'https://idol.wyc0518.cc';
// msgKey → message，便于翻译时按 id 取到原文（重新渲染后 DOM 里只剩 mid）
const MSG_INDEX = new Map();
const state = { tab: 'messages', query: '', dateFrom: null, dateTo: null, dayLimit: 3, lang: 'zh', expanded: new Set(), guideSub: 'guide', perfSub: 'perf', liveSub: 'replay' };

const $ = (sel) => document.querySelector(sel);
const panels = {
  messages: $('#panel-messages'),
  live: $('#panel-live'),
  performances: $('#panel-performances'),
  schedule: $('#panel-schedule'),
  guide: $('#panel-guide'),
  mine: $('#panel-mine')
};

/* ---------------- 新粉指南数据 ---------------- */
// 说明：微博统一用 uid 直链（weibo.com/u/<uid>）直达主页（比中文昵称路由稳定，改名也不失效）；
// 抖音 / 小红书 / B站 已通过短链解析出内部 ID，这里用「平台 scheme + ID」实现 App 内直达主页。
// accounts[].scheme 可覆盖 groups[].scheme（用于精确到某个账号的主页）。
const PROFILE = {
  name: '王语晨',
  aliases: '晨晨 / 壮壮 / 鱼鱼',
  facts: [
    ['生日', '2002.05.18'],
    ['星座', '金牛座'],
    ['出生地', '重庆'],
    ['MBTI', 'INFJ'],
    ['宠物', '小面包'],
    ['队伍', 'Team NIII'],
    ['期数', 'GNZ48 十三期'],
    ['粉丝名', '小甜橙'],
    ['应援色', '天蓝色']
  ],
  secretCode: '831882944',
  groups: [
    {
      label: '微博',
      scheme: 'sinaweibo://',
      color: '#e6162d',
      accounts: [
        { handle: 'GNZ48-王语晨', web: 'https://weibo.com/u/7791377245' },
        { handle: '忘记自己是鱼_', web: 'https://weibo.com/u/7648263890' }
      ]
    },
    {
      label: '抖音',
      scheme: 'snssdk1128://',
      color: '#111111',
      accounts: [
        {
          handle: 'Yuuuchen_',
          web: 'https://v.douyin.com/AOSQp6eBlwg/',
          scheme: 'snssdk1128://user/profile/MS4wLjABAAAADMlKYF7tTpgCmrD4up029mze5aSL3DshSGupCO2KxwnVUHLdRxJiXqoc21nTvfTm'
        },
        {
          handle: '是一只鱼',
          web: 'https://v.douyin.com/ZQ3QZpzoRNY/',
          scheme: 'snssdk1128://user/profile/MS4wLjABAAAAPoRpu29hMC-ZnzB-4iv_gdpKOkRvkIjo4l8C9Mn1zy0uWl3xCwrNhE9Syou8stCc'
        }
      ]
    },
    {
      label: '小红书',
      scheme: 'xhsdiscover://',
      color: '#ff2442',
      accounts: [
        {
          handle: 'Yuuuchen_',
          note: '3935 粉丝',
          web: 'https://xhslink.cn/o/5yLa5r0LeWV',
          scheme: 'xhsdiscover://user/5cedbceb00000000160097c0'
        }
      ]
    },
    {
      label: 'B站',
      scheme: 'bilibili://',
      color: '#00aeec',
      accounts: [
        {
          handle: '忘记自己是鱼_',
          web: 'https://space.bilibili.com/19994272',
          scheme: 'bilibili://space/19994272'
        }
      ]
    },
    {
      label: '往期舞台补档（微博）',
      scheme: 'sinaweibo://',
      color: '#e6162d',
      accounts: [
        { handle: '初昼·王语晨', web: 'https://weibo.com/u/7807274718' },
        { handle: '爱在黎明前_王语晨', web: 'https://weibo.com/u/7730075207' }
      ]
    },
    {
      label: '应援会微博',
      scheme: 'sinaweibo://',
      color: '#e6162d',
      accounts: [
        { handle: 'GNZ48-王语晨的甜橙小铺', web: 'https://weibo.com/u/7794095795' }
      ]
    }
  ],
  // 公式照（按年份倒序分组）：2026 官网，2025 白礼服+皇冠、2024 蓝格纹礼服（均来自微博）
  galleryByYear: [
    {
      year: '2026',
      source: 'SNH48 官网成员资料',
      photos: [
        './assets/member-gs1.jpg',
        './assets/member-gs2.jpg',
        './assets/member-gs4.jpg'
      ]
    },
    {
      year: '2025',
      source: '微博',
      photos: [
        './assets/gs2025-1.jpg',
        './assets/gs2025-2.jpg',
        './assets/gs2025-3.jpg',
        './assets/gs2025-4.jpg'
      ]
    },
    {
      year: '2024',
      source: '微博',
      photos: [
        './assets/gs2024-1.jpg',
        './assets/gs2024-2.jpg',
        './assets/gs2024-3.jpg',
        './assets/gs2024-4.jpg'
      ]
    }
  ],
  // 经历备注（SNH48 官网 member-detail，新→旧；tag: 高飞/梦想/新人/定制/预告）
  experience: [
    { date: '2026.11.28', tag: '预告', text: '个人年V全场定制公演即将到来' },
    { date: '2026.08.08', tag: '高飞', text: 'SNH48 GROUP 年度青春盛典 NO.22 年度高飞成员奖' },
    { date: '2025.08.02', tag: '梦想', text: 'SNH48 GROUP 年度青春盛典 NO45 年度梦想成员奖' },
    { date: '2024.08.03', tag: '高飞', text: 'SNH48 GROUP 年度青春盛典 NO27 年度高飞成员奖' },
    { date: '2023.08.05', tag: '新人', text: 'SNH48 GROUP 年度青春盛典 年度潜力新人' },
    { date: '2023.01.15', tag: '', text: '升格加入 GNZ48 Team NIII 队（Team NIII）' },
    { date: '2022.10.02', tag: '', text: '加入 GNZ48 十三期生' }
  ],
  // 官方微博提及（各官微提到王语晨的微博，手动抓取补入；带官微深链）
  // source = 提及来源账号；渲染时按 date 倒序合并成一条时间线
  officialMentions: [
    { date: '2026.09.05', source: '@SNH48', text: "#SNH48[超话]# GROUP首支电竞女子战队正式集结📣 【大名单发布】 @SNH48-王睿琦 @BEJ48-黄宣绮- @BEJ48-朱虹蓉 @SNH48-由淼 @GNZ48-石竹君 @GNZ48-王语晨 @BEJ48-王佳琪 @SNH48-温若其@SNH48-钟亚男 @SNH48-叶凡 【首发战队】 @SNH48-王睿琦 @BEJ48-黄宣绮- @SNH48-由淼 @SNH48-温若其 ​​​", url: 'https://weibo.com/2689280541/RgGEXi2k8' },
    { date: '2026.08.30', source: '@SNH48', text: "#SNH48[超话]#2026#SNH48GROUP年度青春盛典# ——TOP 22 领奖图—— “让你们的努力，都成为日后「值得」的回忆。” 恭喜@GNZ48-王语晨 获得年度高飞成员奖！你做到了！更远的山海，我们一起奔赴！ ​​​", url: 'https://weibo.com/2689280541/RfKUUz5gN' },
    { date: '2026.08.26', source: '@SNH48', text: "#SNH48[超话]# 2026#SNH48GROUP年度青春盛典# ——TOP 21-24 发言时刻—— @BEJ48-周湘 “这个夏天因你们而饱满，这份成绩因你们而有重量！” @GNZ48-王语晨 “我的心中还有更远的山海，并做好了全力以赴的准备，希望大家都能在生活中拥有奔赴理想的勇气，做到眼里有光，脚下有路。” @SNH48-禹佳蔚 ​​​", url: 'https://weibo.com/2689280541/Rf9Binm0n' },
    { date: '2026.08.25', source: '@GNZ48', text: "#GNZ48[超话]# ✨重磅消息✨ @GNZ48-王语晨 @GNZ48-黄楚茵 @GNZ48-吕思琪 @GNZ48-林家谊 四位成员解锁全新副本🔓 现正式宣布团内荣誉兼任 [星星]王语晨 兼任 GNZ48 TEAM Z [星星]黄楚茵 兼任 GNZ48 TEAM Z [星星]吕思琪 兼任 GNZ48 TEAM Z [星星]林家谊 兼任 GNZ48 TEAM NIII 📅演出信息 9月5日 ​​​", url: 'https://weibo.com/5675361083/Rf1KcqcCe' },
    { date: '2026.08.12', source: '@GNZ48', text: "2026#SNH48GROUP年度青春盛典# 梦想、汗水、坚持 #GNZ48[超话]# 荣誉恭贺 恭喜@GNZ48-王语晨 《过去完成时》 获得『年度高飞成员奖』🏆 “拥有奔赴理想的勇气，做到眼里有光，脚下有路。” 以无畏之姿拥抱每一次蜕变 用热爱镌刻青春最璀璨的印记 期待更耀眼的绽放[心] ​​​", url: 'https://weibo.com/5675361083/Rd1dYrlHJ' },
    { date: '2026.08.08', source: '@GNZ48', text: "#GNZ48[超话]# #SNH48苏州演唱会# 梦想、汗水、坚持✨ 2026 #SNH48GROUP年度青春盛典# 颁奖典礼 荣获「年度高飞成员奖」的作品正式揭晓 [打call] 恭喜@GNZ48-石竹君 @GNZ48-王语晨 @GNZ48-黄楚茵 @GNZ48-王秭歆 @GNZ48-方琪 @GNZ48-吕思琪 @GNZ48-林家谊 心怀热望，终绽锋芒。", url: 'https://weibo.com/5675361083/Rctgln61L' },
    { date: '2026.08.03', source: '@GNZ48', text: "#GNZ48[超话]# 梦想、汗水、坚持✨2026 #SNH48GROUP年度青春盛典# ——倒计时1周 即时周报结果公开—— 恭喜@GNZ48-朱怡欣- 入围年度影响力成员银奖提名 [打call] 恭喜@GNZ48-张琼予 入围『年度星光成员奖项』[打call] 恭喜@GNZ48-王语晨 @GNZ48-黄楚茵 @GNZ48-王秭歆 @GNZ48-陈珊玲 入围『年度高飞成", url: 'https://weibo.com/5675361083/RbEAzwLZa' },
    { date: '2026.07.28', source: '@GNZ48', text: "#GNZ48[超话]# GNZ48歌唱企划 《豪歌 2026》 巅峰之夜圆满收官[打call] 恭喜—— 🥇@GNZ48-朱怡欣- 🥈@CGT48-何林燕 🥉@GNZ48-陈珊玲 🎤@GNZ48-黄楚茵 @GNZ48-张琼予 @GNZ48-石竹君 @GNZ48-王语晨 @GNZ48-方琪 @-CKG48-吴志越- @GNZ48-王秭歆 @-CKG48-何馨曼- ​​​", url: 'https://weibo.com/5675361083/RaKBg2DvE' },
    { date: '2026.07.27', source: '@GNZ48', text: "#GNZ48[超话]# 梦想、汗水、坚持 2026 #SNH48GROUP年度青春盛典# 倒计时2周 即时周报结果公开： 恭喜@GNZ48-朱怡欣- 入围本轮年度影响力成员银奖提名🎉恭喜@GNZ48-张琼予 入围『年度星光成员奖项』🎉恭喜@GNZ48-王语晨 @GNZ48-黄楚茵 @GNZ48-陈珊玲 @GNZ48-王秭歆 @GNZ48-吕思琪 @GNZ48-方琪 入", url: 'https://weibo.com/5675361083/RaAgNvoO4' },
    { date: '2026.07.12', source: '@GNZ48', text: "#GNZ48[超话]# 梦想、汗水、坚持 2026 #SNH48GROUP年度青春盛典# 恭喜@GNZ48-朱怡欣- 入围影响力成员银奖提名 🎉恭喜@GNZ48-张琼予 @GNZ48-王语晨 入围第二阶段『年度星光成员奖项』的提名 🎉 行至山巅，终见星光 [打call] 演唱会购票直达＞＞http://t.cn/AXo3eLAn", url: 'https://weibo.com/5675361083/R8nDHA3dz' },
    { date: '2026.07.09', source: '@GNZ48', text: "2026 #SNH48GROUP年度青春盛典##GNZ48[超话]# 青春时刻返图 作品计分通道正式开启>>http://t.cn/A6aL75W1 @GNZ48-王语晨｜个人作品《过去完成时》 青春宣言： 过往不恋，未来不忧，当下不负。 ​​​", url: 'https://weibo.com/5675361083/R7R5HxpNg' },
    { date: '2026.07.04', source: '@GNZ48', text: "#GNZ48[超话]# 梦想、汗水、坚持 2026 #SNH48GROUP年度青春盛典# 作品计分通道正式开启>>http://t.cn/A6aL75W1 ——成员个人作品汇总—— 今天有3名成员发布了自己的个人作品，分别是： @GNZ48-王语晨《过去完成时》 “过往不恋，未来不忧，当下不负。” http://t.cn/AXo66rrC @GNZ48-许涵婧 《明日 ​​​", url: 'https://weibo.com/5675361083/R78vpyzVV' },
    { date: '2026.06.21', source: '@GNZ48', text: "#GNZ48[超话]# 梦想、汗水、坚持 2026 #SNH48GROUP年度青春盛典# 恭喜🎉 @GNZ48-王语晨 @GNZ48-陈珊玲 入围第一阶段『年度高飞成员奖项』", url: 'https://weibo.com/5675361083/R5bFPej9k' },
    { date: '2026.05.21', source: '@GNZ48', text: "#GNZ48[超话]# @GNZ48-王语晨 生日公演精彩回顾✨ 聚光灯落下的那一刻 青春被赋予了最具体的形状 过往皆为序章 未来才是她更广阔的旷野 ​​​​", url: 'https://weibo.com/5675361083/R0qIx4OkX' },
    { date: '2026.05.18', source: '@GNZ48', text: "#GNZ48[超话]# 今天是@GNZ48-王语晨 的生日～祝壮壮生日快乐🎂 聚光灯下的每一次跳动，都是你与梦想的同频共振。从默默积蓄力量，到在舞台中心尽情释放，你的光芒愈发耀眼且纯粹。🎞️ 愿未来的路途：万里无云，满目星光，掌声常伴。新的一岁，愿你自在生长，在热爱的领域里，永远滚烫，永远自 ​​​", url: 'https://weibo.com/5675361083/QFTVBj0Jr' },
    { date: '2026.05.08', source: '@GNZ48', text: "#GNZ48[超话]# @GNZ48-王语晨 季度MVP精彩回顾✨ 明眸璀璨 似繁星坠落人间 在追梦的轨迹里 始终恪守最初的纯真与滚烫🔥 ​​​", url: 'https://weibo.com/5675361083/QEofowp8q' },
    { date: '2026.04.26', source: '@GNZ48', text: "#GNZ48[超话]# @GNZ48-王语晨 季度MVP环节—《猩红之眼》 🎵撕碎标签 🎵傲慢偏见 撕碎世俗标签，挣脱傲慢偏见，步履不停，奔赴下一程盛放✨ http://t.cn/AXxmUbiU ​​​", url: 'https://weibo.com/5675361083/QCBRXiDRv' },
    { date: '2026.04.19', source: '@GNZ48', text: "#GNZ48[超话]# 星愿树通知：@GNZ48-王语晨 专场指定直播时间为：4月19日21:00；@GNZ48-程戈 专场直播时间为：4月20日20:00。请各位相互转告，谢谢～", url: 'https://weibo.com/5675361083/QBwIp9j7t' },
    { date: '2026.04.17', source: '@GNZ48', text: "#GNZ48[超话]# 星愿树下的心动约定，让动听的旋律点亮你的星光~✨ @GNZ48-王语晨 专场 举办时间：4月25日 16:30-18:00 指定直播时间：4月19日 21:00（以实际开播时间为准） @GNZ48-鲍雨欣 专场 举办时间：4月26日 15:30-17:00 指定直播时间：4月17日 22:00（以实际开播时间为准） 树语见面会：4月26 ​​​", url: 'https://weibo.com/5675361083/QBcsUlYu9' },
    { date: '2026.04.13', source: '@GNZ48', text: "#GNZ48[超话]# 2026年4月23日-4月26日GNZ48公演最新安排[打call] @刘力菲_ 《3652》荣誉毕业生GNZ48剧场年度MVP公演，藏满一路星光，邀你共同见证 [星星]GNZ48 TEAM NIII @GNZ48-王语晨 季度MVP环节 解构与重生的旅程迎来终章，GNZ48 TEAM NIII《没有我的世界(uN_v3rse)》千秋乐，定格最后一场闪耀 GNZ ​​​", url: 'https://weibo.com/5675361083/QAALmbsnv' },
    { date: '2026.03.12', source: '@SNH48', text: "#SNH48[超话]##SNH48无限青春# SNH48 GROUP 2026年度春季EP 《Forever Young》全曲上线倒计时！ 3月14日，白色情人节不见不散！ @-CKG48-何馨曼- @SNH48-蒋舒婷- @BEJ48-郑照暄 @SNH48-柏欣妤 @-GNZ48-徐楚雯 @SNH48-由淼 @GNZ48-王语晨 @CGT48-王艺霖 @-CKG48-雷宇霄 ​​​", url: 'https://weibo.com/2689280541/QvIoOzXI3' },
    { date: '2026.03.11', source: '@SNH48', text: "#SNH48[超话]# #SNH48无限青春# SNH48 GROUP 2026 春季EP同名曲 《Forever Young》MV今日已上线！侧拍花絮送达！ @-CKG48-何馨曼- @SNH48-蒋舒婷- @BEJ48-郑照暄 @SNH48-柏欣妤 @-GNZ48-徐楚雯 @SNH48-由淼 @GNZ48-王语晨 @CGT48-王艺霖 @-CKG48-雷宇霄 http://t.cn/AXVNC0in ​​​", url: 'https://weibo.com/2689280541/Qvza6lj5p' },
    { date: '2026.03.11', source: '@GNZ48', text: "#GNZ48[超话]# #SNH48无限青春# SNH48 GROUP 2026 春季EP同名曲 《Forever Young》MV今日正式上线[打call]@GNZ48-张琼予 @GNZ48-杨媛媛 @-GNZ48-徐楚雯 @GNZ48-王语晨 这是一段属于她们的青春发光故事。", url: 'https://weibo.com/5675361083/Qvz8zbnax' },
    { date: '2026.03.10', source: '@GNZ48', text: "#GNZ48[超话]# #SNH48无限青春# @-GNZ48-徐楚雯 @GNZ48-王语晨 SNH48 GROUP 2026年度春季EP 《Forever Young》热血版接力来袭[打call] 3月11日，主打曲音源&MV同步上线！", url: 'https://weibo.com/5675361083/Qvr9Ylbrr' },
    { date: '2026.03.10', source: '@SNH48', text: "#SNH48[超话]# #SNH48无限青春# SNH48 GROUP 2026年度春季EP 《Forever Young》热血版接力来袭 3月11日，主打曲音源&MV同步上线！ @-CKG48-何馨曼- @SNH48-蒋舒婷- @BEJ48-郑照暄 @SNH48-柏欣妤 @-GNZ48-徐楚雯 @SNH48-由淼 @GNZ48-王语晨 @CGT48-王艺霖 @-CKG48-雷宇霄 http://t.cn/AXVSPWic ​​​", url: 'https://weibo.com/2689280541/QvprlaT3s' },
    { date: '2026.03.08', source: '@SNH48', text: "#SNH48[超话]# #SNH48无限青春# SNH48 GROUP 2026年度春季EP同名主打曲 《Forever Young》青春版Young接力发布 3月11日，音源&MV同步上线，敬请期待！ @-CKG48-何馨曼- @SNH48-蒋舒婷- @BEJ48-郑照暄 @SNH48-柏欣妤 @-GNZ48-徐楚雯 @SNH48-由淼 @GNZ48-王语晨 @CGT48-王艺霖 @-CKG48-雷宇霄 ​​​", url: 'https://weibo.com/2689280541/Qv6AlETmz' },
    { date: '2026.03.05', source: '@SNH48', text: "#SNH48[超话]# #SNH48无限青春# SNH48 GROUP 2026年度春季EP 《Forever Young》青春版海报发布 3月6日MV预告，上线倒计时1天！ @-CKG48-何馨曼- @SNH48-蒋舒婷- @BEJ48-郑照暄 @SNH48-柏欣妤 @-GNZ48-徐楚雯 @SNH48-由淼 @GNZ48-王语晨 @CGT48-王艺霖 @-CKG48-雷宇霄 ​​​", url: 'https://weibo.com/2689280541/QuEiQyLU0' },
    { date: '2026.03.03', source: '@SNH48', text: "#SNH48[超话]# #SNH48无限青春# SNH48 GROUP 2026年度春季EP 《Forever Young》热血版海报发布 3月6日MV预告，上线倒计时3天！ @-CKG48-何馨曼- @SNH48-蒋舒婷- @BEJ48-郑照暄 @SNH48-柏欣妤 @-GNZ48-徐楚雯 @SNH48-由淼 @GNZ48-王语晨 @CGT48-王艺霖 @-CKG48-雷宇霄 ​​​", url: 'https://weibo.com/2689280541/QulrR9Cy9' },
    { date: '2026.02.27', source: '@GNZ48', text: "GNZ48超话#马年大吉# 大年十一，一心一意✨ 由@GNZ48-王语晨 送出的双重好礼🎁 ✅【“简直仙品”——往期成员拍立得一张！】 ✅【GNZ48拍了拍你——一次性胶卷相机】 一张定格回忆里的仙品，一张捕捉未来的光影，愿新的一年十全十美事事顺，每一帧都是好风景！ 2026.2.27 23：59通过@微博抽奖平台 ​​​", url: 'https://weibo.com/5675361083/QtKwAhVsV' },
    { date: '2026.02.04', source: '@GNZ48', text: "#GNZ48[超话]# 马年祝福满载而来🐎2月15日晚19:30锁定@重庆卫视 @四川卫视 2026川渝春节联欢晚会🎁和@GNZ48-王语晨 一起让欢笑与祝福撞个满怀～#2026川渝春晚阵容官宣# #川渝春晚分会场幸福集结#", url: 'https://weibo.com/5675361083/QqgTy16Qm' },
    { date: '2026.01.26', source: '@SNH48', text: "#SNH48[超话]##乐曜曲2025全阵容LIVE# SNH48 GROUP乐曜曲全阵容LIVE HOUSE • 上海站 单人回顾返图 @GNZ48-张琼予 @GNZ48-梁娇 @GNZ48-王秭歆 @-CKG48-朱瑞缘 @-CKG48-林-丹蕾 @-CKG48-徐沁楠 @-CKG48-陈萧扬 @刘力菲_ @GNZ48-王语晨 有些再见，是为了让相遇永远； 关于乐曜曲的故事，「未完待续 ​​​", url: 'https://weibo.com/2689280541/QoTf2vXsT' },
    { date: '2026.01.24', source: '@SNH48', text: "#SNH48[超话]##乐曜曲2025全阵容LIVE# SNH48 GROUP乐曜曲全阵容LIVE HOUSE • 上海站 1/24专属答谢见面会返图 时光会记得所有声音， 穿过人海，漫过四季，抵达崭新的明天。 @GNZ48-张琼予 @SNH48-韩家乐- @SNH48-卢天惠 @SNH48-金莹玥 @GNZ48-梁娇 @GNZ48-王秭歆 @GNZ48-王语晨 @SNH48-赵天杨 ​​​", url: 'https://weibo.com/2689280541/QoCm2zSJA' },
    { date: '2026.01.23', source: '@SNH48', text: "#SNH48[超话]##乐曜曲2025全阵容LIVE# SNH48 GROUP乐曜曲全阵容LIVE HOUSE • 上海站 3月乐曜曲《非正式告别》现场直击 @刘力菲_ @GNZ48-王语晨 有些告别没有句号， 只有未完的旋律在脑海中萦绕。 http://t.cn/AXqPu7v8 ​​​", url: 'https://weibo.com/2689280541/QotzD0qWJ' },
    { date: '2026.01.02', source: '@GNZ48', text: "#GNZ48[超话]#2025年12月GNZ48星梦剧院MVP月度之星及2025年第四季度季度之星名单公布： 恭喜—— #GNZ48TeamG[超话]# @GNZ48-张琼予 #GNZ48TeamNIII[超话]# @GNZ48-王语晨 #GNZ48TeamZ[超话]# @GNZ48-杨媛媛 感谢粉丝们的支持，期待更多精彩舞台在星梦剧院诞生！ ​​​", url: 'https://weibo.com/5675361083/QlecNelig' },
    { date: '2026.01.01', source: '@GNZ48', text: "#GNZ48[超话]# SNH48 GROUP 2025星梦剧院年度MVP TOP16选拔阵容正式公布！[打call]恭喜@GNZ48-张琼予 @GNZ48-杨媛媛 @-GNZ48-徐楚雯 @GNZ48-王语晨 入选选拔阵容！[鼓掌][鼓掌]", url: 'https://weibo.com/5675361083/Ql0PbnVam' },
    { date: '2025.12.11', source: '@GNZ48', text: "#GNZ48[超话]# 2026年纪念台历拍摄花絮｜@GNZ48-王语晨 任浪漫在花间流转 将甜蜜写进温柔时光 2026GNZ48纪念台历及周边现正火热销售中 GNZ48 2026年纪念台历套装-通行版>>>http://t.cn/AXy5ftEc GNZ48 2026年纪念台历套装-定制版>>>http://t.cn/AXy5ftEV GNZ48 2026年台历纪念主题小卡>>> ​​​", url: 'https://weibo.com/5675361083/QhTbR5nP3' },
    { date: '2025.12.08', source: '@GNZ48', text: "#GNZ48[超话]# 星愿树活动通知：@GNZ48-王语晨 指定直播时间：12月11日 21:00，请各位相互转告，谢谢~", url: 'https://weibo.com/5675361083/QhsyzvR3N' },
    { date: '2025.12.03', source: '@GNZ48', text: "#GNZ48[超话]# 星愿树下的心动约定，让动听的旋律点亮你的星光~✨ 12月14日，用歌声连接彼此~ @GNZ48-王语晨 专场 举办时间：12月14日 15:30-17:00 指定直播时间：12月11日 21:00（以实际开播时间为准） @GNZ48-陈珊玲 专场 举办时间：12月14日 20:00-21:30 指定直播时间：12月4日 22:00 （以实际 ​​​", url: 'https://weibo.com/5675361083/QgHJFgASi' },
    { date: '2025.12.01', source: '@GNZ48', text: "#GNZ48[超话]# SNH48 GROUP 2025星梦剧院年度MVP TOP16选拔阵容阶段性结果公布！[打call]恭喜@GNZ48-张琼予 @GNZ48-杨媛媛 @-CKG48-王思予 @GNZ48-王语晨 @GNZ48-朱怡欣- 入围[鼓掌]SNH48 GROUP 2025年度MVP TOP16选拔阵容、2025星梦剧院年度MVP「年度之星」都将于《SNH48 2025⏩2026跨年公演》当晚最", url: 'https://weibo.com/5675361083/QgoiDwFUe' },
    { date: '2025.11.21', source: '@SNH48', text: "#SNH48[超话]# #SNH48新学季# TOP48（梦想组）汇报单曲《新学季》现已上线 世界在倾听 我心底声音 实现着曾经梦境 @-CKG48-朱瑞缘 @BEJ48-郭晓盈 @GNZ48-方琪 @BEJ48-郑照暄 @GNZ48-梁乔 @GNZ48-王语晨 @GNZ48-刘欣媛 @SNH48-周童玥- @SNH48-张倩 ​​​", url: 'https://weibo.com/2689280541/QeQrJBFuQ' },
    { date: '2025.11.17', source: '@GNZ48', text: "#GNZ48[超话]# #SNH48新学季# 距离TOP48汇报MV《新学季》正式上线还有4天！[纸飞机] @GNZ48-梁乔 @GNZ48-王语晨 @GNZ48-刘欣媛 #SNH48GROUP年度青春盛典# TOP48（梦想组）汇报单曲《新学季》 11月21日10:00MV正式上线！", url: 'https://weibo.com/5675361083/QeeXhaiCi' },
    { date: '2025.11.17', source: '@SNH48', text: "#SNH48[超话]##SNH48新学季# 距离TOP48汇报MV《新学季》正式上线还有4天！ @GNZ48-梁乔 @GNZ48-王语晨 @GNZ48-刘欣媛 @SNH48-周童玥- @SNH48-张倩 #SNH48GROUP年度青春盛典# TOP48（梦想组）汇报单曲《新学季》 11月21日10:00MV正式上线！ http://t.cn/AX21Ssf3 ​​​", url: 'https://weibo.com/2689280541/QeeVWaw7X' },
    { date: '2025.11.17', source: '@SNH48', text: "#SNH48[超话]# #SNH48新学季# 青春像一首狂想曲 从来没有既定剧情 @GNZ48-梁乔 @GNZ48-王语晨 @GNZ48-刘欣媛 @SNH48-周童玥- @SNH48-张倩 #SNH48GROUP年度青春盛典# TOP48（梦想组）汇报单曲《新学季》 11月21日10:00MV正式上线！ ​​​", url: 'https://weibo.com/2689280541/QeexzzTHm' },
    { date: '2025.10.01', source: '@GNZ48', text: "#GNZ48[超话]# 2025星梦剧院「年度之星」荣耀继续✨ 2025年9月GNZ48星梦剧院MVP月度之星名单公布： 恭喜—— #GNZ48TeamG[超话]# @GNZ48-张琼予 #GNZ48TeamNIII[超话]# @GNZ48-王语晨 #GNZ48TeamZ[超话]# @GNZ48-杨媛媛 感谢粉丝们的支持，期待更多精彩舞台在星梦剧院诞生！ ​​​", url: 'https://weibo.com/5675361083/Q76rgmLp6' },
    { date: '2025.09.14', source: '@SNH48', text: "#SNH48[超话]#以世界之名，让世界洋溢青春 2025#SNH48GROUP年度青春盛典# ——TOP32&48专场答谢见面会返图—— 穿越千里 只为匆匆一面 @SNH48-李佳恩-@GNZ48-王秭歆 @SNH48-闫娜 @SNH48-叶凡 @GNZ48-石竹君 @BEJ48-郭晓盈 @GNZ48-方琪 @GNZ48-梁乔 @GNZ48-王语晨 @GNZ48-刘欣媛 ​​​", url: 'https://weibo.com/2689280541/Q4x7ZoGvj' },
    { date: '2025.09.08', source: '@SNH48', text: "#SNH48[超话]# 2025 #SNH48GROUP年度青春盛典# 「年度梦想成员奖」NO.45-48发言时刻回顾 恭喜@GNZ48-王语晨《虚构者》 “谢谢你们一直一直守护我，以后也一起幸福快乐地生活下去吧。” 恭喜@GNZ48-刘欣媛《因为你》 “我真的觉得你们特别厉害，每次都可以接住我所有情绪。” 恭喜@SNH48-周童玥- 《别 ​​​", url: 'https://weibo.com/2689280541/Q3AqEbdrN' },
    { date: '2025.09.08', source: '@SNH48', text: "#SNH48[超话]# 2025 #SNH48GROUP年度青春盛典# 「年度梦想成员奖」荣誉恭贺 所有在迷雾中不曾停步的坚持，早已把虚构的影子奏成了光芒本身 恭喜「年度梦想成员奖」NO.45@GNZ48-王语晨《虚构者》 即便有过无助落泪却从未放弃，终于在这舞台上绽放出耀眼的光芒 恭喜「年度梦想成员奖」NO.46 ​​​", url: 'https://weibo.com/2689280541/Q3Aeszx7K' },
    { date: '2025.05.22', source: '@SNH48', text: "#SNH48[超话]##SNH48乐曜曲计划# 2025 SNH48 GROUP星梦剧院 全新歌曲内容企划“乐曜曲计划” 【3月乐曜曲】《非正式告别》音源正式上线！ @GNZ48-刘力菲 @GNZ48-王语晨 所谓离别 就像是被慢放的痛觉 让音乐 代替未说出口的再见 QQ音乐＞＞http://t.cn/A6gpmfDe 酷狗音乐＞＞http://t.cn/A6gpmfDg 酷 ​​​", url: 'https://weibo.com/2689280541/PsY6F1oOY' },
    { date: '2024.11.01', source: '@SNH48', text: "#SNH48[超话]# #SNH48最好的朋友# TOP32汇报MV《花蝴蝶》现已上线 不会再迷惑 越飞越不惧陨落 @BEJ48-黄宣绮- @SNH48-陈雨孜 @SNH48-青钰雯 @GNZ48-王语晨 @SNH48-王睿琦 @GNZ48-杨若惜 @SNH48-卢天惠 @SNH48-林佳怡 @SNH48-金莹玥 ​​​", url: 'https://weibo.com/2689280541/OEdPd7r1J' },
    { date: '2024.10.29', source: '@SNH48', text: "#SNH48[超话]# #SNH48最好的朋友# 你就像是大自然的杰作 措手不及被我诱惑 @BEJ48-黄宣绮- @SNH48-陈雨孜 @SNH48-青钰雯 @GNZ48-王语晨 11月1日10:00《花蝴蝶》MV正式上线！ ​​​", url: 'https://weibo.com/2689280541/ODLlxqz7u' },
    { date: '2024.10.29', source: '@SNH48', text: "#SNH48[超话]# #SNH48最好的朋友# 距离TOP32汇报MV《花蝴蝶》正式上线还有3天！ @BEJ48-黄宣绮- @SNH48-陈雨孜 @SNH48-青钰雯 @GNZ48-王语晨 http://t.cn/A6ntRict ​​​", url: 'https://weibo.com/2689280541/ODKXbAoOi' },
    { date: '2024.08.30', source: '@SNH48', text: "#SNH48[超话]# 2024“新的序章”#SNH48GROUP年度青春盛典# ——发言时刻回顾—— 恭喜@GNZ48-王语晨 《蒲公英的脚印》 荣获「年度高飞成员奖」NO.27 “属于我们的第一个夏天正式打板了！” http://t.cn/A6R6sw6M ​​​", url: 'https://weibo.com/2689280541/OuDHL55F7' },
    { date: '2024.08.30', source: '@SNH48', text: "#SNH48[超话]# 2024“新的序章”#SNH48GROUP年度青春盛典# ——荣誉恭贺—— 乘着风的翅膀飞翔 飞过海平面的另一方 恭喜@GNZ48-王语晨 《蒲公英的脚印》 荣获「年度高飞成员奖」NO.27 ​​​", url: 'https://weibo.com/2689280541/OuDnsg6Zu' },
    { date: '2024.07.29', source: '@SNH48', text: "#SNH48[超话]# “新的序章”2024 #SNH48GROUP年度青春盛典# 即将开启！ 作品计分通道将于8月3日12:00正式关闭>>http://t.cn/A6aL75W1 专属计分EP《薄荷糖》正在SNH48星梦剧院周边店火热销售中 7月30日一日粉丝服务安排公布如下↓ 7月30日18:30-19:30 王语晨、郑照暄、李佳恩、赵天杨、周童玥 7月30日 ​​​", url: 'https://weibo.com/2689280541/OpPDO3VTr' },
    { date: '2024.07.22', source: '@SNH48', text: "#SNH48[超话]# “新的序章”2024 #SNH48GROUP年度青春盛典# 作品计分通道持续开启>>http://t.cn/A6aL75W1 专属计分EP《薄荷糖》全员应援版热销中>> http://t.cn/A6Hc1xw7 7/25-7/28一日粉丝服务安排公布如下↓ 7月25日18:00-18:45 郑丹妮、刘力菲、唐莉佳、张润、王语晨 7月27日17:30-18:15 袁一琦 ​​​", url: 'https://weibo.com/2689280541/OoKrHjc1x' },
    { date: '2024.03.24', source: '@SNH48', text: "#SNH48[超话]# 2024 #SNH48绽放春日见面会# 正是江南好风景 落花时节又逢君 @SNH48-胡晓慧 @BEJ48-黄怡慈 @SNH48-刘洁 @SNH48-冯思佳 @SNH48-郝婧怡 @SNH48-孙语姗 @GNZ48-王语晨 @GNZ48-杨若惜 ​​​", url: 'https://weibo.com/2689280541/O6uTSbL56' },
    { date: '2024.03.10', source: '@SNH48', text: "#SNH48[超话]# 2023 SNH48 GROUP 「年度潜力新人TOP16」巡演——上海站 @SNH48-温若其 @SNH48-杨心渝 @SNH48-卢晨昕- 《深海之声》听见海的心跳 听见了海中妖 @BEJ48-郑照暄 @BEJ48-庄雅雯 《画》十洲风光尽在我笔下 @GNZ48-刘欣媛 @GNZ48-王语晨 《白昼街灯 (LIGHT IT UP)》浪漫情节惹人陶醉 ​​​", url: 'https://weibo.com/2689280541/O4oGq4Tfa' },
    { date: '2024.03.10', source: '@SNH48', text: "#SNH48[超话]# 2023 SNH48 GROUP 「年度潜力新人TOP16」巡演——上海站 好想大声告诉你📢：我-喜-欢-你！ 最热切的呼喊 最浓烈的告白 都在这里 @BEJ48-郑照暄 @CGT48-周是汝 @SNH48-温若其 @GNZ48-刘欣媛 @CGT48-谭思慧 @-CKG48-何馨曼- @GNZ48-王语晨 @CGT48-宋筱璐 @CGT48-夏莹 @BEJ48-庄雅雯 ​​​", url: 'https://weibo.com/2689280541/O4oea7Crf' },
    { date: '2024.01.13', source: '@SNH48', text: "#SNH48[超话]##SNH48年度金曲大赏# SNH48 GROUP 第十届年度金曲大赏媒体采访返图 恭贺以下成员完成本届金曲作品首秀 @SNH48-胡晓慧 @SNH48-刘姝贤 《给未来的我们》 @SNH48-王奕 @SNH48-周诗雨 《双人舞》 @GNZ48-梁乔 @GNZ48-卢静 @GNZ48-杨若惜 @GNZ48-叶舒淇 @GNZ48-龙亦瑞 @GNZ48-王语晨 ​​​", url: 'https://weibo.com/2689280541/NBHQV8LR2' },
    { date: '2023.08.05', source: '@SNH48', text: "#SNH48[超话]# 2023丝芭家族十周年演唱会 #SNH48GROUP年度青春盛典# 颁奖典礼 恭喜@BEJ48-郑照暄 潜力新人TOP1 @BEJ48-马欣宇 @CGT48-周是汝 SNH48温若其 @CGT48-钟洁玟 @-CKG48-杨添淩- @GNZ48-刘欣媛 @CGT48-谭思慧 @-CKG48-何馨曼- @GNZ48-王语晨 @CGT48-宋筱璐 @CGT48-夏莹 @BEJ48-庄雅雯 SN ​​​", url: 'https://weibo.com/2689280541/NdbI1oXb6' }
  ]
};

// 点击社交账号：移动端先尝试唤起对应 App，未成功则回退网页
function openSocial(web, scheme) {
  const ua = navigator.userAgent || '';
  const isMobile = /iPhone|iPad|iPod|Android/i.test(ua);
  if (!isMobile || !scheme) {
    window.open(web, '_blank', 'noopener');
    return;
  }
  let fallbackTimer = setTimeout(() => { window.location.href = web; }, 1400);
  const cancel = () => clearTimeout(fallbackTimer);
  document.addEventListener('visibilitychange', () => { if (document.hidden) cancel(); }, { once: true });
  window.addEventListener('pagehide', cancel, { once: true });
  try {
    window.location.href = scheme;
  } catch {
    cancel();
    window.open(web, '_blank', 'noopener');
  }
}

/* ---------------- 工具函数 ---------------- */
function toUrl(path) {
  if (!path) return '';
  if (/^(https?:|data:)/i.test(path)) return path;
  return 'https://source3.48.cn' + (path.startsWith('/') ? '' : '/') + path;
}

function pad(n) { return String(n).padStart(2, '0'); }

// 全站时间统一按北京时间（UTC+8）显示/筛选：访客机器时区各不相同（UTC+9、UTC 等），
// 若直接用本地时区，同一条发言在不同人手机上会显示不同时刻，且日期筛选会差一天。
// 中国全境无夏令时，固定 +8 偏移即可；刻意不依赖 Intl（各浏览器实现差异大，易在老 Safari 上取不到值）。
const TZ = 'Asia/Shanghai';
const TZ_OFFSET_MS = 8 * 60 * 60 * 1000;
function tzDate(ts) {
  // 时间戳既可能是毫秒数字，也可能是 ISO 字符串（meta.lastUpdated 就是 "2026-09-19T09:21:28.376Z"），两种都要支持
  let t = Number(ts);
  if (!isFinite(t)) { const p = Date.parse(ts); if (isNaN(p)) return null; t = p; }
  return new Date(t + TZ_OFFSET_MS); // 平移后再用 UTC getter 读，得到的就是北京时间
}
function fmtDate(ts) {
  const d = tzDate(ts);
  return d ? `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}` : '';
}
function fmtTime(ts) {
  const d = tzDate(ts);
  return d ? `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}` : '';
}
// 时间戳 → <input type="date"> 需要的 YYYY-MM-DD（北京时间）
function toDateInput(ts) { return fmtDate(ts); }

const TYPE_LABEL = {
  TEXT: '文字', IMAGE: '图片', REPLY: '回复', GIFTREPLY: '礼物回复',
  AUDIO: '语音', AUDIO_GIFT_REPLY: '语音回复', VIDEO: '视频',
  LIVEPUSH: '直播推送', OPEN_LIVE: '公演直播',
  FLIPCARD: '翻牌', FLIPCARD_AUDIO: '翻牌语音', FLIPCARD_VIDEO: '翻牌视频',
  EXPRESS: '表情', EXPRESSIMAGE: '表情包', PRESENT_NORMAL: '礼物',
  PRESENT_TEXT: '文字礼物', SHARE_POSTS: '分享', VOTE: '投票', TRIP_INFO: '行程',
  DELETE: '撤回', DISABLE_SPEAK: '禁言', SESSION_DIANTAI: '电台', CLOSE_ROOM_CHAT: '闭房',
  RED_PACKET_2024: '红包', RED_PACKET_2026: '红包', RED_PACKET_QIXI_2025: '七夕红包',
  ZHONGQIU_ACTIVITY_LANTERN_FANS: '中秋灯笼'
};

// 王语晨本人的口袋 userId：用于区分「她本人发言」与房间里的其他人（粉丝 / 袋王 / 队友）
const SELF_ID = '89653517';

// 语音/视频时长（传入毫秒）
function fmtDur(ms) {
  const s = Math.round(Number(ms) / 1000);
  if (!s || s < 0) return '';
  return s < 60 ? `${s}"` : `${Math.floor(s / 60)}'${pad(s % 60)}"`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- 口袋表情：[敲打] → 表情图 ---------------- */
// 口袋48 服务端存的是纯文本（如「这是住在口袋的一个下午[敲打]」），App 里渲染成图片。
// 表情取自微信/QQ 经典表情表（0~104），已离线托管在 assets/emoji/{序号}.gif，
// 不依赖任何第三方 CDN，也不受防盗链影响。只替换表里存在的名字，未收录的原样保留文本。
const EMOJI_NAMES = ('微笑 撇嘴 色 发呆 得意 流泪 害羞 闭嘴 睡 大哭 '
  + '尴尬 发怒 调皮 呲牙 惊讶 难过 酷 冷汗 抓狂 吐 '
  + '偷笑 可爱 白眼 傲慢 饥饿 困 惊恐 流汗 憨笑 悠闲 '
  + '奋斗 咒骂 疑问 嘘 晕 折磨 衰 骷髅 敲打 再见 '
  + '擦汗 抠鼻 鼓掌 糗大了 坏笑 左哼哼 右哼哼 哈欠 鄙视 委屈 '
  + '快哭了 阴险 亲亲 吓 可怜 菜刀 西瓜 啤酒 篮球 乒乓 '
  + '咖啡 饭 猪头 玫瑰 凋谢 示爱 爱心 心碎 蛋糕 闪电 '
  + '炸弹 刀 足球 瓢虫 便便 月亮 太阳 礼物 拥抱 强 '
  + '弱 握手 胜利 抱拳 勾引 拳头 差劲 爱你 NO OK '
  + '爱情 飞吻 跳跳 发抖 怄火 转圈 磕头 回头 跳绳 挥手 '
  + '激动 街舞 献吻 左太极 右太极').split(/\s+/).filter(Boolean);
const EMOJI_MAP = Object.create(null);
EMOJI_NAMES.forEach((n, i) => { EMOJI_MAP[n] = i; });
EMOJI_MAP['飘虫'] = 73;   // 口袋里的写法，标准名「瓢虫」
EMOJI_MAP['大汗'] = 40;   // 口袋里的写法，标准名「擦汗」

const EMOJI_RE = /\[([^\[\]\n]{1,8})\]/g;
/** 传入已 escape 的文本，把其中的方括号表情换成表情图 */
function withEmoji(escaped) {
  if (!escaped || escaped.indexOf('[') < 0) return escaped;
  return escaped.replace(EMOJI_RE, (m0, name) => {
    const i = EMOJI_MAP[name];
    if (i === undefined) return m0;   // 未收录 → 保持原文本，不瞎猜
    return '<img class="msg-emoji" src="assets/emoji/' + i + '.gif" alt="' + m0
      + '" title="' + m0 + '" loading="lazy" decoding="async">';
  });
}

/* ---------------- 多语言翻译（浏览器按需，免费接口 + localStorage 缓存） ---------------- */
// 目标语言：中 / 英 / 西 / 法 / 荷 / 葡 / 罗 / 日 / 越 / 韩 / 泰（按访客国家分布补：比利时/法国→fr、荷兰→nl、
// 罗马尼亚→ro、莫桑比克→pt、泰国→th；印度访客通用英语，故不加印地语）。选「中文」时不做任何翻译。
// 翻译走 translate.googleapis.com 的公开 endpoint（浏览器端 CORS 已放行，无需密钥），
// 每条译文按「语言 + 文本哈希」缓存到 localStorage，重复查看不再请求、离线也能读缓存。
const TRANSLATE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t';
let proxyOk = null; // 同域代理是否可用：null=未探明 / true / false（首次探测后缓存，避免每次翻译都发无效请求）

// 翻译相关 UI 文案：随目标语言（state.lang）本地化，否则外国粉丝看不懂「翻译 / 查看原帖」等按钮
const TR_UI = {
  zh: { translate: '🌐 翻译', hide: '🌐 隐藏翻译', page: '🌐 翻译本页', loading: '翻译中…', fail: '翻译失败', viewOriginal: '查看原帖', viewRaw: '查看原始数据', videoGoOriginal: '视频内容 · 请到原帖观看' },
  en: { translate: '🌐 Translate', hide: '🌐 Hide translation', page: '🌐 Translate page', loading: 'Translating…', fail: 'Translation failed', viewOriginal: 'View original post', viewRaw: 'View raw data', videoGoOriginal: 'Video · open the source post to watch' },
  es: { translate: '🌐 Traducir', hide: '🌐 Ocultar traducción', page: '🌐 Traducir página', loading: 'Traduciendo…', fail: 'Error de traducción', viewOriginal: 'Ver publicación original', viewRaw: 'Ver datos originales', videoGoOriginal: 'Vídeo · abre la publicación fuente para verlo' },
  ja: { translate: '🌐 翻訳', hide: '🌐 翻訳を隠す', page: '🌐 このページを翻訳', loading: '翻訳中…', fail: '翻訳失敗', viewOriginal: '元の投稿を見る', viewRaw: '元のデータを見る', videoGoOriginal: '動画 · 元の投稿で視聴できます' },
  fr: { translate: '🌐 Traduire', hide: '🌐 Masquer la traduction', page: '🌐 Traduire la page', loading: 'Traduction…', fail: 'Échec de la traduction', viewOriginal: 'Voir la publication originale', viewRaw: 'Voir les données originales', videoGoOriginal: "Vidéo · ouvrez la publication d'origine pour la regarder" },
  nl: { translate: '🌐 Vertalen', hide: '🌐 Vertaling verbergen', page: '🌐 Pagina vertalen', loading: 'Vertalen…', fail: 'Vertaling mislukt', viewOriginal: 'Origineel bericht bekijken', viewRaw: 'Originele gegevens bekijken', videoGoOriginal: 'Video · open het originele bericht om te kijken' },
  pt: { translate: '🌐 Traduzir', hide: '🌐 Ocultar tradução', page: '🌐 Traduzir página', loading: 'Traduzindo…', fail: 'Falha na tradução', viewOriginal: 'Ver postagem original', viewRaw: 'Ver dados originais', videoGoOriginal: 'Vídeo · abra a postagem original para assistir' },
  ro: { translate: '🌐 Tradu', hide: '🌐 Ascunde traducerea', page: '🌐 Tradu pagina', loading: 'Se traduce…', fail: 'Traducere eșuată', viewOriginal: 'Vezi postarea originală', viewRaw: 'Vezi datele originale', videoGoOriginal: 'Videoclip · deschide postarea originală pentru a viziona' },
  vi: { translate: '🌐 Dịch', hide: '🌐 Ẩn bản dịch', page: '🌐 Dịch trang này', loading: 'Đang dịch…', fail: 'Lỗi dịch', viewOriginal: 'Xem bài gốc', viewRaw: 'Xem dữ liệu gốc', videoGoOriginal: 'Video · mở bài gốc để xem' },
  ko: { translate: '🌐 번역', hide: '🌐 번역 숨기기', page: '🌐 이 페이지 번역', loading: '번역 중…', fail: '번역 실패', viewOriginal: '원본 게시물 보기', viewRaw: '원본 데이터 보기', videoGoOriginal: '동영상 · 원본 게시물에서 시청하세요' },
  th: { translate: '🌐 แปล', hide: '🌐 ซ่อนคำแปล', page: '🌐 แปลหน้านี้', loading: 'กำลังแปล…', fail: 'แปลไม่สำเร็จ', viewOriginal: 'ดูโพสต์ต้นฉบับ', viewRaw: 'ดูข้อมูลต้นฉบับ', videoGoOriginal: 'วิดีโอ · เปิดโพสต์ต้นฉบับเพื่อดู' },
};
function trUI(key, lang) {
  const set = TR_UI[lang] || TR_UI.zh;
  return set[key] != null ? set[key] : (TR_UI.zh[key] != null ? TR_UI.zh[key] : key);
}

function strHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (((h << 5) + h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}
function trCacheKey(text, lang) { return `wyc:tr:${lang}:${strHash(text)}`; }
function trGet(text, lang) { try { return localStorage.getItem(trCacheKey(text, lang)); } catch { return null; } }
function trSet(text, lang, val) { try { localStorage.setItem(trCacheKey(text, lang), val); } catch { /* 配额满则忽略 */ } }

// 一条消息里所有可翻译的文本片段（正文 / 引用原话 / 卡片标题 / 描述）
function trSegs(m) {
  const segs = [];
  if (m.text) segs.push({ label: '', text: m.text });
  if (m.reply?.text) {
    const who = m.reply.name ? `@${m.reply.name}：` : '';
    segs.push({ label: '↩︎ ' + who, text: m.reply.text });
  }
  if (m.card?.title) segs.push({ label: '标题：', text: m.card.title });
  if (m.card?.desc) segs.push({ label: '描述：', text: m.card.desc });
  return segs;
}
function hasTranslatable(m) {
  return !!(m.text || m.reply?.text || (m.card && (m.card.title || m.card.desc)));
}
// 稳定的消息 id（msgIdServer 可能缺失，兜底用 文本+时间 哈希）
function msgKey(m) {
  return m.msgIdServer || ('k' + strHash((m.text || '') + (m.reply?.text || '') + m.msgTime));
}

// 调接口翻译单段文本（失败抛错，由调用方决定如何展示）
// 多翻译源按顺序尝试，任一成功即用（覆盖国内/海外、镜像/file:// 各种网络环境）：
//   1) /translate   ：本站 Cloudflare 边缘代理（国内可用、质量最佳；未部署时 404 自动跳过）
//   2) google       ：直连 Google 公开接口（海外/镜像可用、质量最佳）
//   3) mymemory     ：欧洲公共服务（国内可直连、CORS 已放行，作为兜底）
async function translateText(text, target) {
  if (target === 'zh' || !text) return text;
  const q = encodeURIComponent(text);
  const tl = encodeURIComponent(target);
  const gParse = (d) => ((d && d[0]) || []).map((s) => s[0]).join('');

  const gUrl = `${TRANSLATE_ENDPOINT}&tl=${tl}&q=${q}`;
  const pParse = (d) => (d && d.text) || ''; // 同域代理 /translate 返回 { text }（Workers AI 或 Google）
  const mmParse = (d) => {
    if (!d || d.responseStatus !== '200') return '';
    const t = (d.responseData && d.responseData.translatedText) || '';
    if (/MYMEMORY WARNING|QUOTA|YOU USED ALL/i.test(t)) return ''; // 额度耗尽 → 换下一个源
    return t;
  };

  // 翻译源按「质量优先」依次尝试（前一个失败才用下一个）：
  //   1) Google 直连         —— 质量最好（海外/镜像可用；大陆被墙会快速失败后自动降级）
  //   2) 同域代理 /translate —— Cloudflare Workers AI 翻译（稳定可用、含大陆；质量中等）
  //   3) MyMemory            —— 公共兜底
  const sources = [];
  sources.push({ kind: 'google', url: gUrl, parse: gParse, timeout: 2500 });
  if (proxyOk !== false) sources.push({ kind: 'proxy', url: `${API_BASE}/translate?tl=${tl}&q=${q}`, parse: pParse, timeout: 9000 });
  sources.push({ kind: 'mymemory', url: `https://api.mymemory.translated.net/get?langpair=zh|${target}&q=${q}`, parse: mmParse, timeout: 6000 });

  const errs = []; // 记录每个源失败原因，便于用户反馈时定位
  for (const s of sources) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), s.timeout);
    try {
      const r = await fetch(s.url, { cache: 'no-store', signal: ctrl.signal });
      if (s.kind === 'proxy') proxyOk = r.ok; // 记录代理可用性（失败后不再请求）
      if (!r.ok) { errs.push(`${s.kind}=HTTP${r.status}`); continue; }
      const out = s.parse(await r.json());
      if (out) return out;
      errs.push(`${s.kind}=空`);
    } catch (e) {
      errs.push(`${s.kind}=${(e && e.name) || '网络错误'}`);
      if (s.kind === 'proxy') proxyOk = false;
    } finally { clearTimeout(timer); }
  }
  throw new Error(errs.join(' / ') || '全部翻译源失败');
}

// 从缓存生成译文块（已展开但缓存缺失时返回「翻译中…」占位）
function trBlocksHtml(m, lang) {
  return trSegs(m).map((s) => {
    const t = trGet(s.text, lang);
    const body = t != null
      ? withEmoji(escapeHtml(t))
      : '<span class="tr-loading">' + trUI('loading', lang) + '</span>';
    const lab = s.label ? `<span class="tr-label">${escapeHtml(s.label)}</span>` : '';
    return `<div class="tr-item">${lab}<span class="tr-text">${body}</span></div>`;
  }).join('');
}

// 翻译一条消息的全部片段，写入 #tr-<mid>；逐个请求并加微小间隔避免限流
async function doTranslate(mid) {
  const m = MSG_INDEX.get(mid);
  if (!m) return;
  const lang = state.lang;
  if (lang === 'zh') return;
  const segs = trSegs(m);
  if (!segs.length) return;
  for (const s of segs) {
    let t = trGet(s.text, lang);
    if (t == null) {
      try {
        t = await translateText(s.text, lang);
        trSet(s.text, lang, t);
      } catch (e) {
        t = '__ERR__' + ((e && e.message) || '失败');
      }
    }
    s._t = t;
    await new Promise((r) => setTimeout(r, 120));
  }
  const box = document.getElementById('tr-' + mid);
  if (box) {
    box.innerHTML = segs.map((s) => {
      const isErr = typeof s._t === 'string' && s._t.startsWith('__ERR__');
      const body = isErr
        ? `<span class="tr-err">${trUI('fail', lang)}（${escapeHtml(s._t.slice(7))}）</span>`
        : withEmoji(escapeHtml(s._t));
      return `<div class="tr-item">${s.label ? `<span class="tr-label">${escapeHtml(s.label)}</span>` : ''}` +
        `<span class="tr-text">${body}</span></div>`;
    }).join('');
  }
}

// 翻译当前可见的全部消息（带并发上限，避免一次性打爆接口）
async function translateAllVisible() {
  const boxes = [...panels.messages.querySelectorAll('.msg-tr')];
  let i = 0;
  const worker = async () => {
    while (i < boxes.length) {
      const box = boxes[i++];
      const mid = box.id.replace(/^tr-/, '');
      if (!MSG_INDEX.get(mid)) continue;
      state.expanded.add(mid);
      await doTranslate(mid);
    }
  };
  panels.messages.querySelectorAll('.tr-btn').forEach((b) => { b.textContent = trUI('hide', state.lang); });
  await Promise.all(Array.from({ length: 4 }, worker));
}

/* ---------------- 数据加载 ---------------- */
// 加载策略（兼顾「快」与「新」，且对手机/弱网友好）：
//   ① 先用 ~500 字节的 meta.json 取当前数据版本（lastUpdated），该请求每次都取最新（开销可忽略）；
//   ② 再以 <script src="./data/archive.js?v=<版本>"> 加载大文件：
//        数据没变 → 版本号没变 → 浏览器/CDN 直接命中缓存（秒开，不再重下十几 MB）；
//        数据一变 → 版本号随之变化 → URL 不同 → 自动拉到最新，且不会命中旧缓存。
//   ③ 失败自动换一种 URL 再试一次（弱网、连接中断很常见），仍失败才提示，并附上真实原因。
// 说明：改用 <script> 注入而非 fetch + new Function()，让浏览器原生解析，
//      避免再把十几 MB 的源码字符串复制一份交给 V8 编译，显著降低手机端内存峰值。
function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = () => { if (s.parentNode) s.parentNode.removeChild(s); resolve(); };
    s.onerror = () => { if (s.parentNode) s.parentNode.removeChild(s); reject(new Error('无法下载数据文件 data/archive.js')); };
    (document.head || document.body).appendChild(s);
  });
}

// 取当前数据版本：用体积极小的 meta.json（每次都强制取最新）。取不到则返回空串。
async function dataVersion() {
  try {
    const r = await fetch(`./data/meta.json?t=${Date.now()}`, { cache: 'no-store' });
    if (r.ok) {
      const m = await r.json();
      if (m && m.lastUpdated) return String(m.lastUpdated);
    }
  } catch (_) { /* 取不到版本就退回不带版本号的 URL */ }
  return '';
}

// 从 Worker 数据 API 取 JSON（数据存 KV，no-store 保证刷新即拿最新）
async function fetchApi(path) {
  const r = await fetch(API_BASE + path, { cache: 'no-store' });
  if (!r.ok) throw new Error('加载 ' + path + ' 失败: ' + r.status);
  return r.json();
}

// 惰性加载某月发言（合并进 DATA.messages，按 msgKey 去重）。已加载则跳过。
// 同一月份「正在加载中」时复用同一个 Promise —— 后台并行补齐与「首屏预拉当月」可能同时要这个月，
// 没有它的话第二方会直接 early-return（以为已完成），拿到的其实是空数据。
const monthPromises = new Map();
async function loadMonth(m, silent) {
  if (!m) return;
  if (monthPromises.has(m)) return monthPromises.get(m); // 已在加载 → 复用，不重复请求
  if (loadedMonths.has(m)) return;
  const p = (async () => {
    loadedMonths.add(m);
    try {
      const arr = await fetchApi('/api/month?m=' + encodeURIComponent(m));
      const map = new Map();
      for (const x of DATA.messages) map.set(msgKey(x), x);
      for (const x of arr) map.set(msgKey(x), x);
      DATA.messages = [...map.values()];
    } catch (e) {
      loadedMonths.delete(m); // 允许重试
      if (!silent) throw e;
    }
  })();
  monthPromises.set(m, p);
  const cleanup = () => monthPromises.delete(m);
  p.then(cleanup, cleanup); // 用 then(, ) 而非 finally：避免非 silent 失败时产生 unhandled rejection
  return p;
}

function bjMonth(ts) {
  const d = new Date((ts == null ? Date.now() : ts) + 8 * 3600 * 1000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// 后台静默补齐「其余历史月份」。
// 为什么必须做：数据改按月分键存 KV 后，首屏只有 recent + 当前月，
// 若只靠「加载更早」按钮那就一次只多拉 1 个月 —— 想翻到两年前要点击上百次，
// 搜索/日期筛选也只能搜到已加载的那一小段，体验远不如以前一次性读整份数据。
// 历史月内容永不再变（且 /api/month 允许浏览器/CDN 缓存），所以后台并行拉完最划算：
// 首屏不受影响，拉完后「加载更早」/搜索/日期筛选恢复全量语义。
// ★ 全程**静默**：不给加载过程任何提示，只有「搜索/筛选正等数据」时才在工具栏显示小字。
let allMonthsPromise = null;
let allMonthsLoaded = false;

// 并行度 8：实测 44 个月「串行 54s / 并行 8 路 2.1s」，是收益最大的那个点
// （再高会被浏览器同域连接数上限拖慢，实测 44 路并发反而回落到 4s）。
const MONTH_CONCURRENCY = 8;

// 返回同一个 Promise，可安全地被首屏加载、搜索、日期筛选多处重复 await。
function loadRemainingMonths() {
  if (allMonthsPromise) return allMonthsPromise;
  const todo = ALL_MONTHS.filter((m) => !loadedMonths.has(m));
  if (!todo.length) { allMonthsLoaded = true; allMonthsPromise = Promise.resolve(); return allMonthsPromise; }
  allMonthsPromise = (async () => {
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const m = todo[i++];
        // 并发下每个 loadMonth 在 await 之后才读 DATA.messages、并同步写回，
        // 中间没有 await → 单线程下不会交错，无需加锁。
        try { await loadMonth(m, true); } catch (_) { /* 单月失败不影响其余 */ }
      }
    };
    await Promise.all(Array.from({ length: Math.min(MONTH_CONCURRENCY, todo.length) }, worker));
    rebuildIndex();
    allMonthsLoaded = true;
    hideBusy(); // 数据到齐：收起「搜索中…」小字
    if (state.tab === 'messages' && (state.query || dateFilterActive())) {
      // 正在搜索/筛选：必须重绘才能把新补进来的历史结果显示出来
      const y = window.scrollY;
      renderMessages();
      window.scrollTo(0, y);
    } else {
      // 普通浏览：**不整表重绘**（刚打开就重绘会闪一下、打断阅读）。
      // 这里只把「加载更早」的剩余条数就地改成真实值。
      const btn = document.getElementById('loadMore');
      if (btn) {
        const groups = {};
        for (const m of DATA.messages) {
          const d = fmtDate(m.msgTime) || '未知日期';
          (groups[d] ||= []).push(m);
        }
        const days = Object.keys(groups).sort((a, b) => (b > a ? 1 : -1));
        const restDays = days.length - Math.min(state.dayLimit, days.length);
        if (restDays > 0) {
          const restCount = days.slice(state.dayLimit).reduce((n, d) => n + groups[d].length, 0);
          btn.textContent = `加载更早的消息（还有 ${restCount} 条 / ${restDays} 天）`;
        } else {
          btn.remove();
        }
      }
    }
  })();
  return allMonthsPromise;
}

async function loadArchive() {
  // 主路径：从 Worker 数据 API 读取（数据存 KV → 站点零部署更新、实时秒更）
  try {
    const idx = await fetchApi('/api/index');   // { months, recent, updatedAt, meta }
    if (idx && ((idx.months && idx.months.length) || (idx.recent && idx.recent.length))) {
      DATA.meta = idx.meta || {};
      DATA.messages = idx.recent || [];
      ALL_MONTHS = (idx.months || []).slice();    // 降序，最新月份在前
      loadedMonths = new Set();
      // ★ 重载时必须把「月份加载状态」一并复位。否则 loadRemainingMonths() 会直接返回
      //   上一次已经完成的 Promise，历史月再也不会被拉进来 —— 刷新之后搜索/时间筛选就失效了
      //   （表现为「刷新完反而搜不到以前的数据」）。
      allMonthsPromise = null;
      allMonthsLoaded = false;
      monthPromises.clear();
      // ★ 历史月是「搜索 / 时间筛选 / 加载更早」的前提，必须在拿到月份清单的**那一刻**就
      //   最优先开始下载——不能排在 live/performances/social 后面，否则用户要多等同样长的时间
      //   才能搜到历史。这里立刻启动（不 await，不阻塞首屏；搜索/筛选会 await 同一个 Promise）。
      loadRemainingMonths();
      // 首屏只额外等「当月」补全（它就在上面那批并行下载里，await 到的是同一个 Promise）
      await loadMonth(bjMonth(Date.now()), true);
      const [live, perfs, social, perfCuts, liveCuts] = await Promise.all([
        fetchApi('/api/live'), fetchApi('/api/performances'), fetchApi('/api/social'), fetchApi('/api/perf-cuts'),
        // 「直播切片」是锦上添花的数据：单独失败不该拖垮整页
        // （否则整个 API 分支抛错 → 回退去下 19MB 静态 archive.js，因小失大）
        fetchApi('/api/live-cuts').catch(() => null)
      ]);
      DATA.live = live || [];
      DATA.performances = perfs || [];
      DATA.social = social || [];
      DATA.perfCuts = (perfCuts && Array.isArray(perfCuts.cuts)) ? perfCuts : null;
      DATA.liveCuts = (liveCuts && Array.isArray(liveCuts.cuts)) ? liveCuts : null;
      return { meta: DATA.meta, messages: DATA.messages, live: DATA.live, performances: DATA.performances };
    }
  } catch (_) { /* 落到静态兜底 */ }

  // 兜底：KV 无数据或接口异常 → 读旧静态 archive.js（最后一次部署的快照）
  return loadArchiveStatic();
}

// 静态兜底（保留旧逻辑）：注入 ./data/archive.js → 读 window.__ARCHIVE__
async function loadArchiveStatic() {
  const isFile = location.protocol === 'file:';
  let candidates;
  if (isFile) {
    candidates = ['./data/archive.js'];
  } else {
    const ver = await dataVersion();
    candidates = ver
      ? [`./data/archive.js?v=${encodeURIComponent(ver)}`, `./data/archive.js?t=${Date.now()}`]
      : [`./data/archive.js?t=${Date.now()}`];
  }
  let lastErr = null;
  for (const src of candidates) {
    try {
      await injectScript(src);
      if (window.__ARCHIVE__) {
        DATA.social = window.SOCIAL_MEDIA || [];
        DATA.perfCuts = window.PERF_CUTS || null;
        DATA.liveCuts = window.LIVE_CUTS || null;
        return window.__ARCHIVE__;
      }
      lastErr = new Error('数据文件内容为空');
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('加载数据文件 data/archive.js 失败');
}

async function init() {
  let data = null;
  let err = null;
  try {
    data = await loadArchive();
  } catch (e) {
    err = e;
    if (window.__ARCHIVE__) data = window.__ARCHIVE__; // 兜底层：拿不到新数据时先用已加载的旧数据
  }
  if (!data) {
    document.querySelector('.content').innerHTML =
      `<div class="empty-state">数据加载失败：${escapeHtml((err && err.message) || '未知原因')}<br/>` +
      `请检查网络后刷新重试；若持续失败，说明数据可能尚未部署完成。</div>`;
    return;
  }
  DATA.meta = data.meta;
  DATA.messages = data.messages || [];
  DATA.live = data.live || [];
  DATA.performances = data.performances || [];
  rebuildIndex();
  renderMeta();
  bindEvents();
  switchTab(state.tab); // 走一遍 tab 切换逻辑：正确显示/隐藏「时间」按钮并渲染当前面板
}

function rebuildIndex() {
  MSG_INDEX.clear();
  for (const m of DATA.messages) MSG_INDEX.set(msgKey(m), m);
}

async function fetchJson(name) {
  const res = await fetch(`./data/${name}`);
  if (!res.ok) throw new Error(`加载 ${name} 失败: ${res.status}`);
  return res.json();
}

/* ---------------- 使用统计 ---------------- */
// 只记「发生了什么动作」的次数（如切到哪个 tab、播放视频、点开美图），
// 不含任何发言内容 / 个人信息；请求失败一律忽略，绝不影响正常使用。
// 用 1x1 图片发请求：不受跨域限制、不阻塞页面、关闭页面也能发出。
function track(ev) {
  try {
    new Image().src = './track?e=' + encodeURIComponent(String(ev).slice(0, 40)) + '&t=' + Date.now();
  } catch (_) { /* 忽略 */ }
}

// 搜索框防抖统计（停止输入 800ms 才记一次，避免敲每个字都打点）
let trackSearchTimer = null;
function trackSearch() {
  clearTimeout(trackSearchTimer);
  trackSearchTimer = setTimeout(() => track('search'), 800);
}

/* ---------------- 检查更新 ---------------- */
function showToast(msg, isError, linkUrl) {
  let t = document.getElementById('toast');
  if (!t) { t = document.createElement('div'); t.id = 'toast'; t.className = 'toast'; document.body.appendChild(t); }
  if (linkUrl) {
    t.innerHTML = '';
    const span = document.createElement('span');
    span.textContent = msg + ' ';
    const a = document.createElement('a');
    a.href = linkUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = '点此在 GitHub 手动触发';
    a.style.color = '#fff';
    a.style.textDecoration = 'underline';
    t.appendChild(span);
    t.appendChild(a);
  } else {
    t.textContent = msg;
  }
  t.style.background = isError ? '#c0392b' : '#2bc4e0';
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 4200);
}

/* ---------------- 刷新：触发一次最新抓取 + 拉取最新数据 ----------------
 * 点刷新 = 经 Worker 静默触发一次后台抓取（Worker 内部有 15 分钟冷却，粉丝狂点也不会把 GitHub 打爆），
 * 随后立即重新加载当前已部署的最新数据。全程不弹提示、不开新标签，对外完全无感；
 * 若 Cloudflare 密钥未配置导致触发失败，则仅拉取最新数据，不影响浏览。 */
async function checkForUpdates() {
  const btn = document.getElementById('refreshBtn');
  if (!btn || btn.disabled) return;
  const oldText = btn.textContent;
  const beforeTs = String((DATA.meta && DATA.meta.lastUpdated) || '');
  track('refresh');
  btn.disabled = true;
  btn.textContent = '刷新中…';

  // 先用 500 字节的 meta.json 看版本号：数据没变就完全不用重下十几 MB 的 archive.js（接近「秒响应」）
  const applyLatest = async () => {
    const data = await loadArchive();
    DATA.meta = data.meta;
    DATA.messages = data.messages || [];
    DATA.live = data.live || [];
    DATA.performances = data.performances || [];
    rebuildIndex();
    renderMeta();
    renderAll();
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const release = () => { btn.disabled = false; btn.textContent = oldText; };

  let triggered = false;
  try {
    // 1) 比「数据版本号」，相等就不用重下。
    // ★ 版本号必须取自 KV（/api/index 的 meta.lastUpdated）。
    //   数据现在存 KV，而静态 ./data/meta.json 是「上次部署时」的快照、
    //   根本不随抓取更新 —— 拿它跟 KV 的时间比永远不相等，会导致
    //   「点刷新 → 立刻提示已同步 → 实际根本没触发抓取」（用户反馈「手动点更新也没更新」就是这个）。
    const idx = await fetchApi('/api/index');
    const nowVer = String((idx && idx.meta && idx.meta.lastUpdated) || '');
    if (beforeTs && nowVer && nowVer !== beforeTs) {
      await applyLatest();
      showToast('✅ 已同步到最新补档');
      return; // ← finally 会负责恢复按钮
    }

    // 2) 数据没变化 → 触发一次后台抓取（GitHub Actions）
    //    ⚠️ 必须带 Content-Type + body：裸的「空 body POST」会被 Cloudflare 的防护规则拦掉
    //    （前端只会看到 Failed to fetch），曾导致点「刷新」看似有反应、实际根本没触发抓取。
    try {
      const r = await fetch('/scrape', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        cache: 'no-store'
      });
      const j = await r.json().catch(() => ({}));
      triggered = r.ok && !j.skipped;
      if (!r.ok) showToast('⚠️ 触发抓取失败，请稍后再试', true);
    } catch (_) {
      showToast('⚠️ 连接服务器失败，请稍后再试', true);
    }

    // 3) 现在数据走 KV：抓取 2~4 分钟（慢的时候见过 7 分钟）+ KV 写入传播最长约 60 秒。
    //    窗口给足 10 分钟，避免「明明抓到了却等到超时」；按钮在 60 秒时就已还给粉丝
    //    （见下面的 release()），这里只是继续静默等待，不阻塞任何操作。
    const deadline = Date.now() + 600 * 1000;
    let waited = 0, updated = false;
    while (Date.now() < deadline) {
      await sleep(10000); waited += 10;
      btn.textContent = `同步中 ${waited}s…`;
      try {
        // 同上：轮询也要看 **KV** 的版本号。原先读静态 meta.json，
        // 它永远不会变 → 永远等不到变化 → 之前每次点刷新都以「已是最新」收尾。
        const idx2 = await fetchApi('/api/index');
        const v = String((idx2 && idx2.meta && idx2.meta.lastUpdated) || '');
        if (v && v !== beforeTs) {
          await applyLatest();
          updated = true;
          showToast('✅ 已同步到最新补档');
          break;
        }
        // 等满 60 秒还没变化就先把按钮还给粉丝（继续在后台静默轮询），不让刷新键被锁死
        if (waited >= 60) release();
      } catch (_) { /* 继续等 */ }
    }
    // 等完还没变化就明确告诉粉丝结果，避免「点了没反应」的困惑
    if (!updated) {
      showToast(triggered ? '⏳ 已触发抓取，约 3~5 分钟后刷新即可看到最新' : '抓取刚跑过，稍后再点一次');
    }
  } finally {
    release();
  }
}

function renderMeta() {
  const m = DATA.meta;
  if (!m) return;
  $('#memberName').textContent = m.member.name || '王语晨';
  $('#memberSub').textContent = `${m.member.groupName || 'GNZ48'} ${m.member.team || ''} · ${m.member.period || ''}`.trim();
  $('#statMsg').textContent = m.counts.messages ?? DATA.messages.length;
  $('#statLive').textContent = m.counts.live ?? DATA.live.length;
  $('#statPerf').textContent = m.counts.performances ?? DATA.performances.length;
  // 更新时间：宽屏显示完整时间，窄屏（≤560px）自动切换成「HH:MM 更新」，避免挤到右侧按钮
  const upEl = $('#updatedAt');
  if (upEl) {
    if (!m.lastUpdated) {
      upEl.textContent = '';
    } else {
      // 北京时间（UTC+8）：宽屏「更新于 YYYY-MM-DD HH:MM」，窄屏「HH:MM 更新」
      const hhmm = fmtTime(m.lastUpdated).slice(0, 5);
      upEl.innerHTML =
        `<span class="upd-full">更新于 ${fmtDate(m.lastUpdated)} ${hhmm}</span>` +
        `<span class="upd-mini">${hhmm} 更新</span>`;
    }
  }
}

/* ---------------- 事件 ---------------- */
function bindEvents() {
  const refreshBtn = document.getElementById('refreshBtn');
  if (refreshBtn) refreshBtn.addEventListener('click', checkForUpdates);

  // 多语言：切换目标语言 → 清空展开态、显隐「翻译本页」、重渲染消息列表
  const langSelect = document.getElementById('langSelect');
  if (langSelect) {
    langSelect.addEventListener('change', (e) => {
      state.lang = e.target.value;
      state.expanded.clear();
      const trAll = document.getElementById('trAllBtn');
      if (trAll) { trAll.hidden = state.lang === 'zh'; trAll.textContent = trUI('page', state.lang); }
      if (state.tab === 'messages') renderMessages();
      track('lang:' + state.lang);
    });
  }
  const trAllBtn = document.getElementById('trAllBtn');
  if (trAllBtn) {
    trAllBtn.textContent = trUI('page', state.lang);
    trAllBtn.addEventListener('click', async () => {
      panels.messages.querySelectorAll('.msg-tr').forEach((box) => {
        state.expanded.add(box.id.replace(/^tr-/, ''));
      });
      renderMessages();
      await translateAllVisible();
    });
  }

  document.querySelectorAll('.tab').forEach((btn) => {
    btn.addEventListener('click', () => { switchTab(btn.dataset.tab); track('tab:' + btn.dataset.tab); });
  });
  $('#searchInput').addEventListener('input', (e) => {
    state.query = e.target.value.trim().toLowerCase();
    renderAll();
    if (state.query) trackSearch(); // 只在真的输入了内容时才记
    // ★ 搜索必须覆盖「全部历史」，否则就是假阴性：数据按月分键、首屏只有 recent+当月，
    //   历史月还在后台拉的时候立刻下结论，用户就会以为「搜不到老发言」。
    //   故搜索时等全量补齐后再重渲一次（并行 8 路，实测约 2 秒），期间在工具栏显示「搜索中…」。
    if (state.query && !allMonthsLoaded) {
      showBusy('搜索中…');
      loadRemainingMonths().then(() => { if (state.query) renderAll(); });
    } else if (!state.query) {
      hideBusy();
    }
  });
  // 时间筛选：弹窗 + 点「确认」才刷新；含「全部 / 近 N 天」快捷
  const dateModal = document.getElementById('dateModal');
  const openDateModal = () => {
    $('#dateFrom').value = state.dateFrom ? toDateInput(state.dateFrom) : '';
    $('#dateTo').value = state.dateTo ? toDateInput(state.dateTo - 1) : ''; // dateTo 存的是「次日 0 点」，回填减一天
    dateModal.hidden = false;
  };
  const closeDateModal = () => { dateModal.hidden = true; };
  const dateToggle = document.getElementById('dateToggleBtn');
  if (dateToggle) dateToggle.addEventListener('click', openDateModal);
  if (dateModal) {
    dateModal.addEventListener('click', (e) => { if (e.target === dateModal) closeDateModal(); });
    document.getElementById('dateCancel').addEventListener('click', closeDateModal);
    dateModal.querySelectorAll('[data-quick]').forEach((b) => {
      b.addEventListener('click', () => {
        const q = b.dataset.quick;
        if (q === 'all') { $('#dateFrom').value = ''; $('#dateTo').value = ''; return; }
        const days = Number(q) || 7;
        $('#dateFrom').value = toDateInput(Date.now() - (days - 1) * 86400000);
        $('#dateTo').value = toDateInput(Date.now());
      });
    });
    document.getElementById('dateConfirm').addEventListener('click', () => {
      track('filter:date');
      const f = $('#dateFrom').value, t = $('#dateTo').value;
      // 固定按北京时间 0 点（+08:00）取边界，避免访客本地时区导致前后差一天
      state.dateFrom = f ? new Date(f + 'T00:00:00+08:00').getTime() : null;          // 当天 0 点
      state.dateTo = t ? new Date(t + 'T00:00:00+08:00').getTime() + 86400000 : null; // 次日 0 点（含当天）
      closeDateModal();
      state.dayLimit = 3;
      renderAll(); // 发言 / 直播录播 / 公演 三个页都要按新时间范围刷新
      showToast(state.dateFrom || state.dateTo ? '✅ 已按时间筛选' : '✅ 已显示全部时间');
      // 同搜索：按时间筛选也必须覆盖全部历史月，否则早年区间会显示「没有发言」。
      if ((state.dateFrom || state.dateTo) && !allMonthsLoaded) {
        showBusy('筛选中…');
        loadRemainingMonths().then(() => renderAll());
      } else {
        hideBusy();
      }
    });
  }
  // 图片放大预览：支持点击放大、在新标签打开原图、下载，方便保存
  const lb = document.createElement('div');
  lb.className = 'lightbox';
  lb.innerHTML = `
    <div class="lb-bar">
      <button class="lb-btn" id="lbOpen" type="button">⤢ 打开原图</button>
      <button class="lb-btn" id="lbSave" type="button">⤓ 下载</button>
      <button class="lb-btn" id="lbClose" type="button">✕ 关闭</button>
    </div>
    <div class="lb-stage">
      <img alt="图片预览" referrerpolicy="no-referrer" />
    </div>
    <div class="lb-tip">点击空白处关闭</div>`;
  const lbImg = lb.querySelector('img');
  lbImg.addEventListener('load', () => lb.classList.remove('loading'));
  lbImg.addEventListener('error', () => {
    lb.classList.remove('loading');
    lb.classList.add('broken');
  });

  window.__lightboxShow = (src) => {
    if (!src) return;
    lb.dataset.src = src;
    lb.classList.add('show', 'loading');
    lb.classList.remove('broken');
    lbImg.src = src;
  };
  lb.querySelector('#lbOpen').addEventListener('click', () => {
    const s = lb.dataset.src;
    if (s) window.open(s, '_blank', 'noopener');
  });
  lb.querySelector('#lbSave').addEventListener('click', () => {
    const s = lb.dataset.src;
    if (!s) return;
    const name = (s.split('/').pop().split('?')[0]) || 'image.jpg';
    fetch(s, { referrerPolicy: 'no-referrer' })
      .then((r) => { if (!r.ok) throw new Error('net'); return r.blob(); })
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = name;
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
      })
      .catch(() => { if (s) window.open(s, '_blank', 'noopener'); });
  });
  lb.querySelector('#lbClose').addEventListener('click', () => lb.classList.remove('show'));
  lb.addEventListener('click', (e) => {
    // 点图片本体或工具栏时不关闭
    if (e.target.closest('.lb-bar') || e.target.tagName === 'IMG') return;
    lb.classList.remove('show');
  });
  document.body.appendChild(lb);
  window.__lightbox = lb;

  // 视频播放器事件
  $('#playerClose').addEventListener('click', closePlayer);
  $('#playerModal').addEventListener('click', (e) => { if (e.target === $('#playerModal')) closePlayer(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('#playerModal').hidden) closePlayer(); });

  // 卡片「播放」按钮 + 新粉指南社交按钮（事件委托）
  document.querySelector('.content').addEventListener('click', (e) => {
    // 翻译开关：点开才请求译文，再点收起
    const trBtn = e.target.closest('.tr-btn');
    if (trBtn) {
      e.stopPropagation();
      const mid = trBtn.dataset.mid;
      const box = document.getElementById('tr-' + mid);
      if (state.expanded.has(mid)) {
        state.expanded.delete(mid);
        trBtn.textContent = trUI('translate', state.lang);
        if (box) box.innerHTML = '';
      } else {
        state.expanded.add(mid);
        trBtn.textContent = trUI('hide', state.lang);
        if (box) box.innerHTML = trBlocksHtml(MSG_INDEX.get(mid) || {}, state.lang);
        doTranslate(mid);
      }
      return;
    }
    const playBtn = e.target.closest('.play-btn');
    if (playBtn) {
      e.stopPropagation();
      track('play');
      openPlayer(playBtn.dataset.play, playBtn.dataset.title);
      return;
    }
    const biliLink = e.target.closest('.bili-btn');
    if (biliLink) { track('bili'); return; }
    const socialBtn = e.target.closest('.social-btn');
    if (socialBtn) {
      e.stopPropagation();
      openSocial(socialBtn.dataset.web, socialBtn.dataset.scheme);
      return;
    }
    // 子标签切换（公演 / 新粉指南 共用 .subtab）
    const subBtn = e.target.closest('.subtab');
    if (subBtn) {
      e.stopPropagation();
      track('sub:' + subBtn.dataset.sub);
      if (state.tab === 'performances') {
        state.perfSub = subBtn.dataset.sub;
        panels.performances.querySelectorAll('.subtab').forEach((b) =>
          b.classList.toggle('active', b.dataset.sub === state.perfSub));
        renderPerfSub();
      } else if (state.tab === 'live') {
        state.liveSub = subBtn.dataset.sub;
        panels.live.querySelectorAll('.subtab').forEach((b) =>
          b.classList.toggle('active', b.dataset.sub === state.liveSub));
        renderLiveSub();
      } else {
        state.guideSub = subBtn.dataset.sub;
        panels.guide.querySelectorAll('.subtab').forEach((b) =>
          b.classList.toggle('active', b.dataset.sub === state.guideSub));
        renderGuideSub();
      }
      return;
    }
    // 开播推送卡片 → 站内「直播 / 录播」页
    const gotoBtn = e.target.closest('[data-goto]');
    if (gotoBtn) {
      e.stopPropagation();
      switchTab(gotoBtn.dataset.goto);
      return;
    }
    // 列表上方的「清除筛选」
    if (e.target.closest('.filter-clear')) {
      e.stopPropagation();
      state.dateFrom = null;
      state.dateTo = null;
      state.dayLimit = 3;
      const f = $('#dateFrom'), t = $('#dateTo');
      if (f) f.value = '';
      if (t) t.value = '';
      renderAll();
      showToast('✅ 已清除时间筛选');
    }
  });
}

/* ---------------- 渲染 ---------------- */
function switchTab(name) {
  state.tab = name;
  document.querySelectorAll('.tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  Object.entries(panels).forEach(([k, el]) => el.classList.toggle('active', k === name));
  // 「📅 时间」筛选与「搜索」仅对「发言 / 直播 / 公演」有意义；新粉指南、行程页自带内容，隐藏这两项
  const isGuide = name === 'guide' || name === 'schedule' || name === 'mine';
  const df = $('#dateToggleBtn');
  if (df) df.hidden = isGuide;
  const si = $('#searchInput');
  if (si) si.hidden = isGuide;
  renderAll();
}

/* ---------- 时间筛选（发言 / 直播录播 / 公演 共用 state.dateFrom/dateTo） ---------- */
const dateFilterActive = () => !!(state.dateFrom || state.dateTo);
function inDateRange(ts) {
  const t = Number(ts);
  if (!t) return false;
  if (state.dateFrom && t < state.dateFrom) return false;
  if (state.dateTo && t > state.dateTo) return false; // dateTo 存「次日 0 点」，故含当天
  return true;
}
// 筛选生效时在列表上方显示一条提示 + 一键清除
function filterNote(count) {
  if (!dateFilterActive()) return '';
  const f = state.dateFrom ? fmtDate(state.dateFrom) : '最早';
  const t = state.dateTo ? fmtDate(state.dateTo - 86400000) : '最新';
  return `<div class="filter-note">📅 <b>${escapeHtml(f)}</b> ~ <b>${escapeHtml(t)}</b> · 共 ${count} 条` +
    `<button class="filter-clear" type="button">清除筛选</button></div>`;
}

// 工具栏「更新于」左侧的忙碌小字：只在「搜索 / 筛选正等着历史数据就绪」时出现，
// 数据一到就消失。后台静默补齐历史**不显示任何提示**（用户明确要求完全静默）。
let busyTimer = null;
function showBusy(text) {
  const el = document.getElementById('busyNote');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (busyTimer) clearTimeout(busyTimer);
  busyTimer = setTimeout(hideBusy, 15000); // 兜底：异常时最多显示 15 秒，不会卡住不消失
}
function hideBusy() {
  if (busyTimer) { clearTimeout(busyTimer); busyTimer = null; }
  const el = document.getElementById('busyNote');
  if (el) el.hidden = true;
}

function renderAll() {
  if (state.tab === 'messages') renderMessages();
  else if (state.tab === 'live') renderLive();
  else if (state.tab === 'guide') renderGuide();
  else if (state.tab === 'schedule') renderSchedule();
  else if (state.tab === 'mine') renderMine();
  else renderPerformances();
}

/* ---------------- 行程（数据源：微博 @GNZ48-王语晨的甜橙小铺「本周行程」） ----------------
 * ⚠️ 行程是「静态快照」而不是实时接口：数据由脚本抓一次写进 js/schedule.js /
 * js/theater-schedule.js，不会自己变新。所以必须写明发布时间和来源 ——
 * 超过 7 天就直说「可能已变动」，别让访客拿着过期行程当真跑去现场。
 */
function scSourceNote(src) {
  if (!src) return '';
  const day = String(src.pub || '').slice(0, 10);
  let age = null;
  if (day) {
    const a = Date.parse(day + 'T00:00:00Z'), b = Date.parse(fmtDate(Date.now()) + 'T00:00:00Z');
    if (isFinite(a) && isFinite(b)) age = Math.round((b - a) / 86400000);
  }
  const stale = age !== null && age > 7;
  const name = src.name ? escapeHtml(src.name) : '来源';
  const link = src.url
    ? ' <a href="' + escapeHtml(src.url) + '" target="_blank" rel="noopener">看原帖 ↗</a>' : '';
  const when = day ? '更新于 <b>' + escapeHtml(day) + '</b>'
    + (age === null ? '' : age <= 0 ? '（今天）' : '（' + age + ' 天前）') : '发布时间未知';
  return '<div class="sc-note' + (stale ? ' stale' : '') + '">'
    + (stale ? '⚠️ 这份行程 ' + when + '，可能有变动，出发前请先看原帖确认' : '📌 行程 ' + when)
    + ' · 来源 ' + name + link + '</div>';
}
function renderSchedule() {
  const S = window.__SCHEDULE__;
  const box = panels.schedule;
  if (!box) return;
  if (!S || (!S.items || !S.items.length) && (!S.future || !S.future.length)) {
    box.innerHTML = '<div class="empty">暂无行程信息。</div>';
    return;
  }
  const today = fmtDate(Date.now());
  // 距今几天：今天 0 / 明天 1 …
  const daysTo = (d) => {
    if (!d) return null;
    const a = Date.parse(d + 'T00:00:00Z'), b = Date.parse(today + 'T00:00:00Z');
    if (!isFinite(a) || !isFinite(b)) return null;
    return Math.round((a - b) / 86400000);
  };
  const dayTag = (d) => {
    const n = daysTo(d);
    if (n === null) return '';
    if (n === 0) return '<span class="sc-tag today">今天</span>';
    if (n === 1) return '<span class="sc-tag soon">明天</span>';
    if (n > 1) return `<span class="sc-tag">${n} 天后</span>`;
    return '<span class="sc-tag done">已结束</span>';
  };
  const kindIcon = (k) => (k === '见面会' ? '🤝' : k === '预告' ? '📣' : '🎭');

  // 按日期分组（近的在前）
  const groups = {}, order = [];
  (S.items || []).forEach((it) => {
    if (!groups[it.date]) { groups[it.date] = []; order.push(it.date); }
    groups[it.date].push(it);
  });
  order.sort((a, b) => (a < b ? -1 : 1));

  let html = '<div class="sc-wrap">';
  html += scSourceNote(S.source);
  order.forEach((d) => {
    const arr = groups[d];
    const passed = (daysTo(d) !== null && daysTo(d) < 0);
    html += `<section class="sc-day${passed ? ' passed' : ''}">`
      + `<h2 class="sc-day-h"><span class="sc-date">${escapeHtml(d.slice(5).replace('-', '/'))}</span>`
      + `<span class="sc-wd">${escapeHtml(arr[0].weekday || '')}</span>${dayTag(d)}</h2><div class="sc-list">`;
    arr.forEach((it) => {
      html += `<div class="sc-item"><span class="sc-ic">${kindIcon(it.kind)}</span>`
        + `<span class="sc-time">${escapeHtml(it.time || '')}</span>`
        + `<span class="sc-title">${escapeHtml(it.title || '')}</span>`
        + (it.kind ? `<span class="sc-kind">${escapeHtml(it.kind)}</span>` : '')
        + '</div>';
    });
    html += '</div></section>';
  });

  if (S.future && S.future.length) {
    html += '<section class="sc-day future"><h2 class="sc-day-h"><span class="sc-date">更远</span>'
      + '<span class="sc-wd">已知的安排</span></h2><div class="sc-list">';
    S.future.forEach((it) => {
      const n = daysTo(it.date);
      html += `<div class="sc-item"><span class="sc-ic">${kindIcon(it.kind)}</span>`
        + `<span class="sc-time">${escapeHtml(it.date || '')}</span>`
        + `<span class="sc-title">${escapeHtml(it.title || '')}</span>`
        + (n && n > 0 ? `<span class="sc-kind">还有 ${n} 天</span>` : '')
        + '</div>';
    });
    html += '</div></section>';
  }

  if (S.ticket) html += `<div class="sc-note">🎟️ 可使用券种：${escapeHtml(S.ticket)}</div>`;
  if (S.note) html += `<div class="sc-note subtle">${escapeHtml(S.note)}</div>`;
  html += '<div class="sc-links">';
  if (S.callUrl) html += `<a class="sc-btn" href="${escapeHtml(S.callUrl)}" target="_blank" rel="noopener">Call 本 ↗</a>`;
  html += '</div></div>';
  html += renderTheaterSchedule(daysTo);
  box.innerHTML = html;
}

/* ---------------- 行程 · 星梦剧院官方公演安排（只取 NIII / 全团联合） ----------------
 * 数据：demo 专属 js/theater-schedule.js → window.__THEATER_SCHEDULE__
 * 官方一帖列出 G / Z / NIII / 全团联合 / 偶像研究计划 全部场次，这里只留王语晨所在队与全团场。
 */
function renderTheaterSchedule(daysTo) {
  const T = window.__THEATER_SCHEDULE__;
  if (!T || !T.items || !T.items.length) return '';
  const today = fmtDate(Date.now());
  const d2 = daysTo || ((d) => {
    if (!d) return null;
    const a = Date.parse(d + 'T00:00:00Z'), b = Date.parse(today + 'T00:00:00Z');
    return (isFinite(a) && isFinite(b)) ? Math.round((a - b) / 86400000) : null;
  });
  const dayTag = (d) => {
    const n = d2(d);
    if (n === null) return '';
    if (n === 0) return '<span class="sc-tag today">今天</span>';
    if (n === 1) return '<span class="sc-tag soon">明天</span>';
    if (n > 1) return `<span class="sc-tag">${n} 天后</span>`;
    return '<span class="sc-tag done">已结束</span>';
  };
  const groups = {}, order = [];
  T.items.forEach((it) => { if (!groups[it.date]) { groups[it.date] = []; order.push(it.date); } groups[it.date].push(it); });
  order.sort();

  const first = order[0], last = order[order.length - 1];
  const fmt = (x) => x.slice(5).replace('-', '/');
  const range = first === last ? fmt(first) : fmt(first) + ' - ' + fmt(last);

  let h = '<div class="sc-wrap sc-wrap2">';
  h += '<h3 class="sc-sec-h">🏛 星梦剧院 · 官方公演安排'
    + `<span class="sc-range">${escapeHtml(range)}</span>`
    + '<span class="sc-sec-tag">NIII / 全团联合</span></h3>';
  h += scSourceNote(T.source);
  order.forEach((d) => {
    const arr = groups[d];
    const passed = (d2(d) !== null && d2(d) < 0);
    h += `<section class="sc-day${passed ? ' passed' : ''}">`
      + `<h2 class="sc-day-h"><span class="sc-date">${escapeHtml(fmt(d))}</span>`
      + `<span class="sc-wd">${escapeHtml(arr[0].weekday || '')}</span>${dayTag(d)}</h2><div class="sc-list">`;
    arr.forEach((it) => {
      h += '<div class="sc-item">'
        + `<span class="sc-ic">${it.kind === '全团联合' ? '🎊' : '🎭'}</span>`
        + `<span class="sc-time">${escapeHtml(it.time || '')}</span>`
        + `<span class="sc-title">${escapeHtml(it.title || '')}</span>`
        + (it.kind ? `<span class="sc-kind">${escapeHtml(it.kind)}</span>` : '')
        + (it.flags && it.flags.length
          ? it.flags.map((f) => `<span class="sc-flag">${escapeHtml(f)}</span>`).join('') : '')
        + '</div>';
    });
    h += '</div></section>';
  });
  if (T.sales && T.sales.length) {
    h += `<div class="sc-note">🎫 票务：${T.sales.map((s) => escapeHtml(s)).join('；')}</div>`;
  }
  h += '</div>';
  return h;
}

/* ---------------- 我和她的房间（陪伴档案 · 只查自己，不做排名） ----------------
   数据：js/room-stats.js（window.__ROOM_STATS__），由 tools/build-companion.mjs 生成。
   隐私约定：数据里只有 uid + 统计数字（条数 / 日期位图 / 小时分布），
   没有昵称、没有留言正文、也没有「她回复了谁」「送了多少礼」这类可比字段。  */
const MINE_KEY = 'wyc-demo-mine-uid-v1';
// 鸡腿要不要写进分享图，由本人决定（默认写）
const GIFT_OPT_KEY = 'wyc-demo-mine-gift-opt-v1';
const giftOptOn = () => { try { return localStorage.getItem(GIFT_OPT_KEY) !== '0'; } catch (_) { return true; } };
const giftOptSet = (on) => { try { localStorage.setItem(GIFT_OPT_KEY, on ? '1' : '0'); } catch (_) {} };

function bjDayKey(ts) { return new Date(Number(ts) + 8 * 3600e3).toISOString().slice(0, 10); }

function decodeDayBitmap(b64, total) {
  try {
    const bin = atob(b64);
    const a = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    const out = [];
    for (let i = 0; i < total; i++) if (a[i >> 3] & (1 << (i & 7))) out.push(i);
    return out;
  } catch (e) { return []; }
}

const HOUR_BANDS = [
  { k: 'late', h: [22, 23, 0, 1, 2], name: '深夜守候型', desc: '晚上 10 点到凌晨 2 点' },
  { k: 'dawn', h: [5, 6, 7, 8], name: '早起的第一声', desc: '清晨 5 点到 9 点' },
  { k: 'morn', h: [9, 10, 11], name: '上午常客', desc: '上午 9 点到 12 点' },
  { k: 'noon', h: [12, 13, 14, 15, 16, 17], name: '午后时光', desc: '中午到傍晚' },
  { k: 'prime', h: [18, 19, 20, 21], name: '黄金档常驻', desc: '傍晚 6 点到 10 点' }
];

function mainBand(hs) {
  let best = HOUR_BANDS[4], bestN = -1;
  for (const b of HOUR_BANDS) {
    const n = b.h.reduce((s, i) => s + (Number(hs[i]) || 0), 0);
    if (n > bestN) { bestN = n; best = b; }
  }
  return best;
}

function mineBadges(u, band, dayKeys) {
  const out = [];
  if (u.b >= 30) out.push(['连续 ' + u.b + ' 天', 'amber']);
  const years = new Set(dayKeys.map((d) => d.slice(0, 4)));
  if (years.size >= 2) out.push(['陪她跨过 ' + years.size + ' 个年头', 'amber']);
  if (band.k === 'late') out.push(['深夜常客', 'teal']);
  if (u.n >= 1000) out.push(['第 1000 句', 'violet']);
  else if (u.n >= 100) out.push(['第 100 句', 'violet']);
  if (u.d >= 200) out.push(['来过 ' + u.d + ' 天', 'teal']);
  return out.slice(0, 5);
}

function mineCalendar(activeSet, fromKey, toKey, annMap) {
  const startMs = Date.parse(fromKey + 'T00:00:00Z');
  const endMs = Date.parse(toKey + 'T00:00:00Z');
  const s0 = new Date(startMs);
  const dow = (s0.getUTCDay() + 6) % 7;           // 周一 = 0
  let html = '<div class="mine-cal-wrap"><div class="mine-cal">';
  let n = 0;
  for (let t = startMs - dow * 86400e3; t <= endMs; t += 86400e3) {
    const k = new Date(t).toISOString().slice(0, 10);
    const on = activeSet.has(k);
    // 亮起来的格子按顺序依次放大出现（延迟封顶，避免 400 格排太久）
    const d = on ? Math.min(n, 90) * 4 : 0;
    if (on) n++;
    const ann = annMap && annMap[k];           // 纪念日：金边 + 中心小金点
    const cls = 'mc' + (on ? ' on' : '') + (ann ? ' ann' : '');
    const tip = ann ? ' title="认识 ' + ann + ' 天"' : '';
    html += `<i class="${cls}"${on ? ' style="animation-delay:' + d + 'ms"' : ''}${tip} data-d="${k}"></i>`;
  }
  html += '</div></div>'
    + '<div class="mine-cal-legend"><i class="mc"></i>没来过 <i class="mc on"></i>来过'
    + (annMap && Object.keys(annMap).length ? ' <i class="mc ann"></i>纪念日' : '') + '</div>';
  return html;
}

/* 纪念日：认识那天算第 1 天，所以「认识 N 天」= 起点往后 N-1 天。
   只认站长定的这几档；已经过去的列出日期，最近的一档给倒计时。 */
const ANN_DAYS = [100, 365, 500, 1000, 1500, 2000];
function addDaysKey(key, n) {
  return new Date(Date.parse(key + 'T00:00:00Z') + n * 86400e3).toISOString().slice(0, 10);
}
function mineAnniversaries(firstKey, nowDay, activeSet) {
  const nowMs = Date.parse(nowDay + 'T00:00:00Z');
  const passed = [], upcoming = [];
  ANN_DAYS.forEach((n) => {
    const k = addDaysKey(firstKey, n - 1);
    const ms = Date.parse(k + 'T00:00:00Z');
    if (ms <= nowMs) passed.push({ days: n, key: k, there: !!activeSet.has(k) });
    else upcoming.push({ days: n, key: k, left: Math.round((ms - nowMs) / 86400e3) });
  });
  return { passed, next: upcoming[0] || null, keys: passed.map((p) => p.key) };
}

/* ==================== 我和她的房间 · 数据来自服务端 ====================
 * 隐私红线（站长 2026-09-22 定）：粉丝名单不得以任何静态文件形式上公网。
 * 所以这里**不再有任何本地名单文件**——输入自己的 uid，向 Worker 单条回取属于你的那份数据。
 * （早年方案是加载 js/room-stats.js + js/gift-stats-2026.js 两份全量名单，已废弃。）
 */
// ⚠️ 必须和 API_BASE 用同一套判定：以前是「host 里含 cloudstudio/dev 才指线上」，
// 结果演示站的 `*.app.workbuddy.host` 不匹配 → 请求打到演示站自己的静态服务 → 404 → 前端只能报「网络问题」。
const MINE_API = (API_BASE || location.origin) + '/api/mine';

function renderMine() {
  const box = panels.mine;
  if (!box) return;
  buildMineShell(box);
}

function buildMineShell(box) {
  if (box.dataset.built === '1') return;   // 只搭一次骨架，避免重复绑定
  box.dataset.built = '1';
  box.innerHTML = '<div class="mine-wrap">'
    + '<div class="mine-head"><h3 class="mine-title">我和她的房间</h3>'
    + '<p class="mine-sub">输入你的口袋 uid，看看你陪她走了多久。</p></div>'
    + '<form class="mine-form" id="mineForm" autocomplete="off">'
    + '<input id="mineUid" class="mine-input" type="text" inputmode="numeric" placeholder="口袋 uid（纯数字）" aria-label="口袋 uid">'
    + '<button class="mine-btn" type="submit">查我的档案</button></form>'
    + '<div class="mine-saved" id="mineSaved" hidden>已记住这个 uid，下次打开自动查'
    + '<button type="button" class="mine-clear" id="mineClear">清除</button></div>'
    + '<div id="mineResult" class="mine-result"></div></div>';

  const form = document.getElementById('mineForm');
  const input = document.getElementById('mineUid');
  const savedRow = document.getElementById('mineSaved');
  const showSaved = (on) => { if (savedRow) savedRow.hidden = !on; };

  const clearUid = () => {
    try { localStorage.removeItem(MINE_KEY); } catch (e) {}
    if (input) input.value = '';
    showSaved(false);
    const res = document.getElementById('mineResult');
    if (res) res.innerHTML = '';
    mineHint('已清除，下次进来不会再自动带入');
  };
  const clearBtn = document.getElementById('mineClear');
  if (clearBtn) clearBtn.addEventListener('click', clearUid);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const uid = String(input.value || '').trim();
    if (!/^\d{4,12}$/.test(uid)) { mineHint('uid 是纯数字，再看一下'); return; }
    try { localStorage.setItem(MINE_KEY, uid); } catch (e) {}
    showSaved(true);
    lookupMine(uid);
  });
  let saved = '';
  try { saved = localStorage.getItem(MINE_KEY) || ''; } catch (e) {}
  // 旧版本存的是昵称（当时按昵称查），口径换了就丢掉，别拿去当 uid 用
  if (saved && !/^\d{4,12}$/.test(saved)) { try { localStorage.removeItem(MINE_KEY); } catch (e) {} saved = ''; }
  if (saved) { input.value = saved; showSaved(true); lookupMine(saved); }
}

// 「我和她的房间」的即时提示（app.js 里没有 toast，别跨脚本调用）
function mineHint(msg, ok) {
  let el = document.getElementById('mineHint');
  const form = document.getElementById('mineForm');
  if (!form) return;
  if (!el) {
    el = document.createElement('div');
    el.id = 'mineHint';
    el.className = 'mine-hint';
    form.parentNode.insertBefore(el, form.nextSibling);
  }
  el.className = 'mine-hint' + (ok ? ' ok' : '');
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => { if (el) el.textContent = ''; }, 4000);
}

function mineG(label, val, unit) {
  return '<div class="mine-g"><div class="mine-g-l">' + escapeHtml(label) + '</div>'
    + '<div class="mine-g-v">' + escapeHtml(String(val)) + '<small>' + escapeHtml(unit) + '</small></div></div>';
}

// 大数字从 0 滚上去（网易云年报那种感觉）
function mineCountUp() {
  document.querySelectorAll('.mine-report [data-count]').forEach((el) => {
    const target = Number(el.dataset.count) || 0;
    if (!target) { el.textContent = '0'; return; }
    const dur = 950, t0 = performance.now();
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / dur);
      const e = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(target * e).toLocaleString();
      if (p < 1) requestAnimationFrame(tick); else el.textContent = target.toLocaleString();
    };
    requestAnimationFrame(tick);
  });
}

/* ---------- 导出分享卡（canvas 手绘一张竖版长图，不依赖任何外部库） ----------
   卡片里只有「你自己的数字」，不含 uid、不含昵称、不含别人说过的话。 */
function rr(ctx, x, y, w, h, r) {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.arcTo(x + w, y, x + w, y + h, rad);
  ctx.arcTo(x + w, y + h, x, y + h, rad);
  ctx.arcTo(x, y + h, x, y, rad);
  ctx.arcTo(x, y, x + w, y, rad);
  ctx.closePath();
}

function wrapText(ctx, text, maxW, maxLines) {
  const out = [];
  let line = '';
  for (const ch of String(text)) {
    const t = line + ch;
    if (ctx.measureText(t).width > maxW && line) {
      out.push(line);
      line = ch;
      if (out.length === maxLines) break;
    } else line = t;
  }
  if (line && out.length < maxLines) out.push(line);
  if (out.length === maxLines && ctx.measureText(out[maxLines - 1]).width >= maxW - 1) {
    out[maxLines - 1] = out[maxLines - 1].slice(0, -1) + '…';
  }
  return out;
}

function drawShareCard(ctx, d, W, PAD, FONT, bgOnly, H) {
  const CW = W - PAD * 2;
  const cx = W / 2;
  const f = (w, s) => { ctx.font = w + ' ' + s + 'px ' + FONT; };
  ctx.textBaseline = 'top';

  if (bgOnly) {
    const bg = ctx.createLinearGradient(0, 0, W * .35, H);
    bg.addColorStop(0, '#1d3f66'); bg.addColorStop(.45, '#172340'); bg.addColorStop(1, '#1b1533');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    let g = ctx.createRadialGradient(W - 60, 40, 0, W - 60, 40, 330);
    g.addColorStop(0, 'rgba(53,224,200,.55)'); g.addColorStop(1, 'rgba(53,224,200,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    g = ctx.createRadialGradient(40, H * .45, 0, 40, H * .45, 300);
    g.addColorStop(0, 'rgba(255,122,184,.34)'); g.addColorStop(1, 'rgba(255,122,184,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  let y = 66;
  // 头像
  const r = 48;
  const ag = ctx.createLinearGradient(cx - r, y, cx + r, y + r * 2);
  ag.addColorStop(0, '#35e0c8'); ag.addColorStop(.5, '#58a6ff'); ag.addColorStop(1, '#b47aff');
  ctx.beginPath(); ctx.arc(cx, y + r, r, 0, Math.PI * 2); ctx.fillStyle = ag; ctx.fill();
  ctx.globalAlpha = .16; ctx.beginPath(); ctx.arc(cx, y + r, r + 8, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  f('400', 46); ctx.fillStyle = '#fff'; ctx.fillText('🐟', cx, y + r - 26);
  y += r * 2 + 32;

  // 标题
  const tg = ctx.createLinearGradient(PAD, y, W - PAD, y);
  tg.addColorStop(0, '#7ff0dd'); tg.addColorStop(.55, '#9fc8ff'); tg.addColorStop(1, '#e6b3ff');
  f('800', 42); ctx.fillStyle = tg; ctx.fillText(d.title || roomTitle(), cx, y);
  y += 42 + 16;
  f('400', 20); ctx.fillStyle = '#9fb3d1';
  ctx.fillText('从 ' + d.firstKey + ' 那天起', cx, y);
  y += 20 + 48;

  // 大数字
  f('400', 18); ctx.fillStyle = '#a9bcd8';
  ctx.fillText('认  识  她', cx, y);
  y += 30;
  const hg = ctx.createLinearGradient(PAD, y, W - PAD, y);
  hg.addColorStop(0, '#6ff2dd'); hg.addColorStop(.45, '#8fc4ff'); hg.addColorStop(1, '#f0a6ff');
  f('800', 96); const numTxt = String(d.knowDays);
  f('700', 30); const unitTxt = '天';
  f('800', 96); const nw = ctx.measureText(numTxt).width;
  f('700', 30); const uw = ctx.measureText(unitTxt).width;
  const total = nw + 10 + uw;
  ctx.textAlign = 'left';
  f('800', 96); ctx.fillStyle = hg; ctx.fillText(numTxt, cx - total / 2, y);
  f('700', 30); ctx.fillStyle = '#a9bcd8'; ctx.fillText(unitTxt, cx - total / 2 + nw + 10, y + 56);
  ctx.textAlign = 'center';
  y += 96 + 18 + 26;

  // 累计鸡腿（可选：本人可以在分享前关掉，默认写）
  if (d.showGift && Number(d.giftTotal) > 0) {
    f('400', 18); ctx.fillStyle = '#a9bcd8'; ctx.textAlign = 'center';
    ctx.fillText(d.giftLabel || '2 0 2 6 年 送 出', cx, y);
    y += 28;
    const gg2 = ctx.createLinearGradient(PAD, y, W - PAD, y);
    gg2.addColorStop(0, '#ffd98a'); gg2.addColorStop(1, '#ff9ec7');
    const gNum = Number(d.giftTotal).toLocaleString();
    const gUnit = '鸡腿';
    f('800', 58); const gNw = ctx.measureText(gNum).width;
    f('700', 24); const gUw = ctx.measureText(gUnit).width;
    const gTw = gNw + 10 + gUw;
    ctx.textAlign = 'left';
    f('800', 58); ctx.fillStyle = gg2; ctx.fillText(gNum, cx - gTw / 2, y);
    f('700', 24); ctx.fillStyle = '#a9bcd8'; ctx.fillText(gUnit, cx - gTw / 2 + gNw + 10, y + 30);
    ctx.textAlign = 'center';
    y += 58 + 16 + 26;
  }

  // 三张玻璃卡
  const gw = (CW - 32) / 3;
  const items = [['来过房间', String(d.dayCount), '天'], ['最长连续', String(d.best), '天'], ['留下过', Number(d.msgs).toLocaleString(), '句']];
  ctx.textAlign = 'center';
  items.forEach(([l, v, un], k) => {
    const x = PAD + k * (gw + 16);
    ctx.fillStyle = 'rgba(255,255,255,.07)'; rr(ctx, x, y, gw, 116, 18); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.12)'; ctx.lineWidth = 2; ctx.stroke();
    f('400', 17); ctx.fillStyle = '#a3b6d2'; ctx.fillText(l, x + gw / 2, y + 22);
    f('700', 36); ctx.fillStyle = '#fff';
    const vw = ctx.measureText(v).width;
    f('400', 17); const uw2 = ctx.measureText(un).width;
    const tv = vw + 4 + uw2;
    f('700', 36); ctx.fillText(v, x + gw / 2 - tv / 2 + vw / 2, y + 52);
    f('400', 17); ctx.fillStyle = '#9fb3d1'; ctx.fillText(un, x + gw / 2 + tv / 2 - uw2 / 2, y + 70);
  });
  y += 116 + 34;

  // 时段
  f('700', 22); ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
  ctx.fillText('你最常出现的时段', PAD, y);
  f('400', 17); ctx.fillStyle = '#93a8c6';
  ctx.fillText(d.bandDesc, PAD + 186, y + 4);
  y += 22 + 18;
  const bx = PAD, bw = CW, bhh = 150;
  ctx.fillStyle = 'rgba(255,255,255,.055)'; rr(ctx, bx, y, bw, bhh, 20); ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,.09)'; ctx.lineWidth = 2; ctx.stroke();
  const innerX = bx + 20, innerW = bw - 40, hh = 88, baseY = y + bhh - 42;
  const gap = 4, barW = (innerW - gap * 23) / 24;
  const maxH = Math.max(1, ...d.hs.map((x) => Number(x) || 0));
  for (let k = 0; k < 24; k++) {
    const v = Number(d.hs[k]) || 0;
    const hp = Math.max(4, Math.round((v / maxH) * hh));
    const hot = d.bandHours.indexOf(k) >= 0;
    const x = innerX + k * (barW + gap);
    if (hot) {
      const g2 = ctx.createLinearGradient(0, baseY - hp, 0, baseY);
      g2.addColorStop(0, '#7ff0dd'); g2.addColorStop(1, '#58a6ff');
      ctx.fillStyle = g2;
    } else ctx.fillStyle = 'rgba(255,255,255,.18)';
    rr(ctx, x, baseY - hp, barW, hp, Math.min(4, barW / 2)); ctx.fill();
  }
  f('400', 15); ctx.fillStyle = '#879bb8'; ctx.textAlign = 'left';
  ctx.fillText('0 点', innerX, baseY + 10);
  ctx.textAlign = 'center';
  ctx.fillText('6', innerX + innerW * .25, baseY + 10);
  ctx.fillText('12', innerX + innerW * .5, baseY + 10);
  ctx.fillText('18', innerX + innerW * .75, baseY + 10);
  ctx.textAlign = 'right';
  ctx.fillText('23 点', innerX + innerW, baseY + 10);
  ctx.textAlign = 'left';
  y += bhh + 18;
  const ng = ctx.createLinearGradient(PAD, y, PAD + 260, y + 26);
  ng.addColorStop(0, '#7ff0dd'); ng.addColorStop(1, '#c9a6ff');
  f('800', 26); ctx.fillStyle = ng; ctx.fillText(d.bandName, PAD, y);
  y += 26 + 34;

  // 徽章
  if (d.badges.length) {
    let bx2 = PAD; let by = y;
    d.badges.forEach(([t, col]) => {
      f('700', 19);
      const w = ctx.measureText(t).width + 40;
      if (bx2 + w > W - PAD) { bx2 = PAD; by += 54; }
      const g3 = ctx.createLinearGradient(bx2, by, bx2 + w, by + 40);
      if (col === 'amber') { g3.addColorStop(0, '#ffd166'); g3.addColorStop(1, '#ff9e66'); }
      else if (col === 'violet') { g3.addColorStop(0, '#b47aff'); g3.addColorStop(1, '#ff7ab8'); }
      else { g3.addColorStop(0, '#35e0c8'); g3.addColorStop(1, '#58a6ff'); }
      ctx.fillStyle = g3; rr(ctx, bx2, by, w, 40, 20); ctx.fill();
      ctx.fillStyle = col === 'amber' ? '#4a2c00' : (col === 'violet' ? '#2a0b3d' : '#04292b');
      ctx.textAlign = 'center'; ctx.fillText(t, bx2 + w / 2, by + 11);
      ctx.textAlign = 'left';
      bx2 += w + 12;
    });
    y = by + 40 + 34;
  }

  // 足迹：和页面上同一种「按周排成列」的画法，一排放不下就换一块继续
  f('700', 22); ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
  ctx.fillText('我的足迹', PAD, y);
  f('400', 17); ctx.fillStyle = '#93a8c6'; ctx.textAlign = 'right';
  ctx.fillText(d.firstKey + ' · 认识她的那天', W - PAD, y + 4);
  ctx.textAlign = 'left';
  y += 22 + 20;

  const totalDays = Number(d.dayCount2) || 0;
  const dayList = d.daySet || [];
  const fromMs = Date.parse((d.footFrom || d.firstKey) + 'T00:00:00Z');
  if (totalDays && dayList.length) {
    const cell = 13, cgap = 4, perRow = Math.floor((CW + cgap) / (cell + cgap));
    const rowG = ctx.createLinearGradient(PAD, 0, PAD + perRow * (cell + cgap), 0);
    rowG.addColorStop(0, '#6ff2dd'); rowG.addColorStop(1, '#58a6ff');
    let blockStart = 0, bi = 0;
    while (blockStart < totalDays) {
      const cols = Math.min(perRow, Math.ceil((totalDays - blockStart) / 7));
      // 每块头顶标一下这块从哪年哪月开始，翻页时看得出时间
      const headKey = new Date(fromMs + blockStart * 86400e3).toISOString().slice(0, 10);
      const tailIdx = Math.min(totalDays - 1, blockStart + cols * 7 - 1);
      const tailKey = new Date(fromMs + tailIdx * 86400e3).toISOString().slice(0, 10);
      f('500', 12); ctx.fillStyle = 'rgba(163,182,210,.75)'; ctx.textAlign = 'left';
      ctx.fillText(headKey.slice(0, 7).replace('-', ' 年 ') + ' 月起 · 到 ' + tailKey.slice(0, 7).replace('-', ' 年 ') + ' 月', PAD, y);
      y += 16;
      for (let col = 0; col < cols; col++) {
        for (let row = 0; row < 7; row++) {
          const idx = blockStart + col * 7 + row;
          if (idx >= totalDays) break;
          const x = PAD + col * (cell + cgap);
          const yy = y + row * (cell + cgap);
          const on = dayList[idx];
          ctx.fillStyle = on ? rowG : 'rgba(255,255,255,.09)';
          rr(ctx, x, yy, cell, cell, 3); ctx.fill();
          // 纪念日：金边 + 中心小金点
          if (d.annMap) {
            const k = new Date(fromMs + idx * 86400e3).toISOString().slice(0, 10);
            if (d.annMap[k]) {
              ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
              rr(ctx, x - 2, yy - 2, cell + 4, cell + 4, 4); ctx.stroke();
              ctx.fillStyle = '#ffd166';
              ctx.beginPath(); ctx.arc(x + cell / 2, yy + cell / 2, 3, 0, Math.PI * 2); ctx.fill();
            }
          }
        }
      }
      // 起点：第一块第一格（认识她那天）圈出来
      if (bi === 0) {
        ctx.strokeStyle = 'rgba(255,255,255,.75)'; ctx.lineWidth = 2;
        rr(ctx, PAD - 3, y - 3, cell + 6, cell + 6, 5); ctx.stroke();
      }
      y += 7 * (cell + cgap) - cgap + 18;
      blockStart += cols * 7;
      bi++;
    }
    // 图例
    y += 2;
    ctx.fillStyle = rowG; rr(ctx, PAD, y + 2, 11, 11, 3); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.16)'; rr(ctx, PAD + 19, y + 2, 11, 11, 3); ctx.fill();
    f('400', 14); ctx.fillStyle = '#8ea2bf';
    const legX = PAD + 38;
    ctx.fillText('来过 / 没来', legX, y + 2);
    f('400', 14); const legW = ctx.measureText('来过 / 没来').width;
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
    rr(ctx, legX + legW + 22, y + 2, 11, 11, 3); ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.beginPath(); ctx.arc(legX + legW + 27.5, y + 7.5, 3, 0, Math.PI * 2); ctx.fill();
    f('400', 14); ctx.fillStyle = '#8ea2bf';
    ctx.fillText('纪念日', legX + legW + 40, y + 2);
    y += 11 + 22;
  }

  // 纪念日
  const annList = (d.ann || []).filter((p) => p && p.key);
  if (annList.length || d.annNext) {
    f('700', 22); ctx.fillStyle = '#fff'; ctx.textAlign = 'left';
    ctx.fillText('纪念日', PAD, y);
    f('400', 16); ctx.fillStyle = '#93a8c6'; ctx.textAlign = 'right';
    ctx.fillText('认识那天算第 1 天', W - PAD, y + 5);
    ctx.textAlign = 'left';
    y += 22 + 18;
    annList.forEach((p, i) => {
      if (i) {
        ctx.fillStyle = 'rgba(255,255,255,.08)';
        ctx.fillRect(PAD, y - 9, CW, 1);
      }
      f('700', 18); ctx.fillStyle = '#fff';
      ctx.fillText('认识 ' + p.days + ' 天', PAD, y);
      f('400', 17); ctx.fillStyle = '#c9d6ea'; ctx.textAlign = 'center';
      ctx.fillText(p.key, PAD + CW * .58, y + 1);
      f('400', 15); ctx.fillStyle = p.there ? 'rgba(127,240,221,.95)' : 'rgba(147,168,198,.9)';
      ctx.textAlign = 'right';
      ctx.fillText(p.there ? '那天你在' : '那天没来', W - PAD, y + 3);
      ctx.textAlign = 'left';
      y += 18 + 18;
    });
    if (d.annNext) {
      y -= 4;
      f('400', 16); ctx.fillStyle = 'rgba(255,209,102,.95)';
      ctx.fillText('距离认识 ' + d.annNext.days + ' 天还有 ' + d.annNext.left + ' 天 · ' + d.annNext.key, PAD, y);
      y += 16 + 26;
    } else y += 8;
  }

  // 共同记忆
  const memoLines = (() => { f('400', 20); return wrapText(ctx, d.memoText || '', CW - 84, 3); })();
  if (memoLines.length) {
    const mh = 34 + memoLines.length * 32 + 22;
    ctx.fillStyle = 'rgba(255,255,255,.06)'; rr(ctx, PAD, y, CW, mh, 20); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.1)'; ctx.lineWidth = 2; ctx.stroke();
    ctx.font = '400 40px Georgia, serif'; ctx.fillStyle = 'rgba(127,240,221,.55)';
    ctx.fillText('\u201C', PAD + 18, y + 6);
    f('400', 20); ctx.fillStyle = '#dbe6f7';
    memoLines.forEach((ln, n2) => ctx.fillText(ln, PAD + 58, y + 24 + n2 * 32));
    y += mh + 30;
  }

  // 底部
  y += 6;
  f('400', 16); ctx.fillStyle = '#8296b3'; ctx.textAlign = 'center';
  ctx.fillText('王语晨补档站 · ' + d.stamp, cx, y);
  y += 16 + 46;
  ctx.textAlign = 'left';
  return y;
}

/* ---------- 精简版分享卡（「只送过礼、没在房间说过话」的人也能存一张）----------
 * 站长 2026-09-23 定：信息少的人同样要能保存到相册。
 * 这批人（全站 39 位）档案里没有「认识她几天」、没有时段分布、没有足迹日历、
 * 没有徽章 —— 硬套完整版会画出一张「来过房间 0 天 / 最长连续 0 天 / 留下过 0 句」
 * 加一排空柱子的图，等于当面说人什么都没留下。所以另画一张小的：
 * 头像 + 标题 + 那句「心意收到了」+ 鸡腿（可选）。与完整卡共用同一套配色和版式。
 * -------------------------------------------------------------------------- */
function drawLiteShareCard(ctx, d, W, PAD, FONT, bgOnly, H) {
  const cx = W / 2;
  const f = (w, s) => { ctx.font = w + ' ' + s + 'px ' + FONT; };
  ctx.textBaseline = 'top';

  if (bgOnly) {
    const bg = ctx.createLinearGradient(0, 0, W * .35, H);
    bg.addColorStop(0, '#1d3f66'); bg.addColorStop(.45, '#172340'); bg.addColorStop(1, '#1b1533');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
    let g = ctx.createRadialGradient(W - 60, 40, 0, W - 60, 40, 330);
    g.addColorStop(0, 'rgba(53,224,200,.55)'); g.addColorStop(1, 'rgba(53,224,200,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    g = ctx.createRadialGradient(40, H * .45, 0, 40, H * .45, 300);
    g.addColorStop(0, 'rgba(255,122,184,.34)'); g.addColorStop(1, 'rgba(255,122,184,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  }

  let y = 66;
  const r = 48;
  const ag = ctx.createLinearGradient(cx - r, y, cx + r, y + r * 2);
  ag.addColorStop(0, '#35e0c8'); ag.addColorStop(.5, '#58a6ff'); ag.addColorStop(1, '#b47aff');
  ctx.beginPath(); ctx.arc(cx, y + r, r, 0, Math.PI * 2); ctx.fillStyle = ag; ctx.fill();
  ctx.globalAlpha = .16; ctx.beginPath(); ctx.arc(cx, y + r, r + 8, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.globalAlpha = 1;
  ctx.textAlign = 'center';
  f('400', 46); ctx.fillStyle = '#fff'; ctx.fillText('🐟', cx, y + r - 26);
  y += r * 2 + 34;

  const tg = ctx.createLinearGradient(PAD, y, W - PAD, y);
  tg.addColorStop(0, '#7ff0dd'); tg.addColorStop(.55, '#9fc8ff'); tg.addColorStop(1, '#e6b3ff');
  f('800', 42); ctx.fillStyle = tg; ctx.fillText(d.title || roomTitle(), cx, y);
  y += 42 + 20;

  f('400', 21); ctx.fillStyle = '#9fb3d1';
  ctx.fillText('你在房间里还没说过话', cx, y); y += 21 + 10;
  ctx.fillText('但这些心意她都收到了', cx, y); y += 21 + 46;

  if (d.showGift && Number(d.giftTotal) > 0) {
    f('400', 18); ctx.fillStyle = '#a9bcd8';
    ctx.fillText(d.giftLabel || '2 0 2 6 年 送 出', cx, y);
    y += 30;
    const gg2 = ctx.createLinearGradient(PAD, y, W - PAD, y);
    gg2.addColorStop(0, '#ffd98a'); gg2.addColorStop(1, '#ff9ec7');
    const gNum = Number(d.giftTotal).toLocaleString();
    const gUnit = '鸡腿';
    f('800', 78); const gNw = ctx.measureText(gNum).width;
    f('700', 28); const gUw = ctx.measureText(gUnit).width;
    const gTw = gNw + 12 + gUw;
    ctx.textAlign = 'left';
    f('800', 78); ctx.fillStyle = gg2; ctx.fillText(gNum, cx - gTw / 2, y);
    f('700', 28); ctx.fillStyle = '#a9bcd8'; ctx.fillText(gUnit, cx - gTw / 2 + gNw + 12, y + 42);
    ctx.textAlign = 'center';
    y += 78 + 24;
    // 不画「2024、2025 年的归档不完整」这句 —— 站长 2026-09-23 定：
    // 提醒只留在页面上，分享出去的图要保持干净（别人转发时不该带着一句免责声明）。
  }

  y += 10;
  f('400', 16); ctx.fillStyle = '#8296b3';
  ctx.fillText('王语晨补档站 · ' + d.stamp, cx, y);
  y += 16 + 46;
  ctx.textAlign = 'left';
  return y;
}

function buildShareCard(d) {
  const W = 900, PAD = 56;
  const FONT = '"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Heiti SC",sans-serif';
  // 信息少的人（只送过礼、没说过话）走精简版；两张卡共用同一套量高 → 铺背景 → 画内容流程
  const draw = d.lite ? drawLiteShareCard : drawShareCard;
  const measure = document.createElement('canvas').getContext('2d');
  const h = draw(measure, d, W, PAD, FONT, false, 1800);   // 先量高度
  const H = Math.ceil(h);
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  draw(ctx, d, W, PAD, FONT, true, H);   // 先铺背景再画内容（一次搞定）
  return cv;
}

function dataUrlToBlob(dataUrl) {
  const [head, b64] = dataUrl.split(',');
  const bin = atob(b64);
  const a = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return new Blob([a], { type: (head.match(/:(.*?);/) || [, 'image/png'])[1] });
}

/* ⚠️ 站长 2026-09-23 定：按钮写的是「保存到相册」，点了就必须进相册 ——
 * 绝不能落进「文件」App 的下载文件夹（手机上 a[download] 只会存到那里，进不了相册）。
 * 手机上能进相册的只有两条路：① Web Share 系统面板里的「存储到照片」；② 长按图片 → 保存图片。
 * 所以手机端一律不走 a[download]：能分享就分享，不能分享就引导长按。
 * 桌面端下载到本地文件夹本来就是正确行为，保留。
 */
function isPhoneUA() {
  return /iPhone|iPad|iPod|Android|Mobile|HarmonyOS/i.test(navigator.userAgent || '');
}
/** 微信 / QQ / 微博等内置浏览器：没有 Web Share，只能靠长按 */
function isInAppBrowser() {
  return /MicroMessenger|QQ\/|Weibo|QQBrowser|Douban|Alipay|DingTalk/i.test(navigator.userAgent || '');
}
function showAlbumLayer(dataUrl, stamp) {
  const old = document.getElementById('mineAlbum');
  if (old) old.remove();
  const phone = isPhoneUA();
  const tip = phone
    ? (isInAppBrowser() ? '长按图片 → 保存图片' : '长按图片 → 存储到相册')
    : '点下面按钮下载到本地';
  const ov = document.createElement('div');
  ov.id = 'mineAlbum';
  ov.className = 'mine-overlay';
  ov.innerHTML = '<div class="ma-bar"><span class="ma-tip">' + tip + '</span>'
    + '<button type="button" class="ma-close" id="maClose">关闭</button></div>'
    + '<div class="ma-body"><img src="' + dataUrl + '" alt="' + roomTitle() + '"></div>'
    + '<div class="ma-foot"><button type="button" class="ma-act" id="maAct">'
    + (phone ? '保存到相册' : '下载图片') + '</button>'
    + '<div class="ma-note" id="maNote"></div></div>';
  document.body.appendChild(ov);
  document.body.style.overflow = 'hidden';
  const close = () => { ov.remove(); document.body.style.overflow = ''; };
  document.getElementById('maClose').addEventListener('click', close);
  ov.addEventListener('click', (e) => { if (e.target === ov) close(); });

  document.getElementById('maAct').addEventListener('click', async () => {
    const noteEl = document.getElementById('maNote');
    const fname = roomTitle() + '-' + stamp + '.png';
    if (phone) {
      // ① 能调系统分享就调（面板里选「存储到照片」→ 直接进相册）
      try {
        const file = new File([dataUrlToBlob(dataUrl)], fname, { type: 'image/png' });
        if (navigator.canShare && navigator.canShare({ files: [file] })) {
          await navigator.share({ files: [file] });
          return;
        }
      } catch (e) { return; }   // 用户取消或不支持 —— 都不许退回下载
      // ② 不支持（微信 / 微博内置浏览器等）→ 引导长按，绝不写进文件夹
      if (noteEl) noteEl.textContent = '请在上方图片上长按 → 选「保存图片」';
      const img = ov.querySelector('.ma-body img');
      if (img) {
        img.scrollIntoView({ block: 'center' });
        img.classList.remove('ma-flash'); void img.offsetWidth; img.classList.add('ma-flash');
      }
      return;
    }
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = fname;
    document.body.appendChild(a); a.click(); a.remove();
    if (noteEl) noteEl.textContent = '已下载到本地';
  });
}

function saveShareCard(d) {
  const btn = document.getElementById('mineDl');
  const note = (msg) => {
    const el = document.getElementById('mineDlNote');
    if (el) el.textContent = msg;
  };
  if (btn) btn.disabled = true;
  note('正在生成图片…');
  try {
    const cv = buildShareCard(d);
    showAlbumLayer(cv.toDataURL('image/png'), d.stamp);
    note('');
    if (btn) btn.disabled = false;
  } catch (e) {
    note('图片生成失败，稍后再试');
    if (btn) btn.disabled = false;
  }
}

/* ---------- 鸡腿（两档口径，可在档案卡上切换）----------
 * 站长 2026-09-23 定：
 *   「2026 年」     —— 2026-01-01 至今。这是完整、干净、能拿来对账的一年。
 *   「2024 年至今」 —— 2024-01-01 至今。2024/2025 年的归档不完整（早年直播弹幕
 *                     没全量留存、部分月份房间关闭），所以这一档必须显式提示「可能有缺失」。
 * 数据上有两条路：上榜的人（src='list'）取站长给的第三方榜单值，没上榜的自己算，
 * 两边取大值。不过站长 2026-09-23 最终定了：**这行口径说明整个不展示给用户** ——
 * 档位标题已经写清「2026 年送出 / 2024 年起送出」，再补一句时间范围 + 数据来源
 * 对粉丝只是噪音。榜单值 / 自算取大值的逻辑照旧，只是不告诉用户。
 * 两档都是 0 才退回历史累计，并标明「这些年还没有」。
 * -------------------------------------------------------------------------- */
let GIFT_PERIOD = '2026';                 // 当前展示档位：'2026' | '2024plus'
let MINE_GIFT = null;                     // 当前档案的鸡腿数据（切换档位时要重算）
let MINE_CARD = null;                     // 分享卡数据（切换档位后要同步数字）
// 2024 档那句提醒：页面上和分享图里是同一句，抽出来免得两处写得不一样
const GIFT_WARN_2024 = '2024、2025 年的归档不完整，这一档可能比实际少';

/* ---------- 称谓开关：她叫「一只鱼鱼」还是「王语晨」----------
 * 站长 2026-09-23 定：让访客自己挑。**只作用于档案卡本身** —— 页面上的卡片、
 * 分享出去的图、存图文件名；站内其它页面（我的面板标题、直播/公演/行程等）一律不动。
 * 两个叫法都是真的：
 *   - 「一只鱼鱼」是她自己在口袋用的昵称 —— 查 uid 89653517 在房间里的发言，
 *     署名就是「一只鱼鱼˚°🐟」，和微博小号「忘记自己是鱼_」、抖音「一只鱼」同路。
 *   - 「王语晨」是本名，口袋官方资料页显示的则是「GNZ48-王语晨」。
 * -------------------------------------------------------------------------- */
const ROOM_NAMES = [{ id: 'fish', label: '一只鱼鱼' }, { id: 'name', label: '王语晨' }];
const ROOM_NAME_KEY = 'wyc.mine.roomname';
let ROOM_NAME = 'fish';
try {
  const _v = localStorage.getItem(ROOM_NAME_KEY);
  if (ROOM_NAMES.some((x) => x.id === _v)) ROOM_NAME = _v;
} catch (e) {}
const roomName = () => (ROOM_NAME === 'name' ? '王语晨' : '一只鱼鱼');
const roomTitle = () => '我和' + roomName() + '的房间';
// 站长 2026-09-23 反馈：原来做成夹在封面标题下的悬浮胶囊，看不出是干嘛的 ——
// 挪到最下面「保存到相册」那一块，跟「分享图里也写上我送的鸡腿」排成同一族，
// 左边加一句「称呼她为」把用途说清楚。
function roomNameTabs() {
  return '<div class="mine-name-opt">'
    + '<span class="mine-name-lab">称呼她为</span>'
    + '<span class="mine-nm-tabs">' + ROOM_NAMES.map((n) =>
      '<button type="button" class="mine-nm-tab' + (n.id === ROOM_NAME ? ' on' : '') + '" data-nm="' + n.id + '">'
      + n.label + '</button>').join('') + '</span></div>';
}
// 切称谓只改标题文字，别整卡重排（会打断其它区块的入场动画）
function applyRoomName() {
  const t = roomTitle();
  document.querySelectorAll('.mine-cover-t').forEach((el) => { el.textContent = t; });
  if (MINE_CARD) MINE_CARD.title = t;
}
function bindRoomNameTabs() {
  document.querySelectorAll('.mine-nm-tab').forEach((b) => {
    b.addEventListener('click', () => {
      ROOM_NAME = b.getAttribute('data-nm') || 'fish';
      try { localStorage.setItem(ROOM_NAME_KEY, ROOM_NAME); } catch (e) {}
      document.querySelectorAll('.mine-nm-tab').forEach((x) => x.classList.toggle('on', x === b));
      applyRoomName();
    });
  });
}

function giftNums(d) {
  // 一档 = { live, room, self(自算合计), listed(榜单值), total(max), src }
  const pack = (live, room, listed, src, rank) => {
    const L = Number(live) || 0, R = Number(room) || 0, T = Number(listed) || 0;
    return { live: L, room: R, self: L + R, listed: src === 'list' ? T : 0,
             total: Math.max(L + R, src === 'list' ? T : 0), src: src || '', rank: Number(rank) || 0 };
  };
  const p26 = pack(d.live2026, d.room2026, d.total2026, d.src26, d.rank26);
  const p24 = pack(d.liveSince2024, d.roomSince2024, d.totalSince2024, d.srcSince2024, d.rankSince2024);
  // rank 字段保留在数据结构里，但前端不展示排名 ——
  // 站长 2026-09-23 决定去掉：只有两百来人有、口径又是第三方榜，容易起争议。
  const liveAll = Number(d.live) || 0, roomAll = Number(d.room) || 0;
  return { p26, p24, liveAll, roomAll, totalAll: liveAll + roomAll };
}

// 当前该展示哪一档：
//   · 选了 2024 且该档有数 → 2024
//   · 2026 有数 → 2026（默认档）
//   · 2026 没数但 2024 有数 → 还是给 2024（别把人锁在「累计」档看不到数）
//   · 两档都没数 → 退回历史累计
function giftView(g) {
  const gg = g || {};
  const p26 = gg.p26 || { live: 0, room: 0, self: 0, listed: 0, total: 0, src: '' };
  const p24 = gg.p24 || { live: 0, room: 0, self: 0, listed: 0, total: 0, src: '' };
  const v24 = { id: '2024plus', p: p24, label: '2 0 2 4 年 起 送 出', since: '2024 年 1 月 1 日至今' };
  const v26 = { id: '2026', p: p26, label: '2 0 2 6 年 送 出', since: '2026 年 1 月 1 日至今' };
  if (GIFT_PERIOD === '2024plus' && p24.total > 0) return v24;
  if (p26.total > 0) return v26;
  if (p24.total > 0) return v24;
  return { id: 'all', p: { live: gg.liveAll || 0, room: gg.roomAll || 0, self: 0, listed: 0,
                           total: gg.totalAll || 0, src: '' },
           label: '累 计 送 出', since: '2022 年 11 月至今' };
}
// 分享卡用：取当前档位的数字与标题
const giftNum = (g) => giftView(g).p.total;
const giftLabel = (g) => giftView(g).label;

function mineGiftBlock(gg, delay) {
  const g = gg || {};
  const v = giftView(g);
  const tot = v.p.total;
  // 口径说明这一行**不再展示**（站长 2026-09-23 定）——
  // 档位标题已经写清「2026 年送出 / 2024 年起送出」，下面再补一句时间范围 + 来源，
  // 对粉丝是噪音。榜单值 / 自算取大值的逻辑照旧，只是不告诉用户。
  // 2024 档那句「不完整」的提醒保留 —— 它是防对账争议的，不是口径说明。
  // 2024 档自带一句「不完整」的提醒 —— 别让人拿这一档去和第三方榜对账
  const warn = (v.id === '2024plus')
    ? '<div class="mine-gift-warn">' + GIFT_WARN_2024 + '</div>'
    : '';
  // 两个档位都有数才给切换；只有一档就不放空按钮
  const has26 = (g.p26 && g.p26.total > 0), has24 = (g.p24 && g.p24.total > 0);
  let tabs = '';
  if (has26 && has24) {
    tabs = '<div class="mine-gift-tabs">'
      + '<button type="button" class="mine-gift-tab' + (GIFT_PERIOD !== '2024plus' ? ' on' : '')
      + '" data-gp="2026">2026 年</button>'
      + '<button type="button" class="mine-gift-tab' + (GIFT_PERIOD === '2024plus' ? ' on' : '')
      + '" data-gp="2024plus">2024 年至今</button></div>';
  }
  return '<div class="mine-sec mine-hero mine-hero-gift" style="animation-delay:' + delay + 's">'
    + tabs
    + '<div class="mine-hero-l">' + v.label + '</div>'
    // 单位用 🍗（站长 2026-09-23 定）。分享卡是 canvas 绘制，彩色 emoji 在
    // Windows / 部分安卓上会变灰或变豆腐块，所以那边仍写「鸡腿」二字（见 gUnit）。
    + '<div class="mine-hero-v"><span data-count="' + tot + '">0</span><small class="unit">🍗</small></div>'
    + warn
    + '</div>';
}

// 切换档位：只重画鸡腿这一块，别整页重排（会打断其它区块的入场动画）
function bindGiftTabs() {
  document.querySelectorAll('.mine-gift-tab').forEach((b) => {
    b.addEventListener('click', () => {
      GIFT_PERIOD = b.getAttribute('data-gp') || '2026';
      const el = document.querySelector('.mine-hero-gift');
      if (el && MINE_GIFT) {
        el.outerHTML = mineGiftBlock(MINE_GIFT, 0);
        bindGiftTabs();
        mineCountUp();
      }
      // 分享卡跟着当前档位走
      if (MINE_CARD) {
        MINE_CARD.giftTotal = giftNum(MINE_GIFT);
        MINE_CARD.giftLabel = giftLabel(MINE_GIFT);
      }
    });
  });
}

// 只送过礼、没在房间留过言的人
function renderMineGiftOnly(g, box) {
  const gg = g || {};
  const show = (gg.p26 && gg.p26.total > 0) || (gg.p24 && gg.p24.total > 0) || (Number(gg.totalAll) || 0) > 0;
  let h = '<div class="mine-report">';
  h += '<div class="mine-cover">'
    + '<div class="mine-avatar">🐟</div>'
    + '<div class="mine-cover-t">' + roomTitle() + '</div>'
    + '<div class="mine-cover-s">你在房间里还没说过话<br>但这些心意她都收到了</div></div>';
  h += show ? mineGiftBlock(gg, 0.08) : '';
  // 信息少也照样能存一张（站长 2026-09-23 定）—— 只是走精简版卡片，
  // 不画那些空着的小时柱、足迹格和「0 天 / 0 句」。见 drawLiteShareCard。
  h += '<div class="mine-sec mine-dl-wrap" style="animation-delay:.16s">';
  h += roomNameTabs();
  if (show) {
    h += '<label class="mine-share-opt"><input type="checkbox" id="mineGiftOpt"'
      + (giftOptOn() ? ' checked' : '') + '>分享图里也写上我送的鸡腿</label>';
  }
  h += '<button type="button" class="mine-dl" id="mineDl">保存到相册</button>'
    + '<div class="mine-dl-note" id="mineDlNote"></div></div>';
  h += '</div>';
  box.innerHTML = h;
  MINE_GIFT = gg;
  bindGiftTabs();
  bindRoomNameTabs();   // 「一只鱼鱼 / 王语晨」称谓切换（只影响这张卡）
  mineCountUp();

  MINE_CARD = {
    lite: true, stamp: bjDayKey(Date.now()),
    title: roomTitle(),
    giftTotal: giftNum(gg), giftLabel: giftLabel(gg), showGift: false,   // 导出这一刻才按勾选决定
  };
  const giftOpt = document.getElementById('mineGiftOpt');
  if (giftOpt) giftOpt.addEventListener('change', () => giftOptSet(giftOpt.checked));
  const dl = document.getElementById('mineDl');
  if (dl) dl.addEventListener('click', () => {
    MINE_CARD.showGift = !!(giftOpt && giftOpt.checked) && Number(MINE_CARD.giftTotal) > 0;
    saveShareCard(MINE_CARD);
  });
}

async function lookupMine(uid) {
  const box = document.getElementById('mineResult');
  if (!box) return;
  box.innerHTML = '<div class="mine-empty">正在找你的那一份…</div>';
  // 每次新查一个人都回到默认档（2026 年），别把上一个人的选择带过来
  GIFT_PERIOD = '2026';
  MINE_GIFT = null;
  MINE_CARD = null;

  let d = null;
  try {
    const res = await fetch(MINE_API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ uid: String(uid) }),
    });
    d = await res.json();
    // 服务端有明确说法（档案生成中 / 查太快 / uid 格式）就照实显示，别一律说「网络问题」
    if (!res.ok) {
      box.innerHTML = '<div class="mine-empty">'
        + escapeHtml((d && d.error) || '服务暂时不可用，一会儿再试试。') + '</div>';
      return;
    }
  } catch (e) {
    box.innerHTML = '<div class="mine-empty">网络不太顺，一会儿再试试。</div>';
    return;
  }
  if (!d || !d.found) {
    // 档案还没补完全历史时，查不到 ≠ 没记录 —— 如实说明覆盖区间，别冤枉人
    if (d && d.partial && d.since) {
      box.innerHTML = '<div class="mine-empty">目前档案只补到 <b>' + bjDayKey(d.since) + '</b> 之后，'
        + '更早的历史还在录。<br>你如果只在那之前活跃过，过几天再来看会更完整。</div>';
      return;
    }
    box.innerHTML = '<div class="mine-empty">这个 uid 在房间里没留下过记录。<br>'
      + '可能是还没说过话，或者 uid 输错了一位。</div>';
    return;
  }

  // 服务端返回的就是「他自己那一份」，字段沿用旧口径（n/f/l/d/b/h/m）
  const startKey = d.start || '2022-11-01';
  const S = {
    start: startKey,
    days: Math.max(1, Math.round((Date.parse(bjDayKey(Date.now()) + 'T00:00:00Z')
      - Date.parse(startKey + 'T00:00:00Z')) / 86400e3) + 1),
    from: '',                                   // 全量已回溯到 2022-11，不再需要「至少」措辞
  };
  const u = d;
  // 鸡腿（直播弹幕礼物 + 口袋房间送礼折算），服务端已按「2026 / 2024 年起」分别算好
  const gAll = giftNums(d);
  const g = (gAll.p26.total > 0 || gAll.p24.total > 0 || gAll.totalAll > 0) ? gAll : null;
  // 只送过礼、从没在房间说过话的人：给一张只有鸡腿的简版卡
  if (!u.n) { renderMineGiftOnly(g, box); return; }
  const dayIdx = decodeDayBitmap(u.m, S.days);
  const startMs = Date.parse(S.start + 'T00:00:00Z');
  const dayKeys = dayIdx.map((i) => new Date(startMs + i * 86400e3).toISOString().slice(0, 10));
  const activeSet = new Set(dayKeys);
  const firstKey = bjDayKey(u.f);
  const hs = String(u.h || '').split(',').map(Number);
  const band = mainBand(hs);
  const badges = mineBadges(u, band, dayKeys);
  const nowDay = bjDayKey(Date.now());
  const knowDays = Math.max(1, Math.round((Date.parse(nowDay + 'T00:00:00Z') - Date.parse(firstKey + 'T00:00:00Z')) / 86400e3));
  // 数据还没回溯到底时，首次日期只是「已抓到的最早」，措辞要诚实
  const atLeast = firstKey <= S.from;
  const maxH = Math.max(1, ...hs.map((x) => Number(x) || 0));

  let html = '<div class="mine-report">';
  html += '<div class="mine-cover">'
    + '<div class="mine-avatar">🐟</div>'
    + '<div class="mine-cover-t">' + roomTitle() + '</div>'
    + '<div class="mine-cover-s">从 <b>' + escapeHtml(firstKey) + '</b> 那天起'
    + '<br>只属于你的陪伴记录，慢慢往下滑</div></div>';

  html += '<div class="mine-sec mine-hero" style="animation-delay:.08s">'
    + '<div class="mine-hero-l">认 识 她</div>'
    + '<div class="mine-hero-v"><span data-count="' + knowDays + '">0</span><small>天</small></div>'
    + '</div>';

  if (g) { html += mineGiftBlock(g, 0.14); MINE_GIFT = g; }

  html += '<div class="mine-sec mine-glass" style="animation-delay:.18s">'
    + mineG('来过房间', u.d, '天') + mineG('最长连续', u.b, '天') + mineG('留下过', u.n.toLocaleString(), '句')
    + '</div>';

  let bars = '';
  for (let i = 0; i < 24; i++) {
    const v = Number(hs[i]) || 0;
    const pct = Math.max(4, Math.round((v / maxH) * 100));
    const hot = band.h.indexOf(i) >= 0;
    bars += `<i class="mh${hot ? ' hot' : ''}" style="--hh:${pct}%;animation-delay:${120 + i * 24}ms" title="${i} 点 ${v} 条"></i>`;
  }
  html += '<div class="mine-sec mine-band" style="animation-delay:.28s">'
    + '<div class="mine-h"><b>你最常出现的时段</b><span>' + escapeHtml(band.desc) + '</span></div>'
    + '<div class="mine-hours">' + bars + '</div>'
    + '<div class="mine-hours-scale"><span>0 点</span><span>6</span><span>12</span><span>18</span><span>23 点</span></div>'
    + '<div class="mine-band-name">' + escapeHtml(band.name) + '</div></div>';

  if (badges.length) {
    html += '<div class="mine-sec mine-badges" style="animation-delay:.36s">';
    badges.forEach(([t, c], k) => {
      html += `<span class="mine-badge ${c}" style="animation-delay:${360 + k * 70}ms">${escapeHtml(t)}</span>`;
    });
    html += '</div>';
  }

  // 纪念日：从「认识她那天」往后数，认识那天算第 1 天
  const ann = mineAnniversaries(firstKey, nowDay, activeSet);
  const annMap = {};
  ann.passed.forEach((p) => { annMap[p.key] = p.days; });

  html += '<div class="mine-sec" style="animation-delay:.44s"><div class="mine-h"><b>我的足迹</b>'
    + '<span>' + escapeHtml(firstKey) + ' 至今'
    + '<span class="mine-cal-hint">，左右滑动看全部</span></span></div>'
    + mineCalendar(activeSet, dayKeys[0] || firstKey, nowDay, annMap) + '</div>';

  if (ann.passed.length || ann.next) {
    html += '<div class="mine-sec mine-ann" style="animation-delay:.48s">'
      + '<div class="mine-h"><b>纪念日</b><span>认识那天算第 1 天</span></div>';
    ann.passed.forEach((p) => {
      html += '<div class="mine-ann-row"><span class="mar-l">认识 ' + p.days + ' 天</span>'
        + '<span class="mar-d">' + p.key + '</span>'
        + '<span class="mar-t' + (p.there ? ' on' : '') + '">'
        + (p.there ? '那天你在' : '那天没来') + '</span></div>';
    });
    if (ann.next) {
      html += '<div class="mine-ann-next">距离认识 <b>' + ann.next.days + '</b> 天还有 <b>'
        + ann.next.left + '</b> 天 · ' + ann.next.key + '</div>';
    }
    html += '</div>';
  }

  html += '<div class="mine-sec" id="mineMemo" style="animation-delay:.52s">'
    + '<div class="mine-memo"><div class="mine-memo-loading">正在找那天的记忆…</div></div></div>';

  html += '<div class="mine-sec mine-dl-wrap" style="animation-delay:.6s">';
  html += roomNameTabs();
  // 鸡腿是隐私敏感度最高的那一项：由本人决定写不写进分享图
  if (Number(d.total) > 0) {
    html += '<label class="mine-share-opt"><input type="checkbox" id="mineGiftOpt"'
      + (giftOptOn() ? ' checked' : '') + '>分享图里也写上我送的鸡腿</label>';
  }
  html += '<button type="button" class="mine-dl" id="mineDl">保存到相册</button>'
    + '<div class="mine-dl-note" id="mineDlNote"></div></div>';

  // 全量历史还没补完时，说清楚数字只覆盖哪一段，别让人以为这就是全部
  if (d.since && d.since > Date.parse('2022-11-02T00:00:00+08:00')) {
    html += '<div class="mine-dl-note" style="animation-delay:.66s">历史还在补录中，'
      + '当前档案覆盖 <b>' + bjDayKey(d.since) + '</b> 之后，更早的随后补上。</div>';
  }

  html += '</div>';
  box.innerHTML = html;
  bindGiftTabs();          // 「2026 年 / 2024 年至今」切换
  bindRoomNameTabs();      // 「一只鱼鱼 / 王语晨」称谓切换（只影响这张卡）
  mineCountUp();

  // 分享卡需要的数据（导出时现取 DOM 里的共同记忆文本）
  const cardData = {
    firstKey, atLeast, knowDays,
    title: roomTitle(),
    dayCount: u.d, best: u.b, msgs: u.n,
    giftTotal: giftNum(g), giftLabel: giftLabel(g), showGift: false,   // 鸡腿：导出时按勾选决定
    hs, bandName: band.name, bandDesc: band.desc, bandHours: band.h,
    badges,
    dayCount2: Math.max(1, Math.round((Date.parse(nowDay + 'T00:00:00Z') - Date.parse((dayKeys[0] || firstKey) + 'T00:00:00Z')) / 86400e3) + 1),
    daySet: null,
    ann: ann.passed, annNext: ann.next, annMap,
    memoText: '',
    stamp: nowDay,
  };
  {
    const footFrom = dayKeys[0] || firstKey;
    const fromMs = Date.parse(footFrom + 'T00:00:00Z');
    cardData.daySet = [];
    for (let t = fromMs; t <= Date.parse(nowDay + 'T00:00:00Z'); t += 86400e3) {
      cardData.daySet.push(activeSet.has(new Date(t).toISOString().slice(0, 10)));
    }
    cardData.dayCount2 = cardData.daySet.length;
    cardData.footFrom = footFrom;
  }
  MINE_CARD = cardData;    // 切换鸡腿档位时要同步改这里的数字
  const giftOpt = document.getElementById('mineGiftOpt');
  if (giftOpt) giftOpt.addEventListener('change', () => giftOptSet(giftOpt.checked));
  const dl = document.getElementById('mineDl');
  if (dl) dl.addEventListener('click', () => {
    const memoEl = document.querySelector('#mineMemo .mine-memo');
    const txt = memoEl ? memoEl.innerText.replace(/\s*\n\s*/g, ' ').trim() : '';
    cardData.memoText = /正在找/.test(txt) ? '' : txt.replace(/^「|」$/g, '');
    // 勾选状态在导出这一刻才读，改了开关立刻生效
    cardData.showGift = !!(giftOpt && giftOpt.checked) && Number(cardData.giftTotal) > 0;
    saveShareCard(cardData);
  });

  // 共同记忆（异步补，失败就静默去掉这块）
  try {
    const memo = await buildMineMemo(u, firstKey, activeSet);
    const el = document.getElementById('mineMemo');
    if (el && memo) el.innerHTML = '<div class="mine-memo">' + memo + '</div>';
    else if (el) el.remove();
  } catch (e) {
    const el = document.getElementById('mineMemo');
    if (el) el.remove();
  }
}

async function buildMineMemo(u, firstKey, activeSet) {
  const month = firstKey.slice(0, 7);
  let herCount = 0, herLast = '';
  try {
    const arr = await fetchApi('/api/month?m=' + encodeURIComponent(month));
    const day = (Array.isArray(arr) ? arr : []).filter((m) => bjDayKey(m.msgTime) === firstKey);
    herCount = day.length;
    const last = day[day.length - 1];
    if (last) herLast = String(last.text || '').replace(/\s+/g, ' ').trim();
  } catch (e) { /* 拿不到就不提 */ }

  const since = Number(u.f);
  const perfs = (DATA.performances || []).filter((p) => Number(p.stime) >= since);
  const lives = (DATA.live || []).filter((l) => Number(l.ctime) >= since);
  const perfTogether = perfs.filter((p) => activeSet.has(bjDayKey(p.stime))).length;
  const liveTogether = lives.filter((l) => activeSet.has(bjDayKey(l.ctime))).length;

  let html = '<div class="mine-memo-t">' + escapeHtml(firstKey) + '，你第一次在这里说话</div>';
  if (herCount) {
    html += '<div class="mine-memo-b">那天她写了 ' + herCount + ' 条留言'
      + (herLast ? '，最后一句是「' + escapeHtml(herLast.slice(0, 60)) + (herLast.length > 60 ? '…' : '') + '」' : '')
      + '。</div>';
  }
  const allPerf = perfs.length > 0 && perfTogether === perfs.length;
  const allLive = lives.length > 0 && liveTogether === lives.length;
  html += '<div class="mine-memo-b">从那天起，她开了 ' + perfs.length + ' 场公演、' + lives.length + ' 场直播，'
    + '其中你在房间的日子赶上了 ' + perfTogether + ' 场公演、' + liveTogether + ' 场直播'
    + (allPerf && allLive ? ' —— 一场都没落下。' : (allPerf ? ' —— 公演一场没落下。' : (allLive ? ' —— 直播一场没落下。' : '。')))
    + '</div>';
  return html;
}

/* ---------------- 公演（含子标签：公演回放 / 公演cut） ---------------- */
const PERF_SUBS = [
  ['perf', '公演回放'],
  ['cuts', '公演cut']
];

function renderPerformances() {
  const panel = panels.performances;
  const subtabs = PERF_SUBS.map(([k, label]) =>
    `<button class="subtab${state.perfSub === k ? ' active' : ''}" data-sub="${k}">${escapeHtml(label)}</button>`
  ).join('');
  panel.innerHTML = `
    <div class="perf">
      <div class="subtabs">${subtabs}</div>
      <div class="perf-sub" id="perfSub"></div>
    </div>`;
  renderPerfSub();
}

function renderPerfSub() {
  const box = $('#perfSub');
  if (!box) return;
  if (state.perfSub === 'cuts') { box.innerHTML = renderPerfCuts(state.query); return; }
  // 公演回放（原 renderPerformances 内容）
  let list = DATA.performances;
  if (state.query) list = list.filter((m) => (m.title || '').toLowerCase().includes(state.query));
  if (dateFilterActive()) list = list.filter((m) => inDateRange(m.stime));
  // 挂上该场对应的 cut 数量 / 日期（用于卡片角标跳转）
  const cutByLive = {};
  (DATA.perfCuts ? DATA.perfCuts.cuts : []).forEach(c => {
    if (c.liveId) { if (!cutByLive[c.liveId]) cutByLive[c.liveId] = { n: 0, date: c.date }; cutByLive[c.liveId].n++; }
  });
  list = list.map(p => {
    const c = cutByLive[p.liveId];
    const bc = biliCutFor(p);
    const q = { ...p };
    if (c) { q._cutCount = c.n; q._cutDate = c.date; }
    if (bc) { q._biliCutDate = bc.date; q._biliCutTitle = bc.title; }
    return q;
  });
  if (!list.length) {
    box.innerHTML = filterNote(0) +
      `<div class="empty-state">${dateFilterActive() ? '该时间范围内没有公演，点上方「清除筛选」看全部。' : '暂无公演数据。'}</div>`;
    return;
  }
  box.innerHTML = filterNote(list.length) +
    `<div class="card-grid">${list.map((m) => renderCard(m, 'stime')).join('')}</div>`;
}

/* ---------------- 她的公演 cut（B 站合集 season 4752040，UP: Chzhnh） ----------------
 * 数据来自 demo 专属静态文件 js/bili-cuts.js → window.__BILI_CUTS__ = [[日期, 标题, BV号], ...]
 * 与微博「公演cut」的区别：那边是应援会的单曲片段（34 条，按曲分），这边是 UP 主整场个人 cut（154 条，按场分）。
 */
function biliCutsAll() {
  return (typeof window !== 'undefined' && Array.isArray(window.__BILI_CUTS__)) ? window.__BILI_CUTS__ : [];
}
// 一场公演 → 对应的 B 站个人 cut（同日有多条时用剧目名二次匹配）
function biliCutFor(p) {
  const day = fmtDate(p.stime || p.ctime);
  if (!day) return null;
  const same = biliCutsAll().filter((c) => c[0] === day);
  if (!same.length) return null;
  if (same.length === 1) return { date: day, title: same[0][1], bvid: same[0][2] };
  // 同日多场（如生日冷餐会 + NIII 常规公演）：拿公演名里的《剧目》去对
  const m = String(p.subTitle || p.title || '').match(/《([^》]+)》/);
  const key = m ? m[1] : '';
  const hit = key && same.find((c) => c[1].includes(key));
  return { date: day, title: (hit || same[0])[1], bvid: (hit || same[0])[2] };
}
/* 「公演cut」页：B 站合集（整场个人 cut）+ 微博应援会（按单曲切）**按日期混排**，
 * 每张卡片右上角标来源（B站 / 微博），卡片样式统一用封面卡；同一天里 B 站排前面。 */
function renderPerfCuts(query) {
  const wb = (DATA.perfCuts ? DATA.perfCuts.cuts : []).map((c) => ({
    date: c.date, src: 'wb', title: c.song || c.perf || '公演 cut',
    url: c.url, cover: c.cover ? proxyImg(c.cover) : '', song: c.song || '',
  }));
  const bl = biliCutsAll().map((c) => ({
    date: c[0], src: 'bl', title: c[1],
    url: 'https://www.bilibili.com/video/' + c[2], cover: c[3] || '', song: '',
  }));
  const all = bl.concat(wb);
  if (!all.length) return '<div class="empty">暂无公演 cut。</div>';
  const q = (query || '').trim().toLowerCase();
  const list = all.filter((c) => !q || c.title.toLowerCase().includes(q) || c.date.includes(q));
  if (!list.length) return '<div class="empty">没有匹配的 cut。</div>';
  const groups = {}, order = [];
  list.forEach((c) => { if (!groups[c.date]) { groups[c.date] = []; order.push(c.date); } groups[c.date].push(c); });
  order.sort((a, b) => b.localeCompare(a));
  const nBl = list.filter((c) => c.src === 'bl').length;
  const nWb = list.length - nBl;
  let html = `<div class="pc-note">B 站合集 ${nBl} 条（UP 主 Chzhnh，整场个人 cut）+ 微博 ${nWb} 条（应援会，按单曲切），按日期混排 · 角标区分来源</div>`;
  order.forEach((date) => {
    const arr = groups[date];
    html += `<section class="pc-group" id="pc-group-${escapeHtml(date)}">`
      + `<h2 class="pc-group-h"><span class="ym">${escapeHtml(date)}</span>`
      + `<span class="n">${arr.length} 条</span></h2>`
      + '<div class="pc-grid">';
    arr.forEach((c) => {
      const isBl = c.src === 'bl';
      const cover = c.cover
        ? `<img src="${escapeHtml(c.cover)}" loading="lazy" referrerpolicy="no-referrer" alt="" onerror="this.style.display='none'">`
        : '<div class="pc-void">▶</div>';
      html += `<a class="pc-card${isBl ? ' is-bl' : ' is-wb'}" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${cover}`
        + '<div class="pc-scrim"></div>'
        + `<span class="pc-src ${isBl ? 'bl' : 'wb'}">${isBl ? 'B站' : '微博'}</span>`
        + (c.song ? `<span class="pc-ov song">${escapeHtml(c.song)}</span>` : '')
        + `<span class="pc-ov title">${escapeHtml(c.title)}</span>`
        + `<span class="pc-ov go">${isBl ? 'B 站观看' : '微博观看'} ↗</span>`
        + '</a>';
    });
    html += '</div></section>';
  });
  return html;
}

function gotoPerfCuts(date) {
  state.perfSub = 'cuts';
  switchTab('performances');
  setTimeout(() => {
    const el = document.getElementById('pc-group-' + date);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 60);
}

/* ---------------- 新粉指南（含子标签：新粉指南 / 公式照 / 经历备注） ---------------- */
const GUIDE_SUBS = [
  ['guide', '新粉指南'],
  ['starter', '入坑必看'],
  ['social', '社媒美图'],
  ['gallery', '公式照'],
  ['exp', '经历备注']
];

function renderGuide() {
  const panel = panels.guide;
  const subtabs = GUIDE_SUBS.map(([k, label]) =>
    `<button class="subtab${state.guideSub === k ? ' active' : ''}" data-sub="${k}">${escapeHtml(label)}</button>`
  ).join('');
  panel.innerHTML = `
    <div class="guide">
      <div class="subtabs">${subtabs}</div>
      <div class="guide-sub" id="guideSub"></div>
    </div>`;
  renderGuideSub();
}

// 仅刷新子标签内容，不重建整块（切换更快，且保留滚动位置）
function renderGuideSub() {
  const box = $('#guideSub');
  if (!box) return;
  if (state.guideSub === 'starter') { box.innerHTML = (typeof renderStarter === 'function') ? renderStarter() : ''; return; }
  if (state.guideSub === 'social') { box.innerHTML = renderSocialGallery(); renderSocialWall(); }
  else if (state.guideSub === 'gallery') box.innerHTML = renderGallery();
  else if (state.guideSub === 'exp') box.innerHTML = renderExperience();
  else box.innerHTML = renderGuideMain();
}

// 子标签一：新粉指南（资料卡 + 社交账号）
function renderGuideMain() {
  const facts = PROFILE.facts
    .map(([k, v]) => `<div class="fact"><span class="fact-k">${escapeHtml(k)}</span><span class="fact-v">${escapeHtml(v)}</span></div>`)
    .join('');

  const groups = PROFILE.groups.map((g) => {
    const accounts = g.accounts.map((a) =>
      `<button class="social-btn" style="--social:${g.color}" data-web="${escapeHtml(a.web)}" data-scheme="${escapeHtml(a.scheme || g.scheme)}">
        <span class="social-handle">@${escapeHtml(a.handle)}</span>
        ${a.note ? `<span class="social-note">${escapeHtml(a.note)}</span>` : ''}
        <span class="social-go">打开主页 ›</span>
      </button>`
    ).join('');
    return `<div class="social-group">
      <div class="social-label"><span class="social-dot" style="background:${g.color}"></span>${escapeHtml(g.label)}</div>
      <div class="social-list">${accounts}</div>
    </div>`;
  }).join('');

  return `
    <div class="guide-card">
      <div class="guide-facts">
        <div class="guide-aliases">昵称：${escapeHtml(PROFILE.aliases)}</div>
        <div class="facts-grid">${facts}</div>
        <div class="guide-code">神秘代码：<strong>${escapeHtml(PROFILE.secretCode)}</strong></div>
      </div>
      <img class="guide-poster" src="./assets/newfan-guide.jpg" alt="王语晨 新粉指南" loading="lazy" />
    </div>
    <div class="guide-socials">${groups}</div>
    <p class="guide-tip">在手机上点击会直接打开对应 App 并进入 TA 的主页；未安装 App 或唤起失败时，会自动跳转到网页版。</p>`;
}

// 子标签二：公式照（按年份分组：2024 / 2025 / 2026）
function renderGallery() {
  const groups = (PROFILE.galleryByYear || []).map((g) => {
    const items = g.photos.map((src, i) =>
      `<figure class="formula-item"><img src="${escapeHtml(src)}" alt="${escapeHtml(g.year)} 公式照 ${i + 1}" loading="lazy" referrerpolicy="no-referrer" onclick="window.__lightboxShow(this.src)" onerror="this.closest('figure').classList.add('broken')" /><figcaption>${g.photos.length > 1 ? `${i + 1} / ${g.photos.length}` : '公式照'}</figcaption></figure>`
    ).join('');
    return `
      <section class="formula-year">
        <h3 class="formula-year-title">${escapeHtml(g.year)} 年公式照<span class="formula-year-count">${g.photos.length} 张</span></h3>
        <div class="formula-gallery">${items}</div>
        <p class="formula-year-source">来源：${escapeHtml(g.source)}</p>
      </section>`;
  }).join('');
  return `<section class="profile-block">${groups}</section>`;
}

// 子标签三：经历备注（SNH48 官网，新→旧）
function renderExperience() {
  const exp = (PROFILE.experience || []).map((e) => {
    const tag = e.tag
      ? `<span class="exp-tag exp-tag-${escapeHtml(e.tag)}">${escapeHtml(e.tag)}</span>`
      : '';
    return `<li class="exp-item">
      <div class="exp-dot"></div>
      <div class="exp-body">
        <div class="exp-date">${escapeHtml(e.date)}</div>
        <div class="exp-text">${tag}${escapeHtml(e.text)}</div>
      </div>
    </li>`;
  }).join('');
  return `<section class="profile-block">
    <ul class="exp-timeline">${exp}</ul>
    ${renderOfficialMentions()}
  </section>`;
}

// 经历备注下方：各官微提到王语晨的微博（按时间线倒序合并，带官微深链）
function renderOfficialMentions() {
  const list = (PROFILE.officialMentions || []).slice();
  if (!list.length) return '';
  // 按 date（YYYY.MM.DD）倒序排成一条时间线
  const keyOf = (d) => { const p = String(d).split('.').map(Number); return (p[0] || 0) * 10000 + (p[1] || 0) * 100 + (p[2] || 0); };
  list.sort((a, b) => keyOf(b.date) - keyOf(a.date));
  // 标题：列出所有出现过的来源账号
  const sources = [...new Set(list.map((m) => m.source).filter(Boolean))];
  const title = sources.length ? sources.join(' / ') : '@SNH48';
  const items = list.map((m) => `
    <li class="exp-item exp-mention">
      <div class="exp-dot exp-dot-mention"></div>
      <div class="exp-body">
        <div class="exp-date">${escapeHtml(m.date)}${m.source ? `<span class="exp-src">${escapeHtml(m.source)}</span>` : ''}</div>
        <div class="exp-text"><a class="exp-link" href="${escapeHtml(m.url)}" target="_blank" rel="noopener">${escapeHtml(m.text)}</a></div>
      </div>
    </li>`).join('');
  return `<h4 class="exp-subtitle">官方微博提及 · ${escapeHtml(title)}</h4><ul class="exp-timeline exp-mention-list">${items}</ul>`;
}

// 一条消息可用于搜索的全部文字
function msgSearchText(m) {
  return [m.text, m.reply?.name, m.reply?.text, m.card?.title, m.card?.desc]
    .filter(Boolean).join(' ').toLowerCase();
}

function matchQuery(m) {
  if (!state.query) return true;
  const q = state.query.toLowerCase();
  return msgSearchText(m).includes(q) || (m.sender?.nickname || '').toLowerCase().includes(q);
}

function renderMessages() {
  const panel = panels.messages;
  let list = DATA.messages;
  const filtering = !!(state.dateFrom || state.dateTo || state.query);
  if (state.dateFrom || state.dateTo) {
    list = list.filter((m) => {
      const t = m.msgTime;
      if (state.dateFrom && t < state.dateFrom) return false;
      if (state.dateTo && t > state.dateTo) return false;
      return true;
    });
  }
  if (state.query) list = list.filter((m) => matchQuery(m));

  if (!list.length) {
    // 历史月还没拉完就先说「没有」会严重误导。此时**完全不碰面板**（完全静默），
    // 只在工具栏挂一个「搜索中…/筛选中…」小字，数据到齐后会自动重绘出真实结果。
    if (filtering && !allMonthsLoaded) {
      showBusy(state.query ? '搜索中…' : '筛选中…');
      loadRemainingMonths().then(() => { if (state.query || dateFilterActive()) renderMessages(); });
      return;
    }
    panel.innerHTML = filterNote(0) +
      `<div class="empty-state">${dateFilterActive() ? '该时间范围内没有发言，点上方「清除筛选」看全部。' : '暂无口袋发言数据。<br/>若尚未抓取，请设置 <code>POCKET48_TOKEN</code> 后运行 <code>node scrape.mjs</code>。'}</div>`;
    return;
  }

  const groups = {};
  for (const m of list) {
    const d = fmtDate(m.msgTime) || '未知日期';
    (groups[d] ||= []).push(m);
  }
  const sortedDays = Object.keys(groups).sort((a, b) => (b > a ? 1 : -1));

  // 全量存档有 400+ 天、1.5 万条，一次性渲染会让手机卡顿/内存吃紧：
  // 默认只渲染最近若干天，底部提供「加载更早」；搜索或日期筛选时直接全量展示。
  const limit = filtering ? sortedDays.length : Math.min(state.dayLimit, sortedDays.length);
  const shown = sortedDays.slice(0, limit);
  const restDays = sortedDays.length - limit;
  const restCount = restDays > 0
    ? sortedDays.slice(limit).reduce((n, d) => n + groups[d].length, 0)
    : 0;

  // 单条消息渲染异常不应拖垮整个列表
  const renderDay = (day) => `<div class="day-group">
      <div class="day-label">${day}（${groups[day].length}）</div>
      ${groups[day].map((m) => {
        try {
          return renderMsg(m);
        } catch (err) {
          return `<div class="msg"><div class="msg-body empty">［该条消息渲染失败］</div></div>`;
        }
      }).join('')}
    </div>`;

  const matchedCount = sortedDays.reduce((n, d) => n + groups[d].length, 0);
  panel.innerHTML = filterNote(matchedCount) + shown.map(renderDay).join('')
    + (restDays > 0
      ? `<button class="load-more" id="loadMore" type="button">加载更早的消息（还有 ${restCount} 条 / ${restDays} 天）</button>`
      : '');

  const moreBtn = document.getElementById('loadMore');
  if (moreBtn) {
    moreBtn.addEventListener('click', async () => {
      const y = window.scrollY;
      state.dayLimit += 7;
      // 还有更早的月份未加载 → 惰性拉一个进来（append 到 DATA.messages）
      const next = ALL_MONTHS.find(m => !loadedMonths.has(m));
      if (next) { try { await loadMonth(next); } catch (_) {} }
      renderMessages();
      window.scrollTo(0, y);
    });
  }

  // 已展开的消息：若译文块还停留在「翻译中…」占位（缓存缺失），异步补抓
  if (state.lang !== 'zh' && state.expanded.size) {
    shown.forEach((day) => groups[day].forEach((m) => {
      const mid = msgKey(m);
      if (!state.expanded.has(mid)) return;
      const box = document.getElementById('tr-' + mid);
      if (box && box.querySelector('.tr-loading')) doTranslate(mid);
    }));
  }
}

// 回复 / 礼物回复的引用块：她回复了谁、原话是什么
function renderQuote(reply) {
  if (!reply || (!reply.name && !reply.text)) return '';
  const who = reply.name ? `回复 <b>@${escapeHtml(reply.name)}</b>` : '引用';
  return `<div class="msg-quote">
    <div class="msg-quote-who">↩︎ ${who}</div>
    ${reply.text ? `<div class="msg-quote-text">${withEmoji(escapeHtml(reply.text))}</div>` : ''}
  </div>`;
}

// 卡片消息（直播推送 / 分享 / 红包）
// 注意：函数名必须区别于直播面板的 renderCard(item, timeKey)，否则会被后者覆盖
/** 图片：点击放大预览，预览层支持「打开原图 / 下载 / 关闭」 */
function imgHtml(url, cls) {
  const u = escapeHtml(toUrl(url));
  return `<img class="${cls}" loading="lazy" decoding="async" referrerpolicy="no-referrer"
    src="${u}" alt="图片"
    onclick="window.__lightboxShow(this.src)"
    onerror="this.classList.add('failed');this.setAttribute('data-src',this.src)" />`;
}

function renderMsgCard(card) {
  if (!card) return '';
  const pic = card.pic ? imgHtml(card.pic, 'msg-card-pic') : '';
  // 开播推送：跳站内「直播 / 录播」页（原始 shortPath 无跳转意义）
  const link = card.kind === 'live'
    ? `<button class="msg-card-link as-btn" type="button" data-goto="live">前往直播 ›</button>`
    : (card.url
      ? (/^https?:/i.test(card.url)
        ? `<a class="msg-card-link" href="${escapeHtml(card.url)}" target="_blank" rel="noopener">查看详情 ›</a>`
        : `<span class="msg-card-link muted">${escapeHtml(card.url)}</span>`)
      : '');
  return `<div class="msg-card msg-card-${escapeHtml(card.kind || 'info')}">
    ${pic}
    <div class="msg-card-main">
      <div class="msg-card-title">${escapeHtml(card.title || '')}</div>
      ${card.desc ? `<div class="msg-card-desc">${escapeHtml(card.desc)}</div>` : ''}
      ${link}
    </div>
  </div>`;
}

function renderMsg(m) {
  const typeLabel = TYPE_LABEL[m.msgType] || m.msgType || '其他';
  let body = '';

  // 1) 引用块（回复谁 / 什么礼物 / 什么提问）
  body += renderQuote(m.reply);
  // 2) 正文
  if (m.text) body += `<div class="msg-body">${withEmoji(escapeHtml(m.text))}</div>`;
  // 3) 媒体
  if (m.images?.length) {
    body += `<div class="msg-images">${m.images.map((u) => imgHtml(u, '')).join('')}</div>`;
  }
  if (m.audio) {
    const dur = fmtDur(m.duration);
    body += `<div class="msg-media msg-audio">
      ${dur ? `<span class="voice-badge">语音 ${dur}</span>` : ''}
      <audio controls preload="none" src="${escapeHtml(toUrl(m.audio))}"></audio>
    </div>`;
  }
  if (m.video) {
    body += `<div class="msg-media"><video controls preload="metadata" src="${escapeHtml(toUrl(m.video))}"></video></div>`;
  }
  if (m.link) body += `<div class="msg-link">🔗 <a href="${escapeHtml(m.link)}" target="_blank" rel="noopener">${escapeHtml(m.link)}</a></div>`;
  // 4) 卡片
  body += renderMsgCard(m.card);

  if (!body) {
    body = `<div class="msg-body empty">［${typeLabel}］无文本内容</div>
      <div class="msg-raw"><details><summary>${trUI('viewRaw', state.lang)}</summary><pre>${escapeHtml(JSON.stringify(m.raw, null, 2))}</pre></details></div>`;
  }

  // 她本人的消息不重复标注昵称；房间里其他人的消息（粉丝 / 袋王 / 队友）标注出来
  const isSelf = String(m.sender?.userId || '') === SELF_ID;
  const sender = !isSelf && m.sender?.nickname
    ? `<span class="msg-sender other">@${escapeHtml(m.sender.nickname)}</span>`
    : '';

  // 多语言：选择非中文语言后，每条含文字的发言显示「翻译」开关（点开才请求，避免一次性打爆接口）
  let footer = '';
  if (state.lang !== 'zh' && hasTranslatable(m)) {
    const mid = msgKey(m);
    const expanded = state.expanded.has(mid);
    footer = `<div class="msg-tr-row">
      <button class="tr-btn" type="button" data-mid="${escapeHtml(mid)}">${expanded ? trUI('hide', state.lang) : trUI('translate', state.lang)}</button>
      <div class="msg-tr" id="tr-${escapeHtml(mid)}">${expanded ? trBlocksHtml(m, state.lang) : ''}</div>
    </div>`;
  }

  return `<div class="msg${isSelf ? '' : ' from-other'}" data-mid="${escapeHtml(msgKey(m))}">
    <div class="msg-head">
      <span class="msg-time">${fmtTime(m.msgTime)}</span>
      <span class="msg-type">${typeLabel}</span>
      ${sender}
    </div>
    ${body}
    ${footer}
  </div>`;
}

function liveStatusBadge(status, kind) {
  const s = Number(status);
  if (s === 2) return '<span class="badge live">直播中</span>';
  if (s === 1) return '<span class="badge rec">录播</span>';
  if (s === 0) return `<span class="badge soon">${kind === 'perf' ? '未开始' : '预告'}</span>`;
  return '<span class="badge end">已结束</span>';
}

// ⚠️ 口袋48 的 status 对「还没开演」的场次完全不可信：官方一放出排期就可能直接给
//   3（已结束）或 1（录播）。线上曾把 9-26 / 9-27 两场未来公演显示成「录播」「已结束」。
//   所以「开始时间」永远优先于 status：
//     · 现在 < 开始时间        → 0 未开始 / 预告（不看 status）
//     · 开始后仍在合理时长内且 status=2 → 直播中
//     · 开播已远超该时长仍挂在 status=2 → 状态没更新，按已结束呈现
const LIVE_STALE_MS = 6 * 3600 * 1000;   // 单场口袋直播极少超过 6 小时
const PERF_STALE_MS = 5 * 3600 * 1000;   // 公演一般 2.5~3.5 小时，留足富余
function displayStatus(item, timeKey) {
  const s = Number(item.status);
  const key = timeKey === 'stime' ? 'stime' : 'ctime';
  const start = Number(item[key] || 0);
  if (!Number.isFinite(start) || start <= 0) return s;   // 没有开始时间就只能信 status
  const now = Date.now();
  if (now < start) return 0;                             // 还没开演 → 未开始 / 预告
  const stale = key === 'stime' ? PERF_STALE_MS : LIVE_STALE_MS;
  if (s === 2 && now - start > stale) return 3;           // 状态卡在「直播中」→ 已结束
  return s;
}

// 视频播放器（hls.js 播放 m3u8；Safari 原生支持）
let hlsInstance = null;
function setPlayerStatus(text, isError) {
  const hint = $('#playerHint');
  if (!hint) return;
  hint.textContent = text || '';
  hint.style.color = isError ? '#ff9a9a' : '#cfe';
}
function openPlayer(playUrl, title) {
  const modal = $('#playerModal');
  const video = $('#playerVideo');
  // rtmp:// 是直播拉流地址（浏览器无法直接播），只有 http(s) 的 m3u8 才能用 hls.js 播放
  if (!playUrl || !/^https?:/i.test(playUrl)) {
    $('#playerTitle').textContent = title || '视频回放';
    setPlayerStatus(playUrl
      ? '回放尚未生成（官方通常在直播结束后一段时间才生成），请稍后再来看看。'
      : '该条目暂无可用播放地址（可能是尚未生成录播的旧公演）。', true);
    modal.hidden = false;
    return;
  }
  $('#playerTitle').textContent = title || '视频回放';
  modal.hidden = false;

  // 释放上一次
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();

  const url = playUrl.replace(/^http:/, 'https:');
  setPlayerStatus('正在加载视频流…');
  const rawLine = `\n直链（可复制到 VLC 等播放器打开）：${url}`;

  if (window.Hls && window.Hls.isSupported()) {
    const hls = new window.Hls({ lowLatencyMode: false, enableWorker: true });
    hlsInstance = hls;
    hls.loadSource(url);
    hls.attachMedia(video);
    hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      setPlayerStatus('已解析，正在缓冲…（若未自动播放，请点播放器上的 ▶）');
      video.play().catch(() => {});
    });
    hls.on(window.Hls.Events.FRAG_LOADED, () => setPlayerStatus(''));
    hls.on(window.Hls.Events.ERROR, (_e, data) => {
      if (!data.fatal) return;
      let msg = '播放失败：' + (data.details || data.type);
      if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
        msg += '（网络请求被拦截 / 跨域 / 源受限）';
      } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
        try { hls.recoverMediaError(); msg += '（已尝试自动恢复）'; } catch { /* ignore */ }
      }
      setPlayerStatus(msg + rawLine, true);
    });
  } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
    video.src = url;
    video.play().catch(() => {});
    setPlayerStatus('使用浏览器原生播放器（Safari / 部分 iOS）');
  } else {
    setPlayerStatus('当前环境无法内嵌播放 m3u8（hls.js 未加载或被拦截）。' + rawLine, true);
  }
}
function closePlayer() {
  const modal = $('#playerModal');
  const video = $('#playerVideo');
  if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
  video.pause();
  video.removeAttribute('src');
  video.load();
  modal.hidden = true;
}

function renderCard(item, timeKey) {
  const cover = toUrl(item.coverPath || item.cover);
  // 直播标题常为默认数字（如 "1"），回退到成员昵称；公演用 title + subTitle
  const rawTitle = item.title || item.subTitle || '';
  const isGeneric = /^\d+$/.test(rawTitle.trim());
  const fallback = item.userInfo?.nickname || item.teamList?.[0]?.teamName || '';
  const title = !rawTitle || isGeneric ? (fallback || '未命名') : rawTitle;
  const sub = item.subTitle && item.subTitle !== title ? item.subTitle : '';
  const time = fmtDate(item[timeKey]) + ' ' + fmtTime(item[timeKey]);
  const playNum = item.playNum || item.playCount || '';
  // 只有 http(s) 的 m3u8 能播；rtmp:// 是直播拉流地址（浏览器播不了），不能给「▶ 播放」按钮
  const canPlay = !!item.playUrl && /^https?:/i.test(item.playUrl);
  const st = displayStatus(item, timeKey);
  // 未开演的场次只显示「未开始」；playUrlDead = 官方回放流已失效（ts.48.cn），
  // 此时若挂了 B 站备用源就只显示 B 站按钮
  const noPlayText = st === 0 ? (timeKey === 'stime' ? '未开始' : '未开播')
    : (item.playUrlDead ? '官方回放已失效'
    : (item.playUrl && !canPlay ? (st === 2 ? '直播中' : '回放生成中')
    : (timeKey === 'ctime' && st === 3 ? '无回放' : '无视频')));
  const playBtn = canPlay
    ? `<button class="play-btn" data-play="${escapeHtml(item.playUrl)}" data-title="${escapeHtml(title + ' · ' + time)}">▶ 播放</button>`
    : (item.biliUrl || st === 0 ? '' : `<span class="no-play">${noPlayText}</span>`);   // 未开演时角标已说明，不再重复一行
  // 无录播（或有）时的 B 站跳转（按名称手工匹配挂上）
  const biliBtn = item.biliUrl
    ? `<a class="bili-btn" href="${escapeHtml(item.biliUrl)}" target="_blank" rel="noopener">📺 B 站观看</a>`
    : '';
  // 该场对应的公演 cut（来自微博切片）：角标跳转到「公演cut」分组
  const cutBtn = (item._cutCount)
    ? `<button class="cut-btn" type="button" onclick="gotoPerfCuts('${escapeHtml(item._cutDate)}')">🎬 ${item._cutCount} cut</button>`
    : '';
  // 该场对应的她的个人 cut（B 站合集）：角标跳到「她的cut」栏的对应日期
  const biliCutBtn = item._biliCutDate
    ? `<button class="cut-btn bc-btn" type="button" title="${escapeHtml(item._biliCutTitle || '')}" onclick="gotoPerfCuts('${escapeHtml(item._biliCutDate)}')">✂️ B站cut</button>`
    : '';
  // 该场直播对应的 B 站切片 / 回放：角标跳到「直播切片」栏的对应日期
  const liveCutBtn = (item._liveCutCount)
    ? `<button class="cut-btn" type="button" onclick="gotoLiveCuts('${escapeHtml(item._liveCutId)}')">🎬 ${item._liveCutCount} 切片</button>`
    : '';
  const demoT = timeKey === 'ctime' ? 'live' : 'perf';
  const demoK = (item.liveId ? demoT + ':' + item.liveId : demoT + ':' + title + ':' + time);
  return `<div class="card" data-k="${escapeHtml(String(demoK))}" data-t="${demoT}" data-title="${escapeHtml(title)}" data-time="${escapeHtml(time)}">
    ${cover ? `<img class="card-img" loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(cover)}" alt="" onclick="window.__lightboxShow(this.src)" onerror="this.classList.add('failed')" />` : ''}
    <div class="card-body">
      <p class="card-title">${escapeHtml(title)}</p>
      ${sub ? `<p class="card-sub">${escapeHtml(sub)}</p>` : ''}
      <div class="card-meta">
        ${liveStatusBadge(st, timeKey === 'stime' ? 'perf' : 'live')}
        <span>🕒 ${escapeHtml(time)}</span>
        ${playNum ? `<span>▶ ${escapeHtml(String(playNum))}</span>` : ''}
      </div>
      <div class="card-actions">${playBtn}${biliBtn}${biliCutBtn}${cutBtn}${liveCutBtn}</div>
    </div>
  </div>`;
}

/* ---------------- 直播 / 录播（含子标签：直播回放 / 直播切片） ---------------- */
const LIVE_SUBS = [
  ['replay', '直播回放'],
  ['cuts', '直播切片']
];
// 「直播切片」栏收录范围（用户 2026-09-22 两轮明确后的最终口径）：
//   ✅ 收：「王语晨直播回放」合集 + 「王语晨直播cut」合集 + 无合集 UP（忘记自己是猪，其投稿本身即切片）
//   ❌ 不收：公演cut / 官方视频cut / unit-mc cut / 2025特殊舞台 / 口袋语音 / 其他成员直播cut
//     （数据仍完整保留在 live-cuts.js，将来要放进来只改这一行）
// 有合集 → 以 UP 的归类为准（含合集内的电台回放 —— 电台也是直播的一种形式）。
const LIVE_CUT_COLLECTIONS = /王语晨直播回放|王语晨直播cut/;
function liveCutList() {
  const all = (DATA.liveCuts && DATA.liveCuts.cuts) || [];
  // 有合集 → 以 UP 的归类为准：「王语晨直播cut」合集里的**全部**内容都收。
  //   ⚠️ 该合集里混有 2 条「电台直播回放」（20260711 / 20251216 第二段）——
  //   电台也是她的一种直播形式，属于本栏，不能因为标题带「回放」就排除。
  // 无合集 → 该号投稿本身即切片（忘记自己是猪），但标题带「回放」的仍排除。
  return all.filter((c) => (c.collection ? LIVE_CUT_COLLECTIONS.test(c.collection) : c.kind === "cut"));
}

function renderLive() {
  const panel = panels.live;
  const subtabs = LIVE_SUBS.map(([k, label]) =>
    `<button class="subtab${state.liveSub === k ? ' active' : ''}" data-sub="${k}">${escapeHtml(label)}</button>`
  ).join('');
  panel.innerHTML = `
    <div class="perf">
      <div class="subtabs">${subtabs}</div>
      <div class="perf-sub" id="liveSub"></div>
    </div>`;
  renderLiveSub();
}

function renderLiveSub() {
  const box = $('#liveSub');
  if (!box) return;
  if (state.liveSub === 'cuts') { box.innerHTML = renderLiveCuts(); return; }
  // 直播回放（原 renderLive 内容）
  let list = DATA.live;
  if (state.query) list = list.filter((m) =>
    (m.title || '').toLowerCase().includes(state.query) ||
    (m.userInfo?.nickname || '').toLowerCase().includes(state.query)
  );
  if (dateFilterActive()) list = list.filter((m) => inDateRange(m.ctime));
  if (!list.length) {
    box.innerHTML = filterNote(0) +
      `<div class="empty-state">${dateFilterActive() ? '该时间范围内没有直播，点上方「清除筛选」看全部。' : '暂无直播数据。'}</div>`;
    return;
  }
  // 按 liveId 统计该场直播有几个 B 站切片/回放 → 卡片上出现「🎬 N 切片」角标，点了跳到切片栏对应日期
  const byLive = {};
  for (const c of liveCutList()) {
    if (!c.liveId) continue;
    const k = String(c.liveId);
    if (!byLive[k]) byLive[k] = { n: 0 };
    byLive[k].n++;
  }
  const list2 = list.map((p) => {
    const c = byLive[String(p.liveId)];
    // 用 liveId 定位（而不是日期）：切片发布日不等于直播日，按日期跳转会跳错组
    return c ? { ...p, _liveCutCount: c.n, _liveCutId: String(p.liveId) } : p;
  });
  box.innerHTML = filterNote(list2.length) +
    `<div class="card-grid">${list2.map((m) => renderCard(m, 'ctime')).join('')}</div>`;
}

// 直播切片 / 直播回放列表：按【标题日期优先、否则发布时间】分天倒序，
// 同一天里该 UP 的切片与回放并列，方便对照「这场直播有哪些片段」。
function renderLiveCuts() {
  const data = liveCutList();
  if (!data.length) return '<div class="empty">暂无直播切片。数据随抓取自动更新，若刚上线请稍后再看。</div>';
  // ★ 分组键用「直播场次」而不是日期：
  //   切片是直播结束后才剪出来发的（实测同一直播的切片可跨 3 天发布），
  //   若按发布时间分组，同一场直播的回放与切片会被拆散，还会把「09-16 的直播」
  //   和「09-16 发布的切片」混为一谈。
  //   所以：能对上直播的 → 按 liveId 归组；对不上的 → 按发布日排在时间线上。
  const groups = new Map();
  data.forEach((c) => {
    const day = c.liveDate || c.titleDate || c.date;
    const key = c.liveId ? ('live:' + c.liveId) : ('day:' + day);
    let g = groups.get(key);
    if (!g) { g = { live: !!c.liveId, liveId: c.liveId || '', day, items: [] }; groups.set(key, g); }
    g.items.push(c);
  });
  const list = [...groups.values()].sort((a, b) => String(b.day).localeCompare(String(a.day)));
  let html = '';
  list.forEach((g) => {
    // 组内：回放排最前，其余（切片）按发布时间正序
    const arr = g.items.slice().sort((a, b) =>
      (a.kind === 'replay' ? 0 : 1) - (b.kind === 'replay' ? 0 : 1) || a.created - b.created);
    const nReplay = arr.filter((x) => x.kind === 'replay').length;
    const nCut = arr.length - nReplay;
    const parts = [];
    if (nCut) parts.push(`切片 ${nCut}`);
    if (nReplay) parts.push(`回放 ${nReplay}`);   // 仅「直播cut」合集内混入的电台回放会走到这
    const gid = 'lc-group-' + (g.live ? 'live-' + g.liveId : 'day-' + g.day);
    html += `<section class="pc-group" id="${escapeHtml(gid)}">`
      + `<h2 class="pc-group-h"><span class="ym">${escapeHtml(g.day)}</span>`
      + (g.live ? '' : '<span class="pub">未对上直播 · 按发布日</span>')
      + `<span class="perf">${parts.join(' · ')}</span>`
      + `<span class="n">${arr.length} 条</span></h2><div class="pc-grid">`;
    arr.forEach((c) => {
      const cover = c.cover
        ? `<img src="${escapeHtml(c.cover)}" loading="lazy" referrerpolicy="no-referrer" alt="">`
        : '<div class="pc-void">▶</div>';
      // 左下角标出「UP · 发布 MM-DD」：组标题是直播日，而这条的发布日可能晚一两天，
      // 标出来才不会让人误以为它和直播同一天。
      const meta = `${c.up || ''} · 发布 ${String(c.date || '').slice(5)}`;
      html += `<a class="pc-card" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${cover}`
        + '<div class="pc-scrim"></div>'
        + (c.kind ? `<span class="pc-ov song">${c.kind === 'replay' ? '回放' : '切片'}</span>` : '')
        + `<span class="pc-ov date">${escapeHtml(meta)}</span>`
        + '<span class="pc-ov go">去 B 站看 ↗</span>'
        + '</a>';
    });
    html += '</div></section>';
  });
  return html;
}

// 从直播回放卡片的「🎬 N 切片」跳到切片栏对应的那一场（按 liveId 定位，不依赖日期）
function gotoLiveCuts(liveId) {
  state.liveSub = 'cuts';
  switchTab('live');
  setTimeout(() => {
    const el = document.getElementById('lc-group-live-' + liveId);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, 60);
}

// 启动（脚本位于 </body> 前，DOM 已就绪；注意：这一行曾被补丁误删过，勿移除）
init();

/* ---------------- 新粉指南子标签：社媒美图（@忘记自己是鱼_ 本人发的照片/视频） ----------------
   数据来自 DATA.social（site/data/social-media.js，自动生成）。
   图片为微博图床原始 URL，经站点图片代理 /img/?u=<encoded> 获取（直链会被 403 拦截）。
   已剔除：① mymblog 混入的「她赞过的微博」卡片（非本人发布）；② 本人发的表情包/文字图/截图。 */
let socialFilter = 'all';

function proxyImg(url) {
  // 正式站与 Worker 同域 → 相对路径即可；UAT 预览站在别的域名 → 必须带上 API_BASE，否则图全 404
  try { return (typeof API_BASE === 'string' ? API_BASE : '') + '/img?u=' + encodeURIComponent(url); } catch (e) { return url; }
}

function ensureSocialModal() {
  if (document.getElementById('sgModal')) return;
  const d = document.createElement('div');
  d.className = 'sg-modal';
  d.id = 'sgModal';
  d.setAttribute('onclick', "if(event.target===this)closeSocialModal()");
  d.innerHTML =
    '<div class="sg-mbox"><div class="sg-mhead">'
    + '<span class="who">忘记自己是鱼_</span><span class="plat">微博</span>'
    + '<span class="date" id="sgMDate"></span>'
    + '<button class="x" onclick="closeSocialModal()">✕</button></div>'
    + '<div class="sg-mbody"><p class="sg-mtext" id="sgMText"></p><div id="sgMMedia"></div></div>'
    + '<div class="sg-mfoot"><a class="sg-btn" id="sgMLink" target="_blank" rel="noopener">' + trUI('viewOriginal', state.lang) + ' ↗</a></div></div>';
  document.body.appendChild(d);
}

function renderSocialGallery() {
  ensureSocialModal();
  return ''
    + '<div class="sg-toolbar"><input id="sgSearch" type="text" placeholder="搜索文字内容…" oninput="renderSocialWall()">'
    + '<div class="sg-filters">'
    + '<button class="sg-fbtn' + (socialFilter === 'all' ? ' active' : '') + '" data-f="all" onclick="setSocialFilter(\'all\')">全部</button>'
    + '<button class="sg-fbtn' + (socialFilter === 'photo' ? ' active' : '') + '" data-f="photo" onclick="setSocialFilter(\'photo\')">照片</button>'
    + '<button class="sg-fbtn' + (socialFilter === 'video' ? ' active' : '') + '" data-f="video" onclick="setSocialFilter(\'video\')">视频</button>'
    + '</div></div>'
    + '<div class="sg-count" id="sgCount"></div><div id="sgGallery"></div>';
}

function setSocialFilter(f) {
  socialFilter = f;
  document.querySelectorAll('.sg-fbtn').forEach(b => b.classList.toggle('active', b.dataset.f === f));
  renderSocialWall();
}

function socialVisible() {
  const data = DATA.social || [];
  const q = (document.getElementById('sgSearch').value || '').trim().toLowerCase();
  return data.filter(it => {
    if (socialFilter !== 'all' && it.k !== socialFilter) return false;
    if (q && (it.t || '').toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}

function renderSocialWall() {
  const data = DATA.social || [];
  const sel = socialVisible();
  const count = document.getElementById('sgCount');
  if (count) count.innerHTML = '显示 <b>' + sel.length + '</b> / ' + data.length + ' 条' + (socialFilter === 'all' ? '' : '（' + (socialFilter === 'photo' ? '照片' : '视频') + '）');
  const g = document.getElementById('sgGallery');
  if (!g) return;
  if (!sel.length) { g.innerHTML = '<div class="empty">没有匹配的内容</div>'; return; }
  const months = [], map = {};
  sel.forEach(it => { if (!map[it.m]) { map[it.m] = []; months.push(it.m); } map[it.m].push(it); });
  months.sort((a, b) => b.localeCompare(a));
  let html = '';
  months.forEach(m => {
    const arr = map[m];
    html += '<section class="sg-month"><h2 class="sg-month-h"><span class="ym">' + escapeHtml(m) + '</span><span class="n">' + arr.length + ' 条</span></h2><div class="sg-grid">';
    arr.forEach(it => {
      const idx = data.indexOf(it);
      const cnt = it.k === 'video'
        ? '<span class="sg-ov cnt v">▶ 视频</span>'
        : (it.n > 1 ? '<span class="sg-ov cnt">×' + it.n + '</span>' : '');
      // 照片取首图作封面；视频取视频封面（多数拿不到 → 占位）
      const cover = it.k === 'video' ? it.cover : (it.p && it.p[0]);
      const media = cover
        ? '<img src="' + escapeHtml(proxyImg(cover)) + '" loading="lazy" alt="">'
        : '<div class="sg-void">▶<span class="t">' + escapeHtml((it.t || '').slice(0, 22)) + '</span></div>';
      html += '<div class="sg-card" onclick="openSocialModal(' + idx + ')">' + media
        + '<div class="sg-scrim"></div>'
        + '<span class="sg-ov who">忘记自己是鱼_</span>' + cnt
        + '<span class="sg-ov plat">微博</span>'
        + '<span class="sg-ov date">' + escapeHtml(it.d) + '</span>'
        + '</div>';
    });
    html += '</div></section>';
  });
  g.innerHTML = html;
}

function openSocialModal(i) {
  const it = (DATA.social || [])[i];
  if (!it) return;
  track('social:open');
  document.getElementById('sgMDate').textContent = it.d;
  document.getElementById('sgMText').textContent = it.t || '';
  document.getElementById('sgMLink').href = it.u;
  const mm = document.getElementById('sgMMedia');
  if (it.k === 'video') {
    mm.innerHTML = '<div class="sg-mvid"><div class="big">▶</div><div>' + trUI('videoGoOriginal', state.lang) + '</div>'
      + (it.cover ? '<img src="' + escapeHtml(proxyImg(it.cover)) + '" style="width:100%;max-width:420px;border-radius:10px;" alt="">' : '') + '</div>';
  } else if (it.p && it.p.length) {
    mm.innerHTML = '<div class="sg-mmedia">' + it.p.map(u =>
      '<img src="' + escapeHtml(proxyImg(u)) + '" loading="lazy" onclick="window.open(\'' + escapeHtml(proxyImg(u)) + '\',\'_blank\')" alt="">'
    ).join('') + '</div>';
  } else { mm.innerHTML = ''; }
  document.getElementById('sgModal').classList.add('on');
}

function closeSocialModal() {
  const m = document.getElementById('sgModal');
  if (m) m.classList.remove('on');
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { const m = document.getElementById('sgModal'); if (m && m.classList.contains('on')) closeSocialModal(); }
});
