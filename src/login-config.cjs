const { validClientId } = require('./auth.cjs');
const TEST_CLIENT_ID = '00000000-0000-4000-8000-000000000000';
const reserved = new Set([
  TEST_CLIENT_ID,
  '00000000-0000-0000-0000-000000000000',
  'ffffffff-ffff-ffff-ffff-ffffffffffff'
]);

function releaseClientId(config) {
  if (config?.mode !== 'release' || typeof config.clientId !== 'string') return '';
  const id = config.clientId.toLowerCase();
  return validClientId(id) && !reserved.has(id) ? id : '';
}

function buildLoginConfig(args, suppliedId) {
  if (args.length === 1 && args[0] === '--demo') return { mode: 'demo' };
  if (args.length) throw new Error('打包参数无效。仅本地演示包使用 --demo。');
  const value = suppliedId?.trim();
  if (!value) throw new Error('正式包缺少 STUDY_ENTRA_CLIENT_ID。请配置专属课盘客户端 ID，或明确使用 --demo。');
  const clientId = releaseClientId({ mode: 'release', clientId: value });
  if (!clientId) throw new Error('STUDY_ENTRA_CLIENT_ID 无效或为保留测试值。请使用专属课盘客户端 ID。');
  return { mode: 'release', clientId };
}

module.exports = { buildLoginConfig, releaseClientId, TEST_CLIENT_ID };
