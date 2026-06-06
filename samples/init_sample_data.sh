#!/bin/bash

BASE_URL="http://localhost:3000"

echo "=== 冷链温度告警系统 - 示例数据初始化 ==="
echo ""

echo "1. 检查服务健康状态..."
curl -s "$BASE_URL/health" | jq .
echo ""

echo "2. 创建设备台账..."
echo "   - 门店A冷柜1 (FREEZER-001)"
curl -s -X POST "$BASE_URL/api/devices" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{
    "id": "FREEZER-001",
    "name": "肉类冷冻柜1号",
    "storeId": "STORE-001",
    "storeName": "北京朝阳路店",
    "status": "active"
  }' | jq .
echo ""

echo "   - 门店A冷柜2 (FREEZER-002)"
curl -s -X POST "$BASE_URL/api/devices" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{
    "id": "FREEZER-002",
    "name": "雪糕冷冻柜2号",
    "storeId": "STORE-001",
    "storeName": "北京朝阳路店",
    "status": "active"
  }' | jq .
echo ""

echo "   - 门店B冷柜1 (FREEZER-003)"
curl -s -X POST "$BASE_URL/api/devices" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{
    "id": "FREEZER-003",
    "name": "海鲜冷冻柜1号",
    "storeId": "STORE-002",
    "storeName": "上海南京路店",
    "status": "inactive"
  }' | jq .
echo ""

echo "3. 设置阈值..."
echo "   - 默认阈值 (-25℃ ~ -15℃)"
curl -s -X PUT "$BASE_URL/api/thresholds/default" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{"minTemp": -25, "maxTemp": -15}' | jq .
echo ""

echo "   - 门店A阈值 (-28℃ ~ -12℃)"
curl -s -X PUT "$BASE_URL/api/thresholds/store/STORE-001" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{"minTemp": -28, "maxTemp": -12}' | jq .
echo ""

echo "   - FREEZER-002 专用阈值 (-30℃ ~ -18℃)"
curl -s -X PUT "$BASE_URL/api/thresholds/device/FREEZER-002" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{"minTemp": -30, "maxTemp": -18}' | jq .
echo ""

echo "4. 查看所有设备..."
curl -s "$BASE_URL/api/devices" | jq .
echo ""

echo "=== 初始化完成 ==="
echo ""
echo "后续操作建议："
echo "1. 导入异常温度数据："
echo "   curl -X POST $BASE_URL/api/readings/import -F 'file=@samples/temperature_readings_abnormal.csv' -F 'operator=operator_li'"
echo ""
echo "2. 查看生成的告警："
echo "   curl '$BASE_URL/api/alarms?alarmStatus=open'"
echo ""
echo "3. 导入恢复数据后确认并关闭告警："
echo "   curl -X POST $BASE_URL/api/alarms/{alarmId}/acknowledge -H 'X-User-Id: manager_zhang' -H 'Content-Type: application/json' -d '{\"operator\":\"manager_zhang\"}'"
echo "   curl -X POST $BASE_URL/api/alarms/{alarmId}/close -H 'X-User-Id: manager_zhang' -H 'Content-Type: application/json' -d '{\"operator\":\"manager_zhang\",\"note\":\"已恢复正常\"}'"
echo ""
echo "4. 查看审计日志："
echo "   curl '$BASE_URL/api/audit/logs?deviceId=FREEZER-001'"
echo ""
echo "5. 导出审计记录："
echo "   curl '$BASE_URL/api/audit/export?format=csv&storeId=STORE-001' -o audit_export.csv"
