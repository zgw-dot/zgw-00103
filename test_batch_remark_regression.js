const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { spawn } = require('child_process');

const BASE_URL = 'http://localhost:3003';
const TEST_CSV = 'test_remark_mixed.csv';
const TEST_DEVICE = 'REMARK-TEST-' + Date.now().toString().slice(-8);
const DB_FILE = path.join(__dirname, `cold_chain_remark_${Date.now()}.db`);

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
      PORT: '3003',
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
      if (msg.includes('Server started on port 3003')) {
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
    `UNKNOWN-REMARK-999,-20.0,2026-06-01 10:01:00`,
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
let failedRowIndexes = [];
let firstFailedRow = null;
let secondFailedRow = null;

async function runTests() {
  console.log('\x1b[36m========================================\x1b[0m');
  console.log('\x1b[36m批次失败行备注功能 - 全面回归测试\x1b[0m');
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
        name: '备注测试冰柜',
        storeId: 'STORE-REMARK',
        storeName: '备注测试门店',
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

    console.log('\n\x1b[33m=== 阶段 2.5: 导入前Dry-Run预检 ===\x1b[0m');
    console.log('  \x1b[36m导入前Dry-Run检测无效数据（应5条）\x1b[0m');
    const preDryForm = new FormData();
    preDryForm.append('file', fs.createReadStream(TEST_CSV));
    preDryForm.append('operator', 'operator_li');
    const preDryRunResp = await axios.post(BASE_URL + '/api/readings/dry-run', preDryForm, {
      headers: {
        ...preDryForm.getHeaders(),
        'X-User-Id': 'operator_li',
      },
    });
    testResult('导入前Dry-Run正常工作', preDryRunResp.status === 200);
    testResult('导入前Dry-Run检测到5条无效数据', preDryRunResp.data?.data?.invalidCount === 5,
      preDryRunResp.data?.data?.invalidCount, 5);
    testResult('导入前Dry-Run检测到5条有效数据', preDryRunResp.data?.data?.validCount === 5,
      preDryRunResp.data?.data?.validCount, 5);

    console.log('\n\x1b[33m=== 阶段 3: 导入混合CSV ===\x1b[0m');
    const importResp = await uploadCsv(TEST_CSV, 'operator_li');
    testResult('导入成功返回200', importResp.status === 200);

    const importData = importResp.data.data;
    batchId = importData.batchId;
    console.log(`  批次ID: ${batchId}`);

    testResult('批次总数正确 (10)', importData.successCount + importData.failedCount === 10);
    testResult('成功数量正确 (5)', importData.successCount === 5);
    testResult('失败数量正确 (5)', importData.failedCount === 5);

    console.log('\n\x1b[33m=== 阶段 4: 获取失败行 ===\x1b[0m');
    const failedDetail = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('获取失败行成功', failedDetail.status === 200);

    const failedRows = failedDetail.data.data.rowResults.items;
    failedRowIndexes = failedRows.map(r => r.rowIndex).sort((a, b) => a - b);
    firstFailedRow = failedRowIndexes[0];
    secondFailedRow = failedRowIndexes[1];
    console.log(`  失败行号: ${failedRowIndexes.join(', ')}`);
    testResult('失败行数量正确 (5)', failedRowIndexes.length === 5);

    console.log('\n\x1b[33m=== 阶段 5: 权限控制测试 ===\x1b[0m');
    console.log('  \x1b[36m5.1 operator_li 尝试添加备注（应403）\x1b[0m');
    const operatorRemarkResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${firstFailedRow}/remark`,
      headers: { 'X-User-Id': 'operator_li' },
      data: { remarkContent: 'operator尝试添加备注' },
    });
    testResult('operator添加备注返回403', operatorRemarkResp.status === 403,
      operatorRemarkResp.status, 403);
    testResult('403错误代码正确', operatorRemarkResp.data?.code === 'UNAUTHORIZED',
      operatorRemarkResp.data?.code, 'UNAUTHORIZED');

    console.log('  \x1b[36m5.2 viewer_wang 尝试添加备注（应403）\x1b[0m');
    const viewerRemarkResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${firstFailedRow}/remark`,
      headers: { 'X-User-Id': 'viewer_wang' },
      data: { remarkContent: 'viewer尝试添加备注' },
    });
    testResult('viewer添加备注返回403', viewerRemarkResp.status === 403,
      viewerRemarkResp.status, 403);

    console.log('  \x1b[36m5.3 manager_zhang 尝试添加备注（应成功）\x1b[0m');
    const managerRemarkResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${firstFailedRow}/remark`,
      headers: { 'X-User-Id': 'manager_zhang' },
      data: { remarkContent: '设备不存在，已通知门店补充设备台账' },
    });
    testResult('manager添加备注返回200', managerRemarkResp.status === 200,
      managerRemarkResp.status, 200);
    testResult('manager备注内容正确',
      managerRemarkResp.data?.data?.remark?.remarkContent === '设备不存在，已通知门店补充设备台账');
    testResult('manager备注操作人正确',
      managerRemarkResp.data?.data?.remark?.handledBy === 'manager_zhang');

    console.log('  \x1b[36m5.4 admin 尝试添加备注（应成功）\x1b[0m');
    const adminRemarkResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${secondFailedRow}/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '温度格式错误，已反馈给数据采集人员' },
    });
    testResult('admin添加备注返回200', adminRemarkResp.status === 200,
      adminRemarkResp.status, 200);
    testResult('admin备注内容正确',
      adminRemarkResp.data?.data?.remark?.remarkContent === '温度格式错误，已反馈给数据采集人员');
    testResult('admin备注操作人正确',
      adminRemarkResp.data?.data?.remark?.handledBy === 'admin');

    console.log('  \x1b[36m5.5 operator/viewer 查看备注（应成功）\x1b[0m');
    const operatorViewResp = await apiCall({
      url: `/api/readings/batches/${batchId}/rows/${firstFailedRow}/remark`,
      headers: { 'X-User-Id': 'operator_li' },
    });
    testResult('operator查看备注成功', operatorViewResp.status === 200,
      operatorViewResp.status, 200);
    testResult('operator可查看备注内容',
      operatorViewResp.data?.data?.remarkContent === '设备不存在，已通知门店补充设备台账');

    const viewerViewResp = await apiCall({
      url: `/api/readings/batches/${batchId}/rows/${secondFailedRow}/remark`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('viewer查看备注成功', viewerViewResp.status === 200,
      viewerViewResp.status, 200);
    testResult('viewer可查看备注内容',
      viewerViewResp.data?.data?.remarkContent === '温度格式错误，已反馈给数据采集人员');

    console.log('\n\x1b[33m=== 阶段 6: 无效参数测试 ===\x1b[0m');
    console.log('  \x1b[36m6.1 无效批次ID（应404）\x1b[0m');
    const invalidBatchResp = await apiCall({
      method: 'put',
      url: '/api/readings/batches/invalid-batch-id/rows/1/remark',
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '测试' },
    });
    testResult('无效批次返回404', invalidBatchResp.status === 404,
      invalidBatchResp.status, 404);

    console.log('  \x1b[36m6.2 无效行号（应404）\x1b[0m');
    const invalidRowResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/9999/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '测试' },
    });
    testResult('无效行号返回404', invalidRowResp.status === 404,
      invalidRowResp.status, 404);

    console.log('  \x1b[36m6.3 成功行添加备注（应409 BusinessError）\x1b[0m');
    const successRowResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/1/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '测试' },
    });
    testResult('成功行添加备注返回409/业务错误', successRowResp.status === 400 || successRowResp.status === 409,
      successRowResp.status, '400 or 409');
    testResult('错误信息包含状态说明', successRowResp.data?.message?.includes('状态'));

    console.log('  \x1b[36m6.4 行号为0或负数（应400验证错误）\x1b[0m');
    const zeroRowResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/0/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '测试' },
    });
    testResult('行号0返回验证错误', zeroRowResp.status === 400,
      zeroRowResp.status, 400);

    const negativeRowResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/-1/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '测试' },
    });
    testResult('行号负数返回验证错误', negativeRowResp.status === 400,
      negativeRowResp.status, 400);

    console.log('  \x1b[36m6.5 备注内容过长（应400验证错误）\x1b[0m');
    const longContent = 'x'.repeat(1001);
    const longContentResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${firstFailedRow}/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: longContent },
    });
    testResult('备注过长返回400', longContentResp.status === 400,
      longContentResp.status, 400);

    console.log('\n\x1b[33m=== 阶段 7: 备注修改与审计测试 ===\x1b[0m');
    console.log('  \x1b[36m7.1 修改已存在的备注\x1b[0m');
    const updateRemarkResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${firstFailedRow}/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '设备不存在，已通知门店补充设备台账，门店承诺3日内完成' },
    });
    testResult('修改备注返回200', updateRemarkResp.status === 200,
      updateRemarkResp.status, 200);
    testResult('isNew=false（修改）', updateRemarkResp.data?.data?.isNew === false,
      updateRemarkResp.data?.data?.isNew, false);
    testResult('修改后内容正确',
      updateRemarkResp.data?.data?.remark?.remarkContent === '设备不存在，已通知门店补充设备台账，门店承诺3日内完成');

    console.log('  \x1b[36m7.2 查看审计日志（备注更新应记录）\x1b[0m');
    const auditLogsResp = await apiCall({
      url: `/api/audit/logs?importBatchId=${batchId}&pageSize=50`,
      headers: { 'X-User-Id': 'admin' },
    });
    testResult('审计日志查询成功', auditLogsResp.status === 200);

    const auditLogs = auditLogsResp.data?.data?.items || [];
    const remarkUpdateLogs = auditLogs.filter(l =>
      l.operationType === 'batch_row_remark_update'
    );
    testResult('存在备注更新审计日志', remarkUpdateLogs.length >= 2,
      remarkUpdateLogs.length, '>= 2');

    const latestRemarkLog = remarkUpdateLogs[0];
    testResult('审计日志包含备注内容',
      latestRemarkLog?.details?.includes('已通知门店补充设备台账'));
    testResult('审计日志操作人正确', latestRemarkLog?.operator === 'admin',
      latestRemarkLog?.operator, 'admin');

    console.log('  \x1b[36m7.3 空备注视为清空\x1b[0m');
    const clearRemarkResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${firstFailedRow}/remark`,
      headers: { 'X-User-Id': 'manager_zhang' },
      data: { remarkContent: '' },
    });
    testResult('清空备注返回200', clearRemarkResp.status === 200,
      clearRemarkResp.status, 200);
    testResult('isClear=true', clearRemarkResp.data?.data?.isClear === true,
      clearRemarkResp.data?.data?.isClear, true);
    testResult('message为"备注已清空"',
      clearRemarkResp.data?.message === '备注已清空',
      clearRemarkResp.data?.message, '备注已清空');

    console.log('  \x1b[36m7.4 验证备注已清空\x1b[0m');
    const getClearedRemarkResp = await apiCall({
      url: `/api/readings/batches/${batchId}/rows/${firstFailedRow}/remark`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('查询清空的备注返回null', getClearedRemarkResp.data?.data === null,
      getClearedRemarkResp.data?.data, null);

    console.log('  \x1b[36m7.5 清空备注审计日志\x1b[0m');
    const auditLogsAfterClear = await apiCall({
      url: `/api/audit/logs?importBatchId=${batchId}&pageSize=50`,
      headers: { 'X-User-Id': 'admin' },
    });
    const clearLogs = (auditLogsAfterClear.data?.data?.items || []).filter(l =>
      l.operationType === 'batch_row_remark_clear'
    );
    testResult('存在备注清空审计日志', clearLogs.length >= 1,
      clearLogs.length, '>= 1');
    testResult('清空审计日志包含原备注',
      clearLogs[0]?.details?.includes('已通知门店补充设备台账'));

    console.log('  \x1b[36m7.6 重复清空（应无错误）\x1b[0m');
    const clearAgainResp = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${firstFailedRow}/remark`,
      headers: { 'X-User-Id': 'admin' },
      data: { remarkContent: '   ' },
    });
    testResult('重复清空返回200', clearAgainResp.status === 200,
      clearAgainResp.status, 200);
    testResult('isClear=true（空格视为清空）', clearAgainResp.data?.data?.isClear === true,
      clearAgainResp.data?.data?.isClear, true);

    console.log('\n\x1b[33m=== 阶段 8: 批次列表备注统计 ===\x1b[0m');
    const batchListResp = await apiCall({
      url: '/api/readings/batches?pageSize=10',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('批次列表查询成功', batchListResp.status === 200);

    const batchInList = batchListResp.data?.data?.items?.find(b => b.id === batchId);
    testResult('批次在列表中', !!batchInList);
    testResult('包含remarkStats字段', !!batchInList?.remarkStats,
      !!batchInList?.remarkStats, true);
    testResult('remarkStats.totalFailedRows=5', batchInList?.remarkStats?.totalFailedRows === 5,
      batchInList?.remarkStats?.totalFailedRows, 5);
    testResult('remarkStats.remarkedRows=1（secondFailedRow有备注）',
      batchInList?.remarkStats?.remarkedRows === 1,
      batchInList?.remarkStats?.remarkedRows, 1);
    testResult('remarkStats.unremarkedRows=4', batchInList?.remarkStats?.unremarkedRows === 4,
      batchInList?.remarkStats?.unremarkedRows, 4);

    console.log('\n\x1b[33m=== 阶段 9: 批次详情备注展示 ===\x1b[0m');
    const batchDetailResp = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('批次详情查询成功', batchDetailResp.status === 200);

    const detailData = batchDetailResp.data?.data;
    testResult('batch包含remarkStats', !!detailData?.batch?.remarkStats);
    testResult('remarkStats统计正确', detailData?.batch?.remarkStats?.remarkedRows === 1);

    const rowWithRemark = detailData?.rowResults?.items?.find(r => r.rowIndex === secondFailedRow);
    testResult('失败行包含remark字段', rowWithRemark?.remark !== undefined,
      rowWithRemark?.remark !== undefined, true);
    testResult('失败行备注内容正确',
      rowWithRemark?.remark?.remarkContent === '温度格式错误，已反馈给数据采集人员');
    testResult('失败行备注操作人正确', rowWithRemark?.remark?.handledBy === 'admin');
    testResult('失败行备注有处理时间', !!rowWithRemark?.remark?.handledAt);

    const rowWithoutRemark = detailData?.rowResults?.items?.find(r => r.rowIndex === firstFailedRow);
    testResult('已清空备注的行remark为null', rowWithoutRemark?.remark === null,
      rowWithoutRemark?.remark, null);

    console.log('\n\x1b[33m=== 阶段 10: JSON导出包含备注 ===\x1b[0m');
    const jsonExportResp = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('JSON导出成功', jsonExportResp.status === 200);

    const jsonData = typeof jsonExportResp.data === 'string'
      ? JSON.parse(jsonExportResp.data)
      : jsonExportResp.data;

    testResult('JSON导出包含remarkStats', !!jsonData?.batch?.remarkStats);
    testResult('JSON导出行包含remark字段', jsonData?.rowResults?.[0]?.remark !== undefined);

    const jsonRowWithRemark = jsonData?.rowResults?.find(r => r.rowIndex === secondFailedRow);
    testResult('JSON导出备注内容正确',
      jsonRowWithRemark?.remark?.remarkContent === '温度格式错误，已反馈给数据采集人员');
    testResult('JSON导出备注包含所有字段',
      jsonRowWithRemark?.remark?.handledBy && jsonRowWithRemark?.remark?.handledAt && jsonRowWithRemark?.remark?.remarkContent);

    const jsonRowWithoutRemark = jsonData?.rowResults?.find(r => r.rowIndex === firstFailedRow);
    testResult('JSON导出已清空备注为null', jsonRowWithoutRemark?.remark === null);

    console.log('\n\x1b[33m=== 阶段 11: CSV导出包含备注 ===\x1b[0m');
    const csvExportResp = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=csv&rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('CSV导出成功', csvExportResp.status === 200);
    testResult('CSV Content-Type正确',
      csvExportResp.headers['content-type']?.includes('text/csv') ||
      csvExportResp.headers['content-type']?.includes('application/octet-stream'));

    const csvContent = csvExportResp.data;
    testResult('CSV包含批次信息', csvContent.includes('=== 批次信息 ==='));
    testResult('CSV包含remarkStats', csvContent.includes('remarkStats'));
    testResult('CSV包含remark字段头', csvContent.includes('remark_remarkContent'));
    testResult('CSV包含备注内容', csvContent.includes('温度格式错误，已反馈给数据采集人员'));
    testResult('CSV包含操作人', csvContent.includes('admin'));

    const csvLines = csvContent.replace(/\r\n/g, '\n').split('\n');
    const rowResultsIdx = csvLines.findIndex(l => l.includes('=== 逐行结果 ==='));
    const csvHeader = csvLines[rowResultsIdx + 1];
    testResult('CSV表头包含remark字段',
      csvHeader.includes('remark_remarkContent') &&
      csvHeader.includes('remark_handledBy') &&
      csvHeader.includes('remark_handledAt'));

    console.log('\n\x1b[33m=== 阶段 12: 验证不影响CSV导入、幂等、读数、告警 ===\x1b[0m');
    console.log('  \x1b[36m12.1 幂等导入验证\x1b[0m');
    const idemImportResp = await uploadCsv(TEST_CSV, 'operator_li');
    testResult('幂等导入不创建新数据（不报错）', idemImportResp.status === 200);

    console.log('  \x1b[36m12.2 读数查询正常\x1b[0m');
    const readingsResp = await apiCall({
      url: `/api/readings?deviceId=${TEST_DEVICE}`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('读数查询成功', readingsResp.status === 200);
    testResult('读数数量正确 (5)', readingsResp.data?.data?.items?.length === 5,
      readingsResp.data?.data?.items?.length, 5);

    console.log('  \x1b[36m12.3 告警生成正常\x1b[0m');
    const alarmsResp = await apiCall({
      url: `/api/alarms?deviceId=${TEST_DEVICE}`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('告警查询成功', alarmsResp.status === 200);

    console.log('  \x1b[36m12.4 Dry-Run仍正常工作（导入后）\x1b[0m');
    const form = new FormData();
    form.append('file', fs.createReadStream(TEST_CSV));
    form.append('operator', 'operator_li');
    const dryRunResp = await axios.post(BASE_URL + '/api/readings/dry-run', form, {
      headers: {
        ...form.getHeaders(),
        'X-User-Id': 'operator_li',
      },
    });
    testResult('导入后Dry-Run正常工作', dryRunResp.status === 200);
    testResult('导入后Dry-Run检测到10条无效数据（5原始错误+5重复）', 
      dryRunResp.data?.data?.invalidCount === 10,
      dryRunResp.data?.data?.invalidCount, 10);
    testResult('导入后Dry-Run检测到0条有效数据（全部为错误或重复）', 
      dryRunResp.data?.data?.validCount === 0,
      dryRunResp.data?.data?.validCount, 0);

    console.log('\n\x1b[33m=== 阶段 13: 停止服务器准备重启测试 ===\x1b[0m');
    await stopServer();
    testResult('服务器已停止', serverProcess === null);

    console.log('\n\x1b[33m=== 阶段 14: 同一DB_PATH重启后备注仍在 ===\x1b[0m');
    testResult('数据库文件存在', fs.existsSync(DB_FILE));

    await startServer();
    testResult('服务器重启成功', true);

    console.log('  \x1b[36m14.1 重启后批次列表备注统计仍正确\x1b[0m');
    const afterBatchList = await apiCall({
      url: '/api/readings/batches?pageSize=10',
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const afterBatchInList = afterBatchList.data?.data?.items?.find(b => b.id === batchId);
    testResult('重启后remarkStats仍正确', afterBatchInList?.remarkStats?.remarkedRows === 1,
      afterBatchInList?.remarkStats?.remarkedRows, 1);

    console.log('  \x1b[36m14.2 重启后失败行备注仍正确\x1b[0m');
    const afterDetail = await apiCall({
      url: `/api/readings/batches/${batchId}?rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const afterRowWithRemark = afterDetail.data?.data?.rowResults?.items?.find(r => r.rowIndex === secondFailedRow);
    testResult('重启后备注内容仍正确',
      afterRowWithRemark?.remark?.remarkContent === '温度格式错误，已反馈给数据采集人员',
      afterRowWithRemark?.remark?.remarkContent, '温度格式错误，已反馈给数据采集人员');
    testResult('重启后备注操作人仍正确', afterRowWithRemark?.remark?.handledBy === 'admin',
      afterRowWithRemark?.remark?.handledBy, 'admin');

    console.log('  \x1b[36m14.3 重启后审计日志仍完整\x1b[0m');
    const afterAudit = await apiCall({
      url: `/api/audit/logs?importBatchId=${batchId}&pageSize=50`,
      headers: { 'X-User-Id': 'admin' },
    });
    const afterRemarkUpdateLogs = (afterAudit.data?.data?.items || []).filter(l =>
      l.operationType === 'batch_row_remark_update'
    );
    testResult('重启后备注更新审计日志仍存在', afterRemarkUpdateLogs.length >= 2,
      afterRemarkUpdateLogs.length, '>= 2');
    const afterClearLogs = (afterAudit.data?.data?.items || []).filter(l =>
      l.operationType === 'batch_row_remark_clear'
    );
    testResult('重启后备注清空审计日志仍存在', afterClearLogs.length >= 1,
      afterClearLogs.length, '>= 1');

    console.log('  \x1b[36m14.4 重启后JSON导出仍包含备注\x1b[0m');
    const afterJsonExport = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    const afterJsonData = typeof afterJsonExport.data === 'string'
      ? JSON.parse(afterJsonExport.data)
      : afterJsonExport.data;
    const afterJsonRowWithRemark = afterJsonData?.rowResults?.find(r => r.rowIndex === secondFailedRow);
    testResult('重启后JSON导出备注仍正确',
      afterJsonRowWithRemark?.remark?.remarkContent === '温度格式错误，已反馈给数据采集人员');

    console.log('  \x1b[36m14.5 重启后CSV导出仍包含备注\x1b[0m');
    const afterCsvExport = await apiCall({
      url: `/api/readings/batches/${batchId}/export?format=csv&rowStatus=failed`,
      headers: { 'X-User-Id': 'viewer_wang' },
    });
    testResult('重启后CSV导出仍包含备注内容',
      afterCsvExport.data.includes('温度格式错误，已反馈给数据采集人员'));

    console.log('  \x1b[36m14.6 重启后仍可添加/修改备注\x1b[0m');
    const afterAddRemark = await apiCall({
      method: 'put',
      url: `/api/readings/batches/${batchId}/rows/${failedRowIndexes[2]}/remark`,
      headers: { 'X-User-Id': 'manager_zhang' },
      data: { remarkContent: '重启后添加的备注' },
    });
    testResult('重启后添加备注成功', afterAddRemark.status === 200,
      afterAddRemark.status, 200);
    testResult('重启后添加备注内容正确',
      afterAddRemark.data?.data?.remark?.remarkContent === '重启后添加的备注');

    console.log('\n\x1b[33m=== 阶段 15: 清理 ===\x1b[0m');
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
