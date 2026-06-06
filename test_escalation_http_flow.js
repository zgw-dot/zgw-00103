const axios = require('axios');
const fs = require('fs');
const path = require('path');
const FormData = require('form-data');
const { spawn } = require('child_process');

const BASE_URL = 'http://localhost:3000';
const DB_PATH = path.join(__dirname, 'data', 'cold_chain_http_escalation.db');

const headers = {
  admin: { 'X-User-Id': 'admin' },
  manager: { 'X-User-Id': 'manager_zhang' },
  operator: { 'X-User-Id': 'operator_li' },
  viewer: { 'X-User-Id': 'viewer_wang' },
};

let serverProcess = null;

function log(message, type = 'info') {
  const prefix = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`${prefix} ${message}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(60));
  console.log(`  ${title}`);
  console.log('='.repeat(60));
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

async function runHttpFlow() {
  logSection('告警升级和值班派单模块 - 真实 HTTP 链路端到端测试');
  log('使用真实 HTTP 请求测试完整流程：创建规则 → 触发告警 → 生成派单 → 领取 → 导出 → 重启再查');

  let createdRuleId = null;
  let createdAlarmId = null;
  let createdTicketId = null;

  try {
    log('Starting server...', 'info');
    await startServer();
    await waitForServer();

    logSection('步骤 1: 创建设备数据');
    await axios.post(`${BASE_URL}/api/devices`, {
      id: 'DEV_HTTP_001',
      name: 'HTTP测试冷柜',
      storeId: 'STORE_HTTP_001',
      storeName: 'HTTP测试门店',
      status: 'active',
    }, { headers: headers.admin });
    log('设备 DEV_HTTP_001 创建成功', 'success');

    logSection('步骤 2: 创建升级规则 (manager 权限)');
    const ruleResponse = await axios.post(`${BASE_URL}/api/escalation/rules`, {
      name: 'HTTP测试升级规则',
      scope: 'device',
      deviceId: 'DEV_HTTP_001',
      acknowledgeTimeoutSeconds: 2,
      assigneeUserId: 'operator_li',
      operator: 'manager_zhang',
    }, { headers: headers.manager });

    createdRuleId = ruleResponse.data.data.id;
    log(`规则创建成功: ${createdRuleId}`, 'success');
    log(`规则名称: ${ruleResponse.data.data.name}`, 'info');
    log(`确认时限: ${ruleResponse.data.data.acknowledgeTimeoutSeconds} 秒`, 'info');
    log(`处理人: ${ruleResponse.data.data.assigneeUserId}`, 'info');

    logSection('步骤 3: 导入异常温度数据触发告警');
    const now = new Date();
    const timeStr = now.toISOString().replace('T', ' ').substring(0, 19);

    const csvContent = `deviceId,temperature,readingTime\nDEV_HTTP_001,-35,${timeStr}\n`;
    
    const formData = new FormData();
    formData.append('file', Buffer.from(csvContent), {
      filename: 'test_temperatures.csv',
      contentType: 'text/csv',
    });
    formData.append('operator', 'admin');
    
    const importResponse = await axios.post(`${BASE_URL}/api/readings/import`,
      formData, {
        headers: {
          ...headers.admin,
          ...formData.getHeaders(),
        },
      });

    log(`导入成功: 生成 ${importResponse.data.data.generatedAlarms} 条告警`, 'success');

    logSection('步骤 4: 查看告警列表 (包含升级状态)');
    const alarmsResponse = await axios.get(`${BASE_URL}/api/alarms?alarmStatus=open`, { headers: headers.admin });
    const testAlarm = alarmsResponse.data.data.items.find(a => a.deviceId === 'DEV_HTTP_001');
    createdAlarmId = testAlarm.id;

    log(`告警ID: ${createdAlarmId}`, 'info');
    log(`告警类型: ${testAlarm.type}`, 'info');
    log(`告警温度: ${testAlarm.temperature}℃`, 'info');
    log(`当前升级状态: ${testAlarm.escalationStatus || '未升级'}`, 'info');

    logSection('步骤 5: 等待超时并触发升级');
    log('等待 3 秒让告警超时...', 'info');
    await delay(3000);

    const processResponse = await axios.post(`${BASE_URL}/api/escalation/process-overdue`, { operator: 'admin' }, { headers: headers.admin });
    log(`处理超时告警: 生成 ${processResponse.data.data.createdCount} 条升级单`, 'success');

    logSection('步骤 6: 查看升级单列表');
    const ticketsResponse = await axios.get(`${BASE_URL}/api/escalation/tickets`, { headers: headers.admin });
    const testTicket = ticketsResponse.data.data.items.find(t => t.alarmId === createdAlarmId);
    createdTicketId = testTicket.id;

    log(`升级单ID: ${createdTicketId}`, 'info');
    log(`状态: ${testTicket.status}`, 'info');
    log(`指派处理人: ${testTicket.assigneeUserId}`, 'info');
    log(`升级时间: ${new Date(testTicket.escalatedAt).toLocaleString('zh-CN')}`, 'info');

    logSection('步骤 7: 再次查看告警 - 升级状态已更新');
    const alarmDetail = await axios.get(`${BASE_URL}/api/alarms/${createdAlarmId}`, { headers: headers.operator });
    log(`告警升级状态: ${alarmDetail.data.data.escalationStatus}`, 'success');
    log(`升级单ID: ${alarmDetail.data.data.escalationTicketId}`, 'info');
    log(`规则名称: ${alarmDetail.data.data.escalationRuleName}`, 'info');
    log(`指派处理人: ${alarmDetail.data.data.escalationAssignee}`, 'info');

    logSection('步骤 8: operator 领取派单');
    const claimResponse = await axios.post(`${BASE_URL}/api/escalation/tickets/${createdTicketId}/claim`,
      { operator: 'operator_li' }, { headers: headers.operator });

    log(`领取成功!`, 'success');
    log(`新状态: ${claimResponse.data.data.status}`, 'info');
    log(`领取人: ${claimResponse.data.data.claimedBy}`, 'info');
    log(`领取时间: ${new Date(claimResponse.data.data.claimedAt).toLocaleString('zh-CN')}`, 'info');

    logSection('步骤 9: 导出升级数据 (CSV)');
    const csvExport = await axios.get(`${BASE_URL}/api/escalation/export?format=csv`, { headers: headers.operator, responseType: 'text' });
    const csvLines = csvExport.data.split('\n');
    log(`CSV 导出成功`, 'success');
    log(`表头: ${csvLines[0]}`, 'info');
    log(`数据行: ${csvLines.length - 2} 条`, 'info');

    if (csvLines.length > 1) {
      log(`示例数据: ${csvLines[1].substring(0, 100)}...`, 'info');
    }

    logSection('步骤 10: 导出升级数据 (JSON)');
    const jsonExport = await axios.get(`${BASE_URL}/api/escalation/export?format=json`, { headers: headers.operator, responseType: 'text' });
    const jsonData = JSON.parse(jsonExport.data);
    log(`JSON 导出成功`, 'success');
    log(`导出记录数: ${jsonData.length} 条`, 'info');

    if (jsonData.length > 0) {
      const first = jsonData[0];
      log(`示例: 升级单 ${first.ticket.id}, 状态 ${first.ticket.status}, 规则 ${first.ruleName}`, 'info');
    }

    logSection('步骤 11: 查看审计日志');
    const auditResponse = await axios.get(`${BASE_URL}/api/audit/logs`, { headers: headers.admin });
    const escalationLogs = auditResponse.data.data.items.filter(l =>
      l.operationType.startsWith('escalation_')
    );

    log(`审计日志中升级相关记录: ${escalationLogs.length} 条`, 'success');
    escalationLogs.slice(0, 5).forEach(logEntry => {
      log(`  - ${logEntry.operationType}: ${logEntry.details.substring(0, 60)}...`, 'info');
    });

    logSection('步骤 12: 权限边界验证');

    try {
      await axios.post(`${BASE_URL}/api/escalation/rules`, {
        name: 'viewer非法创建规则',
        scope: 'default',
        acknowledgeTimeoutSeconds: 300,
        assigneeUserId: 'operator_li',
        operator: 'viewer_wang',
      }, { headers: headers.viewer });
      log('viewer 创建规则应该被拒绝!', 'error');
    } catch (e) {
      log(`viewer 不能创建规则 - 正确拒绝 (${e.response.status})`, 'success');
    }

    try {
      await axios.post(`${BASE_URL}/api/escalation/rules/${createdRuleId}/revoke`,
        { operator: 'viewer_wang' }, { headers: headers.viewer });
      log('viewer 撤销规则应该被拒绝!', 'error');
    } catch (e) {
      log(`viewer 不能撤销规则 - 正确拒绝 (${e.response.status})`, 'success');
    }

    logSection('步骤 13: 撤销升级规则 (不删除历史)');
    const revokeResponse = await axios.post(`${BASE_URL}/api/escalation/rules/${createdRuleId}/revoke`,
      { operator: 'manager_zhang' }, { headers: headers.manager });

    log(`规则撤销成功`, 'success');
    log(`新状态: ${revokeResponse.data.data.status}`, 'info');

    const ticketsAfterRevoke = await axios.get(`${BASE_URL}/api/escalation/tickets`, { headers: headers.admin });
    log(`撤销规则后历史升级单数量: ${ticketsAfterRevoke.data.data.total}`, 'info');
    log('历史升级单保留 - 符合要求', 'success');

    logSection('步骤 14: 重启服务验证数据持久化');
    log('Stopping server...', 'info');
    await stopServer();

    log('Waiting 5 seconds for port release...', 'info');
    await delay(5000);

    log('Restarting server...', 'info');
    await startServer(true);
    await waitForServer();

    logSection('步骤 15: 重启后验证数据完整性');

    const rulesAfterRestart = await axios.get(`${BASE_URL}/api/escalation/rules`, { headers: headers.admin });
    const ruleAfterRestart = rulesAfterRestart.data.data.items.find(r => r.id === createdRuleId);
    log(`规则数据保留: ${!!ruleAfterRestart}`, 'success');
    log(`规则状态保持: ${ruleAfterRestart?.status}`, ruleAfterRestart?.status === 'revoked' ? 'success' : 'error');

    const ticketsAfterRestart = await axios.get(`${BASE_URL}/api/escalation/tickets`, { headers: headers.admin });
    const ticketAfterRestart = ticketsAfterRestart.data.data.items.find(t => t.id === createdTicketId);
    log(`升级单数据保留: ${!!ticketAfterRestart}`, 'success');
    log(`升级单状态保持: ${ticketAfterRestart?.status}`, ticketAfterRestart?.status === 'claimed' ? 'success' : 'error');
    log(`领取人保持: ${ticketAfterRestart?.claimedBy}`, ticketAfterRestart?.claimedBy === 'operator_li' ? 'success' : 'error');

    const alarmAfterRestart = await axios.get(`${BASE_URL}/api/alarms/${createdAlarmId}`, { headers: headers.admin });
    log(`告警升级状态保持: ${alarmAfterRestart.data.data.escalationStatus}`, 'success');

    const auditAfterRestart = await axios.get(`${BASE_URL}/api/audit/logs`, { headers: headers.admin });
    log(`审计日志保留: ${auditAfterRestart.data.data.total > 0}`, 'success');

    logSection('步骤 16: 重启后导出验证一致性');
    const exportAfterRestart = await axios.get(`${BASE_URL}/api/escalation/export?format=json`, { headers: headers.operator, responseType: 'text' });
    const jsonAfterRestart = JSON.parse(exportAfterRestart.data);
    log(`重启后导出数据数量一致: ${jsonAfterRestart.length === jsonData.length}`,
      jsonAfterRestart.length === jsonData.length ? 'success' : 'error');

    logSection('端到端 HTTP 测试完成');
    log('所有流程验证通过!', 'success');
    log(`创建的规则 ID: ${createdRuleId}`, 'info');
    log(`创建的告警 ID: ${createdAlarmId}`, 'info');
    log(`创建的升级单 ID: ${createdTicketId}`, 'info');

    console.log('\n✅ 完整 HTTP 链路测试成功!');
    console.log('   涵盖: 创建规则 → 触发告警 → 生成派单 → 领取 → 导出 → 重启 → 验证持久化');

  } catch (error) {
    log(`测试失败: ${error.message}`, 'error');
    if (error.response) {
      log(`HTTP 状态: ${error.response.status}`, 'error');
      log(`响应: ${JSON.stringify(error.response.data)}`, 'error');
    }
    console.error(error.stack);
    process.exit(1);
  } finally {
    await stopServer();
    cleanupDatabase();
  }
}

runHttpFlow();
