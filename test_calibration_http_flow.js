const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { spawn } = require('child_process');

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, 'data', 'cold_chain_http_calibration.db');

const headers = {
  admin: { 'X-User-Id': 'admin' },
  manager: { 'X-User-Id': 'manager_zhang' },
  operator: { 'X-User-Id': 'operator_li' },
  viewer: { 'X-User-Id': 'viewer_wang' },
};

let serverProcess = null;
let createdPlanId = null;
let createdBatchId = null;
let createdAlarmId = null;
let initialCorrectionCount = 0;

function log(message, type = 'info') {
  const prefix = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`${prefix} ${message}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
}

function logSubSection(title) {
  console.log('\n' + '-'.repeat(50));
  console.log(`  ${title}`);
  console.log('-'.repeat(50));
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupDatabase() {
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    log('Cleaned up test database', 'info');
  }
}

function startServer(skipCleanup = false) {
  return new Promise((resolve, reject) => {
    if (!skipCleanup) {
      cleanupDatabase();
    }

    const env = { ...process.env, DB_PATH, PORT: '3000' };
    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    serverProcess = spawn(npmCmd, ['run', 'dev'], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });

    let serverReady = false;
    let output = '';

    serverProcess.stdout.on('data', (data) => {
      output += data.toString();
      if (output.includes('Server started on port') && !serverReady) {
        serverReady = true;
        log('Server started successfully', 'success');
        resolve(serverProcess);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      console.error('Server stderr:', data.toString());
    });

    setTimeout(() => {
      if (!serverReady) {
        reject(new Error('Server failed to start within 30 seconds'));
      }
    }, 30000);
  });
}

function stopServer() {
  return new Promise((resolve) => {
    if (serverProcess) {
      if (process.platform === 'win32') {
        try {
          const pid = serverProcess.pid;
          require('child_process').execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' });
        } catch(e) {}
        setTimeout(() => {
          log('Server stopped', 'info');
          resolve();
        }, 3000);
      } else {
        serverProcess.kill('SIGINT');
        serverProcess.on('exit', () => {
          log('Server stopped', 'info');
          setTimeout(resolve, 1000);
        });
      }
    } else {
      resolve();
    }
  });
}

async function waitForServer() {
  for (let i = 0; i < 30; i++) {
    try {
      await axios.get(`${BASE_URL}/health`);
      return true;
    } catch {
      await delay(1000);
    }
  }
  throw new Error('Server not ready after 30 seconds');
}

function createTestCsv(rows, withHeader = true) {
  let content = '';
  if (withHeader) {
    content = 'deviceId,temperature,readingTime\n';
  }
  content += rows.map(r => `${r.deviceId},${r.temperature},${r.readingTime}`).join('\n');
  return Buffer.from(content, 'utf-8');
}

async function createDevice(id, name, storeId, storeName, status = 'active') {
  await axios.post(`${BASE_URL}/api/devices`, {
    id,
    name,
    storeId,
    storeName,
    status,
  }, { headers: headers.admin });
  log(`设备 ${id} 创建成功`, 'success');
}

async function createThreshold(deviceId, storeId, min = 2, max = 8) {
  await axios.put(`${BASE_URL}/api/thresholds/device/${deviceId}`, {
    minTemp: min,
    maxTemp: max,
    operator: 'admin',
  }, { headers: headers.admin });
  log(`阈值 设备${deviceId} ${min}-${max}℃ 设置成功`, 'success');
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(`❌ 断言失败: ${message}`);
  }
  log(`✅ ${message}`, 'success');
}

function assertAlmostEqual(actual, expected, message, epsilon = 0.01) {
  if (Math.abs(actual - expected) > epsilon) {
    throw new Error(`❌ 断言失败: ${message} - 实际值: ${actual}, 期望值: ${expected}`);
  }
  log(`✅ ${message} (${actual} ≈ ${expected})`, 'success');
}

async function runHttpFlow() {
  logSection('设备校准计划和读数修正模块 - 真实 HTTP 链路端到端测试');
  log('测试覆盖：计划冲突、权限边界、导入修正、导出一致性、撤销后历史保持、重启后状态保持');

  let testPassed = true;

  try {
    log('Starting server...', 'info');
    await startServer();
    await waitForServer();

    logSection('步骤 1: 初始化测试数据');
    await createDevice('DEV_CALIB_001', '校准测试冷柜001', 'STORE_CALIB_001', '校准测试门店001', 'active');
    await createDevice('DEV_CALIB_002', '校准测试冷柜002', 'STORE_CALIB_002', '校准测试门店002', 'active');
    await createDevice('DEV_CALIB_INACTIVE', '已停用设备', 'STORE_CALIB_001', '校准测试门店001', 'inactive');
    await createThreshold('DEV_CALIB_001', 'STORE_CALIB_001', 2, 8);
    await createThreshold('DEV_CALIB_002', 'STORE_CALIB_002', 2, 8);

    logSection('步骤 2: 校准计划创建测试');

    logSubSection('2.1 权限边界测试 - viewer 不能创建计划');
    try {
      await axios.post(`${BASE_URL}/api/calibration/plans`, {
        deviceId: 'DEV_CALIB_001',
        offsetValue: 1.5,
        effectiveStartTime: Date.now() - 3600000,
        reason: '传感器漂移校准',
        personInCharge: 'admin',
        operator: 'viewer_wang',
      }, { headers: headers.viewer });
      log('❌ viewer 应该不能创建校准计划', 'error');
      testPassed = false;
    } catch (error) {
      assert(error.response.status === 403 || error.response.status === 401, 'viewer 创建计划被拒绝');
    }

    logSubSection('2.2 权限边界测试 - operator 不能创建计划');
    try {
      await axios.post(`${BASE_URL}/api/calibration/plans`, {
        deviceId: 'DEV_CALIB_001',
        offsetValue: 1.5,
        effectiveStartTime: Date.now() - 3600000,
        reason: '传感器漂移校准',
        personInCharge: 'admin',
        operator: 'operator_li',
      }, { headers: headers.operator });
      log('❌ operator 应该不能创建校准计划', 'error');
      testPassed = false;
    } catch (error) {
      assert(error.response.status === 403 || error.response.status === 401, 'operator 创建计划被拒绝');
    }

    logSubSection('2.3 无效偏移值测试');
    try {
      await axios.post(`${BASE_URL}/api/calibration/plans`, {
        deviceId: 'DEV_CALIB_001',
        offsetValue: 100,
        effectiveStartTime: Date.now() - 3600000,
        reason: '无效偏移测试',
        personInCharge: 'admin',
        operator: 'manager_zhang',
      }, { headers: headers.manager });
      log('❌ 偏移值超出范围应该被拒绝', 'error');
      testPassed = false;
    } catch (error) {
      assert(error.response.status === 400, '无效偏移值被拒绝');
    }

    logSubSection('2.4 停用设备不能创建校准计划');
    try {
      await axios.post(`${BASE_URL}/api/calibration/plans`, {
        deviceId: 'DEV_CALIB_INACTIVE',
        offsetValue: 1.0,
        effectiveStartTime: Date.now() - 3600000,
        reason: '停用设备测试',
        personInCharge: 'admin',
        operator: 'manager_zhang',
      }, { headers: headers.manager });
      log('❌ 停用设备应该不能创建校准计划', 'error');
      testPassed = false;
    } catch (error) {
      assert(error.response.status === 400, '停用设备创建计划被拒绝');
    }

    logSubSection('2.5 manager 创建有效校准计划');
    const now = Date.now();
    const planResponse = await axios.post(`${BASE_URL}/api/calibration/plans`, {
      deviceId: 'DEV_CALIB_001',
      offsetValue: 1.5,
      effectiveStartTime: now - 3600000,
      effectiveEndTime: now + 7200000,
      reason: '传感器漂移校准 - 需要+1.5℃修正',
      personInCharge: 'admin',
      operator: 'manager_zhang',
    }, { headers: headers.manager });

    createdPlanId = planResponse.data.data.id;
    assert(planResponse.data.data.status === 'active', '计划状态为 active');
    assert(planResponse.data.data.offsetValue === 1.5, '偏移值正确');
    log(`校准计划创建成功: ${createdPlanId}`, 'success');

    logSubSection('2.6 时间段重叠冲突测试');
    try {
      await axios.post(`${BASE_URL}/api/calibration/plans`, {
        deviceId: 'DEV_CALIB_001',
        offsetValue: 2.0,
        effectiveStartTime: now,
        reason: '重叠时间段测试',
        personInCharge: 'admin',
        operator: 'manager_zhang',
      }, { headers: headers.manager });
      log('❌ 时间段重叠应该被拒绝', 'error');
      testPassed = false;
    } catch (error) {
      assert(error.response.status === 409, '时间段重叠被拒绝');
    }

    logSection('步骤 3: 温度导入与校准修正测试');

    logSubSection('3.1 导入 CSV - 验证校准自动应用');
    const readingTime1 = now - 1800000;
    const readingTime2 = now + 3600000;
    const csvBuffer = createTestCsv([
      { deviceId: 'DEV_CALIB_001', temperature: 5.0, readingTime: readingTime1 },
      { deviceId: 'DEV_CALIB_001', temperature: 9.0, readingTime: readingTime2 },
      { deviceId: 'DEV_CALIB_002', temperature: 3.0, readingTime: now },
    ]);

    const form = new FormData();
    form.append('file', csvBuffer, { filename: 'calibration_test.csv', contentType: 'text/csv' });
    form.append('operator', 'operator_li');

    const importResponse = await axios.post(
      `${BASE_URL}/api/readings/import`,
      form,
      {
        headers: {
          ...headers.operator,
          ...form.getHeaders(),
        },
      }
    );

    createdBatchId = importResponse.data.data.batchId;
    assert(importResponse.data.data.successCount === 3, '3条数据全部导入成功');
    log(`导入成功，批次ID: ${createdBatchId}`, 'success');

    logSubSection('3.2 验证批次详情中的校准信息');
    const batchDetailResponse = await axios.get(
      `${BASE_URL}/api/readings/batches/${createdBatchId}`,
      { headers: headers.operator }
    );

    const batchDetail = batchDetailResponse.data.data;
    const dev001Rows = batchDetail.rowResults.items.filter(r => r.deviceId === 'DEV_CALIB_001');
    const dev002Rows = batchDetail.rowResults.items.filter(r => r.deviceId === 'DEV_CALIB_002');

    assert(dev001Rows.length === 2, 'DEV_CALIB_001 有2条记录');
    assert(dev002Rows.length === 1, 'DEV_CALIB_002 有1条记录');

    const calibratedRow = dev001Rows.find(r => r.readingTime === readingTime1);
    assertAlmostEqual(calibratedRow.originalTemperature, 5.0, '原始温度正确');
    assertAlmostEqual(calibratedRow.correctedTemperature, 6.5, '修正后温度正确(5.0 + 1.5)');
    assert(calibratedRow.calibrationPlanId === createdPlanId, '校准计划ID正确');
    assertAlmostEqual(calibratedRow.temperature, 6.5, '温度字段使用修正后的值');

    const uncalibratedRow = dev002Rows[0];
    assertAlmostEqual(uncalibratedRow.originalTemperature, 3.0, '无校准计划的原始温度正确');
    assertAlmostEqual(uncalibratedRow.correctedTemperature, 3.0, '无校准计划的修正后温度等于原始值');
    assert(uncalibratedRow.calibrationPlanId === null, '无校准计划时planId为null');

    logSubSection('3.3 验证告警基于修正后温度判断');
    const alarmRow = dev001Rows.find(r => r.readingTime === readingTime2);
    assertAlmostEqual(alarmRow.originalTemperature, 9.0, '告警行原始温度正确');
    assertAlmostEqual(alarmRow.correctedTemperature, 10.5, '告警行修正后温度正确(9.0 + 1.5)');

    assert(batchDetail.alarms.length > 0, '存在生成的告警');

    const highAlarm = batchDetail.alarms.find(a => a.deviceId === 'DEV_CALIB_001' && a.type === 'high_temp');
    if (highAlarm) {
      createdAlarmId = highAlarm.id;
      assertAlmostEqual(highAlarm.temperature, 10.5, '告警使用修正后温度(10.5℃ > 8℃阈值)');
      assertAlmostEqual(highAlarm.originalTemperature, 9.0, '告警记录了原始温度');
      assert(highAlarm.calibrationPlanId === createdPlanId, '告警记录了校准计划ID');
      log(`告警生成成功，告警ID: ${createdAlarmId}，基于修正后温度10.5℃`, 'success');
    } else {
      log('⚠️ 未找到高温告警，可能需要检查阈值设置', 'warn');
    }

    logSubSection('3.4 验证读数修正记录');
    const correctionsResponse = await axios.get(
      `${BASE_URL}/api/calibration/corrections/batch/${createdBatchId}`,
      { headers: headers.operator }
    );

    initialCorrectionCount = correctionsResponse.data.data.length;
    assert(initialCorrectionCount >= 2, '至少有2条读数修正记录（DEV_CALIB_001的两条）');
    log(`读数修正记录数量: ${initialCorrectionCount}`, 'info');

    logSection('步骤 4: 导出一致性测试');

    logSubSection('4.1 校准计划 CSV 导出');
    const csvExportResponse = await axios.get(
      `${BASE_URL}/api/calibration/export?format=csv`,
      { headers: headers.operator }
    );
    assert(csvExportResponse.data.includes(createdPlanId), 'CSV导出包含计划ID');
    assert(csvExportResponse.data.includes('1.5'), 'CSV导出包含偏移值');
    assert(csvExportResponse.data.includes('传感器漂移校准'), 'CSV导出包含原因');
    log('CSV导出包含校准信息', 'success');

    logSubSection('4.2 校准计划 JSON 导出');
    const jsonExportResponse = await axios.get(
      `${BASE_URL}/api/calibration/export?format=json`,
      { headers: headers.operator }
    );
    const exportedPlans = typeof jsonExportResponse.data === 'string'
      ? JSON.parse(jsonExportResponse.data)
      : jsonExportResponse.data;
    const exportedPlan = exportedPlans.find(p => p.id === createdPlanId);
    assert(exportedPlan !== undefined, 'JSON导出包含创建的计划');
    assert(exportedPlan.offsetValue === 1.5, 'JSON导出偏移值正确');
    log('JSON导出包含校准信息', 'success');

    logSubSection('4.3 批次详情 JSON 导出 - 验证校准信息');
    const batchJsonExport = await axios.get(
      `${BASE_URL}/api/readings/batches/${createdBatchId}/export?format=json`,
      { headers: headers.operator }
    );
    const batchExportData = typeof batchJsonExport.data === 'string'
      ? JSON.parse(batchJsonExport.data)
      : batchJsonExport.data;
    assert(batchExportData.rowResults[0].originalTemperature !== undefined, '批次导出包含originalTemperature');
    assert(batchExportData.rowResults[0].correctedTemperature !== undefined, '批次导出包含correctedTemperature');
    assert(batchExportData.rowResults[0].calibrationPlanId !== undefined, '批次导出包含calibrationPlanId');
    log('批次详情导出包含校准信息', 'success');

    logSubSection('4.4 告警导出 - 验证校准信息');
    if (createdAlarmId) {
      const alarmsResponse = await axios.get(
        `${BASE_URL}/api/alarms`,
        { headers: headers.operator }
      );
      const alarmWithCalibration = alarmsResponse.data.data.items.find(a => a.id === createdAlarmId);
      assert(alarmWithCalibration.originalTemperature !== undefined, '告警列表包含originalTemperature');
      assert(alarmWithCalibration.calibrationPlanId !== undefined, '告警列表包含calibrationPlanId');
      log('告警列表包含校准信息', 'success');
    }

    logSubSection('4.5 审计日志导出 - 验证校准操作记录');
    const auditExportResponse = await axios.get(
      `${BASE_URL}/api/audit/export?format=csv`,
      { headers: headers.operator }
    );
    assert(auditExportResponse.data.includes('calibration_plan_create'), '审计日志包含校准计划创建记录');
    log('审计日志包含校准操作记录', 'success');

    logSection('步骤 5: 校准计划生命周期测试');

    logSubSection('5.1 viewer 不能停用计划');
    try {
      await axios.post(
        `${BASE_URL}/api/calibration/plans/${createdPlanId}/deactivate`,
        { operator: 'viewer_wang' },
        { headers: headers.viewer }
      );
      log('❌ viewer 应该不能停用校准计划', 'error');
      testPassed = false;
    } catch (error) {
      assert(error.response.status === 403 || error.response.status === 401, 'viewer 停用计划被拒绝');
    }

    logSubSection('5.2 manager 停用校准计划');
    const deactivateResponse = await axios.post(
      `${BASE_URL}/api/calibration/plans/${createdPlanId}/deactivate`,
      { operator: 'manager_zhang' },
      { headers: headers.manager }
    );
    assert(deactivateResponse.data.data.status === 'inactive', '计划状态变为 inactive');
    assert(deactivateResponse.data.data.deactivatedAt !== undefined, '记录了停用时间');
    assert(deactivateResponse.data.data.deactivatedBy === 'manager_zhang', '记录了停用人');
    log('校准计划停用成功', 'success');

    logSubSection('5.3 停用后导入不应用校准');
    const readingTime3 = now + 5400000;
    const csvBuffer2 = createTestCsv([
      { deviceId: 'DEV_CALIB_001', temperature: 4.0, readingTime: readingTime3 },
    ]);

    const form2 = new FormData();
    form2.append('file', csvBuffer2, { filename: 'calibration_test2.csv', contentType: 'text/csv' });
    form2.append('operator', 'operator_li');

    const importResponse2 = await axios.post(
      `${BASE_URL}/api/readings/import`,
      form2,
      {
        headers: {
          ...headers.operator,
          ...form2.getHeaders(),
        },
      }
    );

    const batchId2 = importResponse2.data.data.batchId;
    const batchDetail2 = await axios.get(
      `${BASE_URL}/api/readings/batches/${batchId2}`,
      { headers: headers.operator }
    );

    const rowAfterDeactivate = batchDetail2.data.data.rowResults.items[0];
    assertAlmostEqual(rowAfterDeactivate.originalTemperature, 4.0, '停用后原始温度正确');
    assertAlmostEqual(rowAfterDeactivate.correctedTemperature, 4.0, '停用后修正后温度等于原始值(无校准)');
    assert(rowAfterDeactivate.calibrationPlanId === null, '停用后无校准计划应用');
    log('停用后导入的新数据不再应用校准', 'success');

    logSubSection('5.4 历史数据保持不变 - 验证撤销前导入的修正结果');
    const correctionsAfterDeactivate = await axios.get(
      `${BASE_URL}/api/calibration/corrections/batch/${createdBatchId}`,
      { headers: headers.operator }
    );
    assert(
      correctionsAfterDeactivate.data.data.length === initialCorrectionCount,
      `历史修正记录数量保持不变 (${initialCorrectionCount}条)`
    );
    log('停用计划后，历史修正结果保持不变', 'success');

    logSubSection('5.5 已停用计划不能重复停用');
    try {
      await axios.post(
        `${BASE_URL}/api/calibration/plans/${createdPlanId}/deactivate`,
        { operator: 'manager_zhang' },
        { headers: headers.manager }
      );
      log('❌ 已停用计划应该不能重复停用', 'error');
      testPassed = false;
    } catch (error) {
      assert(error.response.status === 409, '已停用计划不能重复停用');
    }

    logSubSection('5.6 manager 撤销校准计划');
    const revokeResponse = await axios.post(
      `${BASE_URL}/api/calibration/plans/${createdPlanId}/revoke`,
      { operator: 'manager_zhang' },
      { headers: headers.manager }
    );
    assert(revokeResponse.data.data.status === 'revoked', '计划状态变为 revoked');
    assert(revokeResponse.data.data.revokedAt !== undefined, '记录了撤销时间');
    assert(revokeResponse.data.data.revokedBy === 'manager_zhang', '记录了撤销人');
    log('校准计划撤销成功', 'success');

    logSubSection('5.7 撤销后历史数据仍保持不变');
    const correctionsAfterRevoke = await axios.get(
      `${BASE_URL}/api/calibration/corrections/batch/${createdBatchId}`,
      { headers: headers.operator }
    );
    assert(
      correctionsAfterRevoke.data.data.length === initialCorrectionCount,
      `撤销后历史修正记录数量仍保持不变 (${initialCorrectionCount}条)`
    );

    const batchDetailAfterRevoke = await axios.get(
      `${BASE_URL}/api/readings/batches/${createdBatchId}`,
      { headers: headers.operator }
    );
    const calibratedRowAfterRevoke = batchDetailAfterRevoke.data.data.rowResults.items
      .find(r => r.readingTime === readingTime1);
    assertAlmostEqual(calibratedRowAfterRevoke.correctedTemperature, 6.5, '撤销后历史修正结果仍为6.5℃');
    log('撤销计划后，历史修正结果保持不变', 'success');

    logSection('步骤 6: 重启后状态保持测试');

    logSubSection('6.1 停止服务器');
    await stopServer();
    await delay(2000);

    logSubSection('6.2 重启服务器（不清理数据库）');
    await startServer(true);
    await waitForServer();

    logSubSection('6.3 验证校准计划在重启后仍可查询');
    const planAfterRestart = await axios.get(
      `${BASE_URL}/api/calibration/plans/${createdPlanId}`,
      { headers: headers.viewer }
    );
    assert(planAfterRestart.data.data.status === 'revoked', '重启后计划状态仍为 revoked');
    assert(planAfterRestart.data.data.offsetValue === 1.5, '重启后偏移值正确');
    log('重启后校准计划可查询且状态正确', 'success');

    logSubSection('6.4 验证历史修正记录在重启后仍可查询');
    const correctionsAfterRestart = await axios.get(
      `${BASE_URL}/api/calibration/corrections/batch/${createdBatchId}`,
      { headers: headers.operator }
    );
    assert(
      correctionsAfterRestart.data.data.length === initialCorrectionCount,
      `重启后历史修正记录数量保持不变 (${initialCorrectionCount}条)`
    );
    log('重启后历史修正记录可查询', 'success');

    logSubSection('6.5 验证批次详情在重启后仍包含校准信息');
    const batchAfterRestart = await axios.get(
      `${BASE_URL}/api/readings/batches/${createdBatchId}`,
      { headers: headers.operator }
    );
    const rowAfterRestart = batchAfterRestart.data.data.rowResults.items
      .find(r => r.readingTime === readingTime1);
    assertAlmostEqual(rowAfterRestart.correctedTemperature, 6.5, '重启后历史修正温度仍为6.5℃');
    assert(rowAfterRestart.calibrationPlanId === createdPlanId, '重启后校准计划ID正确');
    log('重启后批次详情仍包含校准信息', 'success');

    logSubSection('6.6 验证审计日志在重启后仍包含校准操作');
    const auditAfterRestart = await axios.get(
      `${BASE_URL}/api/audit/logs`,
      { headers: headers.operator }
    );
    const calibrationCreateLog = auditAfterRestart.data.data.items
      .find(l => l.operationType === 'calibration_plan_create' && l.entityId === createdPlanId);
    assert(calibrationCreateLog !== undefined, '重启后校准创建审计记录存在');

    const calibrationRevokeLog = auditAfterRestart.data.data.items
      .find(l => l.operationType === 'calibration_plan_revoke' && l.entityId === createdPlanId);
    assert(calibrationRevokeLog !== undefined, '重启后校准撤销审计记录存在');
    log('重启后审计日志包含校准操作记录', 'success');

    logSubSection('6.7 验证告警在重启后仍包含校准信息');
    if (createdAlarmId) {
      const alarmAfterRestart = await axios.get(
        `${BASE_URL}/api/alarms/${createdAlarmId}`,
        { headers: headers.operator }
      );
      assertAlmostEqual(alarmAfterRestart.data.data.originalTemperature, 9.0, '重启后告警原始温度正确');
      assert(alarmAfterRestart.data.data.calibrationPlanId === createdPlanId, '重启后告警校准计划ID正确');
      log('重启后告警仍包含校准信息', 'success');
    }

    logSection('步骤 7: 只读权限验证');

    logSubSection('7.1 viewer 可以查看校准计划列表');
    const plansViewer = await axios.get(
      `${BASE_URL}/api/calibration/plans`,
      { headers: headers.viewer }
    );
    assert(plansViewer.data.data.items.length >= 1, 'viewer 可以查看校准计划列表');
    log('viewer 可以查看校准计划列表', 'success');

    logSubSection('7.2 viewer 可以查看校准修正记录');
    const correctionsViewer = await axios.get(
      `${BASE_URL}/api/calibration/corrections`,
      { headers: headers.viewer }
    );
    assert(correctionsViewer.data.data.items.length >= 1, 'viewer 可以查看校准修正记录');
    log('viewer 可以查看校准修正记录', 'success');

    logSubSection('7.3 viewer 可以导出校准数据');
    const exportViewer = await axios.get(
      `${BASE_URL}/api/calibration/export?format=csv`,
      { headers: headers.viewer }
    );
    assert(exportViewer.data.includes(createdPlanId), 'viewer 可以导出校准数据');
    log('viewer 可以导出校准数据', 'success');

    logSubSection('7.4 operator 可以查看但不能修改');
    const plansOperator = await axios.get(
      `${BASE_URL}/api/calibration/plans`,
      { headers: headers.operator }
    );
    assert(plansOperator.data.data.items.length >= 1, 'operator 可以查看校准计划列表');

    try {
      await axios.post(
        `${BASE_URL}/api/calibration/plans`,
        {
          deviceId: 'DEV_CALIB_001',
          offsetValue: 1.0,
          effectiveStartTime: Date.now(),
          reason: 'operator 尝试创建',
          personInCharge: 'admin',
          operator: 'operator_li',
        },
        { headers: headers.operator }
      );
      log('❌ operator 应该不能创建校准计划', 'error');
      testPassed = false;
    } catch (error) {
      assert(error.response.status === 403 || error.response.status === 401, 'operator 不能创建校准计划');
    }
    log('operator 只能查看不能修改校准计划', 'success');

    logSection('测试完成');

    if (testPassed) {
      log('\n🎉 所有测试通过！', 'success');
      log('\n测试覆盖总结：', 'info');
      log('  ✅ 计划冲突：时间段重叠检测', 'info');
      log('  ✅ 权限边界：admin/manager 可管理，operator 可导入，viewer 只读', 'info');
      log('  ✅ 导入修正：CSV 导入时自动应用有效校准', 'info');
      log('  ✅ 导出一致性：CSV/JSON/批次详情/告警/审计日志都包含校准信息', 'info');
      log('  ✅ 撤销后历史保持：停用/撤销计划不修改历史导入结果', 'info');
      log('  ✅ 重启后状态保持：计划、历史修正、审计记录重启后仍可查询', 'info');
    } else {
      log('\n❌ 部分测试失败，请检查日志', 'error');
      process.exit(1);
    }

  } catch (error) {
    console.error('\n❌ 测试执行失败:', error.message);
    if (error.response) {
      console.error('响应状态:', error.response.status);
      console.error('响应数据:', JSON.stringify(error.response.data, null, 2));
    }
    console.error('堆栈:', error.stack);
    testPassed = false;
    process.exit(1);
  } finally {
    await stopServer();
    if (testPassed) {
      log('数据库文件保留供检查: ' + DB_PATH, 'info');
    }
  }
}

runHttpFlow();
