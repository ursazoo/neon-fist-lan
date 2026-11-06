# Neon Fist 局域网双人版

两台电脑打开同一网页，各自用键盘进行 1v1 对战。创建房间后，对方输入 6 位房间号或打开邀请链接即可加入。网页部署在 GitHub Pages，使用免费的 PeerServer Cloud 交换连接信息，不需要账号或自行部署后端。

基于 [Neon Fist](https://github.com/developerrutu/neon-fist) 修改，保留上游的战斗、场景和声音。角色换为 DeepSeek、Claude、ChatGPT 的二创少女形象。来源版本与许可证见 [UPSTREAM.md](UPSTREAM.md) 和 [LICENSE](LICENSE)。

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

双方先选择自己的角色，再创建或加入房间。角色在开始连接时锁定，并同步给对端，重赛保留。普通拳腿采用共同的基础数值，三人的特色技能各有不同。本地练习可另外选择 CPU 对手。

1. 双方点击 **联机对战**。
2. 电脑 A 点击 **创建房间**，将显示的 6 位房间号发给电脑 B。
3. 电脑 B 输入房间号，点击 **加入**。双方连接成功后自动开局。

电脑 A 也可以点击 **复制邀请链接**。电脑 B 打开链接后，房间号自动填好，选择角色并点击 **加入** 即可。无需回传连接码。

创建方保持页面打开。房间最多两人，取消、断开或重新创建后旧房间失效。信令服务暂时无法访问时，可展开 **手动连接（备用）**，按原方式交换主机码和应答码，加入方需要在 3 分钟内回传应答。不同构建的页面会拒绝连接，更新后双方都刷新网页。

主机控制左侧 P1，加入者控制右侧 P2。两台电脑使用相同键位：

| 操作 | 按键 |
| --- | --- |
| 左右移动 | A / D |
| 跳跃 | W / Space |
| 下蹲 | S |
| 出拳 | J |
| 踢腿 | K |
| 防御 | L |
| 牵制 / 防守 / 特色技能 | U / I / O |
| 超必杀，消耗 100 气 | N |

`W + J`、`W + K` 可同时按，分别使出跳拳、跳踢；`S + J`、`S + K` 分别为蹲拳、蹲踢。方向和攻击可以组合，拳腿同时按时优先踢腿。按住攻击键只出一次，松开后再次按下才能再次触发。

特色技能可直接使用 U / I / O，也保留对应方向指令 `↓ ↘ → + J`、`→ ↓ ↘ + J`、`↓ ↙ ← + K`，方向以角色面向为准。例如面向右时，`↘` 表示同时按 S 和 D。比赛结束后双方都确认重赛才开始下一局。

| 角色 | U | I | O | N |
| --- | --- | --- | --- | --- |
| DeepSeek | 鲸尾扫潮，低段甩尾 | 摸鱼反拍，短窗口反击正面中上段近战 | 潜游贴贴，低姿态接近后顶击 | 深海·大鲸落 |
| Claude | 批注飞页 | 请勿越界，对空结界 | 放置书签，再按 O 预警后引爆 | 终章·论证完毕 |
| ChatGPT | 星环吐息 | 改写·翼返，对空并反射一次普通飞行道具 | 龙爪命中或被防后再按 O 追击 | 万象·星环龙息 |

Claude 的书签在受击或超时后消失。ChatGPT 的龙爪二段被防住后有较长收招。三人的超必杀消耗满气，首段命中才触发后续攻击，首段可以防御或躲开。

复制按钮受浏览器限制时，页面会选中待复制内容，按 Ctrl/Cmd+C 手动复制。

## 连接和同步范围

本版使用 WebRTC 的可靠有序数据通道，`iceServers` 为空，不连接外部 STUN 或 TURN。房间模式通过公共 PeerServer Cloud 发现对方并交换连接信息，对战数据在两台电脑之间直连。普通练习和手动连接不连接公共信令服务。

双方收齐某一帧的输入才推进战斗，并比较共同帧的状态校验。网络或对方窗口停顿时会等待，不预测远端动作。

这适合同一局域网的最小验证。访客 Wi-Fi 的设备隔离、系统防火墙或路由器规则可能阻止直连。本版不提供跨公网穿透、自动匹配或作弊防护。

从 GitHub Pages 首次打开网页，以及创建或加入短房间，都需要网络。同一 Wi-Fi 不代表两个设备一定可以互相访问。

## 运行验证

三位角色各自采用独立逐帧动作图，来源及生成说明见 [素材署名](assets/fighters/CREDITS.md) 和 [提示词](ART_PROMPTS.md)。动画时间跟随战斗模拟帧，等待远端输入、暂停和命中停顿时停止播放。

```sh
npm run check
node --test tests/*.test.mjs
npm run test:browser
```

浏览器测试使用本机 Chrome 的真实 WebRTC 和两个独立窗口，完成手动信令、键盘移动与攻击、共同帧状态校验和断线检查。默认使用 macOS 的 Google Chrome；其他位置可通过 `CHROME_BIN` 指定。测试无需 Playwright 或下载浏览器。

浏览器测试将截图与结果写入 `artifacts/`。单机双窗口测试不能替代两台实体电脑在目标 Wi-Fi 下的验收。

输入与动作检查：`CDP_PORT=19334 node tests/input.browser.mjs`，需要已启动本地预览和 Chrome CDP。覆盖同帧跳攻、快速短按、持续防御、暂停输入隔离，以及真实双端网络等待期间的输入保留。可通过 `SITE_URL` 指定部署地址，结果写入 `artifacts/input/report.json`。

特色技能与动作检查：`CDP_PORT=19334 node tests/skills.browser.mjs`。覆盖三人的真实键盘出招、模拟相位与新动作表、局部渲染插值、超必杀命中确认、书签与反射、96 个源帧的 Canvas 像素轮廓，以及不同角色的双端技能同步。结果写入 `artifacts/skills/`。

新技能使用独立人物动作表和特效表。脚底原点、实际轮廓与固定角色比例见 `assets/fighters/skills.json`，运行 `python3 tools/build-skill-frames.py --check` 校对。人物每次绘制使用一个姿势，以轻微局部位移和转角补足模拟帧间过渡；暂停、命中停顿和等待远端输入时停止插值。素材的四个关键姿势和技能数值仍可根据实际试玩继续打磨。

房间流程检查：`CDP_PORT=19334 node tests/rooms.browser.mjs`。通过真实公共信令服务检查房间号、邀请链接、满员、取消重建、完整对战、重赛和断线。需要互联网连接，结果与桌面、375px 截图写入 `artifacts/rooms/`。可用 `SITE_URL` 指定部署地址。

逐帧动作的浏览器检查可复用已启动的 Chrome CDP 与本地预览，运行 `CDP_PORT=19334 SITE_URL=http://127.0.0.1:4174/ node tests/sprites.browser.mjs`。该检查使用真实键盘事件验证完整帧序列，并将动作记录保存到 `artifacts/sprites/`。

裁切检查运行 `CDP_PORT=19334 node tests/sprite-render.browser.mjs`，验证实际绘制的人物轮廓完整且没有邻帧像素。帧表按实际透明区域生成，使用已安装 Pillow 的 Python 运行 `python3 tools/rebuild-sprite-frames.py --check` 校对，或去掉 `--check` 重建。`python3 tests/sprite-crops.test.py` 检查全部 159 个帧别名、原点、素材字节和原始错误案例。
