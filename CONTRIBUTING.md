# 参与贡献

欢迎提 issue 和 PR。动手前先看这几条，能省掉来回返工。

## 先开 issue

- **报 bug**：写清复现步骤、期望与实际表现，附 Claude Nexus 版本（设置页「版本与更新」）、Windows 版本、`claude --version`，以及 `~/.claude-session-panel/logs/` 最新日志里的相关片段（贴之前去掉路径、仓库名等敏感信息）
- **新功能**：先开 issue 说清要解决的问题，确认方向后再写代码；大改动直接提 PR 很可能因为和整体设计冲突而被搁置

## 本地开发

环境与命令见 [开发指南](docs/开发指南.md)。简单说：

```bash
npm install
npm start          # 开发态运行
npm run verify     # 类型检查 + 渲染层静态检查 + 单元测试
npm run e2e        # 端到端测试（隔离实例 + mock claude，不碰你自己的数据）
```

## 提 PR

- 从 `main` 分支拉出功能分支，PR 提到 `main`
- 提交前 `npm run verify` 必须通过；改了界面或交互的，补上或更新对应的 e2e 用例（`tests/e2e/NN-场景.e2e.ts`）并跑一遍相关用例
- 一个 PR 只做一件事；界面改动附前后截图
- 提交信息用 `type: 中文描述`，不带 scope，如 `feat: 改动列表支持搜索过滤`、`fix: 修复子代理终端乱码`；type 取 feat / fix / refactor / style / test / docs / chore

## 代码约定

- 渲染层没有打包器，按分层组织，新功能放 `src/renderer/features/<功能>/` 并通过注册表接入，规则见 [开发指南](docs/开发指南.md) 的「渲染层扩展点」，`npm run check` 会拦下违规导入
- 颜色、字号、圆角只用 `renderer.css` 的 `:root` 变量，新增皮肤要覆盖全部变量
- 注释写做什么、为什么、边界条件，不写任务编号、设计文档编号这类只有作者看得懂的引用
- 界面文案用中文，简洁直接；常驻界面只放和当前操作有关的信息，说明性文字放悬停提示

## 许可

提交的代码按本项目的 [MIT 许可证](LICENSE) 发布。
