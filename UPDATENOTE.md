# 更新说明 / Update Notes

> 本文件记录 WordWise AI 各轮次的重要变更，中英双语。 / This file records notable changes per release round, bilingual (Chinese first, English follows).
> 工作过程文档（审查报告 / 修改文档）存放于仓库外的 `D:\平平学习\研学`。 / Working documents (review & change logs) live outside the repo in `D:\平平学习\研学`.

---

## 2026-11-27 · 背诵入口收口 / Drill Entry Refocus

### 中文

1. **「背诵本文词」改为弹窗**：不再跳转到背单词页，直接在阅读器内用同一套卡片（看词选义 / 看义选词）过一遍本文命中的词；关掉弹窗即回到原文，不打断阅读。
2. **进度真正共用**：抽出 `public/js/drill.js`，背单词页与弹窗都走同一份 `state.meta.learn` 记录、同一套 SRS 更新与今日统计，答错的词两边都能看到。
3. **背单词页只留两个范围**：`阅读错词`（阅读 / 练习里答错、到期的词，含弹窗中答错的词）与 `词表的词`（《高中核心词汇1000+高考超纲词》，1120 条），取代原先的高考核心词 / 我的词库 / 混合三档。
4. **词表范围替换**：词表出词改为 xlsx 生成的 `vocab1000.js`，`article-vocab.js` 新增 `vocabList()` 做清洗与去重；首页「待复习词」的入口直接落到「阅读错词」。

### English

1. **In-page drill modal**: "背诵本文词" now opens a modal in the reader and runs the same word↔meaning cards, so the article stays in context.
2. **Shared progress**: `drill.js` is the single source for drill queueing, `state.meta.learn` records, SRS updates and daily stats; both entries read and write the same data.
3. **Two scopes only**: `阅读错词` (words missed or due from reading/practice, including modal answers) and `词表的词` (the 1120-entry xlsx list), replacing the previous three scopes.
4. **Word-list range**: list drilling now uses `vocab1000.js` via `vocabList()`; the home review board's word entry lands on 阅读错词.

---

## 2026-11-27 · 阅读工作流重构 / Reading Workflow Rebuild

### 中文

本轮把「阅读」设为核心，文章页从一列卡片改为四个分区，并把词表、阅读命题接入同一套学习记录：

1. **文章三部分 + 精讲**：阅读页右侧新增页签「词汇 / 长难句 / 阅读理解 / 精讲」。词汇区对照《高中核心词汇1000+高考超纲词》标出命中词，可单条或整批入库，并用与词库相同的卡片（看词选义 / 看义选词）背诵本文词；长难句沿用本地 NLP 识别与清单；精讲保留回译、对话式讲解与全文分析（结构树卡片已移除，点句子后先由学生自己翻译，再按需点「给点提示」）。
2. **词表数据化**：新增 `tools/build_vocab_xlsx.py`，从 xlsx 生成 `public/js/vocab1000.js`（核心 1000 + 超纲 120）；`public/js/article-vocab.js` 负责词形还原（含不规则形式、短语）与正文一次性多类高亮，纯本地、带缓存。
3. **阅读理解**：`ai.js` 新增 `generateReadingQuestions()`，固定 4 题（1 道主旨 + 3 道细节 / 推理 / 态度 / 词义），难度对标北京卷 C/D 篇；每题附中文解析与原文依据，依据句会做定位匹配，可跳回原文。题目与作答结果按正文指纹缓存在文章对象上，正文不变不重复出题。
4. **首页复习板块**：新增 `review.js`，把「到期 / 答错过的词、试卷错题、阅读题未过关的文章、精读理解度偏低的句子」汇总成清单，可直接跳到对应页面重练。
5. **口语评测收口**：移除前端入口与录音调用（此前视图文件缺失会导致启动报错），后端 `/api/speech/*`、`speech/server.py`、`speakings` 数据字段全部保留；新增《口语评测说明.md》记录接口、降级行为与接回步骤。
6. **移动端与修复**：分区页签可横向滚动，词表行、阅读选项、复习清单改为单列与合适触摸目标；修复阅读器路由 `id` 未消费导致换文章后刷新回弹的问题；Service Worker 预缓存补齐新模块并升级缓存版本。

### English

This round makes reading the core workflow: the article page is reorganized into four panels, with the word list and reading questions wired into the same learning records.

1. **Three parts + deep reading**: the reader's side column now has "Vocabulary / Hard sentences / Reading comprehension / Deep reading" tabs. Vocabulary marks hits from the 1000-word list plus the out-of-syllabus list, supports one-click import to the wordbook, and reuses the existing card drill (word→meaning / meaning→word) for the article's words. Hard-sentence detection stays unchanged; the deep-reading panel keeps back-translation, coached sentence reading and full-article analysis (the syntax-tree card is gone, and clicking a sentence now waits for the student's own translation before any hint).
2. **Word list as data**: `tools/build_vocab_xlsx.py` generates `public/js/vocab1000.js` (1000 core + 120 extra); `article-vocab.js` handles lemmatization (including irregular forms and phrases) and single-pass multi-layer highlighting, fully local and cached.
3. **Reading comprehension**: `generateReadingQuestions()` produces exactly 4 items (1 main-idea + detail / inference / attitude / vocabulary), calibrated to Beijing Gaokao C/D difficulty, each with a Chinese explanation and an evidence sentence anchored back to the article. Questions and results are cached against the article's text fingerprint.
4. **Home review board**: `review.js` collects due/missed words, wrong quiz items, articles whose reading score is below full marks, and sentences with low comprehension scores, each linking straight back to the relevant practice.
5. **Speaking assessment pulled back**: the frontend entry and recording hook are removed (the missing view previously broke app start-up); the backend `/api/speech/*`, `speech/server.py` and `speakings` data field are all kept, documented in `口语评测说明.md`.
6. **Mobile & fixes**: scrollable panel tabs, single-column vocabulary/option/review rows with proper touch targets; fixed the reader route `id` being re-applied after switching articles; Service Worker precache list updated and cache version bumped.

---

## 2026-11-22 · AI 可靠性闭环 / AI Reliability Loop

### 中文

本轮把 README 研究重点——「定位回原文、标注结构、复用缓存」——从提示词承诺落成代码级实现：

1. **定位回原文**：AI 全文分析返回的重点词汇与长难句，现在会逐条在原文中做归一化匹配（大小写 / 标点 / 弯撇号 / 词形变化容忍）。命中的条目可在分析卡一键跳回原句并短暂高亮；**匹配不到的条目不再静默展示，而是打上「未定位」灰色徽章**，提示可能是 AI 改写或杜撰。卡头显示「已定位 x/y」。
2. **AI↔NLP 冲突检测**：句子精讲产出时，代码级对比 AI 讲解与本地 spaCy 骨架的三个可靠维度（主干动词 / 被动语态 / 疑问句）。一致 → 绿色「句法已校准」（现在是真实校验过）；不一致 → 红色徽章可展开详情，冲突字段**并排展示 AI 值与 NLP 值并标明采信 NLP**——兑现 README「不一致时以句法结果为准」的约定，且不改写 AI 原文。
3. **复用缓存**：全文分析增加内容指纹守卫（正文未变直接命中缓存，不再每次点击全量重跑）；本地 NLP 客户端增加单句 / 文章级缓存；精读对话的中间轮次持久化到句子缓存（上限 10 轮），切页 / 刷新后仍可回顾；划词翻译增加会话级缓存。
4. **JSON 自愈**：新增 `chatJson()`——AI 返回无法解析为 JSON 时自动带纠正指令重试一次，八个 AI 调用点全部迁移；删除已无调用方的 `explainSentence` 死代码。
5. 新增纯函数单测 `tools/test-anchor.js`（28 用例：匹配边界 / 冲突判定），无 AI 依赖、可离线回归。

### English

This round turns the README's research focus — "anchor back to the original text, annotate structure, reuse caches" — from prompt-level promises into code-level guarantees:

1. **Anchor back to source**: key words and hard sentences returned by the full-article AI analysis are now matched against the article with normalization (case / punctuation / curly quotes / morphological tolerance). Matched items gain a one-click "jump to sentence" with a brief highlight; **unmatched items are no longer silently rendered — they get an honest "not located" badge** with a caution hint. The card header shows "located x/y".
2. **AI↔NLP cross-check**: when a sentence explanation is produced, three reliable dimensions are compared in code against the local spaCy skeleton (root verb / passive voice / question form). Consistent → green "syntax-calibrated" badge (now genuinely verified); conflict → red expandable badge listing each field side by side with the NLP value trusted per the README's rule — the AI text itself is never rewritten.
3. **Cache reuse**: full-article analysis gains a content-fingerprint guard (unchanged text hits the cache instead of re-running everything); the NLP client caches per-sentence and per-article results; coach conversation turns persist to the sentence cache (last 10 turns) and survive page switches / refreshes; selection translation gains a session cache.
4. **JSON self-healing**: new `chatJson()` retries once with a corrective instruction when the AI output cannot be parsed as JSON; all eight JSON call sites migrated; the dead `explainSentence` export is removed.
5. New pure-function unit tests `tools/test-anchor.js` (28 cases: matching edge cases / conflict verdicts), AI-independent and fully offline.

---

## 2026-11-22 · 重构轮：安全收口与多账号登录 / Refactor Round: Security & Multi-account Login

### 中文

1. **恢复多账号登录**：移除免登录模式；注册 / 登录 / 退出全链路恢复，学习数据按账号独立存放。
2. **安全收口**：11 个此前无鉴权的接口补齐会话检查；封堵 `x-api-base` 透传导致的 **API Key 外泄与 SSRF**（服务端 Key 生效时忽略客户端网关覆盖）；MDX 词条 HTML 过滤增强（无引号事件属性 / `javascript:` 链接 / iframe 嵌入）；本地 NLP 服务移除 CORS 通配头。
3. **模型接入收拢**：新建 `modelconfig.js` 统一解析网关 / Key / 模型；**代码零默认网关**（移除占位 AMD 网关与虚构模型名），支持环境变量覆盖；配置写入增加类型校验。
4. **服务衔接修复**：Python 句法服务崩溃自动重启（指数退避 + 降级态）；推送 410 失效订阅清理与调度器竞态修复；Service Worker 预缓存补齐 8 个缺失模块、通知深链修复。
5. **前端修复**：查词竞态防护、「用当前列表出题」生效、AI 批改缺省分修正、路由并发挂载防护等 12 项。
6. **清理**：删除约 600 行无调用方代码；依赖修正（+jszip，mammoth/pdfjs-dist 转为 devDependencies）；启动脚本修复（PID 文件、探活 `-f`、就绪轮询后开浏览器）。
7. 首次打开需注册 / 登录；`x-api-base` 在未携带自有 Key 时被忽略；`config.json` 不再内置默认网关与模型名。

### English

1. **Multi-account login restored**: the free-login mode is removed; register / login / logout are fully wired again and learning data is stored per account.
2. **Security hardening**: 11 previously unauthenticated endpoints now require a session; the `x-api-base` passthrough that leaked the server-side API key (and enabled SSRF) is closed — client-supplied gateways are honored only when the request carries its own key; MDX entry HTML sanitization is hardened; the local NLP service drops its wildcard CORS header.
3. **Model access centralized**: new `modelconfig.js` resolves gateway / key / model; **no default gateway in code** (placeholder gateway and fabricated model names removed), environment-variable overrides supported; config writes are type-validated.
4. **Integration seams fixed**: the Python syntax service auto-restarts after crashes (exponential backoff + degraded state); stale (410) push subscriptions are pruned and a lost-update race in the scheduler is fixed; the service worker precache list is completed (8 missing modules) and notification deep links are fixed.
5. **Frontend fixes**: lookup race protection, "quiz from current word list" now honored, AI grading default score fixed, concurrent route-mount guard, and 7 more.
6. **Cleanup**: ~600 lines of dead code removed; dependencies corrected (+jszip; mammoth/pdfjs-dist moved to devDependencies); launch scripts fixed (PID file, health-check `-f`, browser opened after readiness polling).
7. First open now requires register / login; `x-api-base` is ignored unless the request carries its own key; `config.json` no longer ships a default gateway or model names.
