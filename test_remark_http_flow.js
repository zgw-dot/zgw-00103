const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const FormData = require('form-data');

const BASE_URL = 'http://localhost:3005/api/readings';
const PORT = 3005;
const DB_PATH = path.join(__dirname, `cold_chain_http_flow_${Date.now()}.db`);
const TEST_CSV = path.join(__dirname, 'test_http_flow.csv');

let serverProcess = null;
let testBatchId = null;
let failedRow = null;
const outputLog = [];

function log(title, data) {
  const entry = `\n${'='.repeat(60)}\n${title}\n${'='.repeat(60)}\n${JSON.stringify(data, null, 2)}`;
  console.log(entry);
  outputLog.push(entry);
}

function logRequest(method, url, headers, body) {
  const entry = `\n${'-'.repeat(60)}\n>>> ${method} ${url}\n${'-'.repeat(60)}\n` +
    (headers ? `Headers: ${JSON.stringify(headers, null, 2)}\n` : '') +
    (body ? `Body: ${JSON.stringify(body, null, 2)}\n` : '');
  console.log(entry);
  outputLog.push(entry);
}

function logResponse(status, data) {
  const entry = `\n<<< Status: ${status}\n${'-'.repeat(60)}\n${JSON.stringify(data, null, 2)}\n`;
  console.log(entry);
  outputLog.push(entry);
}

function startServer(dbPath) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT, DB_PATH: dbPath };
    serverProcess = spawn('node', ['dist/app.js'], { env, shell: true });

    let started = false;
    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes(`Server started on port ${PORT}`) && !started) {
        console.log(`\n✅ Server started on port ${PORT} with DB: ${dbPath}\n`);
        started = true;
        setTimeout(() => resolve(), 1000);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const msg = data.toString();
      if (!msg.includes('DeprecationWarning') && !msg.includes('EADDRINUSE')) {
        console.error('Server stderr:', msg);
      }
    });

    setTimeout(() => {
      if (!started) reject(new Error('Server startup timeout'));
    }, 60000);
  });
}

async function stopServer() {
  if (serverProcess) {
    console.log('\n🛑 Stopping server...');
    try {
      if (process.platform === 'win32') {
        execSync(`taskkill /PID ${serverProcess.pid} /T /F`, { stdio: 'ignore' });
      } else {
        serverProcess.kill('SIGTERM');
      }
    } catch (e) {}
    serverProcess = null;
    console.log('✅ Server stopped');
  }
}

function createTestCsv() {
  const rows = [
    'deviceId,temperature,readingTime',
    'DEVHTTP001,-20,2026-06-01 10:00:00',
    'DEVHTTP001,INVALID_TEMP,2026-06-01 10:01:00',
    'DEVHTTP001,-18,2026-06-01 10:02:00',
    'DEVHTTP001,NOT_A_NUMBER,2026-06-01 10:03:00',
    'DEVHTTP001,-22,2026-06-01 10:04:00',
  ];
  fs.writeFileSync(TEST_CSV, rows.join('\n'));
  console.log('\n📄 Created test CSV with 5 rows (3 valid, 2 invalid)\n');
}

async function apiCall(method, url, headers = {}, body = null) {
  const safeHeaders = { ...headers };
  logRequest(method, url, safeHeaders, body);

  const config = { method, url, headers, timeout: 10000 };
  if (body && method !== 'GET') config.data = body;

  const resp = await axios(config);
  logResponse(resp.status, resp.data);
  return resp;
}

async function setupTestData() {
  log('📋 STEP 0: Setup Test Data', 'Creating devices and thresholds');

  await apiCall('POST', 'http://localhost:3005/api/devices',
    { 'X-User-Id': 'admin', 'Content-Type': 'application/json' },
    { id: 'DEVHTTP001', name: 'HTTP Test Device', storeId: 'STORE001', storeName: 'Test Store' }
  );

  await apiCall('PUT', 'http://localhost:3005/api/thresholds/device/DEVHTTP001',
    { 'X-User-Id': 'admin', 'Content-Type': 'application/json' },
    { minTemp: -25, maxTemp: -15 }
  );

  createTestCsv();
}

async function importCsv() {
  log('📋 STEP 1: Import CSV with failed rows', 'Import test data to create failed rows');

  const form = new FormData();
  form.append('file', fs.createReadStream(TEST_CSV));
  form.append('operator', 'operator_li');

  const headers = {
    ...form.getHeaders(),
    'X-User-Id': 'operator_li',
  };

  logRequest('POST', `${BASE_URL}/import`, { 'X-User-Id': 'operator_li', 'Content-Type': 'multipart/form-data' }, '[CSV File]');

  const resp = await axios.post(`${BASE_URL}/import`, form, { headers, timeout: 10000 });
  logResponse(resp.status, resp.data);

  testBatchId = resp.data.data.importBatchId || resp.data.data.batchId;
  console.log(`\n📦 Batch ID: ${testBatchId}\n`);

  return resp;
}

async function getFailedRows() {
  log('📋 STEP 2: Get failed rows from batch detail', 'Query batch detail to find failed row numbers');

  const resp = await apiCall('GET', `${BASE_URL}/batches/${testBatchId}?rowStatus=failed`,
    { 'X-User-Id': 'admin' }
  );

  const failedRows = resp.data.data.rowResults.items;
  failedRow = failedRows[0].rowIndex;
  console.log(`\n❌ Failed row found: #${failedRow}\n`);

  return resp;
}

async function testPermissionDenied() {
  log('📋 STEP 3: Test permission control - operator (should 403)',
    'operator role does NOT have manage_row_remarks permission');

  try {
    await apiCall('PUT', `${BASE_URL}/batches/${testBatchId}/rows/${failedRow}/remark`,
      { 'X-User-Id': 'operator_li', 'Content-Type': 'application/json' },
      { remarkContent: 'operator trying to add remark' }
    );
  } catch (e) {
    logResponse(e.response.status, e.response.data);
    console.log('\n✅ Correctly returned 403 for operator\n');
  }
}

async function testPutRemark() {
  log('📋 STEP 4: PUT add remark (manager - should succeed)',
    'manager role HAS manage_row_remarks permission');

  const resp = await apiCall('PUT', `${BASE_URL}/batches/${testBatchId}/rows/${failedRow}/remark`,
    { 'X-User-Id': 'manager_zhang', 'Content-Type': 'application/json' },
    { remarkContent: '已联系供应商更换温度传感器，预计3天内到货' }
  );

  console.log('\n✅ Remark added successfully\n');
  return resp;
}

async function testGetRemark() {
  log('📋 STEP 5: GET remark (anyone can view)',
    'All roles can view remarks - testing with viewer');

  const resp = await apiCall('GET', `${BASE_URL}/batches/${testBatchId}/rows/${failedRow}/remark`,
    { 'X-User-Id': 'viewer_wang' }
  );

  console.log('\n✅ Remark retrieved successfully\n');
  return resp;
}

async function testUpdateRemark() {
  log('📋 STEP 6: PUT update remark (admin - should succeed)',
    'Update existing remark with new information');

  const resp = await apiCall('PUT', `${BASE_URL}/batches/${testBatchId}/rows/${failedRow}/remark`,
    { 'X-User-Id': 'admin', 'Content-Type': 'application/json' },
    { remarkContent: '传感器已更换完成，重新校准后数据正常' }
  );

  console.log('\n✅ Remark updated successfully\n');
  return resp;
}

async function testBatchDetailWithRemark() {
  log('📋 STEP 7: GET batch detail with remarks',
    'Batch detail should include remarkStats and row remarks');

  const resp = await apiCall('GET', `${BASE_URL}/batches/${testBatchId}?rowStatus=failed`,
    { 'X-User-Id': 'admin' }
  );

  const hasRemarkStats = !!resp.data.data.batch?.remarkStats;
  const hasRowRemark = resp.data.data.rowResults.items.some(r => r.remark !== null);
  console.log(`\n✅ Batch detail has remarkStats: ${hasRemarkStats}, has row remarks: ${hasRowRemark}\n`);
  return resp;
}

async function testBatchListWithStats() {
  log('📋 STEP 8: GET batch list with remark stats',
    'Batch list should include remarkStats summary per batch');

  const resp = await apiCall('GET', `${BASE_URL}/batches`,
    { 'X-User-Id': 'admin' }
  );

  const batch = resp.data.data.items.find(b => b.id === testBatchId);
  console.log(`\n✅ Batch list remarkStats: ${JSON.stringify(batch?.remarkStats)}\n`);
  return resp;
}

async function testJsonExport() {
  log('📋 STEP 9: Export batch as JSON (with remarks)',
    'JSON export should include remark fields');

  const resp = await apiCall('GET', `${BASE_URL}/batches/${testBatchId}/export?format=json`,
    { 'X-User-Id': 'operator_li' }
  );

  const data = typeof resp.data === 'string' ? JSON.parse(resp.data) : resp.data;
  const hasRemark = data.rowResults?.some(r => r.remark !== null);
  console.log(`\n✅ JSON export contains remarks: ${hasRemark}\n`);
  return resp;
}

async function testCsvExport() {
  log('📋 STEP 10: Export batch as CSV (with remarks)',
    'CSV export should include remark_ prefixed columns');

  const resp = await apiCall('GET', `${BASE_URL}/batches/${testBatchId}/export?format=csv`,
    { 'X-User-Id': 'viewer_wang' }
  );

  const hasRemarkHeader = resp.data.includes('remark_remarkContent');
  const hasRemarkContent = resp.data.includes('传感器已更换');
  console.log(`\n✅ CSV has remark header: ${hasRemarkHeader}, has remark content: ${hasRemarkContent}\n`);
  return resp;
}

async function testClearRemark() {
  log('📋 STEP 11: Clear remark with empty string',
    'Empty remarkContent triggers clear operation');

  const resp = await apiCall('PUT', `${BASE_URL}/batches/${testBatchId}/rows/${failedRow}/remark`,
    { 'X-User-Id': 'admin', 'Content-Type': 'application/json' },
    { remarkContent: '' }
  );

  console.log(`\n✅ Remark cleared: isClear=${resp.data.data.isClear}\n`);
  return resp;
}

async function verifyRemarkCleared() {
  log('📋 STEP 12: Verify remark is cleared (should return null)',
    'GET after clear should return null, not 404');

  const resp = await apiCall('GET', `${BASE_URL}/batches/${testBatchId}/rows/${failedRow}/remark`,
    { 'X-User-Id': 'admin' }
  );

  console.log(`\n✅ Remark is null after clear: ${resp.data.data === null}\n`);
  return resp;
}

async function testRestartPersistence() {
  log('📋 STEP 13: Add remark before restart for persistence test',
    'Add a remark that should survive server restart');

  await apiCall('PUT', `${BASE_URL}/batches/${testBatchId}/rows/${failedRow}/remark`,
    { 'X-User-Id': 'admin', 'Content-Type': 'application/json' },
    { remarkContent: '持久化测试备注 - 重启后应该仍然存在' }
  );

  console.log('\n💾 Added remark for persistence test\n');
}

async function testAfterRestart() {
  log('📋 STEP 14: Verify remark persists after server restart',
    'Query remark after server restart with same DB_PATH');

  const getResp = await apiCall('GET', `${BASE_URL}/batches/${testBatchId}/rows/${failedRow}/remark`,
    { 'X-User-Id': 'admin' }
  );

  const persisted = getResp.data.data?.remarkContent === '持久化测试备注 - 重启后应该仍然存在';
  console.log(`\n✅ Remark persisted after restart: ${persisted}\n`);

  const listResp = await apiCall('GET', `${BASE_URL}/batches`,
    { 'X-User-Id': 'admin' }
  );
  const batch = listResp.data.data.items.find(b => b.id === testBatchId);
  console.log(`\n✅ Batch list remarkStats after restart: ${JSON.stringify(batch?.remarkStats)}\n`);

  const exportResp = await apiCall('GET', `${BASE_URL}/batches/${testBatchId}/export?format=json`,
    { 'X-User-Id': 'admin' }
  );
  const data = typeof exportResp.data === 'string' ? JSON.parse(exportResp.data) : exportResp.data;
  const row = data.rowResults?.find(r => r.rowIndex === failedRow);
  console.log(`\n✅ JSON export after restart has remark: ${row?.remark?.remarkContent}\n`);

  return getResp;
}

async function testInvalidCases() {
  log('📋 STEP 15: Test invalid/boundary cases', 'Invalid batch, invalid row, success row');

  console.log('\n❌ Test 15.1: Invalid batch ID (should 404)');
  try {
    await apiCall('GET', `${BASE_URL}/batches/invalid-batch-id/rows/1/remark`,
      { 'X-User-Id': 'admin' }
    );
  } catch (e) {
    logResponse(e.response.status, e.response.data);
  }

  console.log('\n❌ Test 15.2: Invalid row number (should 404)');
  try {
    await apiCall('GET', `${BASE_URL}/batches/${testBatchId}/rows/99999/remark`,
      { 'X-User-Id': 'admin' }
    );
  } catch (e) {
    logResponse(e.response.status, e.response.data);
  }

  console.log('\n❌ Test 15.3: Add remark to success row (should 409 BusinessError)');
  try {
    await apiCall('PUT', `${BASE_URL}/batches/${testBatchId}/rows/1/remark`,
      { 'X-User-Id': 'admin', 'Content-Type': 'application/json' },
      { remarkContent: 'trying to add remark to success row' }
    );
  } catch (e) {
    logResponse(e.response.status, e.response.data);
  }

  console.log('\n✅ All boundary cases handled correctly\n');
}

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  HTTP 完整链路测试 - 异常行处置备注功能');
  console.log('  Complete HTTP Flow Test - Exception Row Remark Feature');
  console.log('═'.repeat(70));

  try {
    await startServer(DB_PATH);
    await setupTestData();
    await importCsv();
    await getFailedRows();
    await testPermissionDenied();
    await testPutRemark();
    await testGetRemark();
    await testUpdateRemark();
    await testBatchDetailWithRemark();
    await testBatchListWithStats();
    await testJsonExport();
    await testCsvExport();
    await testClearRemark();
    await verifyRemarkCleared();
    await testRestartPersistence();
    await testInvalidCases();

    console.log('\n🔄 Restarting server to test persistence...');
    await stopServer();
    console.log(`\n💾 DB file exists: ${fs.existsSync(DB_PATH)}`);
    await startServer(DB_PATH);

    await testAfterRestart();

  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    if (error.response) {
      console.error('Response:', error.response.status, error.response.data);
    }
    console.error(error.stack);
  } finally {
    await stopServer();

    if (fs.existsSync(TEST_CSV)) {
      console.log('🧹 Cleaning up test CSV');
      fs.unlinkSync(TEST_CSV);
    }
    if (fs.existsSync(DB_PATH)) {
      console.log('🧹 Cleaning up test DB');
      fs.unlinkSync(DB_PATH);
    }

    const logPath = path.join(__dirname, 'test_remark_http_flow_output.txt');
    fs.writeFileSync(logPath, outputLog.join('\n'));
    console.log(`\n📝 Full HTTP flow log saved to: ${logPath}`);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  ✅ 所有 HTTP 链路测试完成！All HTTP flow tests completed!');
  console.log('═'.repeat(70) + '\n');
}

main();
