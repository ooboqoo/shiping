# Structured Chunking Implementation Plan

> Native execution under superpowers:executing-plans. Spec: ../specs/2026-10-31-structured-chunks.md

- [x] 写结构切分失败测试；实现独立structure.ts，验证覆盖/偏移/链接/章节/代码表格与1200字符上限。
- [x] 将章节元数据接入embedding、BM25、来源显示；CHUNK_VERSION、ID、指纹、集合与本地manifest路径隔离v2，测试旧版本拒绝。
- [x] 跑当前知识库只读分片诊断；构建v2集合后复测，保留v1和源文件。
- [x] 全套测试、类型检查、lint、构建；独立审查关键边界；更新试用包、说明、操作台账和卸载集合清单。

不修改正式版，不调用DeepSeek，不删除旧向量。未能完整保留的超长结构明确按长度兜底；超长链接无法安全分割时抛出可见错误。

验证结果：55项项目测试、node/web类型检查、ESLint与构建通过；真实资料重建396片，四种网址问法首条含目标URL；独立审查3项边界问题已修复并复核。
