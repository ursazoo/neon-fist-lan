# Neon Fist 局域网双人版

两台电脑打开同一网页，各自用键盘进行 1v1 对战。网页可部署到 GitHub Pages。连接时手动交换主机码和应答码，不需要账号、房间服务器或数据库。

基于 [Neon Fist](https://github.com/developerrutu/neon-fist) 修改，保留上游的战斗、程序生成角色、场景和声音。来源版本与许可证见 [UPSTREAM.md](UPSTREAM.md) 和 [LICENSE](LICENSE)。

## 在本机打开

安装 Node.js 22 或更新版本，在项目目录运行：

```sh
npm run dev
```

打开终端显示的 `http://127.0.0.1:4174`。无需 `npm install`。不要直接双击 `index.html`，浏览器会限制本地文件读取 JSON 和模块。

## 部署到 GitHub Pages

1. 新建 GitHub 仓库，将本目录内容放在仓库根目录，包括 `.github/workflows/pages.yml` 和 `LICENSE`。
2. 在仓库的 **Settings → Pages → Build and deployment → Source** 中选择 **GitHub Actions**。
3. 将代码推送到 `main`，或在 **Actions → Deploy GitHub Pages → Run workflow** 手动运行。
4. 等部署任务成功，打开 **Settings → Pages** 显示的网址。通常是 `https://你的用户名.github.io/仓库名/`。

工作流仅发布游戏 HTML、模块、JSON 数据、图标和许可证，不发布测试报告或开发脚本。

## 两台电脑连接

两台电脑连接同一 Wi-Fi，并各自打开相同的部署网址。建议先使用最新版桌面 Chrome 或 Edge，保持游戏窗口可见。

1. 双方点击 **联机对战**。
2. 电脑 A 创建主机，等待生成连接码，将主机码完整发送给电脑 B。
3. 电脑 B 选择加入，粘贴主机码并接受，在 3 分钟内将生成的应答码完整发回 A。
4. 电脑 A 粘贴应答码并接受。双方连接成功后自动开局。

主机控制左侧 P1，加入者控制右侧 P2。两台电脑使用相同键位：

| 操作 | 按键 |
| --- | --- |
| 左右移动 | A / D |
| 跳跃 | W |
| 下蹲 | S |
| 出拳 | J |
| 踢腿 | K |
| 防御 | L |

必杀技方向以角色面向为准。波动拳为 `↓ ↘ → + J`，升龙拳为 `→ ↓ ↘ + J`，旋风腿为 `↓ ↙ ← + K`。比赛结束后双方都确认重赛才开始下一局。

连接码需要完整复制，不是短房间号。每次重新创建连接后使用新码。若复制按钮受浏览器限制，选择文本框中的全部内容手动复制。

## 连接和同步范围

本版使用 WebRTC 的可靠有序数据通道，`iceServers` 为空，不连接外部 STUN 或 TURN。双方收齐某一帧的输入才推进战斗，并比较共同帧的状态校验。网络或对方窗口停顿时会等待，不预测远端动作。

这适合同一局域网的最小验证。访客 Wi-Fi 的设备隔离、系统防火墙或路由器规则可能阻止直连。第一版不提供跨公网穿透、短房间号、自动匹配或作弊防护。

从 GitHub Pages 首次打开网页需要网络。同一 Wi-Fi 不代表两个设备一定可以互相访问。

## 运行验证

角色采用逐帧精灵，来源及独立素材许可证见 [素材署名](assets/fighters/CREDITS.md)。两位玩家共用动作素材，通过配色和镜像区分。动画时间跟随战斗模拟帧，等待远端输入、暂停和命中停顿时停止播放。

```sh
npm run check
node --test tests/*.test.mjs
npm run test:browser
```

浏览器测试使用本机 Chrome 的真实 WebRTC 和两个独立窗口，完成手动信令、键盘移动与攻击、共同帧状态校验和断线检查。默认使用 macOS 的 Google Chrome；其他位置可通过 `CHROME_BIN` 指定。测试无需 Playwright 或下载浏览器。

浏览器测试将截图与结果写入 `artifacts/`。单机双窗口测试不能替代两台实体电脑在目标 Wi-Fi 下的验收。

逐帧动作的浏览器检查可复用已启动的 Chrome CDP 与本地预览，运行 `CDP_PORT=19334 SITE_URL=http://127.0.0.1:4174/ node tests/sprites.browser.mjs`。该检查使用真实键盘事件验证完整帧序列，并将动作记录保存到 `artifacts/sprites/`。
