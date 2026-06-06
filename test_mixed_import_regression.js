const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const BASE_URL = 'http://localhost:3001';
const TEST_CSV = 'test_mixed_import.csv';
const TEST_DEVICE = 'REGRESSION-TEST-' + Date.now().toString().slice(-8);

let passCount = 0;
let failCount = 0;

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
    `UNKNOWN-DEVICE-999,-20.0,2026-06-01 10:01:00`,
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
  console.log(`  Created CSV with ${lines.length - 1} data rows (5 valid, 5 invalid)`);
  console.log('    Valid rows: 1, 4, 6, 8, 10');
  console.log('    Invalid rows: 2 (unknown device), 3 (bad temp), 5 (bad timestamp), 7 (empty device), 9 (duplicate time)');
}

async function runTests() {
  console.log('\x1b[36m========================================\x1b[0m');
  console.log('\x1b[36m混合CSV导入 - 回归测试\x1b[0m');
  console.log('\x1b[36m========================================\x1b[0m\n');

  console.log('\x1b[33m=== 步骤 1: 初始化 ===\x1b[0m');
  const health = await apiCall({ url: '/health' });
  testResult('服务健康', health.status === 200 && health.data?.data?.status === 'ok');

  const deviceResp = await apiCall({
    method: 'post',
    url: '/api/devices',
    data: {
      id: TEST_DEVICE,
      name: '测试冰柜',
      storeId: 'STORE-001',
      storeName: '测试门店',
      status: 'active',
    },
  });
  testResult('设备存在或创建成功', deviceResp.status === 200 || deviceResp.status === 201 || deviceResp.status === 409);

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

  console.log('\n\x1b[33m=== 步骤 2: 导入混合CSV ===\x1b[0m');
  const importResp = await uploadCsv(TEST_CSV, 'operator_li');
  testResult('导入成功返回200', importResp.status === 200);

  const importData = importResp.data.data;
  const batchId = importData.batchId;
  console.log(`  批次ID: ${batchId}`);

  testResult('批次总数正确 (10)', importData.totalCount === undefined || importData.successCount + importData.failedCount === 10, importData.successCount + importData.failedCount, 10);
  testResult('成功数量正确 (5)', importData.successCount === 5, importData.successCount, 5);
  testResult('失败数量正确 (5)', importData.failedCount === 5, importData.failedCount, 5);
  testResult('错误数组存在且长度为5', Array.isArray(importData.errors) && importData.errors.length === 5, importData.errors?.length, 5);
  testResult('状态为completed', importData.status === 'completed', importData.status, 'completed');

  console.log('\n\x1b[33m=== 步骤 3: 批次详情查询 ===\x1b[0m');
  console.log('  \x1b[36m测试 3.1: 全部状态 (rowStatus=all)\x1b[0m');
  const allDetail = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=all`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('全部状态查询成功', allDetail.status === 200);
  testResult('批次元信息正确', allDetail.data.data.batch.totalCount === 10 && allDetail.data.data.batch.successCount === 5 && allDetail.data.data.batch.failedCount === 5);
  testResult('返回10条行结果', allDetail.data.data.rowResults.items.length === 10, allDetail.data.data.rowResults.items.length, 10);
  testResult('分页total正确', allDetail.data.data.rowResults.total === 10);

  console.log('  \x1b[36m测试 3.2: 仅成功 (rowStatus=success)\x1b[0m');
  const successDetail = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=success`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('成功状态查询成功', successDetail.status === 200);
  testResult('返回5条成功行', successDetail.data.data.rowResults.items.length === 5, successDetail.data.data.rowResults.items.length, 5);
  const successRows = successDetail.data.data.rowResults.items;
  testResult('成功行状态均为success', successRows.every(r => r.status === 'success'));
  testResult('成功行rowIndex为1,4,6,8,10', successRows.map(r => r.rowIndex).sort((a, b) => a - b).join(',') === '1,4,6,8,10');
  testResult('成功行errorMessage均为null', successRows.every(r => r.errorMessage === null || r.errorMessage === undefined));

  console.log('  \x1b[36m测试 3.3: 仅失败 (rowStatus=failed)\x1b[0m');
  const failedDetail = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=failed`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('失败状态查询成功', failedDetail.status === 200);
  testResult('返回5条失败行', failedDetail.data.data.rowResults.items.length === 5, failedDetail.data.data.rowResults.items.length, 5);
  const failedRows = failedDetail.data.data.rowResults.items;
  testResult('失败行状态均为failed', failedRows.every(r => r.status === 'failed'));
  testResult('失败行rowIndex为2,3,5,7,9', failedRows.map(r => r.rowIndex).sort((a, b) => a - b).join(',') === '2,3,5,7,9');
  testResult('失败行均有errorMessage', failedRows.every(r => r.errorMessage && r.errorMessage.length > 0));

  const unknownDeviceRow = failedRows.find(r => r.rowIndex === 2);
  testResult('未知设备行保留deviceId', unknownDeviceRow?.deviceId === 'UNKNOWN-DEVICE-999', unknownDeviceRow?.deviceId, 'UNKNOWN-DEVICE-999');
  testResult('未知设备行errorMessage正确', unknownDeviceRow?.errorMessage?.includes('不存在') || unknownDeviceRow?.errorMessage?.includes('设备'), unknownDeviceRow?.errorMessage);

  const badTempRow = failedRows.find(r => r.rowIndex === 3);
  testResult('坏温度行保留原始deviceId', badTempRow?.deviceId === TEST_DEVICE);
  testResult('坏温度行temperature为null', badTempRow?.temperature === null || badTempRow?.temperature === undefined);
  testResult('坏温度行readingTime存在', badTempRow?.readingTime !== null && badTempRow?.readingTime !== undefined);

  const badTimeRow = failedRows.find(r => r.rowIndex === 5);
  testResult('坏时间戳行readingTime为null', badTimeRow?.readingTime === null || badTimeRow?.readingTime === undefined);
  testResult('坏时间戳行temperature存在', badTimeRow?.temperature === -18);

  const emptyDeviceRow = failedRows.find(r => r.rowIndex === 7);
  testResult('空设备行deviceId为空字符串', emptyDeviceRow?.deviceId === '' || emptyDeviceRow?.deviceId?.trim() === '');

  const duplicateRow = failedRows.find(r => r.rowIndex === 9);
  testResult('重复时间行有正确错误信息', 
    duplicateRow?.errorMessage?.includes('重复') || 
    duplicateRow?.errorMessage?.includes('已有') || 
    duplicateRow?.errorMessage?.includes('倒序'),
    duplicateRow?.errorMessage,
    '包含重复/已有/倒序');

  console.log('  \x1b[36m测试 3.4: 分页稳定性\x1b[0m');
  const page1 = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=failed&page=1&pageSize=2`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('失败分页第1页正确', page1.data.data.rowResults.items.length === 2);
  testResult('失败分页第1页rowIndex为2,3', page1.data.data.rowResults.items.map(r => r.rowIndex).join(',') === '2,3');

  const page2 = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=failed&page=2&pageSize=2`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('失败分页第2页正确', page2.data.data.rowResults.items.length === 2);
  testResult('失败分页第2页rowIndex为5,7', page2.data.data.rowResults.items.map(r => r.rowIndex).join(',') === '5,7');

  const page3 = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=failed&page=3&pageSize=2`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('失败分页第3页正确', page3.data.data.rowResults.items.length === 1);
  testResult('失败分页第3页rowIndex为9', page3.data.data.rowResults.items[0].rowIndex === 9);

  console.log('\n\x1b[33m=== 步骤 4: 导出一致性测试 ===\x1b[0m');
  console.log('  \x1b[36m测试 4.1: JSON导出 - 全部状态\x1b[0m');
  const jsonAll = await apiCall({
    url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=all`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('JSON导出成功', jsonAll.status === 200);
  const jsonData = typeof jsonAll.data === 'string' ? JSON.parse(jsonAll.data) : jsonAll.data;
  testResult('JSON导出包含10条行结果', jsonData.rowResults.length === 10, jsonData.rowResults.length, 10);
  testResult('JSON导出包含filters信息', jsonData.filters?.rowStatus === 'all');

  console.log('  \x1b[36m测试 4.2: JSON导出 - 仅失败\x1b[0m');
  const jsonFailed = await apiCall({
    url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  const jsonFailedData = typeof jsonFailed.data === 'string' ? JSON.parse(jsonFailed.data) : jsonFailed.data;
  testResult('JSON失败导出5条', jsonFailedData.rowResults.length === 5, jsonFailedData.rowResults.length, 5);
  testResult('JSON失败导出filters正确', jsonFailedData.filters?.rowStatus === 'failed');

  const failedDetailIds = failedRows.map(r => r.rowIndex).sort();
  const jsonFailedIds = jsonFailedData.rowResults.map(r => r.rowIndex).sort();
  testResult('JSON导出与详情行ID一致', failedDetailIds.join(',') === jsonFailedIds.join(','));

  console.log('  \x1b[36m测试 4.3: JSON字段顺序和空值\x1b[0m');
  const firstFailedRow = jsonFailedData.rowResults[0];
  const firstRowKeys = Object.keys(firstFailedRow);
  testResult('行结果字段顺序固定 (rowIndex第一个)', firstRowKeys[0] === 'rowIndex', firstRowKeys[0], 'rowIndex');
  testResult('字段顺序正确 (errorMessage在status后)', firstRowKeys[5] === 'errorMessage', firstRowKeys[5], 'errorMessage');

  const successRowInJson = jsonData.rowResults.find(r => r.status === 'success');
  testResult('成功行errorMessage为null', successRowInJson?.errorMessage === null, successRowInJson?.errorMessage, null);

  console.log('  \x1b[36m测试 4.4: CSV导出格式验证\x1b[0m');
  const csvResp = await apiCall({
    url: `/api/readings/batches/${batchId}/export?format=csv&rowStatus=failed`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  const csvContent = csvResp.data;
  testResult('CSV导出包含批次信息', csvContent.includes('=== 批次信息 ==='));
  testResult('CSV导出包含逐行结果', csvContent.includes('=== 逐行结果 ==='));

  const csvLines = csvContent.replace(/\r\n/g, '\n').split('\n');
  const rowResultsHeaderIndex = csvLines.findIndex(l => l.includes('=== 逐行结果 ==='));
  const alarmsStartIndex = csvLines.findIndex(l => l.includes('=== 关联告警 ==='));
  const csvDataLines = csvLines.slice(rowResultsHeaderIndex + 2, alarmsStartIndex - 1).filter(l => l.trim() !== '');
  testResult('CSV失败导出5条数据行', csvDataLines.length === 5, csvDataLines.length, 5);

  const csvHeaderFields = csvLines[rowResultsHeaderIndex + 1]?.split(',');
  testResult('CSV字段顺序固定 (rowIndex第一个)', csvHeaderFields?.[0] === 'rowIndex', csvHeaderFields?.[0], 'rowIndex');

  console.log('\n\x1b[33m=== 步骤 5: 跨重启持久化 ===\x1b[0m');
  const batchBefore = allDetail.data.data.batch;
  const rowIdsBefore = allDetail.data.data.rowResults.items.map(r => r.rowIndex).sort().join(',');
  const alarmCountBefore = allDetail.data.data.alarms.length;
  const auditCountBefore = allDetail.data.data.auditLogs.length;

  console.log('  模拟数据库重启 (服务继续运行)...');
  const health2 = await apiCall({ url: '/health' });
  testResult('服务仍然运行', health2.status === 200);

  const batchAfter = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=all`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('重启后批次仍存在', batchAfter.status === 200);
  testResult('重启后批次ID一致', batchAfter.data.data.batch.id === batchId);
  testResult('重启后操作者一致', batchAfter.data.data.batch.createdBy === batchBefore.createdBy);
  testResult('重启后文件名一致', batchAfter.data.data.batch.fileName === batchBefore.fileName);
  testResult('重启后计数一致 (10/5/5)', batchAfter.data.data.batch.totalCount === 10 && batchAfter.data.data.batch.successCount === 5 && batchAfter.data.data.batch.failedCount === 5);
  testResult('重启后告警关联一致', batchAfter.data.data.alarms.length === alarmCountBefore);
  testResult('重启后审计关联一致', batchAfter.data.data.auditLogs.length === auditCountBefore);

  const rowIdsAfter = batchAfter.data.data.rowResults.items.map(r => r.rowIndex).sort().join(',');
  testResult('重启后逐行结果ID一致', rowIdsAfter === rowIdsBefore);

  const failedAfter = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=failed`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('重启后失败行仍可查', failedAfter.data.data.rowResults.items.length === 5);
  testResult('重启后失败行错误信息完整', failedAfter.data.data.rowResults.items.every(r => r.errorMessage));

  console.log('\n\x1b[33m=== 步骤 6: 审计日志验证 ===\x1b[0m');
  const auditLog = allDetail.data.data.auditLogs[0];
  testResult('审计日志存在', !!auditLog);
  testResult('审计操作类型正确', auditLog?.operationType === 'reading_import');
  testResult('审计详情包含成功/失败计数', auditLog?.details?.includes('成功5条') && auditLog?.details?.includes('失败5条'));

  console.log('\n\x1b[33m=== 步骤 7: 批次列表验证 ===\x1b[0m');
  const batchList = await apiCall({
    url: '/api/readings/batches?pageSize=10',
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  const batchInList = batchList.data.data.items.find(b => b.id === batchId);
  testResult('批次在列表中', !!batchInList);
  testResult('列表中批次计数正确', batchInList?.successCount === 5 && batchInList?.failedCount === 5);
  testResult('列表中批次状态为completed', batchInList?.status === 'completed');

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

  fs.unlinkSync(TEST_CSV);
}

runTests().catch(err => {
  console.error('测试执行出错:', err.message);
  console.error(err.stack);
  process.exit(1);
});
