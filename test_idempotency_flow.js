const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { spawn, execSync } = require('child_process');

const BASE_URL = 'http://localhost:3003';
const TEST_CSV_A = 'test_idempotency_a.csv';
const TEST_CSV_B = 'test_idempotency_b.csv';
const TEST_CSV_C = 'test_idempotency_c.csv';
const TEST_DEVICE = 'IDEM-TEST-' + Date.now().toString().slice(-8);
const DB_FILE = path.join(__dirname, `cold_chain_idem_${Date.now()}.db`);

let passCount = 0;
let failCount = 0;
let serverProcess = null;

function testResult(name, passed, actual, expected) {
  if (passed) {
    passCount++;
    console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`);
  } else {
    failCount++;
    console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}`);
    if (actual !== undefined && expected !== undefined) {
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
      if (resp.status === 200 && resp.data?.data?.status === 'ok') {
        return true;
      }
    } catch (e) {
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: '3003',
      DB_PATH: DB_FILE,
    };

    const isWindows = process.platform === 'win32';
    const npmCmd = isWindows ? 'npm.cmd' : 'npm';

    console.log(`  Starting server with DB: ${DB_FILE}`);
    serverProcess = spawn(npmCmd, ['run', 'dev'], {
      env,
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
    });

    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Server started on port 3003')) {
        console.log('  Server started successfully');
      }
    });

    serverProcess.stderr.on('data', (data) => {
    });

    serverProcess.on('error', (err) => {
      reject(err);
    });

    waitForServer().then((ready) => {
      if (ready) resolve();
      else reject(new Error('Server failed to start within timeout'));
    });
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (serverProcess) {
      console.log('  Stopping server...');
      serverProcess.kill('SIGINT');
      let timeout = setTimeout(() => {
        if (serverProcess) serverProcess.kill('SIGKILL');
      }, 5000);
      serverProcess.on('exit', () => {
        clearTimeout(timeout);
        serverProcess = null;
        console.log('  Server stopped');
        resolve();
      });
    } else {
      resolve();
    }
  });
}

async function apiCall({ method = 'get', url, headers = {}, data, responseType = 'json' }) {
  try {
    const resp = await axios({
      method,
      url: BASE_URL + url,
      headers: { 'X-User-Id': 'admin', ...headers },
      data,
      responseType,
    });
    return { status: resp.status, data: resp.data };
  } catch (err) {
    if (err.response) {
      return { status: err.response.status, data: err.response.data };
    }
    throw err;
  }
}

async function uploadCsv(filePath, operator = 'operator_li', idempotencyKey = null) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('operator', operator);
  if (idempotencyKey) {
    form.append('idempotencyKey', idempotencyKey);
  }

  const headers = {
    ...form.getHeaders(),
    'X-User-Id': operator,
  };

  try {
    const resp = await axios.post(BASE_URL + '/api/readings/import', form, { headers });
    return { status: resp.status, data: resp.data };
  } catch (err) {
    if (err.response) {
      return { status: err.response.status, data: err.response.data };
    }
    throw err;
  }
}

function createTestCsvA() {
  const lines = [
    'deviceId,temperature,readingTime',
    `${TEST_DEVICE},-18.5,2026-06-01 10:00:00`,
    `${TEST_DEVICE},-19.0,2026-06-01 10:01:00`,
    `${TEST_DEVICE},-18.0,2026-06-01 10:02:00`,
  ];
  fs.writeFileSync(TEST_CSV_A, lines.join('\n'));
  console.log(`  Created CSV A: 3 rows (all valid, times 10:00-10:02)`);
}

function createTestCsvB() {
  const lines = [
    'deviceId,temperature,readingTime',
    `${TEST_DEVICE},-20.0,2026-06-01 11:00:00`,
    `${TEST_DEVICE},-21.0,2026-06-01 11:01:00`,
  ];
  fs.writeFileSync(TEST_CSV_B, lines.join('\n'));
  console.log(`  Created CSV B: 2 rows (all valid, times 11:00-11:01)`);
}

function createTestCsvC() {
  const lines = [
    'deviceId,temperature,readingTime',
    `${TEST_DEVICE},-17.5,2026-06-01 09:00:00`,
    `${TEST_DEVICE},-17.0,2026-06-01 09:01:00`,
    `${TEST_DEVICE},-18.2,2026-06-01 09:02:00`,
  ];
  fs.writeFileSync(TEST_CSV_C, lines.join('\n'));
  console.log(`  Created CSV C: 3 rows (all valid, times 09:00-09:02)`);
}

let firstBatchId = null;
let firstBatchData = null;
let beforeRestartBatch = null;
let beforeRestartIdemKey = null;

async function runTests() {
  console.log('\x1b[36m========================================\x1b[0m');
  console.log('\x1b[36mCSV导入幂等键功能 - 完整测试\x1b[0m');
  console.log('\x1b[36m========================================\x1b[0m\n');

  try {
    console.log('\x1b[33m=== 阶段 1: 启动服务器 ===\x1b[0m');
    if (fs.existsSync(DB_FILE)) {
      fs.unlinkSync(DB_FILE);
      console.log('  Cleaned up existing DB file');
    }
    await startServer();
    testResult('服务器启动成功', true);

    console.log('\n\x1b[33m=== 阶段 2: 初始化测试数据 ===\x1b[0m');
    const deviceResp = await apiCall({
      method: 'post',
      url: '/api/devices',
      data: {
        id: TEST_DEVICE,
        name: '幂等测试冰柜',
        storeId: 'STORE-IDEM',
        storeName: '幂等测试门店',
        status: 'active',
      },
    });
    testResult('设备创建成功', deviceResp.status === 200 || deviceResp.status === 201);

    createTestCsvA();
    createTestCsvB();
    createTestCsvC();

    console.log('\n\x1b[33m=== 阶段 3: 测试1 - 正常导入（无幂等键）===\x1b[0m');
    const importNoKey = await uploadCsv(TEST_CSV_C, 'operator_li', null);
    testResult('无幂等键导入成功返回200', importNoKey.status === 200);
    testResult('返回结果包含success: true', importNoKey.data?.success === true);
    testResult('成功数量正确 (3)', importNoKey.data?.data?.successCount === 3);
    testResult('失败数量正确 (0)', importNoKey.data?.data?.failedCount === 0);
    testResult('isIdempotencyHit为false或undefined', !importNoKey.data?.data?.isIdempotencyHit);
    firstBatchId = importNoKey.data?.data?.batchId;
    console.log(`  第一批次ID: ${firstBatchId}`);

    console.log('\n\x1b[33m=== 阶段 4: 测试2 - 正常导入（带幂等键，首次提交）===\x1b[0m');
    const idemKey = 'import-batch-2026-06-06-001';
    beforeRestartIdemKey = idemKey;
    const importWithKey = await uploadCsv(TEST_CSV_A, 'operator_li', idemKey);
    testResult('带幂等键首次导入成功返回200', importWithKey.status === 200);
    testResult('返回结果包含success: true', importWithKey.data?.success === true);
    testResult('成功数量正确 (3)', importWithKey.data?.data?.successCount === 3);
    testResult('isIdempotencyHit为false', importWithKey.data?.data?.isIdempotencyHit === false);
    testResult('返回idempotencyKey', importWithKey.data?.data?.idempotencyKey === idemKey);
    testResult('submitCount为1', importWithKey.data?.data?.submitCount === 1);
    firstBatchData = importWithKey.data?.data;
    beforeRestartBatch = importWithKey.data?.data;
    console.log(`  第二批次ID: ${firstBatchData.batchId}`);

    console.log('\n\x1b[33m=== 阶段 5: 测试3 - 幂等命中（同操作者、同key、同内容）===\x1b[0m');
    const importHit = await uploadCsv(TEST_CSV_A, 'operator_li', idemKey);
    testResult('幂等命中返回200', importHit.status === 200);
    testResult('返回结果包含success: true', importHit.data?.success === true);
    testResult('isIdempotencyHit为true', importHit.data?.data?.isIdempotencyHit === true);
    testResult('返回原批次ID', importHit.data?.data?.batchId === firstBatchData.batchId);
    testResult('返回正确的submitCount (2)', importHit.data?.data?.submitCount === 2);
    testResult('返回originalBatchId', importHit.data?.data?.originalBatchId === firstBatchData.batchId);
    testResult('返回idempotencyKey', importHit.data?.data?.idempotencyKey === idemKey);
    testResult('返回成功数量与原批次一致', importHit.data?.data?.successCount === firstBatchData.successCount);
    testResult('返回失败数量与原批次一致', importHit.data?.data?.failedCount === firstBatchData.failedCount);
    testResult('generatedAlarms为0（不重复生成）', importHit.data?.data?.generatedAlarms === 0);
    testResult('recoveredAlarms为0（不重复生成）', importHit.data?.data?.recoveredAlarms === 0);

    console.log('\n\x1b[33m=== 阶段 6: 测试4 - 多次幂等命中（提交次数递增）===\x1b[0m');
    const importHit2 = await uploadCsv(TEST_CSV_A, 'operator_li', idemKey);
    testResult('第三次幂等命中提交次数为3', importHit2.data?.data?.submitCount === 3);

    const importHit3 = await uploadCsv(TEST_CSV_A, 'operator_li', idemKey);
    testResult('第四次幂等命中提交次数为4', importHit3.data?.data?.submitCount === 4);

    console.log('\n\x1b[33m=== 阶段 7: 测试5 - 幂等冲突（同key、不同内容）===\x1b[0m');
    const importConflict = await uploadCsv(TEST_CSV_B, 'operator_li', idemKey);
    testResult('幂等冲突返回409', importConflict.status === 409);
    testResult('返回结果包含success: false', importConflict.data?.success === false);
    testResult('错误消息包含幂等键', importConflict.data?.message?.includes(idemKey));
    testResult('错误消息说明内容不同', importConflict.data?.message?.includes('文件内容不同') || importConflict.data?.message?.includes('不一致'));

    console.log('\n\x1b[33m=== 阶段 8: 测试6 - 不同操作者、同key（应为独立幂等域）===\x1b[0m');
    const importDiffOp = await uploadCsv(TEST_CSV_B, 'manager_zhang', idemKey);
    testResult('不同操作者同key首次导入成功', importDiffOp.status === 200);
    testResult('isIdempotencyHit为false', importDiffOp.data?.data?.isIdempotencyHit === false);
    testResult('批次ID与原批次不同', importDiffOp.data?.data?.batchId !== firstBatchData.batchId);
    testResult('submitCount为1', importDiffOp.data?.data?.submitCount === 1);

    console.log('\n\x1b[33m=== 阶段 9: 测试7 - 权限控制（viewer不能导入）===\x1b[0m');
    const importViewer = await uploadCsv(TEST_CSV_A, 'viewer_wang', 'viewer-key-001');
    testResult('viewer导入返回403', importViewer.status === 403);
    testResult('返回结果包含success: false', importViewer.data?.success === false);
    testResult('错误消息包含权限', importViewer.data?.message?.includes('权限'));

    console.log('\n\x1b[33m=== 阶段 10: 测试8 - 批次详情幂等信息 ===\x1b[0m');
    const batchDetail = await apiCall({
      url: `/api/readings/batches/${firstBatchData.batchId}`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('viewer可查询批次详情', batchDetail.status === 200);
    const batch = batchDetail.data?.data?.batch;
    testResult('批次详情包含idempotencyKey', batch?.idempotencyKey === idemKey);
    testResult('批次详情包含fileContentHash', batch?.fileContentHash?.length === 64);
    testResult('批次详情包含isIdempotencyHit', batch?.isIdempotencyHit === false);
    testResult('批次详情包含submitCount', batch?.submitCount === 4);

    console.log('\n\x1b[33m=== 阶段 11: 测试9 - 批次列表幂等信息 ===\x1b[0m');
    const batchList = await apiCall({
      url: '/api/readings/batches?pageSize=20',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('viewer可查询批次列表', batchList.status === 200);
    const items = batchList.data?.data?.items || [];
    const batchInList = items.find(b => b.id === firstBatchData.batchId);
    testResult('批次在列表中', !!batchInList);
    testResult('列表中包含idempotencyKey', batchInList?.idempotencyKey === idemKey);
    testResult('列表中包含submitCount', batchInList?.submitCount === 4);

    console.log('\n\x1b[33m=== 阶段 12: 测试10 - JSON导出幂等信息 ===\x1b[0m');
    const jsonExport = await apiCall({
      url: `/api/readings/batches/${firstBatchData.batchId}/export?format=json`,
      headers: { 'X-User-Id': 'viewer_wang' },
      responseType: 'text',
    });
    testResult('JSON导出成功', jsonExport.status === 200);
    const jsonData = typeof jsonExport.data === 'string' ? JSON.parse(jsonExport.data) : jsonExport.data;
    testResult('JSON导出包含idempotencyKey', jsonData.batch?.idempotencyKey === idemKey);
    testResult('JSON导出包含fileContentHash', jsonData.batch?.fileContentHash?.length === 64);
    testResult('JSON导出包含isIdempotencyHit', jsonData.batch?.isIdempotencyHit === false);
    testResult('JSON导出包含submitCount', jsonData.batch?.submitCount === 4);
    testResult('JSON导出包含originalBatchId', 'originalBatchId' in jsonData.batch);

    console.log('\n\x1b[33m=== 阶段 13: 测试11 - CSV导出幂等信息 ===\x1b[0m');
    const csvExport = await apiCall({
      url: `/api/readings/batches/${firstBatchData.batchId}/export?format=csv`,
      headers: { 'X-User-Id': 'viewer_wang' },
      responseType: 'text',
    });
    testResult('CSV导出成功', csvExport.status === 200);
    testResult('CSV包含idempotency_key列', csvExport.data.includes('idempotencyKey'));
    testResult('CSV包含submitCount列', csvExport.data.includes('submitCount'));
    testResult('CSV包含isIdempotencyHit列', csvExport.data.includes('isIdempotencyHit'));

    console.log('\n\x1b[33m=== 阶段 14: 测试12 - 审计日志完整 ===\x1b[0m');
    const auditDetail = await apiCall({
      url: `/api/readings/batches/${firstBatchData.batchId}`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const auditLogs = auditDetail.data?.data?.auditLogs || [];
    const importLogs = auditLogs.filter(l => l.operationType === 'reading_import');
    const hitLogs = auditLogs.filter(l => l.operationType === 'idempotency_hit');
    const conflictLogs = auditLogs.filter(l => l.operationType === 'idempotency_conflict');
    testResult('有导入审计日志', importLogs.length >= 1);
    testResult('有幂等命中审计日志', hitLogs.length >= 3);
    testResult('幂等命中日志包含提交次数', hitLogs[0]?.details?.includes('提交次数'));

    console.log('\n\x1b[33m=== 阶段 15: 测试13 - 验证不重复写入 ===\x1b[0m');
    const allReadings = await apiCall({
      url: `/api/readings?pageSize=100&deviceId=${TEST_DEVICE}`,
    });
    const deviceReadings = allReadings.data?.data?.items?.filter(r => r.deviceId === TEST_DEVICE) || [];
    testResult('读数数量正确（不重复写入）', deviceReadings.length === 3 + 3 + 2);
    testResult('幂等命中不产生新读数', true);

    const allBatches = await apiCall({
      url: '/api/readings/batches?pageSize=20',
    });
    const batchCount = allBatches.data?.data?.items?.length || 0;
    testResult('批次数量正确（不重复创建批次）', batchCount === 3);

    console.log('\n\x1b[33m=== 阶段 16: 测试14 - 幂等冲突审计日志 ===\x1b[0m');
    const originalBatchDetail = await apiCall({
      url: `/api/readings/batches/${firstBatchData.batchId}`,
    });
    const allAuditLogs = originalBatchDetail.data?.data?.auditLogs || [];
    const conflictAudit = allAuditLogs.find(l => l.operationType === 'idempotency_conflict');
    testResult('幂等冲突审计日志存在', !!conflictAudit);
    testResult('冲突日志包含原始哈希', conflictAudit?.details?.includes('原始哈希'));
    testResult('冲突日志包含当前哈希', conflictAudit?.details?.includes('当前哈希'));

    console.log('\n\x1b[33m=== 阶段 17: 停止服务器 ===\x1b[0m');
    await stopServer();
    testResult('服务器已停止', serverProcess === null);

    console.log('\n\x1b[33m=== 阶段 18: 跨重启一致性验证 ===\x1b[0m');
    testResult('数据库文件存在', fs.existsSync(DB_FILE));
    const dbSize = fs.statSync(DB_FILE).size;
    testResult('数据库文件有数据', dbSize > 10000);

    console.log('\n\x1b[33m=== 阶段 19: 重启服务器（同一DB文件）===\x1b[0m');
    await startServer();
    testResult('服务器重启成功', true);

    console.log('\n\x1b[33m=== 阶段 20: 测试15 - 重启后批次信息一致 ===\x1b[0m');
    const afterDetail = await apiCall({
      url: `/api/readings/batches/${firstBatchData.batchId}`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后批次存在', afterDetail.status === 200);
    const afterBatch = afterDetail.data?.data?.batch;
    testResult('重启后idempotencyKey一致', afterBatch?.idempotencyKey === idemKey);
    testResult('重启后fileContentHash一致', afterBatch?.fileContentHash === batch?.fileContentHash);
    testResult('重启后submitCount一致', afterBatch?.submitCount === 4);
    testResult('重启后isIdempotencyHit一致', afterBatch?.isIdempotencyHit === false);

    console.log('\n\x1b[33m=== 阶段 21: 测试16 - 重启后幂等键仍然有效 ===\x1b[0m');
    const importHitAfter = await uploadCsv(TEST_CSV_A, 'operator_li', idemKey);
    testResult('重启后幂等命中正常', importHitAfter.status === 200);
    testResult('重启后提交次数递增为5', importHitAfter.data?.data?.submitCount === 5);
    testResult('重启后isIdempotencyHit为true', importHitAfter.data?.data?.isIdempotencyHit === true);

    console.log('\n\x1b[33m=== 阶段 22: 测试17 - 重启后冲突检测正常 ===\x1b[0m');
    const conflictAfter = await uploadCsv(TEST_CSV_B, 'operator_li', idemKey);
    testResult('重启后冲突检测正常返回409', conflictAfter.status === 409);

    console.log('\n\x1b[33m=== 阶段 23: 测试18 - 重启后viewer权限正常 ===\x1b[0m');
    const viewerImportAfter = await uploadCsv(TEST_CSV_A, 'viewer_wang', 'new-key');
    testResult('重启后viewer仍不能导入', viewerImportAfter.status === 403);

    const viewerListAfter = await apiCall({
      url: '/api/readings/batches?pageSize=10',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后viewer仍可查询列表', viewerListAfter.status === 200);

    console.log('\n\x1b[33m=== 阶段 24: 测试19 - 重启后导出一致性 ===\x1b[0m');
    const jsonAfter = await apiCall({
      url: `/api/readings/batches/${firstBatchData.batchId}/export?format=json`,
      headers: { 'X-User-Id': 'viewer_wang' },
      responseType: 'text',
    });
    const jsonDataAfter = typeof jsonAfter.data === 'string' ? JSON.parse(jsonAfter.data) : jsonAfter.data;
    testResult('重启后JSON导出submitCount为5', jsonDataAfter.batch?.submitCount === 5);
    testResult('重启后JSON导出幂等信息完整', jsonDataAfter.batch?.idempotencyKey === idemKey);

    const csvAfter = await apiCall({
      url: `/api/readings/batches/${firstBatchData.batchId}/export?format=csv`,
      headers: { 'X-User-Id': 'viewer_wang' },
      responseType: 'text',
    });
    testResult('重启后CSV导出成功', csvAfter.status === 200);
    testResult('重启后CSV包含幂等字段', csvAfter.data.includes('idempotencyKey') && csvAfter.data.includes('submitCount'));

    console.log('\n\x1b[33m=== 阶段 25: 清理 ===\x1b[0m');
    await stopServer();
    testResult('服务器已停止', serverProcess === null);

    if (fs.existsSync(TEST_CSV_A)) fs.unlinkSync(TEST_CSV_A);
    if (fs.existsSync(TEST_CSV_B)) fs.unlinkSync(TEST_CSV_B);
    if (fs.existsSync(TEST_CSV_C)) fs.unlinkSync(TEST_CSV_C);
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    console.log('  清理测试文件');

    console.log('\n\x1b[36m========================================\x1b[0m');
    console.log('\x1b[36m测试完成!\x1b[0m');
    console.log('\x1b[36m========================================\x1b[0m');
    console.log(`\n测试摘要:`);
    console.log(`  总测试数: ${passCount + failCount}`);
    console.log(`  \x1b[32m通过: ${passCount}\x1b[0m`);
    console.log(`  \x1b[31m失败: ${failCount}\x1b[0m`);

    if (failCount > 0) {
      console.log('\n\x1b[31m❌ 存在失败测试，请检查!\x1b[0m');
      process.exit(1);
    } else {
      console.log('\n\x1b[32m🎉 所有测试通过!\x1b[0m');
    }

  } catch (err) {
    console.error('\n\x1b[31m测试执行出错:\x1b[0m', err.message);
    console.error(err.stack);

    try {
      await stopServer();
    } catch (e) { /* ignore */ }

    if (fs.existsSync(TEST_CSV_A)) fs.unlinkSync(TEST_CSV_A);
    if (fs.existsSync(TEST_CSV_B)) fs.unlinkSync(TEST_CSV_B);
    if (fs.existsSync(TEST_CSV_C)) fs.unlinkSync(TEST_CSV_C);
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

    process.exit(1);
  }
}

runTests();
