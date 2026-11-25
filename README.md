# 课盘 StudyDrive

**课盘**是一款面向 OneDrive 个人账户的 Windows 学习资料管理器。可以在同一窗口整理课程文件、传输整目录、预览文档和继续观看视频。

[下载课盘 0.1（Windows x64）](https://github.com/shiqi-yan/StudyDrive-Windows/releases/tag/v0.1.0)

## 快速开始

1. 从 Release 页面下载 `StudyDrive-0.1.0-win-x64-office.zip`。
2. 解压整个文件夹，再运行其中的 `StudyDrive.exe`。
3. 选择「用 Microsoft 登录」连接个人 OneDrive，或选择「打开本地演示」先试用。

## 功能

- **查找与整理** · 按文件名搜索、筛选和排序，支持收藏目录、最近浏览和批量操作。
- **传输** · 上传和下载文件或整目录，在传输页查看各项结果，支持暂停和符合条件的断点续传。
- **阅读** · 预览 PDF、Word、PowerPoint、Excel、Markdown 与文本。支持的 Office 文档可在本机转换为只读预览。
- **播放** · 使用内置 mpv 播放视频和音频，可调倍速、切换音轨和字幕，并从上次位置继续。
- **回收站** · 可查看并还原个人 OneDrive 默认可见的回收站条目。本机删除记录单独显示，个人保管库不在默认列表内。

本版优化了批量上传入队及大型目录列表的重复更新。主页包含继续观看、最近浏览和收藏目录。

## 从源码构建

需要 Windows x64、Node.js 24 和 npm。请将 Electron 45.4.1 的 Windows x64 ZIP 与官方校验清单放入 `.runtime`，再按 [mpv 运行时说明](third-party/MPV-RUNTIME.md) 和 [ZIP 构建说明](third-party/ZIP-BUILD.md) 准备依赖。

~~~powershell
npm ci
npm run check
npm test
npm run pack:dir -- --demo
npm run pack:zip -- --demo
~~~

构建可登录的版本时，配置包含个人 Microsoft 账户的 [Microsoft Entra 公共客户端](https://learn.microsoft.com/en-us/entra/identity-platform/scenario-desktop-app-registration)。回环重定向地址为 `http://localhost/study-drive/auth`。以 `STUDY_ENTRA_CLIENT_ID` 提供公开的应用客户端 ID，再对两个打包命令去掉 `--demo`。普通账户使用 Microsoft Graph 委托权限 `Files.ReadWrite`，个人盘还原按需申请 `Files.ReadWrite.All`。

## 许可证

课盘自身源码采用 [MIT 许可证](LICENSE)。随包分发的运行时和第三方组件遵循各自许可，详见 [第三方声明](third-party/README.md)。
