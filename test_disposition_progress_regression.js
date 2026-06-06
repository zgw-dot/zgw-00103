const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { spawn } = require('child_process');

const BASE_URL = 'http://localhost:3006';
const TEST_CSV = 'test_disposition_mixed.csv';
const TEST_DEVICE = 'DISPO-TEST-' + Date.now().toString().slice(-8);
const DB_FILE = path.join(__dirname, `cold_chain_disposition_${Date.now()}.db`);

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
  return passed;
}

async function waitForServer(timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const resp = await axios.get(BASE_URL + '/health', { timeout: 2000 });
      if (resp.status === 200 && resp.data?.data?.status === 'ok') {
        await new Promise(r => setTimeout(r, 1000));
        return true;
      }
    } catch (e) {
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  return false;
}

function startServer() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      PORT: '3006',
      DB_PATH: DB_FILE,
    };

    const isWindows = process.platform === 'win32';
    const nodeCmd = isWindows ? 'node.exe' : 'node';

    console.log(`  Starting server with DB: ${DB_FILE}`);
    serverProcess = spawn(nodeCmd, ['dist/app.js'], {
      env,
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: isWindows,
    });

    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Server started on port 3006')) {
        console.log('  Server started successfully');
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Error') || msg.includes('error')) {
        console.error('  Server error:', msg);
      }
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
      const isWindows = process.platform === 'win32';
      if (isWindows) {
        try {
          const { exec } = require('child_process');
          exec(`taskkill /PID ${serverProcess.pid} /T /F`, () => {
            serverProcess = null;
            console.log('  Server stopped');
            resolve();
          });
        } catch (e) {
          serverProcess.kill();
          serverProcess = null;
          console.log('  Server stopped');
          resolve();
        }
      } else {
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
      }
    } else {
      resolve();
    }
  });
}

async function apiCall({ method = 'get', url, headers = {}, data }, maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await axios({
        method,
        url: BASE_URL + url,
        headers: { 'X-User-Id': 'admin', ...headers },
        data,
        responseType: url.includes('/export') ? 'text' : 'json',
        timeout: 10000,
      });
      return { status: resp.status, data: resp.data, headers: resp.headers };
    } catch (err) {
      if (err.response) {
        return {
          status: err.response.status,
          data: err.response.data,
          headers: err.response.headers,
        };
      }
      lastError = err;
      if (i < maxRetries - 1) {
        console.log(`  Retrying ${url} (attempt ${i + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw lastError;
}

async function uploadCsv(filePath, operator = 'operator_li', maxRetries = 3) {
  let lastError;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const form = new FormData();
      form.append('file', fs.createReadStream(filePath));
      form.append('operator', operator);

      const resp = await axios.post(BASE_URL + '/api/readings/import', form, {
        headers: {
          ...form.getHeaders(),
          'X-User-Id': operator,
        },
        timeout: 15000,
      });
      return { status: resp.status, data: resp.data };
    } catch (err) {
      if (err.response) {
        return {
          status: err.response.status,
          data: err.response.data,
        };
      }
      lastError = err;
      if (i < maxRetries - 1) {
        console.log(`  Retrying upload (attempt ${i + 1}/${maxRetries})...`);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
  throw lastError;
}

function createMixedCsv() {
  const lines = [
    'deviceId,temperature,readingTime',
    `${TEST_DEVICE},-18.5,2026-06-01 10:00:00`,
    `UNKNOWN-DISPO-001,-20.0,2026-06-01 10:01:00`,
    `${TEST_DEVICE},bad-temp,2026-06-01 10:02:00`,
    `${TEST_DEVICE},-19.0,2026-06-01 10:03:00`,
    `${TEST_DEVICE},-18.0,invalid-timestamp`,
    `${TEST_DEVICE},-17.5,2026-06-01 10:05:00`,
    `UNKNOWN-DISPO-002, -19.5, 2026-06-01 10:06:00`,
    `${TEST_DEVICE},-18.2,2026-06-01 10:07:00`,
    `${TEST_DEVICE},not-a-number,2026-06-01 10:08:00`,
    `${TEST_DEVICE},-17.8,2026-06-01 10:09:00`,
  ];
  fs.writeFileSync(TEST_CSV, lines.join('\n'));
  console.log(`  Created CSV: 10 rows (5 valid, 5 invalid)`);
}

let batchId = null;
let failedRowIndexes = [];
let remarkTimestamps = {};

async function runTests() {
  console.log('\x1b[36m========================================\x1b[0m');
  console.log('\x1b[36m失败行处置进度 - 全面回归测试\x1b[0m');
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
        name: '处置进度测试冰柜',
        storeId: 'STORE-DISPO',
        storeName: '处置进度测试门店',
        status: 'active',
      },
    });
    testResult('设备创建成功', deviceResp.status === 200 || deviceResp.status === 201);

    const thresholdResp = await apiCall({
      method: 'put',
      url: `/api/thresholds/device/${TEST_DEVICE}`,
      data: { minTemp: -25, maxTemp: -15 },
    });
    testResult('设置设备阈值', thresholdResp.status === 200);

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

    const failedDetail = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    failedRowIndexes = failedDetail.data.data.rowResults.items.map(r => r.rowIndex).sort((a, b) => a - b);
    console.log(`  失败行号: ${failedRowIndexes.join(', ')}`);

    console.log('\n\x1b[33m=== 阶段 4: 为失败行添加备注（不同处理人） ===\x1b[0m');
    
    const beforeAdd = Date.now();
    
    const remark1Resp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[0]}/remark`,
      headers: { 'X-User-Id': 'manager_zhang' },
      data: { remarkContent: '设备不存在，已通知门店补充台账' },
    });
    testResult('manager_zhang 添加备注成功', remark1Resp.status === 200);
    remarkTimestamps[failedRowIndexes[0]] = Date.now();

    await new Promise(r => setTimeout(r, 100));

    const remark2Resp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[1]}/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '温度格式错误，已反馈采集人员' },
    });
    testResult('admin 添加备注成功', remark2Resp.status === 200);
    remarkTimestamps[failedRowIndexes[1]] = Date.now();

    await new Promise(r => setTimeout(r, 100));

    const remark3Resp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[2]}/remark`,
      headers: { 'X-User-Id': 'manager_zhang' },
      data: { remarkContent: '时间戳格式错误，已重新生成数据' },
    });
    testResult('manager_zhang 添加第二条备注成功', remark3Resp.status === 200);
    remarkTimestamps[failedRowIndexes[2]] = Date.now();

    const afterAdd = Date.now();
    console.log(`  已添加 3 条备注，2 条未备注`);

    console.log('\n\x1b[33m=== 阶段 5: 批次列表处置统计 ===\x1b[0m');
    
    console.log('  \x1b[36m5.1 无筛选条件的批次列表统计\x1b[0m');
    const batchListResp = await apiCall({
      url: '/api/readings/batches?pageSize=10',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('批次列表查询成功', batchListResp.status === 200);
    testResult('包含 summary 汇总统计', !!batchListResp.data?.data?.summary);
    testResult('包含 appliedFilters', 'appliedFilters' in batchListResp.data?.data);

    const summary = batchListResp.data.data.summary;
    testResult('summary.totalBatches >= 1', summary.totalBatches >= 1);
    testResult('summary.totalFailedRows = 5', summary.totalFailedRows === 5);
    testResult('summary.totalRemarkedRows = 3', summary.totalRemarkedRows === 3);
    testResult('summary.totalUnremarkedRows = 2', summary.totalUnremarkedRows === 2);
    testResult('summary.overallProgress = 60', summary.overallProgress === 60);

    const batchInList = batchListResp.data.data.items.find(b => b.id === batchId);
    testResult('批次包含 dispositionStats', !!batchInList?.dispositionStats);
    
    const batchStats = batchInList.dispositionStats;
    testResult('dispositionStats.totalFailedRows = 5', batchStats.totalFailedRows === 5);
    testResult('dispositionStats.remarkedRows = 3', batchStats.remarkedRows === 3);
    testResult('dispositionStats.unremarkedRows = 2', batchStats.unremarkedRows === 2);
    testResult('dispositionStats.remarkProgress = 60', batchStats.remarkProgress === 60);
    testResult('dispositionStats.byHandler 包含 manager_zhang', 
      batchStats.byHandler.some(h => h.handledBy === 'manager_zhang' && h.count === 2));
    testResult('dispositionStats.byHandler 包含 admin', 
      batchStats.byHandler.some(h => h.handledBy === 'admin' && h.count === 1));

    console.log('  \x1b[36m5.2 按备注状态筛选批次列表 (remarked)\x1b[0m');
    const listRemarkedResp = await apiCall({
      url: '/api/readings/batches?pageSize=10&remarkStatus=remarked',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('筛选已备注批次成功', listRemarkedResp.status === 200);
    
    const remarkedBatch = listRemarkedResp.data.data.items.find(b => b.id === batchId);
    testResult('筛选后批次 dispositionStats.remarkedRows = 3', 
      remarkedBatch?.dispositionStats?.remarkedRows === 3);
    testResult('筛选后 summary 仅统计已备注', 
      listRemarkedResp.data.data.summary.totalRemarkedRows === 3);
    testResult('appliedFilters.remarkStatus = "remarked"', 
      listRemarkedResp.data.data.appliedFilters.remarkStatus === 'remarked');

    console.log('  \x1b[36m5.3 按备注状态筛选批次列表 (unremarked)\x1b[0m');
    const listUnremarkedResp = await apiCall({
      url: '/api/readings/batches?pageSize=10&remarkStatus=unremarked',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('筛选未备注批次成功', listUnremarkedResp.status === 200);
    
    const unremarkedBatch = listUnremarkedResp.data.data.items.find(b => b.id === batchId);
    testResult('筛选后批次 dispositionStats.unremarkedRows = 2', 
      unremarkedBatch?.dispositionStats?.unremarkedRows === 2);
    testResult('筛选后 summary 仅统计未备注', 
      listUnremarkedResp.data.data.summary.totalUnremarkedRows === 2);

    console.log('  \x1b[36m5.4 按处理人筛选批次列表 (manager_zhang)\x1b[0m');
    const listByHandlerResp = await apiCall({
      url: '/api/readings/batches?pageSize=10&handledBy=manager_zhang',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('按处理人筛选成功', listByHandlerResp.status === 200);
    
    const handlerBatch = listByHandlerResp.data.data.items.find(b => b.id === batchId);
    testResult('筛选后 byHandler 仅显示 manager_zhang', 
      handlerBatch?.dispositionStats?.byHandler?.length === 1 &&
      handlerBatch?.dispositionStats?.byHandler[0]?.handledBy === 'manager_zhang' &&
      handlerBatch?.dispositionStats?.byHandler[0]?.count === 2);
    testResult('筛选后 remarkedRows = 2', 
      handlerBatch?.dispositionStats?.remarkedRows === 2);

    console.log('  \x1b[36m5.5 按时间范围筛选批次列表\x1b[0m');
    const listByTimeResp = await apiCall({
      url: `/api/readings/batches?pageSize=10&remarkStartTime=${beforeAdd}&remarkEndTime=${afterAdd}`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('按时间范围筛选成功', listByTimeResp.status === 200);
    testResult('时间筛选后 remarkedRows = 3', 
      listByTimeResp.data.data.items.find(b => b.id === batchId)?.dispositionStats?.remarkedRows === 3);

    console.log('\n\x1b[33m=== 阶段 6: 批次详情筛选与分页 ===\x1b[0m');
    
    console.log('  \x1b[36m6.1 无筛选详情 (所有失败行)\x1b[0m');
    const detailAllResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('详情查询成功', detailAllResp.status === 200);
    testResult('包含 dispositionStats', !!detailAllResp.data?.data?.dispositionStats);
    testResult('包含 appliedFilters', 'appliedFilters' in detailAllResp.data?.data);
    testResult('返回 5 条失败行', detailAllResp.data.data.rowResults.items.length === 5);

    const detailStats = detailAllResp.data.data.dispositionStats;
    testResult('详情 dispositionStats 正确', 
      detailStats.totalFailedRows === 5 && 
      detailStats.remarkedRows === 3 && 
      detailStats.unremarkedRows === 2);

    console.log('  \x1b[36m6.2 筛选已备注行\x1b[0m');
    const detailRemarkedResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=remarked&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('筛选已备注行成功', detailRemarkedResp.status === 200);
    testResult('返回 3 条已备注行', detailRemarkedResp.data.data.rowResults.items.length === 3);
    testResult('所有行都有备注', 
      detailRemarkedResp.data.data.rowResults.items.every(r => r.remark !== null));
    testResult('筛选后 dispositionStats.remarkedRows = 3', 
      detailRemarkedResp.data.data.dispositionStats.remarkedRows === 3);
    testResult('筛选后 dispositionStats.unremarkedRows = 0', 
      detailRemarkedResp.data.data.dispositionStats.unremarkedRows === 0);

    console.log('  \x1b[36m6.3 筛选未备注行\x1b[0m');
    const detailUnremarkedResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=unremarked&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('筛选未备注行成功', detailUnremarkedResp.status === 200);
    testResult('返回 2 条未备注行', detailUnremarkedResp.data.data.rowResults.items.length === 2);
    testResult('所有行都无备注', 
      detailUnremarkedResp.data.data.rowResults.items.every(r => r.remark === null));
    testResult('筛选后 dispositionStats.remarkedRows = 0', 
      detailUnremarkedResp.data.data.dispositionStats.remarkedRows === 0);
    testResult('筛选后 dispositionStats.unremarkedRows = 2', 
      detailUnremarkedResp.data.data.dispositionStats.unremarkedRows === 2);

    console.log('  \x1b[36m6.4 按处理人筛选 (manager_zhang)\x1b[0m');
    const detailByHandlerResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&handledBy=manager_zhang&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('按处理人筛选成功', detailByHandlerResp.status === 200);
    testResult('返回 2 条 manager_zhang 的备注', 
      detailByHandlerResp.data.data.rowResults.items.length === 2);
    testResult('所有备注操作人均为 manager_zhang', 
      detailByHandlerResp.data.data.rowResults.items.every(r => r.remark?.handledBy === 'manager_zhang'));

    console.log('  \x1b[36m6.5 按处理人筛选 (admin)\x1b[0m');
    const detailByAdminResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&handledBy=admin&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('按 admin 筛选成功', detailByAdminResp.status === 200);
    testResult('返回 1 条 admin 的备注', 
      detailByAdminResp.data.data.rowResults.items.length === 1);

    console.log('  \x1b[36m6.6 按时间范围筛选\x1b[0m');
    const detailByTimeResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStartTime=${beforeAdd}&remarkEndTime=${afterAdd}&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('按时间范围筛选成功', detailByTimeResp.status === 200);
    testResult('时间筛选后返回 3 条', 
      detailByTimeResp.data.data.rowResults.items.length === 3);

    console.log('  \x1b[36m6.7 组合筛选: remarked + handledBy\x1b[0m');
    const detailCombinedResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=remarked&handledBy=manager_zhang&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('组合筛选成功', detailCombinedResp.status === 200);
    testResult('组合筛选返回 2 条', 
      detailCombinedResp.data.data.rowResults.items.length === 2);
    testResult('appliedFilters 包含两个筛选条件', 
      detailCombinedResp.data.data.appliedFilters.remarkStatus === 'remarked' &&
      detailCombinedResp.data.data.appliedFilters.handledBy === 'manager_zhang');

    console.log('  \x1b[36m6.8 筛选结果分页验证\x1b[0m');
    const page1Resp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=remarked&page=1&pageSize=2`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('筛选分页第1页正确', page1Resp.data.data.rowResults.items.length === 2);
    testResult('分页 total = 3', page1Resp.data.data.rowResults.total === 3);

    const page2Resp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=remarked&page=2&pageSize=2`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('筛选分页第2页正确', page2Resp.data.data.rowResults.items.length === 1);

    console.log('\n\x1b[33m=== 阶段 7: 导出字段与筛选一致性 ===\x1b[0m');
    
    console.log('  \x1b[36m7.1 JSON导出 - 无筛选\x1b[0m');
    const jsonAllResp = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('JSON导出成功', jsonAllResp.status === 200);
    
    const jsonAllData = typeof jsonAllResp.data === 'string' 
      ? JSON.parse(jsonAllResp.data) 
      : jsonAllResp.data;
    testResult('JSON导出包含 dispositionStats', !!jsonAllData.dispositionStats);
    testResult('JSON导出包含 filters 字段', !!jsonAllData.filters);
    testResult('JSON导出 5 条失败行', jsonAllData.rowResults.length === 5);

    console.log('  \x1b[36m7.2 JSON导出 - 筛选已备注\x1b[0m');
    const jsonRemarkedResp = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed&remarkStatus=remarked`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('JSON导出已备注成功', jsonRemarkedResp.status === 200);
    
    const jsonRemarkedData = typeof jsonRemarkedResp.data === 'string'
      ? JSON.parse(jsonRemarkedResp.data)
      : jsonRemarkedResp.data;
    testResult('JSON筛选导出仅 3 条', jsonRemarkedData.rowResults.length === 3);
    testResult('JSON导出 filters.remarkStatus = "remarked"', 
      jsonRemarkedData.filters.remarkStatus === 'remarked');
    testResult('JSON导出 dispositionStats 与筛选一致', 
      jsonRemarkedData.dispositionStats.remarkedRows === 3);

    console.log('  \x1b[36m7.3 JSON导出 - 按处理人筛选\x1b[0m');
    const jsonByHandlerResp = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed&handledBy=manager_zhang`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const jsonByHandlerData = typeof jsonByHandlerResp.data === 'string'
      ? JSON.parse(jsonByHandlerResp.data)
      : jsonByHandlerResp.data;
    testResult('JSON按处理人筛选导出 2 条', jsonByHandlerData.rowResults.length === 2);
    testResult('所有行操作人为 manager_zhang', 
      jsonByHandlerData.rowResults.every(r => r.remark?.handledBy === 'manager_zhang'));

    console.log('  \x1b[36m7.4 CSV导出 - 无筛选\x1b[0m');
    const csvAllResp = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=csv&rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('CSV导出成功', csvAllResp.status === 200);
    testResult('CSV包含处置统计', csvAllResp.data.includes('dispositionStats'));
    testResult('CSV包含应用筛选条件章节', csvAllResp.data.includes('应用筛选条件'));

    console.log('  \x1b[36m7.5 CSV导出 - 筛选未备注\x1b[0m');
    const csvUnremarkedResp = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=csv&rowStatus=failed&remarkStatus=unremarked`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('CSV导出未备注成功', csvUnremarkedResp.status === 200);
    testResult('CSV筛选条件显示 remarkStatus=unremarked', 
      csvUnremarkedResp.data.includes('remarkStatus: unremarked'));
    
    const csvLines = csvUnremarkedResp.data.replace(/\r\n/g, '\n').split('\n');
    const rowResultsIdx = csvLines.findIndex(l => l.includes('=== 逐行结果 ==='));
    const csvDataLines = csvLines.slice(rowResultsIdx + 2).filter(l => l.trim() !== '' && !l.startsWith('==='));
    testResult('CSV筛选后仅 2 条数据行', csvDataLines.length === 2);

    console.log('  \x1b[36m7.6 导出与查询结果一致性验证\x1b[0m');
    const queryResult = detailRemarkedResp.data.data.rowResults.items.map(r => r.rowIndex).sort();
    const exportResult = jsonRemarkedData.rowResults.map(r => r.rowIndex).sort();
    testResult('导出与查询结果 rowIndex 完全一致', 
      queryResult.join(',') === exportResult.join(','));

    console.log('\n\x1b[33m=== 阶段 8: 权限边界验证 ===\x1b[0m');
    
    console.log('  \x1b[36m8.1 viewer 可查看筛选结果\x1b[0m');
    const viewerFilterResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=unremarked`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('viewer 查看筛选结果成功', viewerFilterResp.status === 200);

    console.log('  \x1b[36m8.2 viewer 可导出筛选结果\x1b[0m');
    const viewerExportResp = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed&remarkStatus=unremarked`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('viewer 导出成功', viewerExportResp.status === 200);

    console.log('  \x1b[36m8.3 operator 可查看筛选结果\x1b[0m');
    const operatorFilterResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=unremarked`,
      headers: { 'X-User-Id': 'operator_li' },
    });
    testResult('operator 查看筛选结果成功', operatorFilterResp.status === 200);

    console.log('  \x1b[36m8.4 operator 写备注返回 403\x1b[0m');
    const operatorRemarkResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[3]}/remark`,
      headers: { 'X-User-Id': 'operator_li' },
      data: { remarkContent: 'operator 尝试写备注' },
    });
    testResult('operator 写备注返回 403', operatorRemarkResp.status === 403);

    console.log('  \x1b[36m8.5 viewer 写备注返回 403\x1b[0m');
    const viewerRemarkResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[3]}/remark`,
      headers: { 'X-User-Id': 'viewer_wang' },
      data: { remarkContent: 'viewer 尝试写备注' },
    });
    testResult('viewer 写备注返回 403', viewerRemarkResp.status === 403);

    console.log('  \x1b[36m8.6 manager 可写备注\x1b[0m');
    const managerRemarkResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[3]}/remark`,
      headers: { 'X-User-Id': 'manager_zhang' },
      data: { remarkContent: 'manager 处理备注' },
    });
    testResult('manager 写备注成功', managerRemarkResp.status === 200);

    console.log('  \x1b[36m8.7 admin 可写备注\x1b[0m');
    const adminRemarkResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[4]}/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: 'admin 处理备注' },
    });
    testResult('admin 写备注成功', adminRemarkResp.status === 200);

    console.log('\n\x1b[33m=== 阶段 9: 参数校验验证 ===\x1b[0m');
    
    console.log('  \x1b[36m9.1 无效 remarkStatus 值\x1b[0m');
    const invalidStatusResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=invalid`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('无效 remarkStatus 返回 400', invalidStatusResp.status === 400);

    console.log('  \x1b[36m9.2 未知处理人\x1b[0m');
    const invalidHandlerResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&handledBy=unknown_user`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('未知处理人返回 400', invalidHandlerResp.status === 400);
    testResult('错误信息包含处理人校验提示', 
      invalidHandlerResp.data?.message?.includes('处理人') || 
      invalidHandlerResp.data?.error?.includes('处理人'));

    console.log('  \x1b[36m9.3 非法时间戳 (太小)\x1b[0m');
    const invalidTimeResp1 = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStartTime=123`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('非法小时间戳返回 400', invalidTimeResp1.status === 400);

    console.log('  \x1b[36m9.4 非法时间戳 (太大)\x1b[0m');
    const invalidTimeResp2 = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStartTime=9999999999999`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('非法大时间戳返回 400', invalidTimeResp2.status === 400);

    console.log('  \x1b[36m9.5 开始时间大于结束时间\x1b[0m');
    const invalidRangeResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStartTime=${Date.now() + 100000}&remarkEndTime=${Date.now()}`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('时间范围错误返回 400', invalidRangeResp.status === 400);
    testResult('错误信息提示开始时间不能大于结束时间', 
      invalidRangeResp.data?.message?.includes('不能大于') ||
      invalidRangeResp.data?.error?.includes('不能大于'));

    console.log('  \x1b[36m9.6 冲突条件: unremarked + handledBy\x1b[0m');
    const conflictResp1 = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=unremarked&handledBy=admin`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('冲突条件返回 400', conflictResp1.status === 400);
    testResult('错误信息提示不能同时指定', 
      conflictResp1.data?.message?.includes('不能同时') ||
      conflictResp1.data?.error?.includes('不能同时'));

    console.log('  \x1b[36m9.7 冲突条件: unremarked + 时间范围\x1b[0m');
    const conflictResp2 = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=unremarked&remarkStartTime=${Date.now()}`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('unremarked + 时间返回 400', conflictResp2.status === 400);

    console.log('  \x1b[36m9.8 批次列表同样的参数校验\x1b[0m');
    const listInvalidResp = await apiCall({
      url: `/api/readings/batches?remarkStatus=unremarked&handledBy=admin`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('批次列表冲突条件返回 400', listInvalidResp.status === 400);

    console.log('\n\x1b[33m=== 阶段 10: 备注修改/清空后统计同步 ===\x1b[0m');
    
    console.log('  \x1b[36m10.1 当前统计: 5/5 已备注\x1b[0m');
    const statsBefore = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&pageSize=1`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('修改前 remarkedRows = 5', 
      statsBefore.data.data.dispositionStats.remarkedRows === 5);
    testResult('修改前 unremarkedRows = 0', 
      statsBefore.data.data.dispositionStats.unremarkedRows === 0);
    testResult('修改前 progress = 100', 
      statsBefore.data.data.dispositionStats.remarkProgress === 100);

    console.log('  \x1b[36m10.2 修改一条备注内容（不改变数量）\x1b[0m');
    const updateResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[0]}/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '修改后的备注内容' },
    });
    testResult('修改备注成功', updateResp.status === 200);

    const statsAfterUpdate = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&pageSize=1`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('修改后 remarkedRows 仍为 5', 
      statsAfterUpdate.data.data.dispositionStats.remarkedRows === 5);
    testResult('byHandler 中 admin 计数增加为 2', 
      statsAfterUpdate.data.data.dispositionStats.byHandler.some(
        h => h.handledBy === 'admin' && h.count === 2
      ));
    testResult('byHandler 中 manager_zhang 计数减少为 2', 
      statsAfterUpdate.data.data.dispositionStats.byHandler.some(
        h => h.handledBy === 'manager_zhang' && h.count === 2
      ));

    console.log('  \x1b[36m10.3 清空一条备注（数量减少）\x1b[0m');
    const clearResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[0]}/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '' },
    });
    testResult('清空备注成功', clearResp.status === 200);

    const statsAfterClear = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&pageSize=1`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('清空后 remarkedRows = 4', 
      statsAfterClear.data.data.dispositionStats.remarkedRows === 4);
    testResult('清空后 unremarkedRows = 1', 
      statsAfterClear.data.data.dispositionStats.unremarkedRows === 1);
    testResult('清空后 progress = 80', 
      statsAfterClear.data.data.dispositionStats.remarkProgress === 80);

    console.log('  \x1b[36m10.4 批次列表统计同步更新\x1b[0m');
    const listAfterClear = await apiCall({
      url: '/api/readings/batches?pageSize=10',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const batchAfterClear = listAfterClear.data.data.items.find(b => b.id === batchId);
    testResult('列表统计同步: remarkedRows = 4', 
      batchAfterClear?.dispositionStats?.remarkedRows === 4);
    testResult('列表 summary 同步更新', 
      listAfterClear.data.data.summary.totalRemarkedRows === 4);
    testResult('列表 summary overallProgress = 80', 
      listAfterClear.data.data.summary.overallProgress === 80);

    console.log('  \x1b[36m10.5 筛选 unremarked 现在能查到 1 条\x1b[0m');
    const unremarkedAfterClear = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=unremarked&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('清空后筛选未备注返回 1 条', 
      unremarkedAfterClear.data.data.rowResults.items.length === 1);

    console.log('\n\x1b[33m=== 阶段 11: 停止服务器准备重启测试 ===\x1b[0m');
    await stopServer();
    testResult('服务器已停止', serverProcess === null);

    console.log('\n\x1b[33m=== 阶段 12: 同一 DB_PATH 重启后筛选仍生效 ===\x1b[0m');
    testResult('数据库文件存在', fs.existsSync(DB_FILE));

    await startServer();
    testResult('服务器重启成功', true);

    console.log('  \x1b[36m12.1 重启后批次列表统计仍正确\x1b[0m');
    const listAfterRestart = await apiCall({
      url: '/api/readings/batches?pageSize=10',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const batchAfterRestart = listAfterRestart.data.data.items.find(b => b.id === batchId);
    testResult('重启后 dispositionStats.remarkedRows = 4', 
      batchAfterRestart?.dispositionStats?.remarkedRows === 4);
    testResult('重启后 dispositionStats.unremarkedRows = 1', 
      batchAfterRestart?.dispositionStats?.unremarkedRows === 1);
    testResult('重启后 summary 正确', 
      listAfterRestart.data.data.summary.overallProgress === 80);

    console.log('  \x1b[36m12.2 重启后筛选已备注仍正确\x1b[0m');
    const remarkedAfterRestart = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=remarked&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后筛选已备注返回 4 条', 
      remarkedAfterRestart.data.data.rowResults.items.length === 4);

    console.log('  \x1b[36m12.3 重启后筛选未备注仍正确\x1b[0m');
    const unremarkedAfterRestart = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=unremarked&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后筛选未备注返回 1 条', 
      unremarkedAfterRestart.data.data.rowResults.items.length === 1);

    console.log('  \x1b[36m12.4 重启后按处理人筛选仍正确\x1b[0m');
    const handlerAfterRestart = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&handledBy=admin&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后按 admin 筛选返回 2 条', 
      handlerAfterRestart.data.data.rowResults.items.length === 2);

    console.log('  \x1b[36m12.5 重启后时间范围筛选仍正确\x1b[0m');
    const timeAfterRestart = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStartTime=${beforeAdd}&remarkEndTime=${afterAdd}&pageSize=10`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后时间筛选返回 3 条（最初添加的3条）', 
      timeAfterRestart.data.data.rowResults.items.length === 3);

    console.log('  \x1b[36m12.6 重启后导出与筛选一致\x1b[0m');
    const exportAfterRestart = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed&remarkStatus=remarked`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const exportData = typeof exportAfterRestart.data === 'string'
      ? JSON.parse(exportAfterRestart.data)
      : exportAfterRestart.data;
    testResult('重启后导出 4 条已备注', exportData.rowResults.length === 4);
    testResult('重启后导出 filters 正确', exportData.filters.remarkStatus === 'remarked');

    console.log('  \x1b[36m12.7 重启后参数校验仍生效\x1b[0m');
    const validateAfterRestart = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed&remarkStatus=unremarked&handledBy=admin`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后冲突条件仍返回 400', validateAfterRestart.status === 400);

    console.log('  \x1b[36m12.8 重启后权限仍生效\x1b[0m');
    const permissionAfterRestart = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[0]}/remark`,
      headers: { 'X-User-Id': 'operator_li' },
      data: { remarkContent: '重启后 operator 尝试' },
    });
    testResult('重启后 operator 仍返回 403', permissionAfterRestart.status === 403);

    console.log('\n\x1b[33m=== 阶段 13: 清理 ===\x1b[0m');
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
    } catch (e) { }

    if (fs.existsSync(TEST_CSV)) fs.unlinkSync(TEST_CSV);
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

    process.exit(1);
  }
}

runTests();
