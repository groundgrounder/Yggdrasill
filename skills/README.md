# 世界树作者 skill

十一个 model-invoked 作者 skill：一个统筹诊断，两个第 0 层前置入口（原作通读与原卡迁移），六个分层建卡阶段，一个大型卡打包后验收，一个日常修订；另有仓库内共享参考页两份。职责表只在本页维护。

## 分层流程

```text
第 0 层 通读   两遍读法·第一遍：分批 Map 抽坐标，Reduce 消歧归并出全局总账（不动 世界书/）
第 0 层 迁移   原卡迁入：拆包现有酒馆角色卡/世界书，盘点映射并产出同构全局总账（不动 世界书/）
   ↓
第 1 层 地基   设定声明 + 世界概况 + 扮演准则
   ↓
第 2 层 条目   公共条目库舞台（地点 / 势力 / 技能 / 装备 / 自定义）
   ↓
第 3 层 骨架   全名单角色组 + 事件树 + 事件串 + 开局；逻辑跑通再填肉
   ↓
第 4a 层 档案  两遍读法·第二遍：纵向写人，按坐标回查原文精写档案
第 4b 层 填景  两遍读法·第二遍：横向写事，按坐标回查原文补实事件、逐字摘原台词
   ↓
第 5 层 打包   卡面定稿 + ygg pack 构建酒馆角色卡
   ↓
第 5.5 层 验收 大型卡推荐：打包卡只读离线挂载 + 五维反原作剧本试玩验收
   ──────────────
建成后   修订   局部改动与跨层小修，按改动级别只跑最小必要检查
```

`世界树·统筹` 的引导/自动运行模式与隔离子代理交接口径见 [`ygg-guide/SKILL.md`](ygg-guide/SKILL.md)。

## 职责表

| skill | 负责 | 文件 |
|---|---|---|
| 世界树·统筹 | 只读诊断项目分层与缺口，引导或自动编排推进 | [`ygg-guide/SKILL.md`](ygg-guide/SKILL.md) |
| 世界树·通读 | 第 0 层：两遍读法建分卷坐标账本与全局总账 | [`ygg-read/SKILL.md`](ygg-read/SKILL.md) |
| 世界树·迁移 | 第 0 层：拆包现有酒馆角色卡/世界书并映射到同构全局总账 | [`ygg-migrate/SKILL.md`](ygg-migrate/SKILL.md) |
| 世界树·地基 | 第 1 层：第二层声明与全局文风 | [`ygg-foundation/SKILL.md`](ygg-foundation/SKILL.md) |
| 世界树·条目 | 第 2 层：公共条目库 | [`ygg-entries/SKILL.md`](ygg-entries/SKILL.md) |
| 世界树·骨架 | 第 3 层：角色组与事件树的逻辑骨架 | [`ygg-skeleton/SKILL.md`](ygg-skeleton/SKILL.md) |
| 世界树·档案 | 第 4a 层：按角色与时期精写档案正文 | [`ygg-profile/SKILL.md`](ygg-profile/SKILL.md) |
| 世界树·填景 | 第 4b 层：补实事件正文、角色位置，摘原台词 | [`ygg-scenes/SKILL.md`](ygg-scenes/SKILL.md) |
| 世界树·打包 | 第 5 层：卡面定稿与酒馆打包 | [`ygg-pack/SKILL.md`](ygg-pack/SKILL.md) |
| 世界树·验收 | 第 5.5 层（大型卡推荐）：打包卡只读离线挂载与五维反原作剧本试玩验收 | [`ygg-playtest/SKILL.md`](ygg-playtest/SKILL.md) |
| 世界树·修订 | 建成后局部改动与跨层小修 | [`ygg-edit/SKILL.md`](ygg-edit/SKILL.md) |

## 仓库内共享速查页

在世界树仓库内查阅完整工具口径与最小检查矩阵，见 [`shared/工具与检查.md`](shared/工具与检查.md)；越界清单、条件文本五槽、文本四问与原台词归属速查见 [`shared/写作红线.md`](shared/写作红线.md)。同时，每个 `ygg-*` skill 目录本身已内置自包含的必要参考与红线（`SKILL.md` 及各自的 `./references/`），即使脱离仓库单独安装也能独立工作。

## 安装与加载

本仓库的 skill 遵循通用 Agent Skills（`SKILL.md`）格式，模型按各文件的 `description` 触发，也可以直接用 `name`（如 `世界树·统筹`）点名：

- **一句话安装 skill（外部项目目录推荐）**：在支持 Agent Skills 的编程代理环境运行：

  ```sh
  npx skills add groundgrounder/Yggdrasill
  ```

  每个 `ygg-*` skill 目录均可单独安装或复制使用，无跨目录相对路径断链。
- **仓库内自动发现**：克隆本仓库后，根目录的 `.agents/skills` 符号链接（指向 `../skills`）供兼容工作区级发现的编程代理自动加载全部十一个作者 skill。
- **命令行配合**：在克隆的 Yggdrasill 仓库执行 `npm ci && npm link`，即可在任意外部项目目录直接调用 `ygg`；未链接时，可按 `node <世界树仓库>/cli/ygg.mjs <命令>` 调用。

规范入口见 [`docs/README.md`](../docs/README.md)；字段表见 [`docs/参考/`](../docs/参考/)。作者视图入口见 [`view/README.md`](../view/README.md)：`ygg view` 提供本地图形作者工具与事件/角色位置编辑，不替代本页的十一个 skill。
