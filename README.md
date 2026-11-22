# WordWise AI · 英语综合学习系统

面向英语学习者的本地优先学习工具：把**文章精读、背单词、语法分析、AI 出题**放在同一套学习记录上，阅读中遇到的生词和长难句可以直接进入词汇与语法练习。

研究重点是**让 AI 对英语文本的识别与分析更可靠**：能定位回原文、能标注结构、能复用缓存，而不是只给一段看起来通顺的解释。

## 功能

- **文章精读**：导入英文文章，逐句拆解结构、讲解语法、提取重点词，标注原文位置。
- **单词速查 / 词库**：词形还原、柯林斯 MDX 词典查询、生词收藏、按 SM-2 思路安排复习。
- **语法分析**：本地 spaCy 给出确定性句法骨架（分词、词性、依存、从句边界），再交给大模型组织讲解；两者不一致时以句法结果为准。
- **朗读**：用浏览器自带的 `speechSynthesis` 朗读，单词、句子、整篇文章都能点「听」，零依赖、不下载模型；语音与语速可在设置里换。
- **AI 出题与批改**：按当天学习内容生成小卷，答完即时批改反馈。
- **学习看板**：正确率、连续打卡、掌握度等统计。

## 技术组成

| 部分 | 方案 |
|---|---|
| 服务端 | Node.js（≥18），单进程 `server.js`，原生 http |
| 前端 | 原生 ES Module + 自研路由，无构建步骤 |
| 朗读 | 浏览器 `speechSynthesis`（系统语音），零依赖、不下载模型 |
| 本地句法 | Python + spaCy `en_core_web_sm`（`nlp/server.py`，独立端口 8791） |
| 词典 | js-mdict 读取 MDX/MDD（柯林斯高阶英汉双解） |
| 大模型 | 兼容 OpenAI `chat/completions` 的任意网关（默认 AMD Radeon 云） |
| 存储 | `data/store.json` 单文件 JSON |

前端会调用 `/api/nlp/*`；Python 服务不可用时全部调用安全降级为 null，应用退回纯大模型模式，不影响使用。

## 快速开始

1. 安装 Node.js 18 或更高版本。
2. 安装依赖：`npm install`
3. 配置本地句法分析（可选但推荐）：双击 `nlp/setup-venv.bat`，脚本会在项目内建 `.venv` 并安装 spaCy 与英语模型。
4. 双击 `start.bat`（一键启动并打开浏览器）或 `backend-start.bat`（仅后台启动）。
5. 打开 http://localhost:8787/

停止后端用 `backend-stop.bat`，重启用 `backend-start.bat --restart`。

## 配置 API Key

仓库中**不含任何 API Key**，`config.json` 已被 git 忽略。首次使用先复制一份配置模板：

```bash
cp config.example.json config.json
```

Key 的三种提供方式，任选一种，都不会进入版本库：

1. 在应用「设置」页填写，前端通过 `x-api-key` 请求头透传（服务端会把设置写回本地 `config.json`，该文件不入库）。
2. 写入本地 `config.json` 的 `apiKey` 字段。
3. 环境变量 `WORDWISE_API_KEY`（服务端优先读取，适合本机长期使用）。

其余可调项在 `config.json`：端口、监听地址、网关地址（apiBase）、文本/视觉/批改模型、每日题量。
代码**不内置任何默认网关与模型名**：`apiBase` 与各模型留空时，AI 功能会以可读提示拒绝，需要你自己配置兼容 OpenAI `chat/completions` 的网关。网关与模型同样支持环境变量覆盖：`WORDWISE_API_BASE`、`WORDWISE_TEXT_MODEL`、`WORDWISE_VISION_MODEL`、`WORDWISE_GRADING_MODEL`。

## 数据存放

应用免登录，打开即用：服务端固定使用本机账号（账号表里的第一个账号，没有则自动创建），学习数据按账号存放于 `data/users/<id>.json`，词典等共享资源全机共用。不再提供注册 / 登录入口。

## 局域网共享（可选）

默认 `config.json` 的 `host` 为 `0.0.0.0`（局域网内设备可访问）。**免登录模式下数据接口没有鉴权**，同一局域网内的任何设备都能读写你的学习数据；传输还是明文 HTTP。只建议在可信内网临时使用，公共 Wi-Fi 下务必关闭；要仅本机访问，把 `host` 改成 `127.0.0.1`。

## 目录结构

```text
wordwise/
├─ server.js          # 服务端：静态资源、API、AI 代理、配置读写
├─ nlp-client.js      # 拉起/健康检查 Python 句法服务，失败降级
├─ nlp/
│  ├─ server.py       # spaCy 句法分析服务（127.0.0.1:8791）
│  ├─ requirements.txt
│  └─ setup-venv.bat  # 一键创建 .venv 并自检
├─ config.example.json # 配置模板（复制成 config.json 后填写自己的 Key）
├─ public/            # 前端页面与 JS 模块（js/tts.js 为朗读封装）
├─ data/              # 本地数据（已忽略，不入库）
├─ tools/             # 词典构建、局域网地址、电子书测试脚本
└─ 环境说明.md         # 环境搭建与排错记录
```

## 朗读

单词、句子、整篇文章都能直接听，全部交给浏览器自带的 `speechSynthesis`，不联网、不下载模型、没有引入任何语音库：

- **每句**：阅读器正文每句句末有喇叭，点一下读这句，不会同时触发句子精讲；
- **每个词**：词库词条与例句、查词结果（含 MDX 词条）、背单词卡片、句库记录、精讲面板的重点词后面都有喇叭；
- **每篇文章**：文章列表卡片、阅读器顶部、首页文章行都有「听全文」，按句排队朗读，避开 Chrome 对长文本的截断；
- 再点一次同一个按钮停止，切换页面自动停；朗读中的按钮会轻微脉动；
- 语音来自系统：Windows 的 SAPI、macOS / iOS 的系统语音、Android 的系统 TTS 引擎。可在「设置 → 朗读」里换英文语音、调语速，选择只存在浏览器 localStorage，不写入学习数据；
- 浏览器不支持 `speechSynthesis` 时，听按钮会自动隐藏，不影响其它功能。

## 说明

- 朗读用浏览器自带的 `speechSynthesis`，不依赖任何语音服务；发音评分、口语对话等语音能力尚未实现，设计时再补充文档。
- 词典文件（MDX/MDD）体积较大且涉及版权，不随仓库分发；把词典放进 `data/mdx/` 后在应用内导入即可。
