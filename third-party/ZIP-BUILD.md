# Windows ZIP 发布包

从 [7-Zip 官方发布页](https://github.com/ip7z/7zip/releases/tag/26.06) 下载 Windows x64 版 7z2606-x64.exe，放入 .runtime/7zip-26.06/（或用 STUDY_7ZIP_INSTALLER 指定路径）。先运行 npm run pack:dir，再以同组参数运行 npm run pack:zip。脚本核对发行文件的 SHA-256，读取归档中的命令行工具，并用同一工具测试生成的 ZIP。发布包包含完整应用目录和原生运行时。解压整个目录后打开 StudyDrive.exe。
