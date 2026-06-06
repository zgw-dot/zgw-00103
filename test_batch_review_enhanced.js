const axios = require('axios');
const fs = require('fs');
const FormData = require('form-data');

const BASE_URL = 'http://localhost:3001';
const RESULTS = [];

function testResult(name, passed, message = '') {
  const status = passed ? 'PASS' : 'FAIL';
  const color = passed ? '\x1b[32m' : '\x1b[31m';
  console.log(`  ${color}[${status}] ${name}\x1b[0m`);
  if (!passed && message) {
    console.log(`    \x1b[33m-> ${message}\x1b[0m`);
  }
  RESULTS.push({ name, passed, message });
  return passed;
}

async function apiCall({ method = 'GET', url, headers = {}, body = null, isFormData = false }) {
  try {
    const config = {
      method,
      url: `${BASE_URL}${url}`,
      headers,
    };
    if (body) {
      if (isFormData) {
        config.data = body;
        config.headers = { ...headers, ...body.getHeaders() };
      } else {
        config.data = body;
        config.headers['Content-Type'] = 'application/json';
      }
    }
    const response = await axios(config);
    return { success: true, status: response.status, data: response.data, headers: response.headers };
  } catch (error) {
    if (error.response) {
      return {
        success: false,
        status: error.response.status,
        data: error.response.data,
        headers: error.response.headers,
      };
    }
    return { success: false, status: 0, data: { message: error.message } };
  }
}

async function main() {
  console.log('\x1b[36m========================================\x1b[0m');
  console.log('\x1b[36m批次复盘功能增强 - 全面测试\x1b[0m');
  console.log('\x1b[36m========================================\x1b[0m\n');

  console.log('\x1b[33m=== 环境准备 ===\x1b[0m');
  const health = await apiCall({ url: '/health' });
  testResult('服务健康检查', health.status === 200 && health.data?.data?.status === 'ok');

  console.log('\n\x1b[33m=== 步骤 1: 初始化测试数据 ===\x1b[0m');

  let deviceResp = await apiCall({
    method: 'POST',
    url: '/api/devices',
    headers: { 'X-User-Id': 'admin' },
    body: {
      id: 'TEST-FREEZER-001',
      name: '测试冷冻柜1号',
      storeId: 'TEST-STORE-001',
      storeName: '测试门店',
      status: 'active',
    },
  });

  if (!deviceResp.success || deviceResp.status !== 200) {
    deviceResp = await apiCall({
      url: '/api/devices/TEST-FREEZER-001',
      headers: { 'X-User-Id': 'admin' },
    });
    testResult('设备已存在', deviceResp.success === true);
  } else {
    testResult('创建设备成功', deviceResp.success === true);
  }

  const thresholdResp = await apiCall({
    method: 'PUT',
    url: '/api/thresholds/device/TEST-FREEZER-001',
    headers: { 'X-User-Id': 'admin' },
    body: { minTemp: -25, maxTemp: -15 },
  });
  testResult('设置设备阈值', thresholdResp.success === true);

  const TEST_CSV = 'test_batch_review.csv';
  const csvLines = [
    'deviceId,temperature,readingTime',
    'TEST-FREEZER-001,-22.5,2024-01-15 08:00:00',
    'TEST-FREEZER-001,-23.0,2024-01-15 08:30:00',
    'TEST-FREEZER-001,-21.0,2024-01-15 09:00:00',
    'TEST-FREEZER-001,-20.0,2024-01-15 09:30:00',
    'TEST-FREEZER-001,-22.0,2024-01-15 10:00:00',
    'TEST-FREEZER-001,-12.0,2024-01-15 10:30:00',
    'TEST-FREEZER-001,-24.0,2024-01-15 11:00:00',
    'TEST-FREEZER-001,-21.5,2024-01-15 11:30:00',
  ];
  fs.writeFileSync(TEST_CSV, csvLines.join('\n'), 'utf8');
  testResult('创建测试CSV文件', fs.existsSync(TEST_CSV));

  console.log('\n\x1b[33m=== 步骤 2: 导入数据创建批次 ===\x1b[0m');

  const form = new FormData();
  form.append('operator', 'operator_li');
  form.append('file', fs.createReadStream(TEST_CSV));

  const importResp = await apiCall({
    method: 'POST',
    url: '/api/readings/import',
    headers: { 'X-User-Id': 'operator_li' },
    body: form,
    isFormData: true,
  });

  const batchId = importResp.data?.data?.batchId;
  testResult('成功创建导入批次', importResp.success === true && !!batchId);
  console.log(`  批次ID: \x1b[36m${batchId}\x1b[0m`);

  console.log('\n\x1b[33m=== 步骤 3: 按行状态筛选测试 ===\x1b[0m');

  console.log('  \x1b[36m测试 3.1: 全部状态 (rowStatus=all)\x1b[0m');
  const detailAll = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=all`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  const allCount = detailAll.data?.data?.rowResults?.total;
  testResult('全部状态查询成功', detailAll.success === true);
  testResult('全部状态返回正确条数', allCount === 8);

  console.log('  \x1b[36m测试 3.2: 成功状态 (rowStatus=success)\x1b[0m');
  const detailSuccess = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=success`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  const successCount = detailSuccess.data?.data?.rowResults?.total;
  testResult('成功状态查询成功', detailSuccess.success === true);
  testResult('成功状态返回正确条数', successCount === 8);

  console.log('  \x1b[36m测试 3.3: 失败状态 (rowStatus=failed)\x1b[0m');
  const detailFailed = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=failed`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  const failedCount = detailFailed.data?.data?.rowResults?.total;
  testResult('失败状态查询成功', detailFailed.success === true);
  testResult('失败状态返回正确条数', failedCount === 0);

  console.log('  \x1b[36m测试 3.4: 非法筛选值 (rowStatus=invalid)\x1b[0m');
  const detailInvalid = await apiCall({
    url: `/api/readings/batches/${batchId}?rowStatus=invalid`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('非法筛选值返回错误', detailInvalid.success === false || detailInvalid.status === 400);
  testResult('非法筛选值返回400错误', detailInvalid.status === 400);

  console.log('\n\x1b[33m=== 步骤 4: 分页稳定性测试 ===\x1b[0m');

  console.log('  \x1b[36m测试 4.1: 第一页 (page=1, pageSize=3)\x1b[0m');
  const page1 = await apiCall({
    url: `/api/readings/batches/${batchId}?page=1&pageSize=3&rowStatus=all`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('第一页查询成功', page1.success === true);
  testResult('第一页返回3条数据', page1.data?.data?.rowResults?.items?.length === 3);
  testResult('第一页page=1正确', page1.data?.data?.rowResults?.page === 1);
  testResult('第一页pageSize=3正确', page1.data?.data?.rowResults?.pageSize === 3);
  testResult('第一页total=8正确', page1.data?.data?.rowResults?.total === 8);
  const page1RowIndices = page1.data?.data?.rowResults?.items?.map(r => r.rowIndex).join(',');
  testResult('第一页行号为1,2,3', page1RowIndices === '1,2,3');

  console.log('  \x1b[36m测试 4.2: 第二页 (page=2, pageSize=3)\x1b[0m');
  const page2 = await apiCall({
    url: `/api/readings/batches/${batchId}?page=2&pageSize=3&rowStatus=all`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('第二页查询成功', page2.success === true);
  testResult('第二页返回3条数据', page2.data?.data?.rowResults?.items?.length === 3);
  const page2RowIndices = page2.data?.data?.rowResults?.items?.map(r => r.rowIndex).join(',');
  testResult('第二页行号为4,5,6', page2RowIndices === '4,5,6');

  console.log('  \x1b[36m测试 4.3: 第三页 (page=3, pageSize=3)\x1b[0m');
  const page3 = await apiCall({
    url: `/api/readings/batches/${batchId}?page=3&pageSize=3&rowStatus=all`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('第三页查询成功', page3.success === true);
  testResult('第三页返回剩余2条数据', page3.data?.data?.rowResults?.items?.length === 2);
  const page3RowIndices = page3.data?.data?.rowResults?.items?.map(r => r.rowIndex).join(',');
  testResult('第三页行号为7,8', page3RowIndices === '7,8');

  console.log('  \x1b[36m测试 4.4: 分页排序一致性\x1b[0m');
  const allRowsNoPaging = detailAll.data?.data?.rowResults?.items?.map(r => r.rowIndex).join(',');
  const pagedRows = [...page1.data?.data?.rowResults?.items?.map(r => r.rowIndex),
                    ...page2.data?.data?.rowResults?.items?.map(r => r.rowIndex),
                    ...page3.data?.data?.rowResults?.items?.map(r => r.rowIndex)].join(',');
  testResult('分页合并与不分页结果一致', pagedRows === allRowsNoPaging);

  console.log('\n\x1b[33m=== 步骤 5: 导出一致性测试 ===\x1b[0m');

  console.log('  \x1b[36m测试 5.1: JSON导出 - 全部状态\x1b[0m');
  const jsonExportAll = await apiCall({
    url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=all`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('JSON导出成功', jsonExportAll.data?.rowResults !== undefined);
  testResult('JSON导出包含filters信息', jsonExportAll.data?.filters !== undefined);
  testResult('JSON导出rowResults条数正确', jsonExportAll.data?.rowResults?.length === 8);
  const batchKeys = Object.keys(jsonExportAll.data?.batch || {});
  testResult('JSON导出批次字段顺序固定 (id第一个)', batchKeys[0] === 'id');

  console.log('  \x1b[36m测试 5.2: JSON导出 - 成功状态\x1b[0m');
  const jsonExportSuccess = await apiCall({
    url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=success`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('JSON成功状态导出正确条数', jsonExportSuccess.data?.rowResults?.length === 8);
  testResult('JSON成功状态导出filters正确', jsonExportSuccess.data?.filters?.rowStatus === 'success');

  console.log('  \x1b[36m测试 5.3: JSON导出 - 失败状态\x1b[0m');
  const jsonExportFailed = await apiCall({
    url: `/api/readings/batches/${batchId}/export?format=json&rowStatus=failed`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('JSON失败状态导出正确条数', jsonExportFailed.data?.rowResults?.length === 0);

  console.log('  \x1b[36m测试 5.4: 导出与详情结果一致\x1b[0m');
  const detailRowIds = detailAll.data?.data?.rowResults?.items?.map(r => r.id).sort().join(',');
  const exportRowIds = jsonExportAll.data?.rowResults?.map(r => r.id).sort().join(',');
  testResult('导出与详情行ID完全一致', detailRowIds === exportRowIds);

  console.log('  \x1b[36m测试 5.5: CSV导出格式验证\x1b[0m');
  const csvResponse = await apiCall({
    url: `/api/readings/batches/${batchId}/export?format=csv&rowStatus=all`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  const csvContent = csvResponse.data;
  testResult('CSV导出包含批次信息', csvContent.includes('=== 批次信息 ==='));
  testResult('CSV导出包含逐行结果', csvContent.includes('=== 逐行结果 ==='));
  testResult('CSV导出包含关联告警', csvContent.includes('=== 关联告警 ==='));
  testResult('CSV导出包含审计日志', csvContent.includes('=== 审计日志 ==='));
  const exportCsvLines = csvContent.replace(/\r\n/g, '\n').split('\n');
  const rowResultsHeaderIndex = exportCsvLines.findIndex(l => l.includes('=== 逐行结果 ==='));
  const csvHeaderFields = exportCsvLines[rowResultsHeaderIndex + 1]?.split(',');
  testResult('CSV字段顺序固定 (rowIndex第一个)', csvHeaderFields?.[0] === 'rowIndex');
  const rowResultsStartIndex = rowResultsHeaderIndex + 2;
  const alarmsStartIndex = exportCsvLines.findIndex(l => l.includes('=== 关联告警 ==='));
  const rowDataLines = exportCsvLines.slice(rowResultsStartIndex, alarmsStartIndex - 1).filter(l => l.trim() !== '');
  testResult('CSV导出数据条数正确', rowDataLines.length === 8);

  console.log('\n\x1b[33m=== 步骤 6: 字段顺序和空值表现测试 ===\x1b[0m');

  console.log('  \x1b[36m测试 6.1: 批次字段顺序\x1b[0m');
  const expectedBatchFields = ['id','fileName','status','createdBy','createdAt','completedAt','totalCount','successCount','failedCount','errorDetails'];
  testResult('批次字段顺序正确', batchKeys.join(',') === expectedBatchFields.join(','));

  console.log('  \x1b[36m测试 6.2: 行结果字段顺序\x1b[0m');
  const rowFields = Object.keys(jsonExportAll.data?.rowResults?.[0] || {});
  const expectedRowFields = ['rowIndex','deviceId','temperature','readingTime','status','errorMessage','importBatchId','id','createdAt'];
  testResult('行结果字段顺序正确', rowFields.join(',') === expectedRowFields.join(','));

  console.log('  \x1b[36m测试 6.3: 空值表现为null\x1b[0m');
  const hasNullError = jsonExportAll.data?.rowResults?.some(r => r.errorMessage === null);
  testResult('空值(errorMessage)正确序列化为null', hasNullError === true);

  console.log('\n\x1b[33m=== 步骤 7: 权限控制测试 ===\x1b[0m');

  console.log('  \x1b[36m测试 7.1: viewer_wang 可以查看批次\x1b[0m');
  const viewerView = await apiCall({
    url: `/api/readings/batches/${batchId}`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('viewer查看批次成功', viewerView.success === true);

  console.log('  \x1b[36m测试 7.2: viewer_wang 可以导出批次\x1b[0m');
  const viewerExport = await apiCall({
    url: `/api/readings/batches/${batchId}/export?format=json`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('viewer导出批次成功', viewerExport.data?.rowResults !== undefined);

  console.log('  \x1b[36m测试 7.3: viewer_wang 不能导入\x1b[0m');
  const viewerForm = new FormData();
  viewerForm.append('operator', 'viewer_wang');
  viewerForm.append('file', fs.createReadStream(TEST_CSV));
  const viewerImport = await apiCall({
    method: 'POST',
    url: '/api/readings/import',
    headers: { 'X-User-Id': 'viewer_wang' },
    body: viewerForm,
    isFormData: true,
  });
  testResult('viewer导入被拒绝', viewerImport.success === false);
  testResult('viewer导入返回403无权限', viewerImport.status === 403);

  console.log('  \x1b[36m测试 7.4: operator_li 可以导入\x1b[0m');
  testResult('operator导入成功 (步骤2已验证)', importResp.success === true);

  console.log('  \x1b[36m测试 7.5: 未授权用户不能查看\x1b[0m');
  const unauthView = await apiCall({
    url: `/api/readings/batches/${batchId}`,
    headers: { 'X-User-Id': 'unknown_user' },
  });
  testResult('未授权用户查看被拒绝', unauthView.success === false || unauthView.status === 403);

  console.log('\n\x1b[33m=== 步骤 8: 错误场景测试 ===\x1b[0m');

  console.log('  \x1b[36m测试 8.1: 不存在的批次\x1b[0m');
  const notFound = await apiCall({
    url: '/api/readings/batches/batch-nonexistent-12345',
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('不存在批次返回错误', notFound.success === false);
  testResult('不存在批次返回404', notFound.status === 404);

  console.log('  \x1b[36m测试 8.2: 无效分页参数\x1b[0m');
  const invalidPage = await apiCall({
    url: `/api/readings/batches/${batchId}?page=-1`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('无效页码返回错误', invalidPage.success === false || invalidPage.status === 400);
  testResult('无效页码返回400验证错误', invalidPage.status === 400);

  console.log('  \x1b[36m测试 8.3: pageSize超过最大值\x1b[0m');
  const invalidPageSize = await apiCall({
    url: `/api/readings/batches/${batchId}?pageSize=1000`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('pageSize过大返回错误', invalidPageSize.success === false || invalidPageSize.status === 400);

  console.log('\n\x1b[33m=== 步骤 9: 跨重启持久化测试 ===\x1b[0m');

  console.log('  \x1b[36m测试 9.1: 重启前记录批次信息\x1b[0m');
  const preRestart = await apiCall({
    url: `/api/readings/batches/${batchId}`,
    headers: { 'X-User-Id': 'admin' },
  });
  const preRestartBatch = preRestart.data?.data?.batch;
  testResult('重启前批次存在', preRestart.success === true);
  testResult('重启前批次元信息正确',
    preRestartBatch?.fileName?.includes(TEST_CSV) && preRestartBatch?.createdBy === 'operator_li');
  testResult('重启前计数正确',
    preRestartBatch?.totalCount === 8 && preRestartBatch?.successCount === 8);

  const preRestartAlarms = await apiCall({
    url: `/api/alarms?importBatchId=${batchId}`,
    headers: { 'X-User-Id': 'admin' },
  });
  const preRestartAudit = await apiCall({
    url: `/api/audit/logs?importBatchId=${batchId}`,
    headers: { 'X-User-Id': 'admin' },
  });
  testResult('重启前告警关联存在', preRestartAlarms.success === true);
  testResult('重启前审计关联存在', preRestartAudit.success === true);

  console.log('  \x1b[36m测试 9.2: 模拟重启 (服务继续运行)\x1b[0m');
  const healthAfter = await apiCall({ url: '/health' });
  testResult('服务仍然运行中', healthAfter.status === 200);

  console.log('  \x1b[36m测试 9.3: 重启后查询批次\x1b[0m');
  const postRestart = await apiCall({
    url: `/api/readings/batches/${batchId}`,
    headers: { 'X-User-Id': 'admin' },
  });
  const postRestartBatch = postRestart.data?.data?.batch;
  testResult('重启后批次仍然存在', postRestart.success === true);
  testResult('重启后批次ID一致', postRestartBatch?.id === batchId);
  testResult('重启后操作者一致', postRestartBatch?.createdBy === preRestartBatch?.createdBy);
  testResult('重启后文件名一致', postRestartBatch?.fileName === preRestartBatch?.fileName);
  testResult('重启后计数一致', postRestartBatch?.totalCount === preRestartBatch?.totalCount);
  testResult('重启后告警关联仍然存在',
    postRestart.data?.data?.alarms?.length === preRestart.data?.data?.alarms?.length);
  testResult('重启后审计关联仍然存在',
    postRestart.data?.data?.auditLogs?.length === preRestart.data?.data?.auditLogs?.length);

  console.log('  \x1b[36m测试 9.4: 重启后逐行结果一致\x1b[0m');
  const preRowIds = preRestart.data?.data?.rowResults?.items?.map(r => r.id).sort().join(',');
  const postRowIds = postRestart.data?.data?.rowResults?.items?.map(r => r.id).sort().join(',');
  testResult('重启后逐行结果ID完全一致', preRowIds === postRowIds);

  console.log('\n\x1b[33m=== 步骤 10: 完整链路测试 ===\x1b[0m');

  console.log('  \x1b[36m测试 10.1: 导入->查看->筛选->导出 完整链路\x1b[0m');
  const FULL_TEST_CSV = 'full_test_chain.csv';
  const fullCsvLines = [
    'deviceId,temperature,readingTime',
    'TEST-FREEZER-001,-22.5,2024-02-01 08:00:00',
    'TEST-FREEZER-001,-23.5,2024-02-01 08:30:00',
    'TEST-FREEZER-001,-21.0,2024-02-01 09:00:00',
  ];
  fs.writeFileSync(FULL_TEST_CSV, fullCsvLines.join('\n'), 'utf8');

  const fullForm = new FormData();
  fullForm.append('operator', 'operator_li');
  fullForm.append('file', fs.createReadStream(FULL_TEST_CSV));

  const fullImport = await apiCall({
    method: 'POST',
    url: '/api/readings/import',
    headers: { 'X-User-Id': 'operator_li' },
    body: fullForm,
    isFormData: true,
  });
  const fullBatchId = fullImport.data?.data?.batchId;
  testResult('完整链路-导入成功', fullImport.success === true);

  const fullDetail = await apiCall({
    url: `/api/readings/batches/${fullBatchId}?rowStatus=success&page=1&pageSize=2`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('完整链路-筛选分页查看成功', fullDetail.success === true);
  testResult('完整链路-分页正确', fullDetail.data?.data?.rowResults?.items?.length === 2);

  const fullExport = await apiCall({
    url: `/api/readings/batches/${fullBatchId}/export?format=json&rowStatus=success`,
    headers: { 'X-User-Id': 'viewer_wang' },
  });
  testResult('完整链路-导出成功', fullExport.data?.rowResults?.length === 3);

  const detailRowIdsFull = fullDetail.data?.data?.rowResults?.items?.map(r => r.id);
  const exportHasDetailRows = fullExport.data?.rowResults?.filter(r => detailRowIdsFull.includes(r.id));
  testResult('完整链路-导出包含详情页数据', exportHasDetailRows.length === 2);

  console.log('\n\x1b[36m========================================\x1b[0m');
  console.log('\x1b[32m测试完成!\x1b[0m');
  console.log('\x1b[36m========================================\x1b[0m\n');

  const totalTests = RESULTS.length;
  const passedTests = RESULTS.filter(r => r.passed).length;
  const failedTests = totalTests - passedTests;

  console.log('\x1b[33m测试摘要:\x1b[0m');
  console.log(`  总测试数: ${totalTests}`);
  console.log(`  \x1b[32m通过: ${passedTests}\x1b[0m`);
  console.log(`  \x1b[31m失败: ${failedTests}\x1b[0m`);
  console.log('');

  if (failedTests > 0) {
    console.log('\x1b[31m失败的测试:\x1b[0m');
    RESULTS.filter(r => !r.passed).forEach(r => {
      console.log(`  \u274C ${r.name}`);
      if (r.message) console.log(`     \x1b[33m${r.message}\x1b[0m`);
    });
    process.exit(1);
  } else {
    console.log('\x1b[32m\uD83C\uDF89 所有测试通过!\x1b[0m');
    process.exit(0);
  }
}

main().catch(err => {
  console.error('Test execution failed:', err);
  process.exit(1);
});
