# Web 与 Shiping 模型设置共用

用户最新布局：Web 和桌面都可配置；桌面 Embedding 放「AI 模型」，Rerank 开关与模型配置放「资料库」。保留网页现有入口。

根因确认：18080 旧后台进程为11月2日启动，网页已更新但旧进程缺少新API。无排队或运行任务后备份SQLite，通过项目管理脚本仅重启admin，验证/model-providers.js与/api/model-providers均200。

实施：
1. 添加纯共享模型类型，保留后端类型导出兼容。
2. 固定模型设置 IPC 操作 → DesktopLibrary 已认证RPC → 同一 LibraryService；开放对应RPC白名单，测试长请求超时覆盖。
3. 桌面公用模型配置表单，Embedding卡挂AI模型，Rerank开关和精排配置卡挂资料库。显示提供商、地址、模型、Key、列表/测试/保存。密钥不回显、不写入渲染层持久存储。云端密钥留空保留。
4. 两端读取同一服务，窗口焦点/周期刷新仅更新无草稿内容；失败时提供重试，保留输入。
5. 补 IPC/RPC/前端调用集成测试，构建并验证实际桌面布局和网页正常；更新本机可运行产物供用户使用。

旧资料、模型配置、所有先前未提交修改均保留。仅有实际运行问题才修改相关文件。

## 完成记录

- 已接通固定 IPC → 认证 RPC → LibraryService，共用配置；旧服务进程导致的 Web 404 已修复。
- Embedding 卡位于 AI 模型；Rerank 开关与模型卡位于资料库。网页原有入口保留。
- 独立审查后修复分组切换草稿丢失、dirty草稿阻止开关同步，以及Ollama预置端口不符。草稿仅存会话内存，可保存或放弃。
- 验证：桌面207项（202通过，5跳过）、Web75项全通过；三套类型检查、构建通过；新增模块lint通过；真实Electron及已签名打包应用验证保存、共享开关、dirty同步及切tab草稿保留。
- 项目内 outputs/Shiping.app 已更新并重新打开，原版备份 work/Shiping-before-desktop-model-settings.app；资料库重启前备份 work/pre-model-api-service-restart.sqlite。
- 更新过程仅重启本项目admin服务和匹配身份的项目内Shiping测试进程，未停止Ollama/Chroma/精排服务。当前资料与模型配置保留；没有使用真实付费Key调用模型。
