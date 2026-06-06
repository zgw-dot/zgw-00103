$BASE_URL = "http://localhost:3000"
$Headers = @{"Content-Type" = "application/json"; "X-User-Id" = "admin"}

Write-Host "=== 冷链温度告警系统 - 示例数据初始化 ==="
Write-Host ""

Write-Host "1. 检查服务健康状态..."
try {
    $response = Invoke-RestMethod -Uri "$BASE_URL/health" -Method Get
    $response | ConvertTo-Json -Depth 10
} catch {
    Write-Host "服务未启动，请先运行 npm run dev" -ForegroundColor Red
    exit 1
}
Write-Host ""

Write-Host "2. 创建设备台账..."
Write-Host "   - 门店A冷柜1 (FREEZER-001)"
$body1 = @{
    id = "FREEZER-001"
    name = "肉类冷冻柜1号"
    storeId = "STORE-001"
    storeName = "北京朝阳路店"
    status = "active"
} | ConvertTo-Json
Invoke-RestMethod -Uri "$BASE_URL/api/devices" -Method Post -Body $body1 -Headers $Headers | ConvertTo-Json -Depth 10
Write-Host ""

Write-Host "   - 门店A冷柜2 (FREEZER-002)"
$body2 = @{
    id = "FREEZER-002"
    name = "雪糕冷冻柜2号"
    storeId = "STORE-001"
    storeName = "北京朝阳路店"
    status = "active"
} | ConvertTo-Json
Invoke-RestMethod -Uri "$BASE_URL/api/devices" -Method Post -Body $body2 -Headers $Headers | ConvertTo-Json -Depth 10
Write-Host ""

Write-Host "   - 门店B冷柜1 (FREEZER-003) - 已停用"
$body3 = @{
    id = "FREEZER-003"
    name = "海鲜冷冻柜1号"
    storeId = "STORE-002"
    storeName = "上海南京路店"
    status = "inactive"
} | ConvertTo-Json
Invoke-RestMethod -Uri "$BASE_URL/api/devices" -Method Post -Body $body3 -Headers $Headers | ConvertTo-Json -Depth 10
Write-Host ""

Write-Host "3. 设置阈值..."
Write-Host "   - 默认阈值 (-25℃ ~ -15℃)"
$bodyDefault = @{minTemp = -25; maxTemp = -15} | ConvertTo-Json
Invoke-RestMethod -Uri "$BASE_URL/api/thresholds/default" -Method Put -Body $bodyDefault -Headers $Headers | ConvertTo-Json -Depth 10
Write-Host ""

Write-Host "   - 门店A阈值 (-28℃ ~ -12℃)"
$bodyStore = @{minTemp = -28; maxTemp = -12} | ConvertTo-Json
Invoke-RestMethod -Uri "$BASE_URL/api/thresholds/store/STORE-001" -Method Put -Body $bodyStore -Headers $Headers | ConvertTo-Json -Depth 10
Write-Host ""

Write-Host "   - FREEZER-002 专用阈值 (-30℃ ~ -18℃)"
$bodyDevice = @{minTemp = -30; maxTemp = -18} | ConvertTo-Json
Invoke-RestMethod -Uri "$BASE_URL/api/thresholds/device/FREEZER-002" -Method Put -Body $bodyDevice -Headers $Headers | ConvertTo-Json -Depth 10
Write-Host ""

Write-Host "4. 查看所有设备..."
Invoke-RestMethod -Uri "$BASE_URL/api/devices" -Method Get | ConvertTo-Json -Depth 10
Write-Host ""

Write-Host "=== 初始化完成 ===" -ForegroundColor Green
Write-Host ""
Write-Host "后续操作建议："
Write-Host "1. 导入异常温度数据（产生高温告警）："
Write-Host '   $fileBytes = [System.IO.File]::ReadAllBytes("samples\temperature_readings_abnormal.csv")'
Write-Host '   $fileContent = [System.Text.Encoding]::UTF8.GetString($fileBytes)'
Write-Host '   $boundary = [System.Guid]::NewGuid().ToString()'
Write-Host '   $LF = "`r`n"'
Write-Host '   $bodyLines = @('
Write-Host '     "--$boundary"'
Write-Host '     "Content-Disposition: form-data; name=`"operator`"$LF$LF" + "operator_li"'
Write-Host '     "--$boundary"'
Write-Host '     "Content-Disposition: form-data; name=`"file`"; filename=`"temperature_readings_abnormal.csv`"$LF" + "Content-Type: text/csv$LF$LF" + $fileContent'
Write-Host '     "--$boundary--$LF"'
Write-Host '   ) -join $LF'
Write-Host '   $headers = @{"Content-Type" = "multipart/form-data; boundary=$boundary"}'
Write-Host '   Invoke-RestMethod -Uri "http://localhost:3000/api/readings/import" -Method Post -Body $bodyLines -Headers $headers'
Write-Host ""
Write-Host "2. 查看生成的告警："
Write-Host '   Invoke-RestMethod -Uri "http://localhost:3000/api/alarms?alarmStatus=open" -Method Get | ConvertTo-Json -Depth 10'
Write-Host ""
Write-Host "3. 确认告警（使用 manager_zhang 权限）："
Write-Host '   $alarmId = "al-xxxx"'
Write-Host '   $headers = @{"Content-Type" = "application/json"; "X-User-Id" = "manager_zhang"}'
Write-Host '   $body = @{operator = "manager_zhang"; note = "已关注此告警"} | ConvertTo-Json'
Write-Host '   Invoke-RestMethod -Uri "http://localhost:3000/api/alarms/$alarmId/acknowledge" -Method Post -Body $body -Headers $headers | ConvertTo-Json -Depth 10'
Write-Host ""
Write-Host "4. 关闭告警（需先恢复）："
Write-Host '   $body = @{operator = "manager_zhang"; note = "温度已恢复正常"} | ConvertTo-Json'
Write-Host '   Invoke-RestMethod -Uri "http://localhost:3000/api/alarms/$alarmId/close" -Method Post -Body $body -Headers $headers | ConvertTo-Json -Depth 10'
Write-Host ""
Write-Host "5. 查看审计日志："
Write-Host '   Invoke-RestMethod -Uri "http://localhost:3000/api/audit/logs?deviceId=FREEZER-001" -Method Get | ConvertTo-Json -Depth 10'
Write-Host ""
Write-Host "6. 导出审计记录："
Write-Host '   Invoke-RestMethod -Uri "http://localhost:3000/api/audit/export?format=csv&storeId=STORE-001" -Method Get -OutFile "audit_export.csv"'
Write-Host ""
