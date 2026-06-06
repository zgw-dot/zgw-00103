const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const FormData = require('form-data');

const BASE_URL = 'http://localhost:3004/api/readings';
const PORT = 3004;
const DB_PATH = path.join(__dirname, `cold_chain_routing_fix_${Date.now()}.db`);
const TEST_CSV = path.join(__dirname, 'test_routing_fix.csv');

let serverProcess = null;
let testBatchId = null;
let failedRowIndices = [];
let passCount = 0;
let failCount = 0;

function testResult(name, pass, actual, expected) {
  if (pass) {
    passCount++;
    console.log(`  \x1b[32m[PASS]\x1b[0m ${name}`);
  } else {
    failCount++;
    const actualStr = actual !== undefined ? ` (实际: ${JSON.stringify(actual)})` : '';
    const expectedStr = expected !== undefined ? ` (期望: ${JSON.stringify(expected)})` : '';
    console.log(`  \x1b[31m[FAIL]\x1b[0m ${name}${actualStr}${expectedStr}`);
  }
}

function startServer(dbPath) {
  return new Promise((resolve, reject) => {
    console.log(`  Starting server with DB: ${dbPath}`);
    
    const env = { ...process.env, PORT, DB_PATH: dbPath };
    serverProcess = spawn('node', ['dist/app.js'], {
      env,
      shell: true,
    });

    let started = false;
    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes(`Server started on port ${PORT}`) && !started) {
        console.log('  Server started successfully');
        started = true;
        setTimeout(() => resolve(), 1000);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error(`  Server stderr: ${data}`);
    });

    serverProcess.on('error', (err) => {
      console.error(`  Server error: ${err}`);
      if (!started) reject(err);
    });

    setTimeout(() => {
      if (!started) reject(new Error('Server startup timeout'));
    }, 60000);
  });
}

async function stopServer() {
  if (serverProcess) {
    console.log('  Stopping server...');
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch (e) {}
    serverProcess = null;
    console.log('  Server stopped');
  }
}

function createMixedCsv() {
  const rows = [
    'deviceId,temperature,readingTime',
    'DEV001,-20,2026-06-01 10:00:00',
    'DEV001,INVALID,2026-06-01 10:01:00',
    'DEV002,-18,2026-06-01 10:02:00',
    'DEV001,TOO_HIGH,2026-06-01 10:03:00',
    'DEV002,-22,2026-06-01 10:04:00',
    'DEV001,999,2026-06-01 10:05:00',
    'DEV002,-19,2026-06-01 10:06:00',
    'DEV001,NOT_A_NUMBER,2026-06-01 10:07:00',
    'DEV002,-21,2026-06-01 10:08:00',
    'DEV001,,2026-06-01 10:09:00',
  ];
  fs.writeFileSync(TEST_CSV, rows.join('\n'));
  console.log(`  Created CSV: 10 rows (5 valid, 5 invalid)`);
}

async function apiCall(config) {
  for (let i = 0; i < 3; i++) {
    try {
      return await axios({ ...config, timeout: 10000 });
    } catch (e) {
      if (i === 2 || !e.code || e.code === 'ECONNABORTED') throw e;
      await new Promise(r => setTimeout(r, 1000));
    }
  }
}

async function setupTestData() {
  console.log('\n\x1b[33m=== 设置测试数据 ===\x1b[0m');

  const deviceResp = await apiCall({
    method: 'post',
    url: 'http://localhost:3004/api/devices',
    headers: { 'X-User-Id': 'admin' },
    data: { id: 'DEV001', name: 'Test Device 1', storeId: 'STORE001', storeName: 'Test Store' },
  });
  testResult('设备1创建成功', deviceResp.status === 200);

  const device2Resp = await apiCall({
    method: 'post',
    url: 'http://localhost:3004/api/devices',
    headers: { 'X-User-Id': 'admin' },
    data: { id: 'DEV002', name: 'Test Device 2', storeId: 'STORE001', storeName: 'Test Store' },
  });
  testResult('设备2创建成功', device2Resp.status === 200);

  const thresholdResp = await apiCall({
    method: 'put',
    url: 'http://localhost:3004/api/thresholds/device/DEV001',
    headers: { 'X-User-Id': 'admin' },
    data: { minTemp: -25, maxTemp: -15 },
  });
  testResult('设置设备阈值', thresholdResp.status === 200);

  const threshold2Resp = await apiCall({
    method: 'put',
    url: 'http://localhost:3004/api/thresholds/device/DEV002',
    headers: { 'X-User-Id': 'admin' },
    data: { minTemp: -25, maxTemp: -15 },
  });
  testResult('设置设备2阈值', threshold2Resp.status === 200);

  createMixedCsv();

  console.log('\n\x1b[33m=== 导入CSV获取失败行 ===\x1b[0m');
  const form = new FormData();
  form.append('file', fs.createReadStream(TEST_CSV));
  form.append('operator', 'operator_li');

  const importResp = await apiCall({
    method: 'post',
    url: BASE_URL + '/import',
    headers: {
      ...form.getHeaders(),
      'X-User-Id': 'operator_li',
    },
    data: form,
  });
  testResult('导入成功返回200', importResp.status === 200);

  const importData = importResp.data.data;
  testBatchId = importData.importBatchId || importData.batchId;
  console.log(`  批次ID: ${testBatchId}`);
  testResult('失败数量正确 (5)', importData.failedCount === 5, importData.failedCount, 5);

  const detailResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}?rowStatus=failed`,
    headers: { 'X-User-Id': 'admin' },
  });
  failedRowIndices = detailResp.data.data.rowResults.items.map(r => r.rowIndex).sort((a, b) => a - b);
  console.log(`  失败行号: ${failedRowIndices.join(', ')}`);
  testResult('获取到5个失败行', failedRowIndices.length === 5);
}

async function testRoutingFix() {
  console.log('\n\x1b[33m=== 阶段 1: 路由遮挡问题验证 (核心修复验证) ===\x1b[0m');
  const targetRow = failedRowIndices[0];

  console.log('  \x1b[36m1.1 PUT 添加备注 - 验证不返回404\x1b[0m');
  const putResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent: '路由修复测试 - 已联系供应商' },
    validateStatus: () => true,
  });
  testResult('PUT备注不返回404 (路由不被遮挡)', putResp.status !== 404, putResp.status, '!= 404');
  testResult('PUT备注返回200成功', putResp.status === 200, putResp.status, 200);
  testResult('PUT备注返回success=true', putResp.data?.success === true, putResp.data?.success, true);
  testResult('PUT备注isNew=true', putResp.data?.data?.isNew === true, putResp.data?.data?.isNew, true);
  testResult('PUT备注内容正确', putResp.data?.data?.remark?.remarkContent === '路由修复测试 - 已联系供应商');

  console.log('  \x1b[36m1.2 GET 查询备注 - 验证不返回404\x1b[0m');
  const getResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'admin' },
    validateStatus: () => true,
  });
  testResult('GET备注不返回404 (路由不被遮挡)', getResp.status !== 404, getResp.status, '!= 404');
  testResult('GET备注返回200成功', getResp.status === 200, getResp.status, 200);
  testResult('GET备注内容正确', getResp.data?.data?.remarkContent === '路由修复测试 - 已联系供应商');
  testResult('GET备注操作人正确', getResp.data?.data?.handledBy === 'admin');
  testResult('GET备注有处理时间', typeof getResp.data?.data?.handledAt === 'number');

  console.log('  \x1b[36m1.3 PUT 修改备注 - 验证路由正确\x1b[0m');
  const updateResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'manager_zhang' },
    data: { remarkContent: '路由修复测试 - 已补发设备' },
  });
  testResult('修改备注返回200', updateResp.status === 200);
  testResult('isNew=false（修改操作）', updateResp.data?.data?.isNew === false);
  testResult('修改后内容正确', updateResp.data?.data?.remark?.remarkContent === '路由修复测试 - 已补发设备');
  testResult('修改后操作人正确', updateResp.data?.data?.remark?.handledBy === 'manager_zhang');

  console.log('  \x1b[36m1.4 PUT 空备注清空 - 验证路由正确\x1b[0m');
  const clearResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent: '' },
  });
  testResult('清空备注返回200', clearResp.status === 200);
  testResult('isClear=true', clearResp.data?.data?.isClear === true);
  testResult('message为"备注已清空"', clearResp.data?.message === '备注已清空');

  const getAfterClear = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'admin' },
  });
  testResult('清空后GET返回null', getAfterClear.data?.data === null);

  console.log('  \x1b[36m1.5 PUT 空格备注清空 - 验证路由正确\x1b[0m');
  const clearSpaceResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent: '   ' },
  });
  testResult('空格备注视为清空', clearSpaceResp.data?.data?.isClear === true);

  console.log('  \x1b[36m1.6 验证通配路由/:id仍正常工作\x1b[0m');
  const batchDetailResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}`,
    headers: { 'X-User-Id': 'admin' },
  });
  testResult('通配路由/:id仍正常工作', batchDetailResp.status === 200);
  testResult('通配路由返回正确批次ID', batchDetailResp.data?.data?.batch?.id === testBatchId);

  console.log('  \x1b[36m1.7 验证/export路由仍正常工作\x1b[0m');
  const exportResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/export?format=json`,
    headers: { 'X-User-Id': 'admin' },
  });
  testResult('/export路由仍正常工作', exportResp.status === 200);
}

async function testPermissionControl() {
  console.log('\n\x1b[33m=== 阶段 2: 权限控制验证 ===\x1b[0m');
  const targetRow = failedRowIndices[1];

  console.log('  \x1b[36m2.1 operator 无权限修改备注 (403)\x1b[0m');
  const operatorResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'operator_li' },
    data: { remarkContent: 'operator尝试修改' },
    validateStatus: () => true,
  });
  testResult('operator修改备注返回403', operatorResp.status === 403, operatorResp.status, 403);
  testResult('403错误包含code字段', operatorResp.data?.code === 'UNAUTHORIZED', operatorResp.data?.code, 'UNAUTHORIZED');
  testResult('403错误包含success=false', operatorResp.data?.success === false);

  console.log('  \x1b[36m2.2 viewer 无权限修改备注 (403)\x1b[0m');
  const viewerResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'viewer_wang' },
    data: { remarkContent: 'viewer尝试修改' },
    validateStatus: () => true,
  });
  testResult('viewer修改备注返回403', viewerResp.status === 403, viewerResp.status, 403);

  console.log('  \x1b[36m2.3 manager 有权限修改备注\x1b[0m');
  const managerResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'manager_zhang' },
    data: { remarkContent: 'manager添加备注' },
  });
  testResult('manager添加备注成功', managerResp.status === 200);
  testResult('manager备注内容正确', managerResp.data?.data?.remark?.remarkContent === 'manager添加备注');

  console.log('  \x1b[36m2.4 operator 可查看备注\x1b[0m');
  const opGetResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'operator_li' },
  });
  testResult('operator查看备注成功', opGetResp.status === 200);
  testResult('operator可看到备注内容', opGetResp.data?.data?.remarkContent === 'manager添加备注');

  console.log('  \x1b[36m2.5 viewer 可查看备注\x1b[0m');
  const vwGetResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('viewer查看备注成功', vwGetResp.status === 200);
  testResult('viewer可看到备注内容', vwGetResp.data?.data?.remarkContent === 'manager添加备注');

  console.log('  \x1b[36m2.6 operator 可导出\x1b[0m');
  const opExportResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/export?format=json`,
    headers: { 'X-User-Id': 'operator_li' },
  });
  testResult('operator可导出', opExportResp.status === 200);
}

async function testBoundaryConditions() {
  console.log('\n\x1b[33m=== 阶段 3: 边界条件验证 ===\x1b[0m');

  console.log('  \x1b[36m3.1 无效批次ID返回404\x1b[0m');
  const invalidBatchResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/invalid-batch-id/rows/1/remark`,
    headers: { 'X-User-Id': 'admin' },
    validateStatus: () => true,
  });
  testResult('无效批次返回404', invalidBatchResp.status === 404, invalidBatchResp.status, 404);

  console.log('  \x1b[36m3.2 无效行号返回404\x1b[0m');
  const invalidRowResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/rows/9999/remark`,
    headers: { 'X-User-Id': 'admin' },
    validateStatus: () => true,
  });
  testResult('无效行号返回404', invalidRowResp.status === 404, invalidRowResp.status, 404);

  console.log('  \x1b[36m3.3 成功行不能添加备注 (业务错误409)\x1b[0m');
  const successRowResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/1/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent: '尝试给成功行加备注' },
    validateStatus: () => true,
  });
  testResult('成功行返回409/业务错误', successRowResp.status === 409 || successRowResp.data?.success === false,
    successRowResp.status, '409 or success=false');
  testResult('错误信息包含状态说明', successRowResp.data?.message?.includes('状态') || successRowResp.data?.message?.includes('失败'));

  console.log('  \x1b[36m3.4 行号验证 (负数/0)\x1b[0m');
  const negativeRowResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/-1/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent: 'test' },
    validateStatus: () => true,
  });
  testResult('行号负数返回400验证错误', negativeRowResp.status === 400, negativeRowResp.status, 400);

  const zeroRowResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/0/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent: 'test' },
    validateStatus: () => true,
  });
  testResult('行号0返回400验证错误', zeroRowResp.status === 400, zeroRowResp.status, 400);

  console.log('  \x1b[36m3.5 备注内容过长验证\x1b[0m');
  const longContent = 'x'.repeat(1001);
  const longResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${failedRowIndices[2]}/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent: longContent },
    validateStatus: () => true,
  });
  testResult('备注过长返回400', longResp.status === 400, longResp.status, 400);
}

async function testExportFields() {
  console.log('\n\x1b[33m=== 阶段 4: 导出字段验证 ===\x1b[0m');

  const targetRow = failedRowIndices[2];
  await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent: '导出测试备注' },
  });

  console.log('  \x1b[36m4.1 JSON导出包含备注字段\x1b[0m');
  const jsonExportResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/export?format=json`,
    headers: { 'X-User-Id': 'admin' },
  });
  testResult('JSON导出成功', jsonExportResp.status === 200);

  const exportData = typeof jsonExportResp.data === 'string'
    ? JSON.parse(jsonExportResp.data)
    : jsonExportResp.data;

  testResult('JSON导出包含remarkStats', !!exportData?.batch?.remarkStats);
  testResult('JSON导出包含rowResults', Array.isArray(exportData?.rowResults));

  const rowWithRemark = exportData.rowResults?.find(r => r.rowIndex === targetRow);
  testResult('JSON导出行包含remark字段', rowWithRemark?.remark !== undefined);
  testResult('JSON导出备注内容正确', rowWithRemark?.remark?.remarkContent === '导出测试备注');
  testResult('JSON导出备注包含handledBy', rowWithRemark?.remark?.handledBy === 'admin');
  testResult('JSON导出备注包含handledAt', typeof rowWithRemark?.remark?.handledAt === 'number');

  console.log('  \x1b[36m4.2 CSV导出包含备注字段\x1b[0m');
  const csvExportResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/export?format=csv`,
    headers: { 'X-User-Id': 'admin' },
  });
  testResult('CSV导出成功', csvExportResp.status === 200);
  testResult('CSV Content-Type正确', csvExportResp.headers['content-type']?.includes('text/csv'));

  const csvContent = csvExportResp.data;
  testResult('CSV包含remark_remarkContent字段头', csvContent.includes('remark_remarkContent'));
  testResult('CSV包含remark_handledBy字段头', csvContent.includes('remark_handledBy'));
  testResult('CSV包含备注内容', csvContent.includes('导出测试备注'));
  testResult('CSV包含操作人', csvContent.includes('admin'));

  console.log('  \x1b[36m4.3 批次列表包含remarkStats\x1b[0m');
  const listResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches`,
    headers: { 'X-User-Id': 'admin' },
  });
  const batchInList = listResp.data.data.items.find(b => b.id === testBatchId);
  testResult('批次列表包含remarkStats', batchInList?.remarkStats !== undefined);
  testResult('remarkStats.totalFailedRows=5', batchInList?.remarkStats?.totalFailedRows === 5);
  testResult('remarkStats.remarkedRows>=1', batchInList?.remarkStats?.remarkedRows >= 1);

  console.log('  \x1b[36m4.4 批次详情包含备注\x1b[0m');
  const detailResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}?rowStatus=failed`,
    headers: { 'X-User-Id': 'admin' },
  });
  const detailData = detailResp.data.data;
  testResult('批次详情包含remarkStats', !!detailData?.batch?.remarkStats);
  const detailRow = detailData?.rowResults?.items?.find(r => r.rowIndex === targetRow);
  testResult('批次详情行包含remark', detailRow?.remark !== undefined);
  testResult('批次详情备注内容正确', detailRow?.remark?.remarkContent === '导出测试备注');
}

async function testRestartPersistence() {
  console.log('\n\x1b[33m=== 阶段 5: DB重启持久化验证 ===\x1b[0m');

  const targetRow = failedRowIndices[3];
  const remarkContent = '持久化测试备注 - 重启后应保留';

  await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent },
  });

  console.log('  \x1b[36m5.1 停止服务器\x1b[0m');
  await stopServer();
  testResult('服务器已停止', serverProcess === null);

  testResult('数据库文件存在', fs.existsSync(DB_PATH));

  console.log('  \x1b[36m5.2 重启服务器（同一DB_PATH）\x1b[0m');
  await startServer(DB_PATH);
  testResult('服务器重启成功', serverProcess !== null);

  console.log('  \x1b[36m5.3 重启后查询备注应保留\x1b[0m');
  const getResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'admin' },
  });
  testResult('重启后备注内容正确', getResp.data?.data?.remarkContent === remarkContent);
  testResult('重启后备注操作人正确', getResp.data?.data?.handledBy === 'admin');

  console.log('  \x1b[36m5.4 重启后批次列表remarkStats正确\x1b[0m');
  const listResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches`,
    headers: { 'X-User-Id': 'admin' },
  });
  const batchInList = listResp.data.data.items.find(b => b.id === testBatchId);
  testResult('重启后remarkStats正确', batchInList?.remarkStats?.remarkedRows >= 2);

  console.log('  \x1b[36m5.5 重启后仍可添加修改备注\x1b[0m');
  const updateResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent: '重启后修改的备注' },
  });
  testResult('重启后修改备注成功', updateResp.status === 200);
  testResult('重启后修改内容正确', updateResp.data?.data?.remark?.remarkContent === '重启后修改的备注');

  console.log('  \x1b[36m5.6 重启后JSON导出仍包含备注\x1b[0m');
  const jsonResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/export?format=json`,
    headers: { 'X-User-Id': 'admin' },
  });
  const exportData = typeof jsonResp.data === 'string' ? JSON.parse(jsonResp.data) : jsonResp.data;
  const row = exportData.rowResults?.find(r => r.rowIndex === targetRow);
  testResult('重启后JSON导出备注正确', row?.remark?.remarkContent === '重启后修改的备注');

  console.log('  \x1b[36m5.7 重启后CSV导出仍包含备注\x1b[0m');
  const csvResp = await apiCall({
    method: 'get',
    url: `${BASE_URL}/batches/${testBatchId}/export?format=csv`,
    headers: { 'X-User-Id': 'admin' },
  });
  testResult('重启后CSV导出包含备注内容', csvResp.data.includes('重启后修改的备注'));

  console.log('  \x1b[36m5.8 重启后可清空备注\x1b[0m');
  const clearResp = await apiCall({
    method: 'put',
    url: `${BASE_URL}/batches/${testBatchId}/rows/${targetRow}/remark`,
    headers: { 'X-User-Id': 'admin' },
    data: { remarkContent: '' },
  });
  testResult('重启后清空备注成功', clearResp.data?.data?.isClear === true);
}

async function main() {
  console.log('\n========================================');
  console.log('备注路由修复 - 回归测试');
  console.log('========================================\n');

  try {
    console.log('\x1b[33m=== 启动服务器 ===\x1b[0m');
    await startServer(DB_PATH);
    testResult('服务器启动成功', serverProcess !== null);

    await setupTestData();

    await testRoutingFix();
    await testPermissionControl();
    await testBoundaryConditions();
    await testExportFields();
    await testRestartPersistence();

  } catch (error) {
    console.error('\n\x1b[31m测试执行出错:\x1b[0m', error.message);
    console.error(error.stack);
    failCount++;
  } finally {
    console.log('\n\x1b[33m=== 清理 ===\x1b[0m');
    await stopServer();

    if (fs.existsSync(TEST_CSV)) {
      console.log('  清理测试CSV文件');
      fs.unlinkSync(TEST_CSV);
    }
    if (fs.existsSync(DB_PATH)) {
      console.log('  清理测试数据库文件');
      fs.unlinkSync(DB_PATH);
    }
  }

  console.log('\n========================================');
  console.log('测试完成!');
  console.log('========================================\n');
  console.log('测试摘要:');
  console.log(`  总测试数: ${passCount + failCount}`);
  console.log(`  通过: \x1b[32m${passCount}\x1b[0m`);
  console.log(`  失败: \x1b[31m${failCount}\x1b[0m`);

  if (failCount === 0) {
    console.log('\n🎉 所有测试通过!\n');
    process.exit(0);
  } else {
    console.log(`\n❌ ${failCount} 个测试失败\n`);
    process.exit(1);
  }
}

main();
