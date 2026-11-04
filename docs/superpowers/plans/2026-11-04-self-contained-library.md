# Self-contained library implementation plan

> **For agentic workers:** Use superpowers:executing-plans or focused parallel implementers. Work in the existing user-authorized checkout; preserve all existing uncommitted work.

**Goal:** 安装后首次配置模型即可上传、自动向量化、检索；保留内部SQLite，去除必需的外部Chroma/Python/手工后台依赖。
**Architecture:** Electron管理随包后台；Desktop与Web共用LibraryService；现有索引协议通过内嵌SQLite向量适配器执行，不发Chroma网络请求。现有SQLite与缓存向量迁移复用，首装缺模型时任务等待配置。
**Constraints:** 所有模型配置在AI模型；资料库只保留Rerank开关；新安装移除固定本机精排选项；保留Ollama/Xinference高级外部接入；不使用真实付费密钥测试；不丢弃已有数据或用户改动。

- [x] UI任务：Embedding/Rerank卡集中AI模型；独立Rerank开关资料库；Web相同分组；移除固定local精排常规选项，旧配置可识别迁移；补验证。
- [x] 向量任务：本地SQLite collections/upsert/get/query/delete适配器，有限数/维度/权限/取消验证；复用Catalog缓存迁移旧代际；LibraryService默认注入并关闭；保留测试自定义io。
- [x] 生命周期：动态选择用户数据目录/旧资料根；自动初始化及启动随包Node/Electron utility子进程；单实例所有权、就绪、异常重启、退出清理；IPC动态打开Web；无项目绝对路径。
- [x] 首次配置：云端Embedding未设置时解析可完成，索引任务等待设置；配置保存后恢复；不自动付费调用测试。
- [x] 打包：后台entry与静态Web资源随包，OCR资源复用；无独立Node/Python/Chroma要求。
- [x] 验证：定向红绿测试、旧完整测试、实际Electron全新用户目录/临时模型端点上传检索与重启、旧库迁移；最终审查、打包、项目内测试版升级备份。

Review focus: 多实例不得共写SQLite；切换模型不得混用向量；旧目录/原件引用保持；缺Key不丢上传；故障与退出不能遗留服务。


## 完成与验收

- 内部SQLite保留；本地Float32向量、余弦检索与缓存迁移已替代必需的Chroma服务。后台由Shiping自动管理，使用Electron自带运行时，不要求系统Node/Python。
- 首装自动初始化；缺Embedding配置时资料可解析、索引等待，配置保存后自动恢复。新安装默认向量检索，既有显式全文偏好保留。
- AI模型集中全部模型卡，资料库只保留精排开关与跳转；固定本机精排入口移除并禁用旧隐式配置。两端共用状态。
- 服务源码与Web静态源归入shiping/library-web，构建验证不依赖旁边local-rag源码，发布流程显式准备OCR。JSZip登记直接生产依赖，锁文件沿用已存在版本。
- 审查修复旧active.json缺库不得创建空库、旧明文资料迁移后排队索引、旧历史generation缺vectorKey启动错误、Windows权限模式差异。新增回归覆盖。
- 最终桌面229项：224通过、5跳过；Web78项全通过。三套类型检查、构建、差异检查通过。新增核心模块lint通过；历史代码全量lint不作为已通过声明。
- 真实macOS已签名打包应用在全新目录验证：自动启动、上传前无Key、等待配置、配置后向量化检索、动态Web地址/端口回退和退出关闭后台。未使用真实付费密钥。
- 项目内outputs/Shiping.app已更新重开。旧应用work/Shiping-before-self-contained.app和资料work/pre-self-contained-library已备份；两知识库13份现存资料数量核对一致，当前活动索引就绪。迁移复用10351条缓存；9条旧格式历史索引保留为不可直接复用，没有自动付费补算。
- Windows发布配置和兼容分支已更新，尚未Windows实机验收；精确扫描针对个人知识库，不作百万向量规模性能承诺。
