/* 王语晨 音乐作品（发行曲 / 单曲）—— 站「公演 → 音乐作品」子标签页数据
 * 说明：
 *  - 她没有独立歌手主页，SNH48 系作品都挂在团体 EP / 数字单曲 / 年度盛典作品辑里；
 *  - 本表为「她署名参与演唱」的发行作品清单，按年份倒序；
 *  - 数据来自公开资料 + 抓取（2026-10-14 经 WebFetch 通道核对网易云 / QQ音乐 精确 id）；
 *  - nc    = 网易云精确歌曲 id（点开即该首）；
 *  - qqmid = QQ音乐精确 songmid（点开即该首）；
 *  - bili  = B站官方音源 BV 号（团体官方账号上传，点开即该首）；
 *  - 收录原则：网易云 / QQ音乐 / B站官方 任一平台有「她的版本」音源才保留，三个都没有则不放；
 *  - 渲染时各平台按钮只在确有该平台音源时才挂（避免「打不开对应歌」）；
 *  - ❌ 不落地音频文件（NCM/mgg 加密 + 版权）。
 */
window.__MUSIC_WORKS__ = [
  { title: '过去完成时', credit: '单人', album: '第十三届年度青春盛典作品辑', year: 2026, qqmid: '0011Xl4747Mxyr', bili: 'BV1WqTD6vEAy' },
  { title: '非正式告别', credit: '与刘力菲 对唱', album: '乐曜曲计划数字单曲', year: 2025, nc: 2711833209, qqmid: '003eUVqy43kqzP' },
  { title: 'Mint Candy（薄荷糖）', credit: '参与演唱', album: 'EP 同名主打', year: 2024, qqmid: '003Qv4i41w9UGH' },
  { title: '闪耀的愿望', credit: '多人合唱', album: '年度主题曲', year: 2024, qqmid: '003As5VN1xMvYs' },
  { title: '不完美', credit: 'GNZ48（总决选 live）', album: 'Into The World 专辑', year: 2023, nc: 1383678416 },
  { title: 'Circle', credit: '团体（GNZ48）', album: '公演曲目', year: 0, qqmid: '0033Jvea0Y9pdI' }
];
