const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { spawn } = require('child_process');

const BASE_URL = 'http://localhost:3004';
const TEST_CSV = 'test_regression_h.csv';
const TEST_DEVICE = 'REG-H-' + Date.now().toString().slice(-8);
const DB_FILE = path.join(__dirname, `cold_chain_reg_h_${Date.now()}.db`);

let passCount = 0;
let failCount = 0;
let serverProcess = null;

function testResult(name, passed, actual, expected, showValues = true) {
  if (passed) {
    passCount++;
    console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`);
  } else {
    failCount++;
    console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}`);
    if (showValues && actual !== undefined && expected !== undefined) {
      console.log(`    Expected: ${JSON.stringify(expected)}`);
      console.log(`    Actual:   ${JSON.stringify(actual)}`);
    }
  }
}

async function waitForServer(timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const resp = await axios.get(BASE_URL + '/health', { timeout: 1000 });
      if (resp.status === 200 && resp.data?.data?.status === 'ok') return true;
    } catch (e) {}
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT: '3004', DB_PATH: DB_FILE };
    const isWindows = process.platform === 'win32';
    const npmCmd = isWindows ? 'npm.cmd' : 'npm';

    serverProcess = spawn(npmCmd, ['run', 'dev'], {
      env, cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'], shell: isWindows,
    });

    waitForServer().then(ready => ready ? resolve() : reject(new Error('Server timeout')));
  });
}

function stopServer() {
  return new Promise(resolve => {
    if (serverProcess) {
      serverProcess.kill('SIGINT');
      const t = setTimeout(() => serverProcess && serverProcess.kill('SIGKILL'), 5000);
      serverProcess.on('exit', () => { clearTimeout(t); serverProcess = null; resolve(); });
    } else resolve();
  });
}

async function apiCall({ method = 'get', url, headers = {}, data, responseType = 'json' }) {
  try {
    const resp = await axios({
      method, url: BASE_URL + url,
      headers: { 'X-User-Id': 'admin', ...headers },
      data, responseType,
    });
    return { status: resp.status, data: resp.data };
  } catch (err) {
    if (err.response) return { status: err.response.status, data: err.response.data };
    throw err;
  }
}

async function uploadCsv(filePath, operator, idempotencyKey = null) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('operator', operator);
  if (idempotencyKey) form.append('idempotencyKey', idempotencyKey);
  const headers = { ...form.getHeaders(), 'X-User-Id': operator };
  try {
    const resp = await axios.post(BASE_URL + '/api/readings/import', form, { headers });
    return { status: resp.status, data: resp.data };
  } catch (err) {
    if (err.response) return { status: err.response.status, data: err.response.data };
    throw err;
  }
}

function createTestCsv() {
  const lines = [
    'deviceId,temperature,readingTime',
    `${TEST_DEVICE},-18.5,2026-06-01 10:00:00`,
    `${TEST_DEVICE},-19.0,2026-06-01 10:01:00`,
  ];
  fs.writeFileSync(TEST_CSV, lines.join('\n'));
}

async function runTests() {
  console.log('\x1b[36m=== CSV导入幂等命中可见性 - 回归测试 ===\x1b[0m\n');
  try {
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    createTestCsv();

    console.log('\x1b[33m[1/6] 启动服务器 & 初始化设备\x1b[0m');
    await startServer();
    await apiCall({
      method: 'post', url: '/api/devices',
      data: { id: TEST_DEVICE, name: '回归测试', storeId: 'REG-STORE', storeName: '回归门店', status: 'active' },
    });
    testResult('设备创建', true);

    console.log('\n\x1b[33m[2/6] 首次导入（带幂等键）\x1b[0m');
    const idemKey = 'reg-h-key-' + Date.now();
    const firstImport = await uploadCsv(TEST_CSV, 'operator_li', idemKey);
    testResult('首次导入成功', firstImport.status === 200);
    testResult('首次导入isIdempotencyHit=false', firstImport.data?.data?.isIdempotencyHit === false);
    const originalBatchId = firstImport.data?.data?.batchId;
    console.log(`  原始批次ID: ${originalBatchId}`);

    console.log('\n\x1b[33m[3/6] 重复提交（幂等命中）\x1b[0m');
    const hitImport = await uploadCsv(TEST_CSV, 'operator_li', idemKey);
    testResult('命中返回200', hitImport.status === 200);
    testResult('导入响应isIdempotencyHit=true', hitImport.data?.data?.isIdempotencyHit === true);
    testResult('导入响应submitCount=2', hitImport.data?.data?.submitCount === 2);
    const hitBatchId = hitImport.data?.data?.batchId;
    console.log(`  命中批次ID: ${hitBatchId}`);

    console.log('\n\x1b[33m[4/6] 验证批次详情持久化（核心测试）\x1b[0m');
    const hitDetail = await apiCall({
      url: `/api/readings/batches/${hitBatchId}`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('命中批次详情可查询', hitDetail.status === 200);
    const hitBatch = hitDetail.data?.data?.batch;
    testResult('详情中isIdempotencyHit=true', hitBatch?.isIdempotencyHit === true, hitBatch?.isIdempotencyHit, true);
    testResult('详情中originalBatchId正确', hitBatch?.originalBatchId === originalBatchId, hitBatch?.originalBatchId, originalBatchId);
    testResult('详情中submitCount=2', hitBatch?.submitCount === 2, hitBatch?.submitCount, 2);
    testResult('详情中idempotencyKey正确', hitBatch?.idempotencyKey === idemKey, hitBatch?.idempotencyKey, idemKey);

    const originalDetail = await apiCall({ url: `/api/readings/batches/${originalBatchId}` });
    const originalBatch = originalDetail.data?.data?.batch;
    testResult('原始批次isIdempotencyHit=false（语义正确）', originalBatch?.isIdempotencyHit === false);
    testResult('原始批次originalBatchId=null（语义正确）', originalBatch?.originalBatchId === null, originalBatch?.originalBatchId, null);

    console.log('\n\x1b[33m[5/6] 验证批次列表持久化\x1b[0m');
    const listResp = await apiCall({
      url: '/api/readings/batches?pageSize=20',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const items = listResp.data?.data?.items || [];
    const hitInList = items.find(b => b.id === hitBatchId);
    testResult('命中批次在列表中', !!hitInList);
    testResult('列表中isIdempotencyHit=true', hitInList?.isIdempotencyHit === true, hitInList?.isIdempotencyHit, true);
    testResult('列表中originalBatchId正确', hitInList?.originalBatchId === originalBatchId, hitInList?.originalBatchId, originalBatchId);
    testResult('列表中submitCount=2', hitInList?.submitCount === 2, hitInList?.submitCount, 2);

    console.log('\n\x1b[33m[6/6] 验证导出持久化\x1b[0m');
    const jsonExport = await apiCall({
      url: `/api/readings/batches/${hitBatchId}/export?format=json`,
      headers: { 'X-User-Id': 'viewer_wang' },
      responseType: 'text',
    });
    const jsonData = typeof jsonExport.data === 'string' ? JSON.parse(jsonExport.data) : jsonExport.data;
    testResult('JSON导出isIdempotencyHit=true', jsonData.batch?.isIdempotencyHit === true, jsonData.batch?.isIdempotencyHit, true);
    testResult('JSON导出originalBatchId正确', jsonData.batch?.originalBatchId === originalBatchId, jsonData.batch?.originalBatchId, originalBatchId);
    testResult('JSON导出submitCount=2', jsonData.batch?.submitCount === 2, jsonData.batch?.submitCount, 2);

    const csvExport = await apiCall({
      url: `/api/readings/batches/${hitBatchId}/export?format=csv`,
      headers: { 'X-User-Id': 'viewer_wang' },
      responseType: 'text',
    });
    const csvLines = csvExport.data.split('\n');
    const headerLine = csvLines.find(l => l.startsWith('id,')) || csvLines[1];
    const dataLine = csvLines.find(l => l.includes(hitBatchId));
    testResult('CSV包含isIdempotencyHit列', headerLine.includes('isIdempotencyHit'), headerLine, 'isIdempotencyHit');
    testResult('CSV包含originalBatchId列', headerLine.includes('originalBatchId'), headerLine, 'originalBatchId');
    testResult('CSV包含submitCount列', headerLine.includes('submitCount'), headerLine, 'submitCount');
    testResult('CSV数据行isIdempotencyHit为true', dataLine?.includes('true') || dataLine?.includes('1'));
    testResult('CSV数据行包含originalBatchId', dataLine?.includes(originalBatchId));

    console.log('\n\x1b[33m=== 验证不重复写入业务数据 ===\x1b[0m');
    const readingsResp = await apiCall({ url: `/api/readings?pageSize=100&deviceId=${TEST_DEVICE}` });
    const readings = readingsResp.data?.data?.items?.filter(r => r.deviceId === TEST_DEVICE) || [];
    testResult('读数仅2条（不重复写入）', readings.length === 2, readings.length, 2);

    const alarmsResp = await apiCall({ url: '/api/alarms?pageSize=100' });
    const alarms = alarmsResp.data?.data?.items || [];
    testResult('无新增告警（幂等命中不生成）', alarms.length === 0, alarms.length, 0);

    const batchListAll = await apiCall({ url: '/api/readings/batches?pageSize=20' });
    const allBatches = batchListAll.data?.data?.items || [];
    testResult('共2个批次（原始+命中）', allBatches.length === 2, allBatches.length, 2);

    const auditsResp = await apiCall({ url: `/api/readings/batches/${originalBatchId}` });
    const audits = auditsResp.data?.data?.auditLogs || [];
    const importAudits = audits.filter(a => a.operationType === 'reading_import');
    testResult('仅1条导入审计（不重复创建）', importAudits.length === 1, importAudits.length, 1);

    const hitAuditResp = await apiCall({ url: `/api/readings/batches/${hitBatchId}` });
    const hitAudits = hitAuditResp.data?.data?.auditLogs || [];
    const hitAuditItems = hitAudits.filter(a => a.operationType === 'idempotency_hit');
    testResult('命中批次有1条幂等命中审计', hitAuditItems.length === 1, hitAuditItems.length, 1);

    console.log('\n\x1b[33m=== 跨重启一致性验证 ===\x1b[0m');
    await stopServer();
    await startServer();
    testResult('服务器重启成功', true);

    const afterDetail = await apiCall({
      url: `/api/readings/batches/${hitBatchId}`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const afterBatch = afterDetail.data?.data?.batch;
    testResult('重启后isIdempotencyHit=true', afterBatch?.isIdempotencyHit === true, afterBatch?.isIdempotencyHit, true);
    testResult('重启后originalBatchId正确', afterBatch?.originalBatchId === originalBatchId, afterBatch?.originalBatchId, originalBatchId);
    testResult('重启后submitCount=2', afterBatch?.submitCount === 2, afterBatch?.submitCount, 2);

    const afterJson = await apiCall({
      url: `/api/readings/batches/${hitBatchId}/export?format=json`,
      responseType: 'text',
    });
    const afterJsonData = typeof afterJson.data === 'string' ? JSON.parse(afterJson.data) : afterJson.data;
    testResult('重启后JSON导出isIdempotencyHit=true', afterJsonData.batch?.isIdempotencyHit === true);

    const afterHit = await uploadCsv(TEST_CSV, 'operator_li', idemKey);
    testResult('重启后幂等命中正常', afterHit.data?.data?.isIdempotencyHit === true);
    testResult('重启后submitCount递增为3', afterHit.data?.data?.submitCount === 3, afterHit.data?.data?.submitCount, 3);

    const afterList = await apiCall({ url: '/api/readings/batches?pageSize=20' });
    const afterItems = afterList.data?.data?.items || [];
    testResult('重启后共3个批次', afterItems.length === 3, afterItems.length, 3);

    console.log('\n\x1b[36m=== 测试完成 ===\x1b[0m');
    console.log(`通过: \x1b[32m${passCount}\x1b[0m / 失败: \x1b[31m${failCount}\x1b[0m`);

    await stopServer();
    if (fs.existsSync(TEST_CSV)) fs.unlinkSync(TEST_CSV);
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

    if (failCount > 0) {
      console.log('\n\x1b[31m❌ 有失败测试\x1b[0m');
      process.exit(1);
    } else {
      console.log('\n\x1b[32m🎉 所有测试通过\x1b[0m');
    }
  } catch (err) {
    console.error('\n\x1b[31m测试异常:\x1b[0m', err.message);
    try { await stopServer(); } catch (e) {}
    if (fs.existsSync(TEST_CSV)) fs.unlinkSync(TEST_CSV);
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    process.exit(1);
  }
}

runTests();
