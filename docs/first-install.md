# 首次安装与本机依赖

安装 dist 中的 macOS arm64 安装包。运行安装后的应用无需 Node.js、npm、Python、Docker 或独立向量数据库。

AI 模型不预填，需用户在设置中主动填写服务地址、模型及自己的 API Key。资料库的向量模型与可选精排模型也由用户配置；可选择云端兼容服务，或填写用户自行部署的 Ollama / Xinference 地址。不要把开发者本机的模型服务视为已安装依赖。

OCR 中英文资源随安装包分发。源码打包前运行 npm ci、npm run setup:ocr、npm run build:mac。高级用户可通过 SHIPING_OCR_DATA 指定 OCR 资源目录。

macOS 截图与系统音频需要用户授予系统权限。语音识别需要用户自己的 DashScope API Key。

打包签名可通过 MAC_SIGN_KEYCHAIN 指定证书所在钥匙串；没有发布证书时本地构建使用临时签名，换版本可能需要重新授予权限。

源码构建需要独立安装 Node.js 22 与 npm，不应引用 Codex 的运行环境。本次构建用校验过的官方临时 Node.js，应用运行不依赖该临时目录。
