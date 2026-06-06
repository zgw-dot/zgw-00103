const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { execSync, spawn } = require('child_process');

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, 'data', 'cold_chain_test_escalation.db');

const headers = {
  admin: { 'X-User-Id': 'admin' },
  manager: { 'X-User-Id': 'manager_zhang' },
  operator: { 'X-User-Id': 'operator_li' },
  viewer: { 'X-User-Id': 'viewer_wang' },
};

let serverProcess = null;
let testResults = [];

function logTest(name, passed, message = '') {
  const status = passed ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name}`);
  if (message && !passed) {
    console.log(`       ${message}`);
  }
  testResults.push({ name, passed, message });
  return passed;
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupDatabase() {
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    console.log('Cleaned up test database');
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
        setTimeout(resolve, 3000);
      } else {
        serverProcess.kill('SIGINT');
        serverProcess.on('exit', () => {
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

async function runTests() {
  console.log('\n=== 告警升级和值班派单模块回归测试 ===\n');

  try {
    console.log('Starting server...');
    await startServer();
    await waitForServer();
    console.log('Server is ready!\n');

    await testSetupData();
    await testRuleCreationValidation();
    await testDuplicateRule();
    await testPermissionBoundary();
    await testDeactivateAndRevokeRule();
    await testAlarmEscalationTrigger();
    await testClaimTicket();
    await testExportConsistency();
    await testEscalationStatusInAlarms();
    await testAuditLogging();

    console.log('\n--- 重启后状态保持测试 ---');
    await stopServer();
    console.log('Server stopped, restarting...');
    await delay(5000);
    await startServer(true);
    await waitForServer();
    console.log('Server restarted!\n');

    await testPersistenceAfterRestart();

  } catch (error) {
    console.error('Test suite failed:', error.message);
    logTest('Test suite', false, error.message);
  } finally {
    await stopServer();
    cleanupDatabase();
  }

  printSummary();
}

async function testSetupData() {
  console.log('--- 初始化测试数据 ---');

  try {
    await axios.post(`${BASE_URL}/api/devices`, {
      id: 'DEV_ESC_001',
      name: '升级测试设备1',
      storeId: 'STORE_ESC_001',
      storeName: '升级测试门店1',
      status: 'active',
    }, { headers: headers.admin });

    await axios.post(`${BASE_URL}/api/devices`, {
      id: 'DEV_ESC_002',
      name: '升级测试设备2',
      storeId: 'STORE_ESC_002',
      storeName: '升级测试门店2',
      status: 'inactive',
    }, { headers: headers.admin });

    logTest('创建设备数据', true);
  } catch (error) {
    logTest('创建设备数据', false, error.response?.data?.message || error.message);
  }
}

async function testRuleCreationValidation() {
  console.log('\n--- 规则创建验证测试 ---');

  try {
    const invalidTimeout = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '无效时限规则',
      scope: 'default',
      acknowledgeTimeoutSeconds: 0,
      assigneeUserId: 'operator_li',
      operator: 'admin',
    }, { headers: headers.admin }).catch(e => e);

    logTest('无效时限(0秒)被拒绝',
      invalidTimeout.response?.status === 400,
      invalidTimeout.response?.data?.message);

    const invalidAssignee = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '无效处理人规则',
      scope: 'default',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'nonexistent_user',
      operator: 'admin',
    }, { headers: headers.admin }).catch(e => e);

    logTest('无效处理人被拒绝',
      invalidAssignee.response?.status === 400,
      invalidAssignee.response?.data?.message);

    const inactiveDevice = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '停用设备规则',
      scope: 'device',
      deviceId: 'DEV_ESC_002',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'operator_li',
      operator: 'admin',
    }, { headers: headers.admin }).catch(e => e);

    logTest('停用设备不能创建规则',
      inactiveDevice.response?.status === 400,
      inactiveDevice.response?.data?.message);

    const nonexistentDevice = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '不存在设备规则',
      scope: 'device',
      deviceId: 'DEV_NONEXISTENT',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'operator_li',
      operator: 'admin',
    }, { headers: headers.admin }).catch(e => e);

    logTest('不存在设备不能创建规则',
      nonexistentDevice.response?.status === 400,
      nonexistentDevice.response?.data?.message);

    const storeWithoutId = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '无门店ID规则',
      scope: 'store',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'operator_li',
      operator: 'admin',
    }, { headers: headers.admin }).catch(e => e);

    logTest('门店范围必须指定门店ID',
      storeWithoutId.response?.status === 400,
      storeWithoutId.response?.data?.message);

    const validDefault = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '默认升级规则',
      scope: 'default',
      acknowledgeTimeoutSeconds: 2,
      assigneeUserId: 'operator_li',
      operator: 'admin',
    }, { headers: headers.admin });

    logTest('创建默认范围规则成功', validDefault.data.success);

    const validStore = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '门店升级规则',
      scope: 'store',
      storeId: 'STORE_ESC_001',
      acknowledgeTimeoutSeconds: 2,
      assigneeUserId: 'manager_zhang',
      operator: 'admin',
    }, { headers: headers.admin });

    logTest('创建门店范围规则成功', validStore.data.success);

    const validDevice = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '设备升级规则',
      scope: 'device',
      deviceId: 'DEV_ESC_001',
      acknowledgeTimeoutSeconds: 2,
      assigneeUserId: 'operator_li',
      operator: 'admin',
    }, { headers: headers.admin });

    logTest('创建设备范围规则成功', validDevice.data.success);

  } catch (error) {
    logTest('规则创建验证测试', false, error.message);
  }
}

async function testDuplicateRule() {
  console.log('\n--- 重复规则测试 ---');

  try {
    const duplicateDefault = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '重复默认规则',
      scope: 'default',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'manager_zhang',
      operator: 'admin',
    }, { headers: headers.admin }).catch(e => e);

    logTest('重复默认范围规则被拒绝',
      duplicateDefault.response?.status === 409,
      duplicateDefault.response?.data?.message);

    const duplicateStore = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '重复门店规则',
      scope: 'store',
      storeId: 'STORE_ESC_001',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'admin',
      operator: 'admin',
    }, { headers: headers.admin }).catch(e => e);

    logTest('重复门店范围规则被拒绝',
      duplicateStore.response?.status === 409,
      duplicateStore.response?.data?.message);

    const duplicateDevice = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '重复设备规则',
      scope: 'device',
      deviceId: 'DEV_ESC_001',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'admin',
      operator: 'admin',
    }, { headers: headers.admin }).catch(e => e);

    logTest('重复设备范围规则被拒绝',
      duplicateDevice.response?.status === 409,
      duplicateDevice.response?.data?.message);

  } catch (error) {
    logTest('重复规则测试', false, error.message);
  }
}

async function testPermissionBoundary() {
  console.log('\n--- 权限边界测试 ---');

  try {
    const viewerCreateRule = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: 'viewer创建规则',
      scope: 'default',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'operator_li',
      operator: 'viewer_wang',
    }, { headers: headers.viewer }).catch(e => e);

    logTest('viewer不能创建规则',
      viewerCreateRule.response?.status === 403,
      viewerCreateRule.response?.data?.message);

    const operatorCreateRule = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: 'operator创建规则',
      scope: 'default',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'operator_li',
      operator: 'operator_li',
    }, { headers: headers.operator }).catch(e => e);

    logTest('operator不能创建规则',
      operatorCreateRule.response?.status === 403,
      operatorCreateRule.response?.data?.message);

    const managerCreateRule = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: 'manager创建规则',
      scope: 'store',
      storeId: 'STORE_ESC_002',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'operator_li',
      operator: 'manager_zhang',
    }, { headers: headers.manager });

    logTest('manager可以创建规则', managerCreateRule.data.success);

    const viewerViewRules = await axios.get(`${BASE_URL}/api/escalation/rules`, { headers: headers.viewer });
    logTest('viewer可以查看规则', viewerViewRules.data.success);

    const operatorViewRules = await axios.get(`${BASE_URL}/api/escalation/rules`, { headers: headers.operator });
    logTest('operator可以查看规则', operatorViewRules.data.success);

    const viewerDeactivate = await axios.post(`${BASE_URL}/api/escalation/rules/${managerCreateRule.data.data.id}/deactivate`,
      { operator: 'viewer_wang' }, { headers: headers.viewer }).catch(e => e);
    logTest('viewer不能停用规则',
      viewerDeactivate.response?.status === 403,
      viewerDeactivate.response?.data?.message);

    const operatorDeactivate = await axios.post(`${BASE_URL}/api/escalation/rules/${managerCreateRule.data.data.id}/deactivate`,
      { operator: 'operator_li' }, { headers: headers.operator }).catch(e => e);
    logTest('operator不能停用规则',
      operatorDeactivate.response?.status === 403,
      operatorDeactivate.response?.data?.message);

    const managerDeactivate = await axios.post(`${BASE_URL}/api/escalation/rules/${managerCreateRule.data.data.id}/deactivate`,
      { operator: 'manager_zhang' }, { headers: headers.manager });
    logTest('manager可以停用规则', managerDeactivate.data.success);

  } catch (error) {
    logTest('权限边界测试', false, error.message);
  }
}

async function testDeactivateAndRevokeRule() {
  console.log('\n--- 停用和撤销规则测试 ---');

  try {
    const createResult = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '待撤销测试规则',
      scope: 'store',
      storeId: 'STORE_ESC_002',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'operator_li',
      operator: 'admin',
    }, { headers: headers.admin });

    const ruleId = createResult.data.data.id;

    const deactivatedRule = await axios.post(`${BASE_URL}/api/escalation/rules/${ruleId}/deactivate`,
      { operator: 'admin' }, { headers: headers.admin });
    logTest('停用规则成功', deactivatedRule.data.data.status === 'inactive');

    const reactivateAttempt = await axios.post(`${BASE_URL}/api/escalation/rules/${ruleId}/deactivate`,
      { operator: 'admin' }, { headers: headers.admin }).catch(e => e);
    logTest('已停用规则不能重复停用',
      reactivateAttempt.response?.status === 409,
      reactivateAttempt.response?.data?.message);

    const revokedRule = await axios.post(`${BASE_URL}/api/escalation/rules/${ruleId}/revoke`,
      { operator: 'admin' }, { headers: headers.admin });
    logTest('撤销规则成功', revokedRule.data.data.status === 'revoked');

    const rulesAfterRevoke = await axios.get(`${BASE_URL}/api/escalation/rules`, { headers: headers.admin });
    const revokedRuleInList = rulesAfterRevoke.data.data.items.find(r => r.id === ruleId);
    logTest('撤销规则后仍能查询到历史记录', !!revokedRuleInList);

    const duplicateAfterRevoke = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: '撤销后新规则',
      scope: 'store',
      storeId: 'STORE_ESC_002',
      acknowledgeTimeoutSeconds: 300,
      assigneeUserId: 'operator_li',
      operator: 'admin',
    }, { headers: headers.admin });
    logTest('撤销规则后可以创建同范围新规则', duplicateAfterRevoke.data.success);

  } catch (error) {
    logTest('停用和撤销规则测试', false, error.message);
  }
}

async function testAlarmEscalationTrigger() {
  console.log('\n--- 告警超时升级触发测试 ---');
  process.stdout.write('DEBUG: Starting testAlarmEscalationTrigger\n');

  try {
    // 先检查当前的规则
    const rulesCheck = await axios.get(`${BASE_URL}/api/escalation/rules?ruleStatus=active`, { headers: headers.admin });
    console.log('Active rules before import:', JSON.stringify(rulesCheck.data.data.items.map(r => ({
      id: r.id, name: r.name, scope: r.scope, storeId: r.storeId, deviceId: r.deviceId, timeout: r.acknowledgeTimeoutSeconds
    })), null, 2));

    const now = new Date();
    const readingTime = now.toISOString().slice(0, 19).replace('T', ' ');
    console.log('Using readingTime:', readingTime);
    
    const csvContent = 'deviceId,temperature,readingTime\n' +
      `DEV_ESC_001,-30,${readingTime}\n`;

    const formData = new FormData();
    formData.append('file', Buffer.from(csvContent), {
      filename: 'test_temperatures.csv',
      contentType: 'text/csv',
    });
    formData.append('operator', 'admin');

    console.log('Sending import request...');
    let importResult;
    try {
      importResult = await axios.post(`${BASE_URL}/api/readings/import`,
        formData, {
          headers: {
            ...headers.admin,
            ...formData.getHeaders(),
          },
        });
      console.log('Import result:', JSON.stringify(importResult.data, null, 2));
    } catch (e) {
      console.log('Import error status:', e.response?.status);
      console.log('Import error data:', JSON.stringify(e.response?.data, null, 2));
      throw e;
    }

    logTest('导入异常温度数据成功', importResult.data.success);

    const alarmsBefore = await axios.get(`${BASE_URL}/api/alarms?alarmStatus=open`, { headers: headers.admin });
    const testAlarm = alarmsBefore.data.data.items.find(a => a.deviceId === 'DEV_ESC_001');
    logTest('open告警已创建', !!testAlarm);

    if (testAlarm) {
      console.log('  Alarm createdAt:', testAlarm.createdAt, '(', new Date(testAlarm.createdAt).toLocaleString('zh-CN'), ')');
      console.log('  Current time:', Date.now(), '(', new Date().toLocaleString('zh-CN'), ')');
      console.log('  Time diff (seconds):', Math.floor((Date.now() - testAlarm.createdAt) / 1000));
    }

    await delay(3000);

    let processResult;
    try {
      processResult = await axios.post(`${BASE_URL}/api/escalation/process-overdue`, { operator: 'admin' }, { headers: headers.admin });
      console.log('Process-overdue success:', processResult.data);
    } catch (e) {
      console.log('Process-overdue error:', e.response?.status, e.response?.data || e.message);
      processResult = e;
    }
    logTest('处理超时告警成功', processResult.data?.success, processResult.response?.data?.message || processResult.message);
    logTest('已生成升级单', processResult.data?.data?.createdCount >= 1);

    const tickets = await axios.get(`${BASE_URL}/api/escalation/tickets`, { headers: headers.admin });
    const testTicket = tickets.data.data.items.find(t => t.alarmId === testAlarm?.id);
    logTest('升级单已创建', !!testTicket);
    logTest('升级单状态为待领取', testTicket?.status === 'pending');
    logTest('升级单指派给正确处理人', testTicket?.assigneeUserId === 'operator_li');

  } catch (error) {
    logTest('告警超时升级触发测试', false, error.message);
  }
}

async function testClaimTicket() {
  console.log('\n--- 领取派单测试 ---');

  try {
    const tickets = await axios.get(`${BASE_URL}/api/escalation/tickets?ticketStatus=pending`, { headers: headers.admin });
    const pendingTicket = tickets.data.data.items[0];

    if (!pendingTicket) {
      logTest('领取派单测试', false, '没有待领取的升级单');
      return;
    }

    const viewerClaim = await axios.post(`${BASE_URL}/api/escalation/tickets/${pendingTicket.id}/claim`,
      { operator: 'viewer_wang' }, { headers: headers.viewer }).catch(e => e);
    logTest('viewer不能领取派单',
      viewerClaim.response?.status === 403,
      viewerClaim.response?.data?.message);

    const operatorClaim = await axios.post(`${BASE_URL}/api/escalation/tickets/${pendingTicket.id}/claim`,
      { operator: 'operator_li' }, { headers: headers.operator });
    logTest('operator可以领取派单', operatorClaim.data.success);
    logTest('领取后状态变为已领取', operatorClaim.data.data.status === 'claimed');
    logTest('领取人正确', operatorClaim.data.data.claimedBy === 'operator_li');

    const duplicateClaim = await axios.post(`${BASE_URL}/api/escalation/tickets/${pendingTicket.id}/claim`,
      { operator: 'manager_zhang' }, { headers: headers.manager }).catch(e => e);
    logTest('已领取的派单不能重复领取',
      duplicateClaim.response?.status === 409,
      duplicateClaim.response?.data?.message);

  } catch (error) {
    logTest('领取派单测试', false, error.message);
  }
}

async function testExportConsistency() {
  console.log('\n--- 导出一致性测试 ---');

  try {
    const tickets = await axios.get(`${BASE_URL}/api/escalation/tickets`, { headers: headers.admin });
    const ticketCount = tickets.data.data.total;

    const csvExport = await axios.get(`${BASE_URL}/api/escalation/export?format=csv`, { headers: headers.admin, responseType: 'text' });
    logTest('CSV导出成功', csvExport.status === 200);
    logTest('CSV包含表头和数据', csvExport.data.includes('升级单ID') && csvExport.data.includes('\n'));

    const jsonExport = await axios.get(`${BASE_URL}/api/escalation/export?format=json`, { headers: headers.admin, responseType: 'text' });
    logTest('JSON导出成功', jsonExport.status === 200);

    const jsonData = JSON.parse(jsonExport.data);
    logTest('JSON导出数据数量一致', jsonData.length === ticketCount);

    const filteredExport = await axios.get(`${BASE_URL}/api/escalation/export?format=csv&ticketStatus=claimed`, { headers: headers.admin, responseType: 'text' });
    const csvLines = filteredExport.data.split('\n');
    const dataLines = csvLines.slice(1).filter(line => line.trim());
    logTest('筛选导出功能正常', dataLines.length === 1);

  } catch (error) {
    logTest('导出一致性测试', false, error.message);
  }
}

async function testEscalationStatusInAlarms() {
  console.log('\n--- 告警中升级状态展示测试 ---');

  try {
    const alarms = await axios.get(`${BASE_URL}/api/alarms`, { headers: headers.admin });
    const alarmWithEscalation = alarms.data.data.items.find(a => a.escalationStatus !== null);

    logTest('告警列表包含升级状态字段', 'escalationStatus' in alarms.data.data.items[0]);
    logTest('已升级告警显示升级状态', !!alarmWithEscalation);
    logTest('升级状态字段正确', alarmWithEscalation?.escalationStatus === 'claimed');
    logTest('包含升级单ID', !!alarmWithEscalation?.escalationTicketId);
    logTest('包含规则名称', !!alarmWithEscalation?.escalationRuleName);

    const alarmDetail = await axios.get(`${BASE_URL}/api/alarms/${alarmWithEscalation.id}`, { headers: headers.admin });
    logTest('告警详情也包含升级信息', alarmDetail.data.data.escalationStatus === 'claimed');

  } catch (error) {
    logTest('告警中升级状态展示测试', false, error.message);
  }
}

async function testAuditLogging() {
  console.log('\n--- 审计日志测试 ---');

  try {
    const auditLogs = await axios.get(`${BASE_URL}/api/audit/logs`, { headers: headers.admin });
    const logs = auditLogs.data.data.items;

    const ruleCreateLogs = logs.filter(l => l.operationType === 'escalation_rule_create');
    logTest('规则创建审计日志存在', ruleCreateLogs.length > 0);

    const ticketCreateLogs = logs.filter(l => l.operationType === 'escalation_ticket_create');
    logTest('升级单创建审计日志存在', ticketCreateLogs.length > 0);

    const ticketClaimLogs = logs.filter(l => l.operationType === 'escalation_ticket_claim');
    logTest('升级单领取审计日志存在', ticketClaimLogs.length > 0);

    const ruleRevokeLogs = logs.filter(l => l.operationType === 'escalation_rule_revoke');
    logTest('规则撤销审计日志存在', ruleRevokeLogs.length > 0);

    const ticketLog = ticketCreateLogs[0];
    logTest('升级单日志包含告警ID', !!ticketLog.alarmId);
    logTest('升级单日志包含设备ID', !!ticketLog.deviceId);

  } catch (error) {
    logTest('审计日志测试', false, error.message);
  }
}

async function testPersistenceAfterRestart() {
  console.log('\n--- 重启后状态保持测试 ---');

  try {
    const rules = await axios.get(`${BASE_URL}/api/escalation/rules`, { headers: headers.admin });
    logTest('重启后规则数据保留', rules.data.data.items.length > 0);

    const revokedRule = rules.data.data.items.find(r => r.status === 'revoked');
    logTest('重启后撤销状态保持', !!revokedRule);

    const tickets = await axios.get(`${BASE_URL}/api/escalation/tickets`, { headers: headers.admin });
    logTest('重启后升级单数据保留', tickets.data.data.items.length > 0);

    const claimedTicket = tickets.data.data.items.find(t => t.status === 'claimed');
    logTest('重启后领取状态保持', !!claimedTicket);

    const alarms = await axios.get(`${BASE_URL}/api/alarms`, { headers: headers.admin });
    const alarmWithEscalation = alarms.data.data.items.find(a => a.escalationStatus !== null);
    logTest('重启后告警升级状态保持', !!alarmWithEscalation);

    const auditLogs = await axios.get(`${BASE_URL}/api/audit/logs`, { headers: headers.admin });
    logTest('重启后审计日志保留', auditLogs.data.data.items.length > 0);

  } catch (error) {
    logTest('重启后状态保持测试', false, error.message);
  }
}

function printSummary() {
  const passed = testResults.filter(r => r.passed).length;
  const total = testResults.length;

  console.log('\n=== 测试总结 ===');
  console.log(`总测试数: ${total}`);
  console.log(`通过: ${passed}`);
  console.log(`失败: ${total - passed}`);
  console.log(`通过率: ${((passed / total) * 100).toFixed(2)}%`);

  if (total > passed) {
    console.log('\n失败的测试:');
    testResults.filter(r => !r.passed).forEach(r => {
      console.log(`  - ${r.name}: ${r.message}`);
    });
    process.exit(1);
  } else {
    console.log('\n所有测试通过!');
    process.exit(0);
  }
}

runTests();
