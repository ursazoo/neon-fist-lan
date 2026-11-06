# 上游来源

- 项目：[developerrutu/neon-fist](https://github.com/developerrutu/neon-fist)
- 基线提交：`c28ffb7e7e81ed8f9cec274772c43c30d2876d42`
- 许可证：MIT，见 LICENSE。
- 本版本保留上游的 Canvas 战斗和 JSON 招式数据，面向静态部署与同 Wi-Fi 双机对战。
- 角色改用 DeepSeek、Claude、ChatGPT 的社区拟人造型，基于参考图生成独立战斗动作图。来源与适配说明见 [角色素材署名](assets/fighters/CREDITS.md) 和 [美术提示词](ART_PROMPTS.md)。程序生成的场景、音效继续沿用上游。
- 动画结构参考 [iuritorres/street-fighter-2-javascript](https://github.com/iuritorres/street-fighter-2-javascript) 中的帧序列、每帧原点和动作阶段编排，未引入该项目的角色素材或代码。
- 房间连接使用 [PeerJS](https://github.com/peers/peerjs) 1.5.5，MIT 许可证。浏览器包与许可证自托管于 `shared/vendor/`，来自 npm 官方发布包 `peerjs@1.5.5`。PeerServer Cloud 仅负责信令，不承载对战数据；应用明确使用空 ICE 服务列表。
