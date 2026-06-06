const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const FormData = require('form-data');

const BASE_URL = 'http://localhost:3001';
const DB_PATH = path.join(__dirname, 'data', 'cold_chain_inspection_identity.db');

const headers = {
  admin: { 'X-User-Id': 'admin' },
  manager: { 'X-User-Id': 'manager_zhang' },
  operator: { 'X-User-Id': 'operator_li' },
  viewer: { 'X-User-Id': 'viewer_wang' },
};

let serverProcess = null;
let passCount = 0;
let failCount = 0;
let createdTemplateId = null;
let createdRecordId = null;
let createdDeviceId = 'IDENTITY_TEST_FRIDGE_001';
let createdDeviceId2 = 'IDENTITY_TEST_FREEZER_002';
let createdDeviceId3 = 'IDENTITY_TEST_DISABLED_003';
let crossStoreDeviceId = 'IDENTITY_TEST_CROSS_STORE_004';

let beforeRestart = {
  templateCount: 0,
  recordCount: 0,
  templateStatus: null,
  recordStatus: null,
};

function log(message, type = 'info') {
  const prefix = type === 'success' ? '✅' : type === 'error' ? '❌' : type === 'warn' ? '⚠️' : 'ℹ️';
  console.log(`${prefix} ${message}`);
}

function logSection(title) {
  console.log('\n' + '='.repeat(70));
  console.log(`  ${title}`);
  console.log('='.repeat(70));
}

function logSubSection(title) {
  console.log('\n' + '-'.repeat(58));
  console.log(`  ${title}`);
  console.log('-'.repeat(58));
}

function testResult(name, passed, actual, expected) {
  if (passed) {
    passCount++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    console.log(`  ❌ ${name}`);
    if (actual !== undefined && expected !== undefined) {
      console.log(`    Expected: ${JSON.stringify(expected)}`);
      console.log(`    Actual:   ${JSON.stringify(actual)}`);
    }
  }
}

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupDatabase() {
  if (fs.existsSync(DB_PATH)) {
    fs.unlinkSync(DB_PATH);
    log('Cleaned up test database', 'info');
  }
  const tmpPath = DB_PATH + '.tmp';
  if (fs.existsSync(tmpPath)) {
    fs.unlinkSync(tmpPath);
  }
}

function startServer(skipCleanup = false) {
  return new Promise((resolve, reject) => {
    if (!skipCleanup) {
      cleanupDatabase();
    }

    const env = { ...process.env, DB_PATH, PORT: '3001', NODE_ENV: 'test' };
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
      if (output.includes('Server started on port 3001') && !serverReady) {
        serverReady = true;
        log('Server started successfully', 'success');
        resolve(serverProcess);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const errMsg = data.toString();
      if (errMsg.includes('Error') || errMsg.includes('error')) {
        // Ignore noise during startup
      }
    });

    setTimeout(() => {
      if (!serverReady) {
        console.error('Server output:', output);
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
        setTimeout(() => {
          log('Server stopped', 'info');
          resolve();
        }, 1000);
      }
    } else {
      resolve();
    }
  });
}

async function assertError(requestPromise, expectedCode, expectedMsg, description) {
  try {
    await requestPromise;
    log(`❌ ${description}: 期望 ${expectedCode}，但请求成功`, 'error');
    failCount++;
    return false;
  } catch (error) {
    const response = error.response;
    if (!response) {
      log(`❌ ${description}: 无响应 - ${error.message}`, 'error');
      failCount++;
      return false;
    }
    const actualCode = response.status;
    const actualMessage = response.data?.message || '';
    const codeMatch = actualCode === expectedCode;
    const msgMatch = actualMessage.includes(expectedMsg);
    if (codeMatch && msgMatch) {
      log(`✅ ${description}: 正确返回 ${expectedCode}`, 'success');
      passCount++;
      return true;
    } else {
      log(`❌ ${description}: 期望 ${expectedCode} "${expectedMsg}", 实际 ${actualCode} "${actualMessage}"`, 'error');
      failCount++;
      return false;
    }
  }
}

async function assertSuccess(requestPromise, description) {
  try {
    const response = await requestPromise;
    if (response.data && response.data.success) {
      log(`✅ ${description}: 成功`, 'success');
      passCount++;
      return response.data.data;
    } else {
      log(`❌ ${description}: 响应未标记成功`, 'error');
      failCount++;
      return null;
    }
  } catch (error) {
    const msg = error.response?.data?.message || error.message;
    log(`❌ ${description}: 失败 - ${msg}`, 'error');
    failCount++;
    return null;
  }
}

async function setupTestData() {
  logSubSection('Setup: 创建测试设备');

  await axios.post(`${BASE_URL}/api/devices`, {
    id: createdDeviceId,
    name: '身份测试冷藏柜001',
    storeId: 'STORE_001',
    storeName: '门店001',
    status: 'active',
  }, { headers: headers.admin });
  log(`创建设备 ${createdDeviceId} 成功`, 'info');

  await axios.post(`${BASE_URL}/api/devices`, {
    id: createdDeviceId2,
    name: '身份测试冷冻柜002',
    storeId: 'STORE_001',
    storeName: '门店001',
    status: 'active',
  }, { headers: headers.admin });
  log(`创建设备 ${createdDeviceId2} 成功`, 'info');

  await axios.post(`${BASE_URL}/api/devices`, {
    id: createdDeviceId3,
    name: '身份测试停用设备003',
    storeId: 'STORE_001',
    storeName: '门店001',
    status: 'inactive',
  }, { headers: headers.admin });
  log(`创建设备 ${createdDeviceId3} 成功`, 'info');

  await axios.post(`${BASE_URL}/api/devices`, {
    id: crossStoreDeviceId,
    name: '跨门店设备004',
    storeId: 'STORE_002',
    storeName: '门店002',
    status: 'active',
  }, { headers: headers.admin });
  log(`创建设备 ${crossStoreDeviceId} (门店002) 成功`, 'info');

  const tempDir = require('os').tmpdir();
  const tempFile = path.join(tempDir, `identity_test_${Date.now()}.csv`);
  const now = Date.now();
  const csvContent = `deviceId,temperature,readingTime\n${createdDeviceId},5.0,${new Date(now - 300000).toISOString().replace('T', ' ').substring(0, 19)}\n`;
  fs.writeFileSync(tempFile, csvContent);

  const form = new FormData();
  form.append('file', fs.createReadStream(tempFile), { filename: 'test.csv' });
  form.append('operator', 'operator_li');

  await axios.post(`${BASE_URL}/api/readings/import`, form, {
    headers: {
      ...headers.admin,
      ...form.getHeaders(),
    },
  });
  log(`创建 ${createdDeviceId} 温度读数成功`, 'info');

  fs.unlinkSync(tempFile);
  await delay(100);
}

async function runTests() {
  logSection('巡检模块身份识别与权限 - 回归测试');

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const futureWindow = { startTime: '08:00', endTime: '23:59' };
  const pastWindow = { startTime: '00:00', endTime: '01:00' };

  // ========== Step 1: 无请求头测试 ==========
  logSection('Step 1: 无 X-User-Id 请求头测试 - 所有接口必须返回稳定错误');

  const noHeaderTests = [
    { name: '创建模板(POST /templates)', method: 'post', url: '/templates', data: { name: 'test', storeId: 'STORE_001', storeName: '门店001', shift: 'morning', date: Date.now(), devices: [{ deviceId: 'fake', timeWindow: futureWindow, photoRequirement: { minCount: 0, required: false }, remarkRequirement: { minLength: 0, required: false }, personInCharge: 'operator_li', sortOrder: 0 }] } },
    { name: '查询模板列表(GET /templates)', method: 'get', url: '/templates' },
    { name: '查询单个模板(GET /templates/xxx)', method: 'get', url: '/templates/fake-id' },
    { name: '发布模板(POST /templates/xxx/publish)', method: 'post', url: '/templates/fake-id/publish', data: { reason: 'test' } },
    { name: '关闭模板(POST /templates/xxx/close)', method: 'post', url: '/templates/fake-id/close', data: { reason: 'test' } },
    { name: '撤销模板(POST /templates/xxx/revoke)', method: 'post', url: '/templates/fake-id/revoke', data: { reason: 'test' } },
    { name: '提交巡检(POST /records/submit)', method: 'post', url: '/records/submit', data: { templateId: 'fake', deviceId: 'fake', photos: [], remark: '' } },
    { name: '查询巡检列表(GET /records)', method: 'get', url: '/records' },
    { name: '查询单个记录(GET /records/xxx)', method: 'get', url: '/records/fake-id' },
    { name: '查询统计(GET /stats/counts)', method: 'get', url: '/stats/counts' },
    { name: '导出(GET /export)', method: 'get', url: '/export' },
  ];

  for (const test of noHeaderTests) {
    logSubSection(`1.${noHeaderTests.indexOf(test) + 1} ${test.name} - 无请求头`);
    try {
      const config = { method: test.method, url: `${BASE_URL}/api/inspection${test.url}` };
      if (test.data) config.data = test.data;
      await axios(config);
      testResult(test.name + ' - 无请求头应失败', false, 'success', 'error');
    } catch (error) {
      const code = error.response?.status;
      const msg = error.response?.data?.message || '';
      const codeOk = code === 403;
      const msgOk = msg.includes('缺失 X-User-Id') || msg.includes('无法识别当前用户身份');
      testResult(test.name + ` - 返回 403 且包含稳定错误信息 (${code})`, codeOk && msgOk, msg, '包含"缺失 X-User-Id"');
    }
  }

  // ========== Step 2: body 伪造身份测试 ==========
  logSection('Step 2: Body 伪造身份测试 - body.operator 必须被完全忽略');

  logSubSection('2.1 viewer 在 body 伪造 manager_zhang 尝试创建模板');
  const forgedCreate = await assertError(
    axios.post(`${BASE_URL}/api/inspection/templates`, {
      name: '伪造身份创建模板',
      storeId: 'STORE_001',
      storeName: '门店001',
      shift: 'morning',
      date: today.getTime(),
      devices: [{
        deviceId: createdDeviceId,
        timeWindow: futureWindow,
        photoRequirement: { minCount: 0, required: false },
        remarkRequirement: { minLength: 0, required: false },
        personInCharge: 'operator_li',
        sortOrder: 0,
      }],
      operator: 'manager_zhang',
    }, { headers: headers.viewer }),
    403, '没有', 'viewer 伪造 manager 创建模板被拒绝'
  );

  logSubSection('2.2 viewer 在 body 伪造 admin 尝试发布模板');
  const draftTemplate = await assertSuccess(
    axios.post(`${BASE_URL}/api/inspection/templates`, {
      name: '待发布测试模板',
      storeId: 'STORE_001',
      storeName: '门店001',
      shift: 'afternoon',
      date: today.getTime(),
      devices: [{
        deviceId: createdDeviceId,
        timeWindow: futureWindow,
        photoRequirement: { minCount: 0, required: false },
        remarkRequirement: { minLength: 0, required: false },
        personInCharge: 'operator_li',
        sortOrder: 0,
      }],
    }, { headers: headers.manager }),
    'manager 创建草稿模板'
  );

  if (draftTemplate) {
    const forgedPublish = await assertError(
      axios.post(`${BASE_URL}/api/inspection/templates/${draftTemplate.id}/publish`, {
        reason: '伪造身份发布',
        operator: 'admin',
      }, { headers: headers.viewer }),
      403, '没有', 'viewer 伪造 admin 发布模板被拒绝'
    );
  }

  logSubSection('2.3 viewer 在 body 伪造 operator_li 尝试提交巡检');
  if (draftTemplate) {
    await assertSuccess(
      axios.post(`${BASE_URL}/api/inspection/templates/${draftTemplate.id}/publish`, {}, { headers: headers.manager }),
      'manager 发布模板'
    );
    createdTemplateId = draftTemplate.id;
  }

  if (createdTemplateId) {
    const forgedSubmit = await assertError(
      axios.post(`${BASE_URL}/api/inspection/records/submit`, {
        templateId: createdTemplateId,
        deviceId: createdDeviceId,
        photos: ['photo1.jpg'],
        remark: '伪造身份提交巡检',
        operator: 'operator_li',
      }, { headers: headers.viewer }),
      403, '没有', 'viewer 伪造 operator 提交巡检被拒绝'
    );
  }

  // ========== Step 3: 低权限写入失败测试 ==========
  logSection('Step 3: 低权限写入失败测试');

  logSubSection('3.1 operator 尝试创建模板 - 期望 403');
  await assertError(
    axios.post(`${BASE_URL}/api/inspection/templates`, {
      name: 'operator越权创建',
      storeId: 'STORE_001',
      storeName: '门店001',
      shift: 'evening',
      date: today.getTime(),
      devices: [{
        deviceId: createdDeviceId,
        timeWindow: futureWindow,
        photoRequirement: { minCount: 0, required: false },
        remarkRequirement: { minLength: 0, required: false },
        personInCharge: 'operator_li',
        sortOrder: 0,
      }],
    }, { headers: headers.operator }),
    403, '没有', 'operator 创建模板被拒绝'
  );

  logSubSection('3.2 viewer 尝试关闭模板 - 期望 403');
  if (createdTemplateId) {
    await assertError(
      axios.post(`${BASE_URL}/api/inspection/templates/${createdTemplateId}/close`, {
        reason: 'viewer越权关闭',
      }, { headers: headers.viewer }),
      403, '没有', 'viewer 关闭模板被拒绝'
    );
  }

  logSubSection('3.3 operator 尝试撤销模板 - 期望 403');
  if (createdTemplateId) {
    await assertError(
      axios.post(`${BASE_URL}/api/inspection/templates/${createdTemplateId}/revoke`, {
        reason: 'operator越权撤销',
      }, { headers: headers.operator }),
      403, '没有', 'operator 撤销模板被拒绝'
    );
  }

  // ========== Step 4: 正常创建发布提交测试 ==========
  logSection('Step 4: 正常创建→发布→提交 完整流程');

  logSubSection('4.1 manager 正常创建模板');
  const normalTemplate = await assertSuccess(
    axios.post(`${BASE_URL}/api/inspection/templates`, {
      name: '正常流程测试模板',
      storeId: 'STORE_001',
      storeName: '门店001',
      shift: 'morning',
      date: today.getTime(),
      devices: [
        {
          deviceId: createdDeviceId,
          timeWindow: futureWindow,
          photoRequirement: { minCount: 1, required: true },
          remarkRequirement: { minLength: 10, required: true },
          personInCharge: 'operator_li',
          sortOrder: 0,
        },
        {
          deviceId: createdDeviceId2,
          timeWindow: futureWindow,
          photoRequirement: { minCount: 0, required: false },
          remarkRequirement: { minLength: 0, required: false },
          personInCharge: 'operator_li',
          sortOrder: 1,
        }
      ],
      operator: 'this_should_be_ignored',
    }, { headers: headers.manager }),
    'manager 创建模板成功'
  );

  if (normalTemplate) {
    testResult('创建人正确 (manager_zhang)', normalTemplate.createdBy === 'manager_zhang', normalTemplate.createdBy, 'manager_zhang');
    testResult('body.operator 被忽略', normalTemplate.createdBy !== 'this_should_be_ignored', normalTemplate.createdBy, '!= this_should_be_ignored');
  }

  logSubSection('4.2 manager 发布模板');
  let publishedTemplate = null;
  if (normalTemplate) {
    publishedTemplate = await assertSuccess(
      axios.post(`${BASE_URL}/api/inspection/templates/${normalTemplate.id}/publish`, {
        reason: '正式发布',
        operator: 'fake_operator_in_body',
      }, { headers: headers.manager }),
      'manager 发布模板成功'
    );
    if (publishedTemplate) {
      testResult('模板状态为 published', publishedTemplate.status === 'published', publishedTemplate.status, 'published');
      testResult('发布人正确 (manager_zhang)', publishedTemplate.publishedBy === 'manager_zhang', publishedTemplate.publishedBy, 'manager_zhang');
      createdTemplateId = normalTemplate.id;
    }
  }

  logSubSection('4.3 operator 正常提交巡检');
  if (createdTemplateId) {
    const record = await assertSuccess(
      axios.post(`${BASE_URL}/api/inspection/records/submit`, {
        templateId: createdTemplateId,
        deviceId: createdDeviceId,
        photos: ['photo1.jpg', 'photo2.jpg'],
        remark: '这是一条正常的巡检备注，长度足够满足要求',
        operator: 'fake_operator_in_body',
      }, { headers: headers.operator }),
      'operator 提交巡检成功'
    );
    if (record) {
      testResult('提交人正确 (operator_li)', record.submittedBy === 'operator_li', record.submittedBy, 'operator_li');
      testResult('body.operator 被忽略', record.submittedBy !== 'fake_operator_in_body', record.submittedBy, '!= fake_operator_in_body');
      testResult('巡检状态为 submitted', record.status === 'submitted', record.status, 'submitted');
      createdRecordId = record.id;
    }
  }

  logSubSection('4.4 重复提交检测');
  if (createdTemplateId) {
    await assertError(
      axios.post(`${BASE_URL}/api/inspection/records/submit`, {
        templateId: createdTemplateId,
        deviceId: createdDeviceId,
        photos: ['photo3.jpg'],
        remark: '重复提交测试',
      }, { headers: headers.operator }),
      409, '已经提交过巡检', '重复提交被拒绝'
    );
  }

  logSubSection('4.5 非负责人提交检测');
  if (createdTemplateId) {
    await assertError(
      axios.post(`${BASE_URL}/api/inspection/records/submit`, {
        templateId: createdTemplateId,
        deviceId: createdDeviceId2,
        photos: [],
        remark: '',
      }, { headers: headers.manager }),
      403, '不是', '非负责人提交被拒绝'
    );
  }

  logSubSection('4.6 停用设备提交检测');
  if (createdTemplateId) {
    await assertError(
      axios.post(`${BASE_URL}/api/inspection/templates`, {
        name: '停用设备测试模板',
        storeId: 'STORE_001',
        storeName: '门店001',
        shift: 'night',
        date: today.getTime(),
        devices: [{
          deviceId: createdDeviceId3,
          timeWindow: futureWindow,
          photoRequirement: { minCount: 0, required: false },
          remarkRequirement: { minLength: 0, required: false },
          personInCharge: 'operator_li',
          sortOrder: 0,
        }],
      }, { headers: headers.manager }),
      400, '已停用', '停用设备添加到模板被拒绝'
    );
  }

  logSubSection('4.7 跨门店设备检测');
  await assertError(
    axios.post(`${BASE_URL}/api/inspection/templates`, {
      name: '跨门店设备测试模板',
      storeId: 'STORE_001',
      storeName: '门店001',
      shift: 'morning',
      date: today.getTime() + 86400000,
      devices: [{
        deviceId: crossStoreDeviceId,
        timeWindow: futureWindow,
        photoRequirement: { minCount: 0, required: false },
        remarkRequirement: { minLength: 0, required: false },
        personInCharge: 'operator_li',
        sortOrder: 0,
      }],
    }, { headers: headers.manager }),
    400, '不匹配', '跨门店设备被拒绝'
  );

  // ========== Step 5: 查询和导出测试 ==========
  logSection('Step 5: 查询与导出测试');

  logSubSection('5.1 viewer 查询模板列表');
  const templateList = await assertSuccess(
    axios.get(`${BASE_URL}/api/inspection/templates?storeId=STORE_001`, { headers: headers.viewer }),
    'viewer 查询模板列表成功'
  );
  if (templateList) {
    const count = templateList.items?.length || templateList.length || 0;
    testResult('查询到模板数据', count > 0, count, '> 0');
  }

  logSubSection('5.2 operator 查询巡检记录');
  const recordList = await assertSuccess(
    axios.get(`${BASE_URL}/api/inspection/records?storeId=STORE_001`, { headers: headers.operator }),
    'operator 查询巡检记录成功'
  );
  if (recordList) {
    const count = recordList.items?.length || recordList.length || 0;
    testResult('查询到巡检记录', count > 0, count, '> 0');
  }

  logSubSection('5.3 查询统计数据');
  const stats = await assertSuccess(
    axios.get(`${BASE_URL}/api/inspection/stats/counts`, { headers: headers.viewer }),
    'viewer 查询统计成功'
  );
  if (stats) {
    testResult('统计包含已发布模板', stats.publishedTemplates >= 1, stats.publishedTemplates, '>= 1');
    testResult('统计包含已提交巡检', stats.submittedInspections >= 1, stats.submittedInspections, '>= 1');
  }

  logSubSection('5.4 导出巡检记录为 CSV');
  try {
    const csvResp = await axios.get(`${BASE_URL}/api/inspection/export?type=records&format=csv&storeId=STORE_001`, {
      headers: headers.viewer,
      responseType: 'text',
    });
    const isCsv = csvResp.headers['content-type']?.includes('csv');
    const hasContent = csvResp.data.length > 0;
    const hasHeader = csvResp.data.includes('巡检记录ID') && csvResp.data.includes('提交人');
    testResult('CSV 导出成功 (Content-Type 正确)', isCsv, csvResp.headers['content-type'], 'text/csv');
    testResult('CSV 内容非空', hasContent, csvResp.data.length, '> 0');
    testResult('CSV 包含正确表头', hasHeader, csvResp.data.substring(0, 100), '包含巡检记录ID,提交人');
  } catch (error) {
    testResult('CSV 导出异常: ' + error.message, false);
  }

  logSubSection('5.5 导出巡检记录为 JSON');
  try {
    const jsonResp = await axios.get(`${BASE_URL}/api/inspection/export?type=records&format=json&storeId=STORE_001`, {
      headers: headers.viewer,
    });
    const isJson = jsonResp.headers['content-type']?.includes('json');
    const items = jsonResp.data?.items || jsonResp.data?.data?.items || [];
    const hasData = items.length > 0;
    testResult('JSON 导出成功 (Content-Type 正确)', isJson, jsonResp.headers['content-type'], 'application/json');
    testResult('JSON 包含数据', hasData, items.length, '> 0');
  } catch (error) {
    testResult('JSON 导出异常: ' + error.message, false);
  }

  logSubSection('5.6 导出模板为 CSV');
  try {
    const tplCsvResp = await axios.get(`${BASE_URL}/api/inspection/export?type=templates&format=csv`, {
      headers: headers.viewer,
      responseType: 'text',
    });
    const isCsv = tplCsvResp.headers['content-type']?.includes('csv');
    const hasContent = tplCsvResp.data.length > 0;
    const hasHeader = tplCsvResp.data.includes('模板ID') && tplCsvResp.data.includes('创建人');
    testResult('模板 CSV 导出成功', isCsv && hasContent && hasHeader, tplCsvResp.data.length, '> 0');
  } catch (error) {
    testResult('模板 CSV 导出异常: ' + error.message, false);
  }

  logSubSection('5.7 无权限导出测试 - 未知用户');
  await assertError(
    axios.get(`${BASE_URL}/api/inspection/export?type=records&format=csv`, {
      headers: { 'X-User-Id': 'unknown_user' },
    }),
    403, '没有', '未知用户导出被拒绝'
  );

  // ========== Step 6: 关闭/撤销后历史记录不变测试 ==========
  logSection('Step 6: 关闭/撤销后历史记录保持不变');

  logSubSection('6.1 manager 关闭模板');
  let closedTemplate = null;
  if (createdTemplateId) {
    closedTemplate = await assertSuccess(
      axios.post(`${BASE_URL}/api/inspection/templates/${createdTemplateId}/close`, {
        reason: '测试关闭，历史记录应保持不变',
      }, { headers: headers.manager }),
      'manager 关闭模板成功'
    );
    if (closedTemplate) {
      testResult('模板状态为 closed', closedTemplate.status === 'closed', closedTemplate.status, 'closed');
      testResult('关闭人正确 (manager_zhang)', closedTemplate.closedBy === 'manager_zhang', closedTemplate.closedBy, 'manager_zhang');
    }
  }

  logSubSection('6.3 验证关闭后历史记录不变');
  if (createdRecordId) {
    const recordAfterClose = await assertSuccess(
      axios.get(`${BASE_URL}/api/inspection/records/${createdRecordId}`, { headers: headers.operator }),
      '查询关闭后的历史记录'
    );
    if (recordAfterClose) {
      testResult('历史记录状态保持 submitted', recordAfterClose.status === 'submitted', recordAfterClose.status, 'submitted');
      testResult('历史记录提交人不变', recordAfterClose.submittedBy === 'operator_li', recordAfterClose.submittedBy, 'operator_li');
    }
  }

  logSubSection('6.4 创建并撤销模板');
  const revokeTemplate = await assertSuccess(
    axios.post(`${BASE_URL}/api/inspection/templates`, {
      name: '待撤销测试模板',
      storeId: 'STORE_001',
      storeName: '门店001',
      shift: 'night',
      date: today.getTime(),
      devices: [{
        deviceId: createdDeviceId2,
        timeWindow: futureWindow,
        photoRequirement: { minCount: 0, required: false },
        remarkRequirement: { minLength: 0, required: false },
        personInCharge: 'operator_li',
        sortOrder: 0,
      }],
    }, { headers: headers.manager }),
    '创建待撤销模板'
  );

  if (revokeTemplate) {
    await assertSuccess(
      axios.post(`${BASE_URL}/api/inspection/templates/${revokeTemplate.id}/publish`, {}, { headers: headers.manager }),
      '发布待撤销模板'
    );

    const revokedTemplate = await assertSuccess(
      axios.post(`${BASE_URL}/api/inspection/templates/${revokeTemplate.id}/revoke`, {
        reason: '测试撤销，历史记录保持不变',
      }, { headers: headers.manager }),
      'manager 撤销模板成功'
    );
    if (revokedTemplate) {
      testResult('模板状态为 revoked', revokedTemplate.status === 'revoked', revokedTemplate.status, 'revoked');
      testResult('撤销人正确 (manager_zhang)', revokedTemplate.revokedBy === 'manager_zhang', revokedTemplate.revokedBy, 'manager_zhang');
    }
  }

  // ========== Step 7: 迟到检测 ==========
  logSection('Step 7: 迟到检测');

  logSubSection('7.1 创建已过期时间窗模板并提交');
  const lateTemplate = await assertSuccess(
    axios.post(`${BASE_URL}/api/inspection/templates`, {
      name: '迟到检测模板',
      storeId: 'STORE_001',
      storeName: '门店001',
      shift: 'morning',
      date: today.getTime(),
      devices: [{
        deviceId: createdDeviceId2,
        timeWindow: pastWindow,
        photoRequirement: { minCount: 0, required: false },
        remarkRequirement: { minLength: 0, required: false },
        personInCharge: 'operator_li',
        sortOrder: 0,
      }],
    }, { headers: headers.manager }),
    '创建迟到检测模板'
  );

  if (lateTemplate) {
    await assertSuccess(
      axios.post(`${BASE_URL}/api/inspection/templates/${lateTemplate.id}/publish`, {}, { headers: headers.manager }),
      '发布迟到检测模板'
    );

    const lateSubmit = await assertSuccess(
      axios.post(`${BASE_URL}/api/inspection/records/submit`, {
        templateId: lateTemplate.id,
        deviceId: createdDeviceId2,
        photos: [],
        remark: '迟到提交',
      }, { headers: headers.operator }),
      '提交迟到巡检'
    );
    if (lateSubmit) {
      testResult('正确标记为迟到 (isLate=true)', lateSubmit.isLate === true, lateSubmit.isLate, true);
      testResult('状态为 late', lateSubmit.status === 'late', lateSubmit.status, 'late');
      testResult('lateMinutes > 0', lateSubmit.lateMinutes > 0, lateSubmit.lateMinutes, '> 0');
    }
  }

  // ========== Step 8: 重启后数据一致测试 ==========
  logSection('Step 8: 同一 DB_PATH 重启后数据一致');

  logSubSection('8.1 保存重启前数据');
  const templatesBefore = await axios.get(`${BASE_URL}/api/inspection/templates`, { headers: headers.admin });
  const recordsBefore = await axios.get(`${BASE_URL}/api/inspection/records`, { headers: headers.admin });
  beforeRestart.templateCount = templatesBefore.data.data?.items?.length || templatesBefore.data.data?.length || 0;
  beforeRestart.recordCount = recordsBefore.data.data?.items?.length || recordsBefore.data.data?.length || 0;
  log(`重启前: 模板=${beforeRestart.templateCount}, 记录=${beforeRestart.recordCount}`, 'info');

  if (createdTemplateId) {
    const tplBefore = await axios.get(`${BASE_URL}/api/inspection/templates/${createdTemplateId}`, { headers: headers.admin });
    beforeRestart.templateStatus = tplBefore.data.data?.status || tplBefore.data?.data?.status;
  }
  if (createdRecordId) {
    const recBefore = await axios.get(`${BASE_URL}/api/inspection/records/${createdRecordId}`, { headers: headers.admin });
    beforeRestart.recordStatus = recBefore.data.data?.status || recBefore.data?.data?.status;
  }

  logSubSection('8.2 停止服务器');
  await stopServer();
  await delay(2000);

  logSubSection('8.3 重启服务器（相同 DB_PATH）');
  await startServer(true);
  await delay(1000);

  logSubSection('8.4 验证重启后模板数量一致');
  const templatesAfter = await assertSuccess(
    axios.get(`${BASE_URL}/api/inspection/templates`, { headers: headers.admin }),
    '重启后查询模板列表'
  );
  if (templatesAfter) {
    const count = templatesAfter.items?.length || templatesAfter.length || 0;
    testResult(`重启后模板数量一致 (${count} == ${beforeRestart.templateCount})`, count === beforeRestart.templateCount, count, beforeRestart.templateCount);
  }

  logSubSection('8.5 验证重启后巡检记录数量一致');
  const recordsAfter = await assertSuccess(
    axios.get(`${BASE_URL}/api/inspection/records`, { headers: headers.admin }),
    '重启后查询巡检记录'
  );
  if (recordsAfter) {
    const count = recordsAfter.items?.length || recordsAfter.length || 0;
    testResult(`重启后记录数量一致 (${count} == ${beforeRestart.recordCount})`, count === beforeRestart.recordCount, count, beforeRestart.recordCount);
  }

  logSubSection('8.6 验证重启后关闭的模板仍保持关闭');
  if (createdTemplateId) {
    const closedAfter = await assertSuccess(
      axios.get(`${BASE_URL}/api/inspection/templates/${createdTemplateId}`, { headers: headers.viewer }),
      '重启后查询已关闭模板'
    );
    if (closedAfter) {
      testResult('模板状态保持 closed', closedAfter.status === 'closed', closedAfter.status, 'closed');
      testResult('关闭人保持不变', closedAfter.closedBy === 'manager_zhang', closedAfter.closedBy, 'manager_zhang');
      testResult('关闭原因保持不变', !!closedAfter.closedReason, closedAfter.closedReason, '非空');
    }
  }

  logSubSection('8.7 验证重启后巡检记录内容一致');
  if (createdRecordId) {
    const recordAfter = await assertSuccess(
      axios.get(`${BASE_URL}/api/inspection/records/${createdRecordId}`, { headers: headers.viewer }),
      '重启后查询巡检记录'
    );
    if (recordAfter) {
      testResult('记录状态保持不变', recordAfter.status === beforeRestart.recordStatus, recordAfter.status, beforeRestart.recordStatus);
      testResult('提交人保持不变', recordAfter.submittedBy === 'operator_li', recordAfter.submittedBy, 'operator_li');
      testResult('照片数量保持不变', recordAfter.photos?.length === 2, recordAfter.photos?.length, 2);
    }
  }

  logSubSection('8.8 验证重启后导出功能正常');
  try {
    const exportAfter = await axios.get(`${BASE_URL}/api/inspection/export?type=records&format=csv`, {
      headers: headers.viewer,
      responseType: 'text',
    });
    testResult('重启后 CSV 导出功能正常', exportAfter.data.length > 0, exportAfter.data.length, '> 0');
  } catch (error) {
    testResult('重启后导出异常: ' + error.message, false);
  }

  logSubSection('8.9 验证重启后审计日志可查');
  const auditAfter = await assertSuccess(
    axios.get(`${BASE_URL}/api/audit/logs?operationType=inspection_template_close`, { headers: headers.admin }),
    '重启后查询审计日志'
  );
  if (auditAfter) {
    const logs = auditAfter.items || auditAfter.data?.items || auditAfter.data || [];
    testResult('重启后审计日志可查询', Array.isArray(logs) && logs.length > 0, logs.length, '> 0');
  }

  // ========== Step 9: 角色权限边界验证 ==========
  logSection('Step 9: 角色权限边界综合验证');

  const roleTests = [
    { role: 'admin', header: headers.admin, canManage: true, canSubmit: true, canView: true, canExport: true },
    { role: 'manager', header: headers.manager, canManage: true, canSubmit: true, canView: true, canExport: true },
    { role: 'operator', header: headers.operator, canManage: false, canSubmit: true, canView: true, canExport: true },
    { role: 'viewer', header: headers.viewer, canManage: false, canSubmit: false, canView: true, canExport: true },
  ];

  for (const roleTest of roleTests) {
    logSubSection(`9.${roleTests.indexOf(roleTest) + 1} ${roleTest.role} 权限验证`);

    const canCreate = async () => {
      try {
        const resp = await axios.post(`${BASE_URL}/api/inspection/templates`, {
          name: `权限测试_${roleTest.role}`,
          storeId: 'STORE_001',
          storeName: '门店001',
          shift: 'morning',
          date: Date.now(),
          devices: [{
            deviceId: createdDeviceId,
            timeWindow: futureWindow,
            photoRequirement: { minCount: 0, required: false },
            remarkRequirement: { minLength: 0, required: false },
            personInCharge: 'operator_li',
            sortOrder: 0,
          }],
        }, { headers: roleTest.header });
        return resp.data.success;
      } catch { return false; }
    };

    const canView = async () => {
      try {
        const resp = await axios.get(`${BASE_URL}/api/inspection/templates`, { headers: roleTest.header });
        return resp.data.success;
      } catch { return false; }
    };

    const canExport = async () => {
      try {
        const resp = await axios.get(`${BASE_URL}/api/inspection/export?type=records&format=csv`, { headers: roleTest.header });
        return resp.status === 200 && resp.data.length > 0;
      } catch { return false; }
    };

    const results = await Promise.all([canCreate(), canView(), canExport()]);

    let rolePassed = true;
    if (results[0] !== roleTest.canManage) {
      log(`❌ ${roleTest.role} 创建模板权限: 期望${roleTest.canManage}, 实际${results[0]}`, 'error');
      rolePassed = false;
      failCount++;
    } else { passCount++; }
    if (results[1] !== roleTest.canView) {
      log(`❌ ${roleTest.role} 查看权限: 期望${roleTest.canView}, 实际${results[1]}`, 'error');
      rolePassed = false;
      failCount++;
    } else { passCount++; }
    if (results[2] !== roleTest.canExport) {
      log(`❌ ${roleTest.role} 导出权限: 期望${roleTest.canExport}, 实际${results[2]}`, 'error');
      rolePassed = false;
      failCount++;
    } else { passCount++; }

    if (rolePassed) {
      log(`✅ ${roleTest.role} 所有权限边界正确`, 'success');
    }
  }

  // ========== 测试结果汇总 ==========
  logSection('测试结果汇总');
  console.log(`\n  📊 通过: ${passCount}  |  失败: ${failCount}  |  总计: ${passCount + failCount}`);
  console.log(`  📈 通过率: ${((passCount / (passCount + failCount)) * 100).toFixed(1)}%\n`);

  if (failCount > 0) {
    log(`${failCount} 个测试失败`, 'error');
    process.exitCode = 1;
  } else {
    log('所有测试通过！🎉', 'success');
    process.exitCode = 0;
  }
}

async function main() {
  console.log('\n' + '🚀'.repeat(20));
  console.log('  巡检模块身份识别与权限 - 回归测试');
  console.log('  覆盖: 无请求头 → body伪造 → 低权限 → 正常流程 → 导出 → 重启一致性');
  console.log('🚀'.repeat(20) + '\n');

  try {
    log('启动服务器...', 'info');
    await startServer();
    await delay(1000);

    log('准备测试数据...', 'info');
    await setupTestData();

    await runTests();

  } catch (error) {
    log(`主流程异常: ${error.message}`, 'error');
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    await stopServer();
    cleanupDatabase();
  }
}

main();
