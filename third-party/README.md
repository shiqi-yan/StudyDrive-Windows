# 第三方参考与许可

| 上游及许可 | 实际研读 | 课盘中的对应实现 |
| --- | --- | --- |
| nini22P/omp · AGPL-3.0 | [Graph 请求](https://github.com/nini22P/omp/blob/18af251187ec92787dc1ef9ec5445f13063b2038/src/graph/graph.ts)、[目录](https://github.com/nini22P/omp/blob/18af251187ec92787dc1ef9ec5445f13063b2038/src/hooks/graph/useFilesData.ts)、[播放器](https://github.com/nini22P/omp/blob/18af251187ec92787dc1ef9ec5445f13063b2038/src/hooks/player/usePlayerCore.ts)、[历史数据](https://github.com/nini22P/omp/blob/18af251187ec92787dc1ef9ec5445f13063b2038/src/store/useHistoryStore.ts) | 依据浏览、打开媒体后取链接和按播放时间写历史的行为独立实现。Graph 调用、令牌与签名 URL 留在主进程，续播使用客户端账户和文件标识。 |
| pseudosavant/player.html · MIT | [播放、历史与键盘分发](https://github.com/pseudosavant/player.html/blob/f6326826e69951b94f3c52b84b0edc33cc55d8ba/src/js/app.js)、[OneDrive picker](https://github.com/pseudosavant/player.html/blob/f6326826e69951b94f3c52b84b0edc33cc55d8ba/src/js/file-pickers.js)、[数值限制](https://github.com/pseudosavant/player.html/blob/f6326826e69951b94f3c52b84b0edc33cc55d8ba/src/js/utils.js#L211) | 复用 MIT 的 minmax，重命名后用于跳转和音量边界。播放器事件路由、倍速、恢复逻辑与历史资料结构独立实现。 |
| chius-me/ilist · MIT | [OneDrive 请求、分页及上传会话](https://github.com/chius-me/ilist/blob/edabe2a4ca0aded7b04973aa8262afb2cb6fc88a/src/worker/drivers/onedrive/client.ts)、[上传队列](https://github.com/chius-me/ilist/blob/edabe2a4ca0aded7b04973aa8262afb2cb6fc88a/src/ui/features/uploads/useUploadQueue.ts)、[会话服务](https://github.com/chius-me/ilist/blob/edabe2a4ca0aded7b04973aa8262afb2cb6fc88a/src/worker/upload-service.ts) | 改编 MIT 的 nextExpectedRanges 字符串数组验证。沿用会话重试前读取服务端进度的行为，独立实现本地文件读取、Windows 授权隔离和传输队列。分页链接在主进程检查 Graph 来源并用本地游标映射。 |
| OpenListTeam/OpenList · AGPL-3.0 | [OneDrive Link](https://github.com/OpenListTeam/OpenList/blob/7c26f1012c2951441233dce4ef309753fc76165d/drivers/onedrive/driver.go#L111)、[OneDrive 分页](https://github.com/OpenListTeam/OpenList/blob/7c26f1012c2951441233dce4ef309753fc76165d/drivers/onedrive/util.go#L169)、[下载与 Range 转发](https://github.com/OpenListTeam/OpenList/blob/7c26f1012c2951441233dce4ef309753fc76165d/server/handles/down.go) | 独立实现下载、按需取链接及有界 Range 转发。课盘客户端用受限环回端点交付媒体流。 |

两份 MIT 许可全文随包分发。OMP 和 OpenList 作为行为与结构参考，未引入代码、资源或运行时。Electron 运行时及 Chromium 声明随运行时分发。PDF.js 按 Apache-2.0 许可随程序分发，包含其 PDF worker、字体映射和标准字体资源。Playwright 和 electron-builder 为开发依赖。

便携启动器由 electron-builder 26.18.0 的 `portable.nsi` 和 `extractAppPackage.nsh` 生成，包含 NSIS 3.0.4.1 的启动代码和 nsis-resources 3.4.1 提供的 Nsis7z 解包模块。分发包附带 electron-builder（MIT）、NSIS 和 7-Zip 的许可证和版权声明。Nsis7z 由 Nik Medved 编写，基于 Igor Pavlov 的 7-Zip，按 LGPL 条款分发。源码和工具来源见 [NSIS 源码](https://github.com/NSIS-Dev/nsis)、[Nsis7z 源码与许可](https://nsis.sourceforge.io/Nsis7z_plug-in)、[7-Zip 源码](https://www.7-zip.org/download.html) 与 [electron-builder 工具构建](https://github.com/electron-userland/electron-builder-binaries)。

## 文档预览

| 上游及许可 | 参考内容和课盘复用 |
| --- | --- |
| Microsoft Graph v1.0 | 调用 driveItem 的 `/content?format=pdf` 并处理 `302` 临时地址及个人委托授权。课盘用现有 `Drive.response()` 刷新 Graph 授权，用 `Media.fetchContent()` 验证下载地址并续取临时链接。Graph 授权只发给 Graph。参见 [driveItem 转换 API](https://learn.microsoft.com/en-us/graph/api/driveitem-get-content-format?view=graph-rest-1.0)。 |
| Mozilla PDF.js 5.4.394 · Apache-2.0 | 继续使用 PDF.js 的 `getDocument`、PDF worker、CMap、字体、ICC 和 WASM。原生 PDF 与 Graph 转换结果共用课盘的 `pdfPreview()`。包内许可位于 `resources/app/vendor/pdf` 和其中各资源目录。参见 [PDF.js](https://github.com/mozilla/pdf.js/tree/v5.4.394)。 |
| SheetJS CE 0.20.3 · Apache-2.0 | 从官方 CDN 安装锁定版本，实际调用 `XLSX.read` 和 `utils.decode_range` 读取 XLS、XLSX、XLSM、ODS。通过 `cell.w` 和 `cell.f` 分别取得显示值与公式。CSV/TSV 使用课盘的文本解析器保留空字段和原始字符串。包内保留 `xlsx/LICENSE` 和分发文件所含声明。参见 [官方分发源](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/) 与 [解析参数](https://docs.sheetjs.com/docs/api/parse-options/)。 |
| markdown-it 15.0.3 · MIT | 调用 `parse` 和 `renderer.render`，关闭 HTML、处理标题与链接 token，并替换 image 规则。运行时分发 markdown-it 及其依赖。各包许可证位于 `resources/app/node_modules`，包括 entities（BSD-2-Clause）、linkify-it、mdurl、punycode.js、uc.micro（MIT）及 argparse（PSF-2.0）。参见 [15.0.3 发行版](https://github.com/markdown-it/markdown-it/releases/tag/15.0.3)。 |
| Cloudreve · GPL-3.0 | 参考「文件浏览应用」里的 Markdown 和同目录图片工作流。课盘独立实现标题目录、只读排版和当前 OneDrive 目录单层路径授权。参见 [文件浏览应用](https://docs.cloudreve.org/zh/usage/file-apps) 与 [Cloudreve 项目](https://github.com/cloudreve/cloudreve)。 |
| OpenList · AGPL-3.0 | 参考 `internal/bootstrap/data/setting.go` 的预览类别和文档中的按类型分派。课盘的 `fileType()` 与 `open` IPC 独立实现分派。参见 [预览配置](https://doc.oplist.org/configuration/preview) 与 [预览配置模块](https://github.com/OpenListTeam/OpenList/blob/main/internal/bootstrap/data/setting.go)。 |
| Nextcloud Office 集成 · AGPL-3.0-or-later | 参考 `lib/Preview/Office.php` 的统一 Office 预览入口以及转换时限设置。课盘独立实现 Graph 转换与 PDF 显示。参见 [预览入口](https://github.com/nextcloud/richdocuments/blob/main/lib/Preview/Office.php) 与 [应用设置](https://github.com/nextcloud/richdocuments/blob/main/docs/app_settings.md)。 |
| Apache POI 5.4.1 · Apache-2.0 | 使用 HWPF、XWPF、HSLF、XSLF 和 POI 的 `test-data/document/empty.doc` 模板生成合成中文 DOC、DOCX、PPT、PPTX。DOC 夹带衍生模板，许可与 NOTICE 一并分发。POI JAR 仅用于生成样本。参见 [Word 模块](https://poi.apache.org/components/document/index.html)、[PPT 模块](https://poi.apache.org/components/slideshow/quick-guide.html) 与 [样本模板](https://raw.githubusercontent.com/apache/poi/REL_5_4_1/test-data/document/empty.doc)。 |

## 媒体播放

- 运行时采用 mpv 官方 Windows x64 LGPL CI 的 libmpv 动态库，保留归档的 LGPL 文本、固定构建编号与源码信息。运行时桥接采用 Koffi，许可证随对应 npm 包分发。[构建及许可](MPV-RUNTIME.md)
- 合成低清课程样片 `lecture-360p-low.mp4` 继续来自 DSH 的 `onedrive-video-enhancement` 测试样本。[样本归属](DSH-video-enhancement-LICENSE)

## 课盘 0.2.5 Office 增强

- LibreOffice Kit 0.2.3 及其 Windows x64 原生引擎仅随含引擎版分发。源码和补丁、MPL-2.0、上游通知和第三方许可分别保留在随包的 adapter 的 LICENSE、NOTICE、frame-forwarding 和原生包的 licenses、sources。原生包的 prebuilds.json 逐项核验后完整复制。课盘调用 createConverter 和 render，原生助手独立执行，不使用嵌入式编辑或纹理接口。包内源码确认禁用 curl、WebDAV、脚本并以 NO_UPDATE 打开外部引用。 [官方 npm 包](https://www.npmjs.com/package/%40deepseek-ai/libreoffice-kit) · [源代码与运行库要求](https://github.com/deepseek-ai/dsh-libreoffice-kit)
- SheetJS CE 继续读取值、数字格式、缓存公式结果、合并范围及旧 XLS。本地样本中其 XLSX 单元格样式只包含 patternType、fgColor。ExcelJS 4.4.0（MIT）只补充常见 XLSX 样式，保留依赖各自的许可。对原样式读取限制为声明解压不超过 16 MiB、最多 7.5 万个有效单元格。主题色与线型作浏览器近似，采用本机已装字体。 [ExcelJS v4.4.0](https://github.com/exceljs/exceljs/tree/v4.4.0)
- PPT 缩略图复用随包的 PDF.js 页面对象，按可见窗口逐张渲染。原缩放、页码、全屏和阅读位置逻辑沿用。
