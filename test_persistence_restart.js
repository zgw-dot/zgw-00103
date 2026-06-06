const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { spawn, execSync } = require('child_process');

const BASE_URL = 'http://localhost:3002';
const TEST_CSV = 'test_persistence_mixed.csv';
const TEST_DEVICE = 'PERSIST-TEST-' + Date.now().toString().slice(-8);
const DB_FILE = path.join(__dirname, `cold_chain_persist_${Date.now()}.db`);

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
      // Server not ready yet
    }
    await new Promise(r => setTimeout(r, 500));
  }
  return false;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: '3002',
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
      if (msg.includes('Server started on port 3002')) {
        console.log('  Server started successfully');
      }
    });

    serverProcess.stderr.on('data', (data) => {
      // Ignore noise
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

async function apiCall({ method = 'get', url, headers = {}, data }) {
  try {
    const resp = await axios({
      method,
      url: BASE_URL + url,
      headers: { 'X-User-Id': 'admin', ...headers },
      data,
      responseType: url.includes('/export') ? 'text' : 'json',
    });
    return { status: resp.status, data: resp.data };
  } catch (err) {
    if (err.response) {
      return { status: err.response.status, data: err.response.data };
    }
    throw err;
  }
}

async function uploadCsv(filePath, operator = 'operator_li') {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('operator', operator);

  const resp = await axios.post(BASE_URL + '/api/readings/import', form, {
    headers: {
      ...form.getHeaders(),
      'X-User-Id': operator,
    },
  });
  return { status: resp.status, data: resp.data };
}

function createMixedCsv() {
  const lines = [
    'deviceId,temperature,readingTime',
    `${TEST_DEVICE},-18.5,2026-06-01 10:00:00`,
    `UNKNOWN-PERSIST-999,-20.0,2026-06-01 10:01:00`,
    `${TEST_DEVICE},bad-temp,2026-06-01 10:02:00`,
    `${TEST_DEVICE},-19.0,2026-06-01 10:03:00`,
    `${TEST_DEVICE},-18.0,invalid-timestamp`,
    `${TEST_DEVICE},-17.5,2026-06-01 10:05:00`,
    `, -19.5, 2026-06-01 10:06:00`,
    `${TEST_DEVICE},-18.2,2026-06-01 10:07:00`,
    `${TEST_DEVICE},-25.0,2026-06-01 10:00:00`,
    `${TEST_DEVICE},-17.8,2026-06-01 10:09:00`,
  ];
  fs.writeFileSync(TEST_CSV, lines.join('\n'));
  console.log(`  Created CSV: 10 rows (5 valid, 5 invalid)`);
}

let batchId = null;
let beforeData = null;
let beforeFailedRows = null;
let beforeSuccessRows = null;

async function runTests() {
  console.log('\x1b[36m========================================\x1b[0m');
  console.log('\x1b[36m跨真实重启持久化 - 回归测试\x1b[0m');
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
        name: '持久化测试冰柜',
        storeId: 'STORE-PERSIST',
        storeName: '持久化测试门店',
        status: 'active',
      },
    });
    testResult('设备创建成功', deviceResp.status === 200 || deviceResp.status === 201);

    await apiCall({
      method: 'post',
      url: '/api/thresholds',
      data: {
        deviceId: TEST_DEVICE,
        storeId: null,
        isDefault: false,
        minTemp: -25,
        maxTemp: -15,
      },
    });

    createMixedCsv();

    console.log('\n\x1b[33m=== 阶段 3: 导入混合CSV ===\x1b[0m');
    const importResp = await uploadCsv(TEST_CSV, 'operator_li');
    testResult('导入成功返回200', importResp.status === 200);

    const importData = importResp.data.data;
    batchId = importData.batchId;
    console.log(`  批次ID: ${batchId}`);

    testResult('批次总数正确 (10)', importData.successCount + importData.failedCount === 10);
    testResult('成功数量正确 (5)', importData.successCount === 5);
    testResult('失败数量正确 (5)', importData.failedCount === 5);

    console.log('\n\x1b[33m=== 阶段 4: 重启前数据验证 ===\x1b[0m');
    console.log('  \x1b[36m4.1 批次详情（全部状态）\x1b[0m');
    const allDetail = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=all`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    beforeData = allDetail.data.data;
    testResult('全部状态查询成功', allDetail.status === 200);
    testResult('批次元信息正确 (10/5/5)', beforeData.batch.totalCount === 10 && beforeData.batch.successCount === 5 && beforeData.batch.failedCount === 5);
    testResult('返回10条行结果', beforeData.rowResults.items.length === 10);
    testResult('操作者正确', beforeData.batch.createdBy === 'operator_li');
    testResult('文件名正确', beforeData.batch.fileName === TEST_CSV);

    console.log('  \x1b[36m4.2 成功状态筛选\x1b[0m');
    const successDetail = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=success`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    beforeSuccessRows = successDetail.data.data.rowResults.items;
    testResult('成功筛选返回5条', beforeSuccessRows.length === 5);
    testResult('成功行rowIndex正确', beforeSuccessRows.map(r => r.rowIndex).sort((a,b) => a-b).join(',') === '1,4,6,8,10');

    console.log('  \x1b[36m4.3 失败状态筛选\x1b[0m');
    const failedDetail = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    beforeFailedRows = failedDetail.data.data.rowResults.items;
    testResult('失败筛选返回5条', beforeFailedRows.length === 5);
    testResult('失败行rowIndex正确', beforeFailedRows.map(r => r.rowIndex).sort((a,b) => a-b).join(',') === '2,3,5,7,9');
    testResult('失败行均有errorMessage', beforeFailedRows.every(r => r.errorMessage));

    const unknownDeviceRow = beforeFailedRows.find(r => r.rowIndex === 2);
    testResult('未知设备行保留deviceId', unknownDeviceRow?.deviceId === 'UNKNOWN-PERSIST-999');
    testResult('未知设备行有错误信息', unknownDeviceRow?.errorMessage?.includes('不存在') || unknownDeviceRow?.errorMessage?.includes('设备'));

    const badTempRow = beforeFailedRows.find(r => r.rowIndex === 3);
    testResult('坏温度行temperature为null', badTempRow?.temperature === null || badTempRow?.temperature === undefined);
    testResult('坏温度行readingTime存在', badTempRow?.readingTime !== null && badTempRow?.readingTime !== undefined);

    console.log('  \x1b[36m4.4 分页验证\x1b[0m');
    const page1 = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&page=1&pageSize=2`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('分页第1页正确', page1.data.data.rowResults.items.map(r => r.rowIndex).join(',') === '2,3');

    const page2 = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&page=2&pageSize=2`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('分页第2页正确', page2.data.data.rowResults.items.map(r => r.rowIndex).join(',') === '5,7');

    console.log('  \x1b[36m4.5 JSON导出\x1b[0m');
    const jsonExport = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const jsonData = typeof jsonExport.data === 'string' ? JSON.parse(jsonExport.data) : jsonExport.data;
    testResult('JSON导出5条失败行', jsonData.rowResults.length === 5);
    testResult('JSON导出filters正确', jsonData.filters?.rowStatus === 'failed');
    testResult('JSON字段顺序正确', Object.keys(jsonData.rowResults[0])[0] === 'rowIndex');

    console.log('  \x1b[36m4.6 CSV导出\x1b[0m');
    const csvExport = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=csv&rowStatus=all`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('CSV导出成功', csvExport.status === 200);
    testResult('CSV包含批次信息', csvExport.data.includes('=== 批次信息 ==='));
    const csvLines = csvExport.data.replace(/\r\n/g, '\n').split('\n');
    const rowResultsIdx = csvLines.findIndex(l => l.includes('=== 逐行结果 ==='));
    const alarmsIdx = csvLines.findIndex(l => l.includes('=== 关联告警 ==='));
    const csvDataLines = csvLines.slice(rowResultsIdx + 2, alarmsIdx - 1).filter(l => l.trim() !== '');
    testResult('CSV导出10条数据行', csvDataLines.length === 10);

    console.log('  \x1b[36m4.7 告警关联\x1b[0m');
    const alarmCount = beforeData.alarms.length;
    testResult('告警关联存在', alarmCount >= 0);

    console.log('  \x1b[36m4.8 审计关联\x1b[0m');
    const auditLog = beforeData.auditLogs[0];
    testResult('审计日志存在', !!auditLog);
    testResult('审计详情包含计数', auditLog?.details?.includes('成功5条') && auditLog?.details?.includes('失败5条'));

    console.log('  \x1b[36m4.9 批次列表\x1b[0m');
    const batchList = await apiCall({
      url: '/api/readings/batches?pageSize=10',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const batchInList = batchList.data.data.items.find(b => b.id === batchId);
    testResult('批次在列表中', !!batchInList);
    testResult('列表中计数正确', batchInList?.successCount === 5 && batchInList?.failedCount === 5);

    console.log('\n\x1b[33m=== 阶段 5: 停止服务器 ===\x1b[0m');
    await stopServer();
    testResult('服务器已停止', serverProcess === null);

    console.log('\n\x1b[33m=== 阶段 6: 验证数据库文件存在 ===\x1b[0m');
    testResult('数据库文件存在', fs.existsSync(DB_FILE));
    const dbSize = fs.statSync(DB_FILE).size;
    testResult('数据库文件有数据', dbSize > 10000, dbSize, '>10000 bytes');
    console.log(`  DB file size: ${dbSize} bytes`);

    console.log('\n\x1b[33m=== 阶段 7: 重启服务器（同一DB文件）===\x1b[0m');
    await startServer();
    testResult('服务器重启成功', true);

    console.log('\n\x1b[33m=== 阶段 8: 重启后数据验证 ===\x1b[0m');
    console.log('  \x1b[36m8.1 批次存在性验证\x1b[0m');
    const afterAll = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=all`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后批次仍存在', afterAll.status === 200);

    const afterBatch = afterAll.data.data.batch;
    testResult('重启后批次ID一致', afterBatch.id === batchId);
    testResult('重启后操作者一致', afterBatch.createdBy === beforeData.batch.createdBy);
    testResult('重启后文件名一致', afterBatch.fileName === beforeData.batch.fileName);
    testResult('重启后计数一致 (10/5/5)', afterBatch.totalCount === 10 && afterBatch.successCount === 5 && afterBatch.failedCount === 5);
    testResult('重启后状态一致', afterBatch.status === beforeData.batch.status);
    testResult('重启后createdAt一致', afterBatch.createdAt === beforeData.batch.createdAt);
    testResult('重启后completedAt一致', afterBatch.completedAt === beforeData.batch.completedAt);

    console.log('  \x1b[36m8.2 逐行结果一致性\x1b[0m');
    const afterRows = afterAll.data.data.rowResults.items;
    const beforeIds = beforeData.rowResults.items.map(r => `${r.rowIndex}-${r.status}`).sort().join(',');
    const afterIds = afterRows.map(r => `${r.rowIndex}-${r.status}`).sort().join(',');
    testResult('重启后逐行结果一致', beforeIds === afterIds);
    testResult('重启后仍为10条', afterRows.length === 10);

    console.log('  \x1b[36m8.3 失败行数据完整性\x1b[0m');
    const afterFailed = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const afterFailedRows = afterFailed.data.data.rowResults.items;
    testResult('重启后失败行仍为5条', afterFailedRows.length === 5);

    const beforeErrorKeys = beforeFailedRows.map(r => `${r.rowIndex}:${r.errorMessage?.slice(0, 20)}`).sort().join('|');
    const afterErrorKeys = afterFailedRows.map(r => `${r.rowIndex}:${r.errorMessage?.slice(0, 20)}`).sort().join('|');
    testResult('重启后失败行errorMessage一致', beforeErrorKeys === afterErrorKeys);

    const afterUnknownDevice = afterFailedRows.find(r => r.rowIndex === 2);
    testResult('重启后未知设备行deviceId保留', afterUnknownDevice?.deviceId === 'UNKNOWN-PERSIST-999');

    const afterBadTemp = afterFailedRows.find(r => r.rowIndex === 3);
    testResult('重启后坏温度行readingTime保留', afterBadTemp?.readingTime !== null && afterBadTemp?.readingTime !== undefined);

    const afterBadTime = afterFailedRows.find(r => r.rowIndex === 5);
    testResult('重启后坏时间戳行temperature保留', afterBadTime?.temperature === -18);

    console.log('  \x1b[36m8.4 成功行数据完整性\x1b[0m');
    const afterSuccess = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=success`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const afterSuccessRows = afterSuccess.data.data.rowResults.items;
    testResult('重启后成功行仍为5条', afterSuccessRows.length === 5);
    testResult('重启后成功行无errorMessage', afterSuccessRows.every(r => r.errorMessage === null || r.errorMessage === undefined));

    const beforeSuccessKeys = beforeSuccessRows.map(r => `${r.rowIndex}:${r.temperature}:${r.readingTime}`).sort().join('|');
    const afterSuccessKeys = afterSuccessRows.map(r => `${r.rowIndex}:${r.temperature}:${r.readingTime}`).sort().join('|');
    testResult('重启后成功行数据一致', beforeSuccessKeys === afterSuccessKeys);

    console.log('  \x1b[36m8.5 分页稳定性（重启后）\x1b[0m');
    const afterPage1 = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&page=1&pageSize=2`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后分页第1页正确', afterPage1.data.data.rowResults.items.map(r => r.rowIndex).join(',') === '2,3');

    const afterPage2 = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&page=2&pageSize=2`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后分页第2页正确', afterPage2.data.data.rowResults.items.map(r => r.rowIndex).join(',') === '5,7');

    const afterPage3 = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&page=3&pageSize=2`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后分页第3页正确', afterPage3.data.data.rowResults.items[0].rowIndex === 9);

    console.log('  \x1b[36m8.6 JSON导出一致性（重启后）\x1b[0m');
    const afterJson = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const afterJsonData = typeof afterJson.data === 'string' ? JSON.parse(afterJson.data) : afterJson.data;
    testResult('重启后JSON导出5条', afterJsonData.rowResults.length === 5);
    testResult('重启后JSON字段顺序一致', Object.keys(afterJsonData.rowResults[0])[0] === 'rowIndex');

    const beforeJsonKeys = jsonData.rowResults.map(r => `${r.rowIndex}:${r.deviceId}`).sort().join('|');
    const afterJsonKeys = afterJsonData.rowResults.map(r => `${r.rowIndex}:${r.deviceId}`).sort().join('|');
    testResult('重启后JSON导出数据一致', beforeJsonKeys === afterJsonKeys);

    console.log('  \x1b[36m8.7 CSV导出一致性（重启后）\x1b[0m');
    const afterCsv = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=csv&rowStatus=all`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const afterCsvLines = afterCsv.data.replace(/\r\n/g, '\n').split('\n');
    const afterRowResultsIdx = afterCsvLines.findIndex(l => l.includes('=== 逐行结果 ==='));
    const afterAlarmsIdx = afterCsvLines.findIndex(l => l.includes('=== 关联告警 ==='));
    const afterCsvDataLines = afterCsvLines.slice(afterRowResultsIdx + 2, afterAlarmsIdx - 1).filter(l => l.trim() !== '');
    testResult('重启后CSV导出10条', afterCsvDataLines.length === 10);

    const beforeCsvKeys = csvDataLines.map(l => l.split(',')[0]).sort().join(',');
    const afterCsvKeys = afterCsvDataLines.map(l => l.split(',')[0]).sort().join(',');
    testResult('重启后CSV导出数据一致', beforeCsvKeys === afterCsvKeys);

    console.log('  \x1b[36m8.8 告警关联一致性（重启后）\x1b[0m');
    testResult('重启后告警数量一致', afterAll.data.data.alarms.length === alarmCount);

    console.log('  \x1b[36m8.9 审计关联一致性（重启后）\x1b[0m');
    testResult('重启后审计日志数量一致', afterAll.data.data.auditLogs.length === beforeData.auditLogs.length);
    const afterAudit = afterAll.data.data.auditLogs[0];
    testResult('重启后审计详情一致', afterAudit?.details === auditLog?.details);
    testResult('重启后审计操作者一致', afterAudit?.operator === auditLog?.operator);

    console.log('  \x1b[36m8.10 批次列表一致性（重启后）\x1b[0m');
    const afterList = await apiCall({
      url: '/api/readings/batches?pageSize=10',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const afterBatchInList = afterList.data.data.items.find(b => b.id === batchId);
    testResult('重启后批次仍在列表中', !!afterBatchInList);
    testResult('重启后列表计数一致', afterBatchInList?.successCount === 5 && afterBatchInList?.failedCount === 5);

    console.log('  \x1b[36m8.11 所有行查询一致性（重启后）\x1b[0m');
    const allReadings = await apiCall({
      url: '/api/readings?pageSize=20',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const deviceReadings = allReadings.data.data.items.filter(r => r.deviceId === TEST_DEVICE);
    testResult('重启后读数仍可查询', deviceReadings.length === 5);

    console.log('\n\x1b[33m=== 阶段 9: 清理 ===\x1b[0m');
    await stopServer();
    testResult('服务器已停止', serverProcess === null);

    if (fs.existsSync(TEST_CSV)) {
      fs.unlinkSync(TEST_CSV);
      console.log('  清理测试CSV文件');
    }

    if (fs.existsSync(DB_FILE)) {
      fs.unlinkSync(DB_FILE);
      console.log('  清理测试数据库文件');
    }

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

    if (fs.existsSync(TEST_CSV)) fs.unlinkSync(TEST_CSV);
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

    process.exit(1);
  }
}

runTests();
