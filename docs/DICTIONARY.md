# 离线词典：来源、构建与质量记录

核实日期：2026-10-20（Australia/Sydney）。对应 PRD §16。

## 采用的数据

| 项 | 内容 |
| --- | --- |
| 上游 | [ECDICT](https://github.com/skywind3000/ECDICT)，文件 `ecdict.csv` |
| 冻结版本 | 提交 `bc015ed2e24a7abef49fc6dbbb7fe32c1dadaf8b`（2025-03-28） |
| 文件校验 | `ecdict.csv` SHA-256 `1a6947e04785db63613a92e14903cdae7954f7e84860b10e68e5c7cbb3f9c3cf`，770,611 行 |
| 许可 | MIT（Copyright (c) 2025 Linwei），许可全文随每个词典包的 manifest 一起分发 |
| 英文释义 | ECDICT 的 `definition` 字段来自 WordNet，按 [Princeton WordNet 许可](https://wordnet.princeton.edu/license-and-commercial-use) 在包内与界面中保留来源声明 |
| 使用的字段 | `word`、`phonetic`、`definition`（英英）、`translation`（英汉）、`tag`（考试标签）、`collins`、`oxford`、`bnc`、`frq`（词频）、`exchange`（词形） |
| 未使用 | `detail`、`audio`（音频授权未单独核实，PRD §8.5：真人音频需单独确认来源） |

ECDICT 的 README 说明其数据由多个来源汇编。项目采用的是上游在 MIT 下发布的 `ecdict.csv` 本身；若将来商业分发或更换数据文件，需要按 PRD 重新核查。

## 构建决定

`scripts/build_dict.py` 只做格式转换和筛选，不生成任何释义：

- **丢弃 `[网络]` 行**：这些是来源未记录的网络释义（例如 `'hood` 的 `[网络] 胡德；兜帽`）。其它领域标签（`[计]`、`[医]` 等）保留并原样显示。
- **缺失即缺失**：没有音标、例句、等级的词条不补全。
- **词形**：`exchange` 中的 `0:原形/1:变形类型` 用作“原形候选”（`studies → study`、`saw → see（过去式）`），并生成反向词形索引（`accounted → account`）。界面把候选与原词并列显示，从不替换。
- **包内容**：

| 包 | 内容 | 词条 | 大小 |
| --- | --- | --- | --- |
| `base` | 有词频 / 考试标签 / 柯林斯 / 牛津标记的词、它们的词形，以及只由这些词组成、且不是纯领域术语的 2–5 词短语 | 149,191 | 8.2 MB |
| `full` | 全部非空词条 | 730,662 | 25.2 MB |

每个包是 gzip 压缩的 NDJSON：第一行是 manifest（`source_id`、`source_version`、`source_sha256`、`license_text`、`builder_version`、计数），之后是 `entry` / `form` 记录。旁边的 `.json` 文件记录包文件自身的 SHA-256 与大小，扩展从服务器安装时会校验。

## 导入与使用

- 扩展：学习中心 → 设置 → 离线词典。导入在 Web Worker 中分批写入 IndexedDB，可取消；新版本写完后才切换，失败或取消不影响已安装的版本（`learning/dict-idb.js`）。
- 服务器：Docker 构建时按上表的提交和 SHA-256 下载并构建；运行时把 `base` 载入 SQLite 供网页版查词，并提供两个包的下载。
- 查词逻辑只有一份（`learning/dict.js`），扩展和网页版共用。

## 实测（Apple Silicon，Chrome，基础包）

| 项 | 结果 | PRD 目标 |
| --- | --- | --- |
| 导入 149,191 个词条到 IndexedDB | 约 2.9 秒 | 分批、可取消、不阻塞页面 |
| 本地查词（20 个查询，经扩展消息） | 冷查 P95 2 ms，热查 P95 1 ms | 热查 P95 ≤200 ms，冷查 ≤500 ms |
| 服务器载入基础包到 SQLite | 约 0.7 秒（首次），之后按校验和跳过 | — |

测试在内置浏览器的测试页中进行（模拟 `chrome.*`，真实 IndexedDB 与真实词典包），不是在安装好的扩展里测的；真实 Chrome 中的数值需要再测。

## 质量核对（待做）

PRD §16.3 要求 200 条以上人工核对的基础集。目前已有的是自动化用例（`tests/js/learning.test.mjs`：变形、多义、短语、大小写、未命中）和 20 个真实查询的抽查（见上）。**200 条人工核对集尚未建立**，是 0.4 正式发布前的待办项。
