# 世界树作者 skill

六个 model-invoked 作者 skill，按世界书的编辑层级分工。职责摘要只在本页维护。

## 加载方式

本仓库用根目录的 `.omp/skills` 符号链接（指向 `../skills`）作为 omp 的项目级发现入口。在仓库 cwd 启动 omp 时，六个 `skill://世界树·…` 都可读取；模型按各文件的 `description` 触发，也可以直接用 `name` 点名。

跨项目使用：把本仓库 `skills/` 的绝对路径登记进 omp 的 `skills.customDirectories`。本仓库不代改全局配置，也不把这一步写成已实施。

复制安装不受支持：`shared/` 是公共引用页，不是可调用的 skill；六个 skill 指向 `docs/`、`cli/` 与 `shared/` 的都是仓库相对路径，复制到仓库外会断链。

## 职责

| skill | 级 | 负责 | 文件 |
|---|---|---|---|
| 世界树·设定 | 设定级 | 修改第二层声明，迁移受影响的第三层内容 | [`ygg-setting/SKILL.md`](ygg-setting/SKILL.md) |
| 世界树·建立 | 结构级、文本级 | 从原作逐篇建立名单、角色组、事件树、事件串与档案 | [`ygg-build/SKILL.md`](ygg-build/SKILL.md) |
| 世界树·事件 | 结构级 | 事件、分支、门槛、变化、事件串、开局选项与方案 | [`ygg-event/SKILL.md`](ygg-event/SKILL.md) |
| 世界树·角色 | 结构级 | 角色组、版本、档案元数据、别名、初始能力与初始所在 | [`ygg-character/SKILL.md`](ygg-character/SKILL.md) |
| 世界树·建角色 | 文本级 | 从作者资料写 `基本信息.txt` 与 `角色印象.txt` | [`ygg-profile/SKILL.md`](ygg-profile/SKILL.md) |
| 世界树·文本 | 文本级 | 修改第四、五层正文、分支结果，核对条件文本的适用范围 | [`ygg-text/SKILL.md`](ygg-text/SKILL.md) |

## 共享页

编辑分级、越界清单、首稿归属、`ygg` 工具调用、改前改后的检查口径与人工复核边界只在 [`shared/编辑分级.md`](shared/编辑分级.md) 维护。各 skill 只写自己的职责与步骤，不复制这些内容。

## 使用方式

1. 先判断改动属于哪一级：第二层声明用“设定”；第三层程序字段用“事件”或“角色”；第四、五层文本用“建角色”或“文本”；从原作建立整套世界书用“建立”。
2. 在临时副本上按 skill 的步骤工作，真实世界书与作者资料只读。
3. 按 `shared/编辑分级.md` 的检查口径运行 `check`、`trace`、`if`、`preview` 与 `format`，把改动前已有的问题与本次新增的问题分开报告。
4. 作品专属的路径、对象键、方案与角色组从项目的 `作者资料/` 与 `docs/` 读取，不写进 skill。

规范入口见 [`docs/README.md`](../docs/README.md)；字段表见 [`docs/参考/`](../docs/参考/)。

作者视图入口见 [`view/README.md`](../view/README.md)：`ygg view` 提供本地图形作者工具与单事件编辑，不替代本页的六个 skill。
