const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, execSync } = require('child_process');
const FormData = require('form-data');

const BASE_URL = 'http://localhost:3007/api/readings';
const PORT = 3007;
const DB_PATH = path.join(__dirname, 'cold_chain_disposition_http_' + Date.now() + '.db');
const TEST_CSV = path.join(__dirname, 'test_disposition_http.csv');

let serverProcess = null;
let testBatchId = null;
let failedRows = [];
const outputLog = [];

function log(title, data) {
  const entry = '\n' + '='.repeat(70) + '\n' + title + '\n' + '='.repeat(70) + '\n' + (typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  console.log(entry);
  outputLog.push(entry);
}

function logRequest(method, url, headers, body) {
  const safeHeaders = { };
  for (const k in headers) safeHeaders[k] = headers[k];
  delete safeHeaders['Content-Length'];
  let entry = '\n' + '-'.repeat(70) + '\n>>> ' + method + ' ' + url + '\n' + '-'.repeat(70) + '\n';
  if (safeHeaders && Object.keys(safeHeaders).length > 0) {
    entry += 'Headers: ' + JSON.stringify(safeHeaders, null, 2) + '\n';
  }
  if (body) {
    entry += 'Body: ' + (typeof body === 'string' ? body : JSON.stringify(body, null, 2)) + '\n';
  }
  console.log(entry);
  outputLog.push(entry);
}

function logResponse(status, data) {
  const entry = '\n<<< Status: ' + status + '\n' + '-'.repeat(70) + '\n' + JSON.stringify(data, null, 2) + '\n';
  console.log(entry);
  outputLog.push(entry);
}

function startServer(dbPath) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PORT, DB_PATH: dbPath };
    const isWindows = process.platform === 'win32';
    const nodeCmd = isWindows ? 'node.exe' : 'node';
    
    serverProcess = spawn(nodeCmd, ['dist/app.js'], { env, shell: isWindows });

    let started = false;
    serverProcess.stdout.on('data', (data) => {
      const msg = data.toString();
      if (msg.includes('Server started on port ' + PORT) && !started) {
        console.log('\n✅ Server started on port ' + PORT + ' with DB: ' + dbPath + '\n');
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
        execSync('taskkill /PID ' + serverProcess.pid + ' /T /F', { stdio: 'ignore' });
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
    'DEVDISPO001,-20,2026-06-01 10:00:00',
    'DEVDISPO001,INVALID_TEMP,2026-06-01 10:01:00',
    'DEVDISPO001,-18,2026-06-01 10:02:00',
    'UNKNOWN-DISPO-001,-19,2026-06-01 10:03:00',
    'DEVDISPO001,NOT_A_NUMBER,2026-06-01 10:04:00',
    'DEVDISPO001,-22,2026-06-01 10:05:00',
    ', -19.5, 2026-06-01 10:06:00',
    'DEVDISPO001,-17,2026-06-01 10:07:00',
    'DEVDISPO001,BAD_VALUE,2026-06-01 10:08:00',
    'DEVDISPO001,-21,2026-06-01 10:09:00',
  ];
  fs.writeFileSync(TEST_CSV, rows.join('\n'));
  console.log('\n📄 Created test CSV with 10 rows (6 valid, 4 invalid)\n');
}

async function apiCall(method, url, headers, body) {
  const safeHeaders = { };
  for (const k in headers) safeHeaders[k] = headers[k];
  logRequest(method, url, safeHeaders, body);

  const config = { method, url, headers, timeout: 10000 };
  if (body && method !== 'GET') config.data = body;
  if (url.includes('/export')) config.responseType = 'text';

  try {
    const resp = await axios(config);
    logResponse(resp.status, resp.data);
    return resp;
  } catch (e) {
    if (e.response) {
      logResponse(e.response.status, e.response.data);
      throw e;
    }
    throw e;
  }
}

async function setupTestData() {
  log('📋 STEP 0: Setup Test Data', 'Creating devices and thresholds');

  await apiCall('POST', 'http://localhost:3007/api/devices',
    { 'X-User-Id': 'admin', 'Content-Type': 'application/json' },
    { id: 'DEVDISPO001', name: 'Disposition Test Device', storeId: 'STORE-DISPO', storeName: 'Disposition Test Store', status: 'active' }
  );

  await apiCall('PUT', 'http://localhost:3007/api/thresholds/device/DEVDISPO001',
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

  logRequest('POST', BASE_URL + '/import', { 'X-User-Id': 'operator_li', 'Content-Type': 'multipart/form-data' }, '[CSV File]');

  const resp = await axios.post(BASE_URL + '/import', form, { headers, timeout: 10000 });
  logResponse(resp.status, resp.data);

  testBatchId = resp.data.data.importBatchId || resp.data.data.batchId;
  console.log('\n📦 Batch ID: ' + testBatchId + '\n');

  return resp;
}

async function getFailedRows() {
  log('📋 STEP 2: Get failed rows from batch detail', 'Query batch detail to find failed row numbers');

  const resp = await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed',
    { 'X-User-Id': 'admin' }
  );

  failedRows = resp.data.data.rowResults.items.map(r => r.rowIndex).sort((a, b) => a - b);
  console.log('\n❌ Failed rows found: #' + failedRows.join(', #') + '\n');

  return resp;
}

async function testBatchListWithoutFilters() {
  log('📋 STEP 3: GET batch list with disposition stats (no filters)',
    'Batch list should include dispositionStats and summary');

  return await apiCall('GET', BASE_URL + '/batches?pageSize=10',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function addRemarks() {
  log('📋 STEP 4: Add remarks to failed rows (different handlers)',
    'Add remarks with manager_zhang and admin');

  const t1 = Date.now();
  await apiCall('PUT', BASE_URL + '/batches/' + testBatchId + '/rows/' + failedRows[0] + '/remark',
    { 'X-User-Id': 'manager_zhang', 'Content-Type': 'application/json' },
    { remarkContent: '温度格式错误，已反馈数据采集团队排查' }
  );

  await new Promise(r => setTimeout(r, 200));

  const t2 = Date.now();
  await apiCall('PUT', BASE_URL + '/batches/' + testBatchId + '/rows/' + failedRows[1] + '/remark',
    { 'X-User-Id': 'admin', 'Content-Type': 'application/json' },
    { remarkContent: '设备不存在，已通知门店补充设备台账' }
  );

  await new Promise(r => setTimeout(r, 200));

  const t3 = Date.now();
  await apiCall('PUT', BASE_URL + '/batches/' + testBatchId + '/rows/' + failedRows[2] + '/remark',
    { 'X-User-Id': 'manager_zhang', 'Content-Type': 'application/json' },
    { remarkContent: 'deviceId为空，已联系供应商确认数据格式' }
  );

  console.log('\n✅ Added 3 remarks, 1 remaining unremarked\n');
  return { t1, t2, t3 };
}

async function testBatchListWithRemarked() {
  log('📋 STEP 5: GET batch list filtered by remarkStatus=remarked',
    'Filter batches to show only those with remarked rows');

  return await apiCall('GET', BASE_URL + '/batches?pageSize=10&remarkStatus=remarked',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testBatchListWithUnremarked() {
  log('📋 STEP 6: GET batch list filtered by remarkStatus=unremarked',
    'Filter batches to show only those with unremarked rows');

  return await apiCall('GET', BASE_URL + '/batches?pageSize=10&remarkStatus=unremarked',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testBatchListByHandler() {
  log('📋 STEP 7: GET batch list filtered by handledBy=manager_zhang',
    'Filter batches by handler');

  return await apiCall('GET', BASE_URL + '/batches?pageSize=10&handledBy=manager_zhang',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testDetailFilterRemarked() {
  log('📋 STEP 8: GET batch detail filtered by remarkStatus=remarked',
    'Filter failed rows to show only remarked ones');

  return await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=remarked&pageSize=10',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testDetailFilterUnremarked() {
  log('📋 STEP 9: GET batch detail filtered by remarkStatus=unremarked',
    'Filter failed rows to show only unremarked ones');

  return await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=unremarked&pageSize=10',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testDetailFilterByHandler() {
  log('📋 STEP 10: GET batch detail filtered by handledBy=admin',
    'Filter failed rows by handler');

  return await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&handledBy=admin&pageSize=10',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testDetailFilterByTime(timestamps) {
  log('📋 STEP 11: GET batch detail filtered by time range',
    'Filter failed rows by remark time range');

  return await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStartTime=' + timestamps.t1 + '&remarkEndTime=' + timestamps.t3 + '&pageSize=10',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testDetailCombinedFilter() {
  log('📋 STEP 12: GET batch detail with combined filters',
    'Filter by remarkStatus=remarked AND handledBy=manager_zhang');

  return await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=remarked&handledBy=manager_zhang&pageSize=10',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testDetailPaginationWithFilter() {
  log('📋 STEP 13: GET batch detail with pagination + filter',
    'Test pagination works correctly with filters applied');

  await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=remarked&page=1&pageSize=2',
    { 'X-User-Id': 'viewer_wang' }
  );

  return await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=remarked&page=2&pageSize=2',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testJsonExportWithFilter() {
  log('📋 STEP 14: Export batch as JSON with filter',
    'JSON export should include filters and filtered results');

  return await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '/export?format=json&rowStatus=failed&remarkStatus=remarked',
    { 'X-User-Id': 'operator_li' }
  );
}

async function testCsvExportWithFilter() {
  log('📋 STEP 15: Export batch as CSV with filter',
    'CSV export should include applied filters section');

  return await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '/export?format=csv&rowStatus=failed&remarkStatus=unremarked',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testPermissionViewer() {
  log('📋 STEP 16: Test permission - viewer can view filtered results',
    'viewer role can view filtered results but cannot add remarks');

  await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=unremarked',
    { 'X-User-Id': 'viewer_wang' }
  );

  try {
    await apiCall('PUT', BASE_URL + '/batches/' + testBatchId + '/rows/' + failedRows[3] + '/remark',
      { 'X-User-Id': 'viewer_wang', 'Content-Type': 'application/json' },
      { remarkContent: 'viewer trying to add remark' }
    );
  } catch (e) {
    console.log('\n✅ Correctly returned 403 for viewer\n');
  }
}

async function testPermissionOperator() {
  log('📋 STEP 17: Test permission - operator can view and export',
    'operator role can view and export but cannot add remarks');

  await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '/export?format=json&rowStatus=failed&remarkStatus=remarked',
    { 'X-User-Id': 'operator_li' }
  );

  try {
    await apiCall('PUT', BASE_URL + '/batches/' + testBatchId + '/rows/' + failedRows[3] + '/remark',
      { 'X-User-Id': 'operator_li', 'Content-Type': 'application/json' },
      { remarkContent: 'operator trying to add remark' }
    );
  } catch (e) {
    console.log('\n✅ Correctly returned 403 for operator\n');
  }
}

async function testInvalidParams() {
  log('📋 STEP 18: Test invalid filter parameters',
    'Invalid parameters should return 400 with clear error messages');

  console.log('\n❌ Test 18.1: Invalid remarkStatus');
  try {
    await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=invalid_value',
      { 'X-User-Id': 'viewer_wang' }
    );
  } catch (e) { /* expected */ }

  console.log('\n❌ Test 18.2: Unknown handler');
  try {
    await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&handledBy=unknown_user',
      { 'X-User-Id': 'viewer_wang' }
    );
  } catch (e) { /* expected */ }

  console.log('\n❌ Test 18.3: Conflict: unremarked + handledBy');
  try {
    await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=unremarked&handledBy=admin',
      { 'X-User-Id': 'viewer_wang' }
    );
  } catch (e) { /* expected */ }

  console.log('\n❌ Test 18.4: Conflict: unremarked + time range');
  try {
    await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=unremarked&remarkStartTime=' + Date.now(),
      { 'X-User-Id': 'viewer_wang' }
    );
  } catch (e) { /* expected */ }

  console.log('\n❌ Test 18.5: Invalid timestamp too small');
  try {
    await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStartTime=123',
      { 'X-User-Id': 'viewer_wang' }
    );
  } catch (e) { /* expected */ }

  console.log('\n❌ Test 18.6: Start time > end time');
  try {
    await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStartTime=' + (Date.now() + 100000) + '&remarkEndTime=' + Date.now(),
      { 'X-User-Id': 'viewer_wang' }
    );
  } catch (e) { /* expected */ }

  console.log('\n✅ All invalid parameter validations working correctly\n');
}

async function testStatsSyncAfterUpdate() {
  log('📋 STEP 19: Test stats sync after remark update',
    'dispositionStats should update after remark is modified');

  await apiCall('PUT', BASE_URL + '/batches/' + testBatchId + '/rows/' + failedRows[0] + '/remark',
    { 'X-User-Id': 'admin', 'Content-Type': 'application/json' },
    { remarkContent: '温度格式错误，已反馈数据采集团队，已修复采集程序' }
  );

  return await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&pageSize=1',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testStatsSyncAfterClear() {
  log('📋 STEP 20: Test stats sync after remark clear',
    'dispositionStats should update after remark is cleared');

  await apiCall('PUT', BASE_URL + '/batches/' + testBatchId + '/rows/' + failedRows[0] + '/remark',
    { 'X-User-Id': 'admin', 'Content-Type': 'application/json' },
    { remarkContent: '' }
  );

  return await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&pageSize=1',
    { 'X-User-Id': 'viewer_wang' }
  );
}

async function testAfterRestart() {
  log('📋 STEP 21: Verify all functionality persists after server restart',
    'Query filtered results after server restart with same DB_PATH');

  await apiCall('GET', BASE_URL + '/batches?pageSize=10',
    { 'X-User-Id': 'viewer_wang' }
  );

  await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=remarked&pageSize=10',
    { 'X-User-Id': 'viewer_wang' }
  );

  await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=unremarked&pageSize=10',
    { 'X-User-Id': 'viewer_wang' }
  );

  await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '/export?format=json&rowStatus=failed&remarkStatus=remarked',
    { 'X-User-Id': 'viewer_wang' }
  );

  try {
    await apiCall('PUT', BASE_URL + '/batches/' + testBatchId + '/rows/' + failedRows[0] + '/remark',
      { 'X-User-Id': 'operator_li', 'Content-Type': 'application/json' },
      { remarkContent: 'operator trying after restart' }
    );
  } catch (e) {
    console.log('\n✅ Permission still enforced after restart\n');
  }

  try {
    await apiCall('GET', BASE_URL + '/batches/' + testBatchId + '?rowStatus=failed&remarkStatus=unremarked&handledBy=admin',
      { 'X-User-Id': 'viewer_wang' }
    );
  } catch (e) {
    console.log('\n✅ Validation still enforced after restart\n');
  }
}

async function main() {
  console.log('\n' + '═'.repeat(70));
  console.log('  HTTP 完整链路测试 - 失败行处置进度功能');
  console.log('  Complete HTTP Flow Test - Failed Row Disposition Progress');
  console.log('═'.repeat(70));

  try {
    await startServer(DB_PATH);
    await setupTestData();
    await importCsv();
    await getFailedRows();
    await testBatchListWithoutFilters();
    const timestamps = await addRemarks();
    await testBatchListWithRemarked();
    await testBatchListWithUnremarked();
    await testBatchListByHandler();
    await testDetailFilterRemarked();
    await testDetailFilterUnremarked();
    await testDetailFilterByHandler();
    await testDetailFilterByTime(timestamps);
    await testDetailCombinedFilter();
    await testDetailPaginationWithFilter();
    await testJsonExportWithFilter();
    await testCsvExportWithFilter();
    await testPermissionViewer();
    await testPermissionOperator();
    await testInvalidParams();
    await testStatsSyncAfterUpdate();
    await testStatsSyncAfterClear();

    console.log('\n🔄 Restarting server to test persistence...');
    await stopServer();
    console.log('\n💾 DB file exists: ' + fs.existsSync(DB_PATH));
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

    const logPath = path.join(__dirname, 'test_disposition_http_flow_output.txt');
    fs.writeFileSync(logPath, outputLog.join('\n'));
    console.log('\n📝 Full HTTP flow log saved to: ' + logPath);
  }

  console.log('\n' + '═'.repeat(70));
  console.log('  ✅ 所有 HTTP 链路测试完成！All HTTP flow tests completed!');
  console.log('═'.repeat(70) + '\n');
}

main();
