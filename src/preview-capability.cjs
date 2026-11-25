const { documentLimit, localDocument, sheetPageView } = require('./documents.cjs');
const { maxInput, supportsLocal } = require('./local-office.cjs');

function previewCapability(item, requestedView, office) {
  const pageView = sheetPageView(item);
  if (item.kind === 'office' || requestedView === 'pdf' && pageView) {
    let source = 'graph';
    let localLimit = '';
    if (supportsLocal(item)) {
      if (item.size > maxInput) localLimit = '此文件超过本机预览的 32 MB 限制';
      else {
        const readiness = office.readiness;
        if (readiness === 'ready') source = 'local';
        else localLimit = readiness === 'runtime' ? '缺少 Windows VC++ v14 x64 运行库' : '本机 Office 组件暂不可用';
      }
    }
    return { view: 'pdf', source, pageView, localLimit, note: localLimit ? localLimit + '，正在尝试 OneDrive 转换…' : '' };
  }
  if (localDocument(item) || ['audio', 'video', 'pdf', 'image'].includes(item.kind)) {
    return { view: item.kind, source: '', pageView, limit: documentLimit(item) };
  }
  throw new Error('此格式可下载后打开。');
}

module.exports = { previewCapability };
