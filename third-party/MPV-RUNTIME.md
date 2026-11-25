# mpv 播放核心与对应构建

课盘通过 Koffi 动态加载官方 mpv CI 的 Windows x64 MinGW LGPL 构建。应用运行时只取归档中的 `libmpv-2.dll` 和原样的 `LICENSE.LGPL`，位于 `resources/app/vendor/mpv`。目录版可替换为兼容的 libmpv 2 动态库来调试相应修改。两种便携包均保留同一许可文档和源码信息。Koffi 的许可证随其 npm 包复制。

| 项目 | 固定版本 |
| --- | --- |
| 源提交 | `d11ffba253def00b5172c4b8b47e6b2eb765cae1` |
| GitHub Actions | [官方 Windows x64 LGPL 构建任务](https://github.com/mpv-player/mpv/actions/runs/44760162632/job/136370248600) |
| 压缩包 | `libmpv-v0.42.0-dev-gd11ffba25-44760162632-x86_64-w64-mingw32-lgpl.zip` |
| 压缩包 SHA-256 | `a0474d5cd726c77e6d0c280b750a320d943d3960a7d03d61687d387b84f67b43` |
| DLL SHA-256 | `3ac0bf3a6f863a6242c2741219d9ed1f89d1b24e5cad8aa799dea94db8239797` |
| 对应 mpv 源码归档 SHA-256 | `ed8766776bbcfba12425fcf675748728cc2bfc0d124745ec32b6aa22efafd3aa` |

从 [mpv 官方安装页](https://mpv.io/installation/) 链接的 [官方 CI 发行页](https://github.com/mpv-player/mpv/releases/tag/git-release) 取上述固定归档，保存到 `.runtime/mpv/`。`git-release` 会滚动更新，需依完整文件名、构建任务和校验值匹配，构建脚本只接收固定归档。对应 [mpv 源码及构建配置](https://github.com/mpv-player/mpv/tree/d11ffba253def00b5172c4b8b47e6b2eb765cae1) 和官方 CI 任务保留其源码及依赖构建来源。归档附带 LGPL 2.1 文本，课盘通过动态库公共 C 接口调用，未修改 mpv。

可直接获取 [固定 mpv 源码归档](https://codeload.github.com/mpv-player/mpv/tar.gz/d11ffba253def00b5172c4b8b47e6b2eb765cae1)，本机同时保留该归档。构建任务输出报告 FFmpeg `git-2026-11-20-9ced9e3`，对应 [FFmpeg 源码提交](https://github.com/FFmpeg/FFmpeg/tree/9ced9e3)。构建镜像与其余依赖以该官方 CI 任务的日志和选项为准。

只有打开视频或音频才启动隔离的 Electron 播放辅助进程并加载 DLL。Windows 使用 mpv 的 `wid` 选项附着到课盘自己的原生子窗口，辅助进程通过库的 C API 控制播放。课盘不开放 mpv JSON 命令端口。播放源使用受控环回 Range，不启用用户脚本、自动外部文件和外部播放列表。
