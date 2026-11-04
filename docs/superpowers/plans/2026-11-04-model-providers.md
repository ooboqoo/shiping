# Ollama / Xinference 接入

用户要求直接实施；沿用现有 library-v4 与配套 local-rag/web 设置页，不改动已有对话模型配置或未提交工作。

参考：本机 ragflow/conf/models/{ollama,xinference}.json 和 internal/entity/models/{ollama,xinference}.go。Ollama 不提供 Rerank，界面明确说明；Xinference 使用部署的模型 UID。

1. 在 tests/model-providers.test.cjs 添加失败测试：URL 规范化、Embedding 顺序/维度/有限数、模型列表、鉴权、错误脱敏、取消、指纹变化与持久化。
2. 新建 library-v4/model-providers.ts：独立协议函数、私有配置持久化、每个 LibraryService 实例的 runtime；保留默认 Ollama 11435 配置及旧指纹兼容。指纹包含提供商/地址/模型身份/维度，变化后现有索引拒绝混用。
3. 扩展 reranker.ts：保留本机严格校验与降级，新增 Xinference /v1/rerank、model/top_n、可选 Bearer；校验完整无重复索引与有限分数。
4. LibraryService 接入同一 runtime 到索引/检索/回退；新增配置读取、保存、模型列表、实际调用测试接口。保存时阻止正在构建时切换。
5. 在 local-rag/web/chat-api.ts 添加认证现有边界内的配置路由，在 public/model-providers.js 实现独立配置卡，maintenance 页面载入。
6. 定向测试、完整单元测试、两端类型检查、构建与差异审查。无需安装或启动真实模型，真实推理联调若无服务则明确交付限制。

检查重点：旧配置兼容、API Key 不返回前端/错误、失败测试不吞降级、模型切换不复用旧向量、保存原子化。

## 完成记录

- 已按计划完成协议适配、私有配置、实例级索引/检索/回退 io、设置卡、认证 API 与使用说明。
- 独立代码审查后修复：浮点探针抖动不再影响指纹；列表/测试断连取消上游；页面请求超时跟随配置；检索在生成查询向量后再次验证模型身份。
- 最终桌面端测试：197 项，192 通过、5 跳过、0 失败；管理后台：73 项全部通过。
- 三套 TypeScript 检查、Electron Vite 构建、管理后台与文档 worker 构建通过。
- 浏览器实际页面验证：无运行错误，空模型校验、保存及刷新持久化通过；截图 work/model-provider-settings.png。
- 新适配模块 ESLint 通过；已有 service/reranker 文件的全量 lint 仍有历史 explicit-any 问题，不宣称仓库全量 lint 通过。
- 没有修改用户现用模型设置或真实数据；尚未连接真实 Ollama/Xinference 部署，也未打包安装或发布。现有未提交工作保持原位。
