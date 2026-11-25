const { parentPort, workerData } = require('node:worker_threads');
const { DriveIndexDb } = require('./drive-index-db.cjs');
const { CloudRecycleDb } = require('./cloud-recycle-db.cjs');

const db = new DriveIndexDb(workerData);
const cloud = new CloudRecycleDb(db);
const cloudOperations = new Map(['begin', 'append', 'publish', 'discard', 'page', 'restoreRows'].map(name => ['cloud:' + name, name]));
const operations = new Set(['status', 'begin', 'page', 'fail', 'search', 'trail', 'intent',
  'mutation', 'pending', 'reconcile', 'recoverIntents', 'trashRecord', 'setTrash', 'trashRows']);
parentPort.on('message', ({ request, operation, args }) => {
  try {
    if (cloudOperations.has(operation)) {
      parentPort.postMessage({ request, result: cloud[cloudOperations.get(operation)](...args) });
    } else {
      if (!operations.has(operation)) throw new Error('Unknown index operation');
      parentPort.postMessage({ request, result: db[operation](...args) });
    }
  } catch {
    parentPort.postMessage({ request, error: true });
  }
});
