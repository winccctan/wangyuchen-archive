// 王语晨补档站 - 前端逻辑
const DATA = { meta: null, messages: [], live: [], performances: [] };
// msgKey → message，便于翻译时按 id 取到原文（重新渲染后 DOM 里只剩 mid）
const MSG_INDEX = new Map();
const state = { tab: 'messages', query: '', dateFrom: null, dateTo: null, dayLimit: 3, lang: 'zh', expanded: new Set(), guideSub: 'guide', perfSub: 'perf' };

const $ = (sel) => document.querySelector(sel);
const panels = {
  messages: $('#panel-messages'),
  live: $('#panel-live'),
  performances: $('#panel-performances'),
  guide: $('#panel-guide')
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
  // 经历备注（SNH48 官网 member-detail，新→旧；tag: 高飞/梦想/新人）
  experience: [
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

/* ---------------- 多语言翻译（浏览器按需，免费接口 + localStorage 缓存） ---------------- */
// 目标语言：中 / 英 / 西 / 葡 / 日 / 越 / 韩。选「中文」时不做任何翻译。
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
  pt: { translate: '🌐 Traduzir', hide: '🌐 Ocultar tradução', page: '🌐 Traduzir página', loading: 'Traduzindo…', fail: 'Falha na tradução', viewOriginal: 'Ver postagem original', viewRaw: 'Ver dados originais', videoGoOriginal: 'Vídeo · abra a postagem original para assistir' },
  vi: { translate: '🌐 Dịch', hide: '🌐 Ẩn bản dịch', page: '🌐 Dịch trang này', loading: 'Đang dịch…', fail: 'Lỗi dịch', viewOriginal: 'Xem bài gốc', viewRaw: 'Xem dữ liệu gốc', videoGoOriginal: 'Video · mở bài gốc để xem' },
  ko: { translate: '🌐 번역', hide: '🌐 번역 숨기기', page: '🌐 이 페이지 번역', loading: '번역 중…', fail: '번역 실패', viewOriginal: '원본 게시물 보기', viewRaw: '원본 데이터 보기', videoGoOriginal: '동영상 · 원본 게시물에서 시청하세요' },
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
  if (proxyOk !== false) sources.push({ kind: 'proxy', url: `/translate?tl=${tl}&q=${q}`, parse: pParse, timeout: 9000 });
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
      ? escapeHtml(t)
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
        : escapeHtml(s._t);
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

async function loadArchive() {
  const isFile = location.protocol === 'file:';
  let candidates;
  if (isFile) {
    // file:// 下带查询串会取不到文件，只能直接加载
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
      if (window.__ARCHIVE__) return window.__ARCHIVE__;
      lastErr = new Error('数据文件内容为空');
    } catch (e) {
      lastErr = e;
    }
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
    // 1) 先用 500 字节的 meta.json 看版本号，并重载一次：
    //    版本号变了 → 拿到最新快照（提示已同步）；没变 → URL 不变，浏览器缓存直接命中，几乎秒回。
    const ver = await dataVersion();
    await applyLatest();
    if (ver && ver !== beforeTs) {
      showToast('✅ 已同步到最新补档');
      return; // ← finally 会负责恢复按钮
    }

    // 2) 数据没变化 → 静默触发一次后台抓取（GitHub Actions），失败也不提示
    try {
      const r = await fetch('/scrape', { method: 'POST', cache: 'no-store' });
      if (r.ok) { const j = await r.json().catch(() => ({})); triggered = !j.skipped; }
    } catch (_) { /* 忽略 */ }

    // 3) 抓取 → 提交 → Cloudflare 部署这一条链路通常 1~3 分钟。这里最多自动等 3 分钟，
    //    期间粉丝只需点一次；超时或已是最新就释放按钮，不把刷新键锁死。
    const deadline = Date.now() + 180 * 1000;
    let waited = 0, updated = false;
    while (Date.now() < deadline) {
      await sleep(10000); waited += 10;
      btn.textContent = `同步中 ${waited}s…`;
      try {
        const v = await dataVersion();
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
    if (!updated && triggered) showToast('抓取已触发，稍后再点一次刷新即可看到最新');
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
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });
  $('#searchInput').addEventListener('input', (e) => { state.query = e.target.value.trim().toLowerCase(); renderAll(); });
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
      const f = $('#dateFrom').value, t = $('#dateTo').value;
      // 固定按北京时间 0 点（+08:00）取边界，避免访客本地时区导致前后差一天
      state.dateFrom = f ? new Date(f + 'T00:00:00+08:00').getTime() : null;          // 当天 0 点
      state.dateTo = t ? new Date(t + 'T00:00:00+08:00').getTime() + 86400000 : null; // 次日 0 点（含当天）
      closeDateModal();
      state.dayLimit = 3;
      renderAll(); // 发言 / 直播录播 / 公演 三个页都要按新时间范围刷新
      showToast(state.dateFrom || state.dateTo ? '✅ 已按时间筛选' : '✅ 已显示全部时间');
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
      openPlayer(playBtn.dataset.play, playBtn.dataset.title);
      return;
    }
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
      if (state.tab === 'performances') {
        state.perfSub = subBtn.dataset.sub;
        panels.performances.querySelectorAll('.subtab').forEach((b) =>
          b.classList.toggle('active', b.dataset.sub === state.perfSub));
        renderPerfSub();
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
  // 「📅 时间」筛选与「搜索」仅对「发言 / 直播录播 / 公演」有意义；新粉指南页自带内容，隐藏这两项
  const isGuide = name === 'guide';
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

function renderAll() {
  if (state.tab === 'messages') renderMessages();
  else if (state.tab === 'live') renderLive();
  else if (state.tab === 'guide') renderGuide();
  else renderPerformances();
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
  if (state.perfSub === 'cuts') { box.innerHTML = renderPerfCuts(); return; }
  // 公演回放（原 renderPerformances 内容）
  let list = DATA.performances;
  if (state.query) list = list.filter((m) => (m.title || '').toLowerCase().includes(state.query));
  if (dateFilterActive()) list = list.filter((m) => inDateRange(m.stime));
  // 挂上该场对应的 cut 数量 / 日期（用于卡片角标跳转）
  const cutByLive = {};
  (window.PERF_CUTS ? window.PERF_CUTS.cuts : []).forEach(c => {
    if (c.liveId) { if (!cutByLive[c.liveId]) cutByLive[c.liveId] = { n: 0, date: c.date }; cutByLive[c.liveId].n++; }
  });
  list = list.map(p => {
    const c = cutByLive[p.liveId];
    return c ? { ...p, _cutCount: c.n, _cutDate: c.date } : p;
  });
  if (!list.length) {
    box.innerHTML = filterNote(0) +
      `<div class="empty-state">${dateFilterActive() ? '该时间范围内没有公演，点上方「清除筛选」看全部。' : '暂无公演数据。'}</div>`;
    return;
  }
  box.innerHTML = filterNote(list.length) +
    `<div class="card-grid">${list.map((m) => renderCard(m, 'stime')).join('')}</div>`;
}

function renderPerfCuts() {
  const data = window.PERF_CUTS ? window.PERF_CUTS.cuts : [];
  if (!data.length) return '<div class="empty">暂无公演 cut。</div>';
  const groups = {}, order = [];
  data.forEach(c => { if (!groups[c.date]) { groups[c.date] = []; order.push(c.date); } groups[c.date].push(c); });
  order.sort((a, b) => b.localeCompare(a));
  let html = '';
  order.forEach(date => {
    const arr = groups[date];
    const perf = arr[0].perf || '';
    html += `<section class="pc-group" id="pc-group-${escapeHtml(date)}">`
      + `<h2 class="pc-group-h"><span class="ym">${escapeHtml(date)}</span>`
      + `<span class="perf">${escapeHtml(perf)}</span><span class="n">${arr.length} 条</span></h2>`
      + '<div class="pc-grid">';
    arr.forEach(c => {
      const cover = c.cover ? `<img src="${escapeHtml(proxyImg(c.cover))}" loading="lazy" alt="">` : '<div class="pc-void">▶</div>';
      html += `<a class="pc-card" href="${escapeHtml(c.url)}" target="_blank" rel="noopener">${cover}`
        + '<div class="pc-scrim"></div>'
        + (c.song ? `<span class="pc-ov song">${escapeHtml(c.song)}</span>` : '')
        + `<span class="pc-ov date">${escapeHtml(c.date)}</span>`
        + '<span class="pc-ov go">跳转原帖 ↗</span>'
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
    moreBtn.addEventListener('click', () => {
      const y = window.scrollY;
      state.dayLimit += 7;
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
    ${reply.text ? `<div class="msg-quote-text">${escapeHtml(reply.text)}</div>` : ''}
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
    ? `<button class="msg-card-link as-btn" type="button" data-goto="live">前往直播 / 录播 ›</button>`
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
  if (m.text) body += `<div class="msg-body">${escapeHtml(m.text)}</div>`;
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

  return `<div class="msg${isSelf ? '' : ' from-other'}">
    <div class="msg-head">
      <span class="msg-time">${fmtTime(m.msgTime)}</span>
      <span class="msg-type">${typeLabel}</span>
      ${sender}
    </div>
    ${body}
    ${footer}
  </div>`;
}

function liveStatusBadge(status) {
  const s = Number(status);
  if (s === 2) return '<span class="badge live">直播中</span>';
  if (s === 1) return '<span class="badge rec">录播</span>';
  if (s === 0) return '<span class="badge soon">预告</span>';
  return '<span class="badge end">已结束</span>';
}

// 直播「结束判定」前端兜底：口袋48 的直播结束后若官方未生成回放，该条目会从
// 「直播中」「录播」两个列表同时消失，抓取端拿不到状态更新，本地 status 可能仍停在 2。
// 这里按开播时间兜底：开播已超过 6 小时仍标记「直播中」的，一律按已结束呈现。
// （单场口袋直播极少超过 6 小时，阈值足够安全；抓取端正常时不会走到这里。）
const LIVE_STALE_MS = 6 * 3600 * 1000;
function displayStatus(item) {
  const s = Number(item.status);
  if (s === 2 && item.ctime) {
    const started = Number(item.ctime);
    if (Number.isFinite(started) && started > 0 && Date.now() - started > LIVE_STALE_MS) return 3;
  }
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
  const st = displayStatus(item);
  // 排期累积来的场次（尚未开演 / 尚无录播）标记为 upcoming；
  // playUrlDead = 官方回放流已失效（ts.48.cn），此时若挂了 B 站备用源就只显示 B 站按钮
  const noPlayText = item.upcoming ? '即将开演'
    : (item.playUrlDead ? '官方回放已失效'
    : (item.playUrl && !canPlay ? (st === 2 ? '直播中' : '回放生成中')
    : (timeKey === 'ctime' && st === 3 ? '无回放' : '无视频')));
  const playBtn = canPlay
    ? `<button class="play-btn" data-play="${escapeHtml(item.playUrl)}" data-title="${escapeHtml(title + ' · ' + time)}">▶ 播放</button>`
    : (item.biliUrl ? '' : `<span class="no-play">${noPlayText}</span>`);
  // 无录播（或有）时的 B 站跳转（按名称手工匹配挂上）
  const biliBtn = item.biliUrl
    ? `<a class="bili-btn" href="${escapeHtml(item.biliUrl)}" target="_blank" rel="noopener">📺 B 站观看</a>`
    : '';
  // 该场对应的公演 cut（来自微博切片）：角标跳转到「公演cut」分组
  const cutBtn = (item._cutCount)
    ? `<button class="cut-btn" type="button" onclick="gotoPerfCuts('${escapeHtml(item._cutDate)}')">🎬 ${item._cutCount} cut</button>`
    : '';
  return `<div class="card">
    ${cover ? `<img class="card-img" loading="lazy" referrerpolicy="no-referrer" src="${escapeHtml(cover)}" alt="" onclick="window.__lightboxShow(this.src)" onerror="this.classList.add('failed')" />` : ''}
    <div class="card-body">
      <p class="card-title">${escapeHtml(title)}</p>
      ${sub ? `<p class="card-sub">${escapeHtml(sub)}</p>` : ''}
      <div class="card-meta">
        ${item.upcoming ? '<span class="badge soon">即将开始</span>' : liveStatusBadge(st)}
        <span>🕒 ${escapeHtml(time)}</span>
        ${playNum ? `<span>▶ ${escapeHtml(String(playNum))}</span>` : ''}
      </div>
      <div class="card-actions">${playBtn}${biliBtn}${cutBtn}</div>
    </div>
  </div>`;
}

function renderLive() {
  const panel = panels.live;
  let list = DATA.live;
  if (state.query) list = list.filter((m) =>
    (m.title || '').toLowerCase().includes(state.query) ||
    (m.userInfo?.nickname || '').toLowerCase().includes(state.query)
  );
  if (dateFilterActive()) list = list.filter((m) => inDateRange(m.ctime));
  if (!list.length) {
    panel.innerHTML = filterNote(0) +
      `<div class="empty-state">${dateFilterActive() ? '该时间范围内没有直播 / 录播，点上方「清除筛选」看全部。' : '暂无直播 / 录播数据。'}</div>`;
    return;
  }
  panel.innerHTML = filterNote(list.length) +
    `<div class="card-grid">${list.map((m) => renderCard(m, 'ctime')).join('')}</div>`;
}

init();

/* ---------------- 新粉指南子标签：社媒美图（@忘记自己是鱼_ 本人发的照片/视频） ----------------
   数据来自 window.SOCIAL_MEDIA（site/data/social-media.js，自动生成）。
   图片为微博图床原始 URL，经站点图片代理 /img/?u=<encoded> 获取（直链会被 403 拦截）。
   已剔除：① mymblog 混入的「她赞过的微博」卡片（非本人发布）；② 本人发的表情包/文字图/截图。 */
let socialFilter = 'all';

function proxyImg(url) {
  try { return '/img?u=' + encodeURIComponent(url); } catch (e) { return url; }
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
  const data = window.SOCIAL_MEDIA || [];
  const q = (document.getElementById('sgSearch').value || '').trim().toLowerCase();
  return data.filter(it => {
    if (socialFilter !== 'all' && it.k !== socialFilter) return false;
    if (q && (it.t || '').toLowerCase().indexOf(q) < 0) return false;
    return true;
  });
}

function renderSocialWall() {
  const data = window.SOCIAL_MEDIA || [];
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
  const it = (window.SOCIAL_MEDIA || [])[i];
  if (!it) return;
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
