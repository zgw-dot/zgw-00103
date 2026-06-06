# 冷链温度告警后端服务

本地部署的冷链温度监控告警系统，支持设备台账管理、阈值配置、CSV温度导入、自动告警生成、告警确认与关闭、审计日志查询与导出。

## 目录结构

```
src/
├── api/                    # API层 - 路由控制器
│   ├── devices.ts          # 设备管理接口
│   ├── thresholds.ts       # 阈值配置接口
│   ├── alarms.ts           # 告警管理接口
│   ├── readings.ts         # 读数导入接口
│   ├── audit.ts            # 审计查询接口
│   └── index.ts
├── domain/                 # 领域层 - 业务逻辑
│   ├── rules/              # 领域规则
│   │   ├── alarmRules.ts   # 告警规则（阈值检测、恢复判断、状态流转）
│   │   ├── importRules.ts  # 导入规则（设备校验、重复检测、时序检查）
│   │   ├── authRules.ts    # 权限规则（角色权限控制）
│   │   └── index.ts
│   └── services/           # 领域服务
│       ├── DeviceService.ts
│       ├── ThresholdService.ts
│       ├── AlarmService.ts
│       ├── ReadingImportService.ts
│       ├── AuditService.ts
│       ├── ServiceContainer.ts
│       └── index.ts
├── storage/                # 存储层 - 数据持久化
│   ├── database.ts         # SQLite数据库初始化
│   └── repositories/       # 数据访问层
│       ├── DeviceRepository.ts
│       ├── ThresholdRepository.ts
│       ├── ImportBatchRepository.ts
│       ├── ReadingRepository.ts
│       ├── AlarmRepository.ts
│       ├── AuditRepository.ts
│       └── index.ts
├── validation/             # 校验层 - 参数验证
│   ├── schemas.ts          # Zod校验Schema
│   └── index.ts            # Express校验中间件
├── types/                  # 类型定义
│   └── index.ts
├── config/                 # 应用配置
│   └── index.ts
├── utils/                  # 工具类
│   ├── logger.ts           # 日志
│   └── errors.ts           # 自定义错误
├── middleware/             # Express中间件
│   └── errorHandler.ts     # 错误处理
└── app.ts                  # 应用入口

samples/                    # 示例数据
├── temperature_readings_abnormal.csv      # 含异常的温度数据
├── temperature_readings_with_errors.csv   # 含错误的温度数据
├── temperature_readings_multi_device.csv  # 多设备温度数据
├── init_sample_data.sh                   # Linux/Mac初始化脚本
└── init_sample_data.ps1                  # Windows初始化脚本
```

## 技术栈

- **运行时**: Node.js 18+
- **框架**: Express 4.x
- **语言**: TypeScript 5.x
- **数据库**: SQLite (better-sqlite3)
- **参数校验**: Zod 3.x
- **CSV处理**: csv-parser + multer
- **日志**: Winston 3.x

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 启动服务

```bash
# 开发模式（自动编译）
npm run dev

# 生产模式
npm run build && npm start
```

服务默认运行在 `http://localhost:3000`

### 3. 初始化示例数据

Windows:
```powershell
powershell -ExecutionPolicy Bypass -File samples\init_sample_data.ps1
```

Linux/Mac:
```bash
bash samples/init_sample_data.sh
```

### 4. 验证服务

```bash
curl http://localhost:3000/health
```

## 核心功能

### 1. 设备台账管理

- 新增门店冷柜设备
- 编辑设备信息和状态
- 按门店、设备ID筛选查询
- 支持启用/停用设备

### 2. 阈值配置

三级阈值体系（优先级从高到低）：
1. **设备级阈值**: 针对单个设备的特殊配置
2. **门店级阈值**: 针对某个门店的统一配置
3. **系统默认阈值**: 全局默认配置

### 3. 温度读数导入

CSV格式要求：
```csv
deviceId,temperature,readingTime
FREEZER-001,-22.5,2024-01-15 08:00:00
```

支持的时间格式：
- `YYYY-MM-DD HH:mm:ss`
- `YYYY/MM/DD HH:mm:ss`
- ISO 8601 格式
- Unix 时间戳（毫秒）

**失败路径拦截**：
- ❌ 未知设备 → 返回"设备不存在"
- ❌ 停用设备 → 返回"设备已停用"
- ❌ 重复时间读数 → 返回"已有读数记录"
- ❌ 倒序时间 → 返回"读数时间倒序"
- ❌ 无效温度 → 返回"温度不是有效数字"
- ❌ 无效时间 → 返回"时间格式无效"

### 4. 告警管理

**告警状态流转**：
```
open → acknowledged → recovered → closed
  ↓         ↓            ↑
  └─────────┴────────────┘
         自动恢复
```

**告警类型**：
- `high_temp`: 温度高于阈值上限
- `low_temp`: 温度低于阈值下限

**操作权限控制**：
- `admin`: 全部权限
- `manager_zhang`: 告警确认/关闭、导入、导出
- `operator_li`: 导入、导出
- `viewer_wang`: 仅导出

**失败路径拦截**：
- ❌ 未授权确认 → 403 无权限
- ❌ 未恢复就关闭 → 409 告警尚未恢复
- ❌ 重复确认已确认告警 → 409 状态不允许
- ❌ 关闭已关闭告警 → 409 状态不允许

### 5. 审计查询与导出

- 按门店、设备、告警状态、导入批次筛选
- 支持分页查询
- 导出格式：CSV / JSON
- 导出内容与接口查询完全一致

## API 接口文档

### 认证

所有写操作需要在 Header 中携带 `X-User-Id` 指定操作用户。

测试用户：
- `admin` - 全部权限
- `manager_zhang` - 告警确认/关闭、导入、导出
- `operator_li` - 导入、导出
- `viewer_wang` - 仅导出

---

### 设备管理

#### 创建设备
```http
POST /api/devices
Content-Type: application/json
X-User-Id: admin

{
  "id": "FREEZER-001",
  "name": "肉类冷冻柜1号",
  "storeId": "STORE-001",
  "storeName": "北京朝阳路店",
  "status": "active"
}
```

#### 查询设备列表
```http
GET /api/devices?storeId=STORE-001&page=1&pageSize=50
```

#### 查询单个设备
```http
GET /api/devices/FREEZER-001
```

#### 更新设备
```http
PUT /api/devices/FREEZER-001
Content-Type: application/json
X-User-Id: admin

{
  "name": "肉类冷冻柜1号-更新",
  "status": "inactive"
}
```

#### 更新设备状态
```http
PATCH /api/devices/FREEZER-001/status
Content-Type: application/json
X-User-Id: admin

{
  "status": "inactive"
}
```

---

### 阈值配置

#### 获取默认阈值
```http
GET /api/thresholds/default
```

#### 更新默认阈值
```http
PUT /api/thresholds/default
Content-Type: application/json
X-User-Id: admin

{
  "minTemp": -25,
  "maxTemp": -15
}
```

#### 设置门店阈值
```http
PUT /api/thresholds/store/STORE-001
Content-Type: application/json
X-User-Id: admin

{
  "minTemp": -28,
  "maxTemp": -12
}
```

#### 删除门店阈值
```http
DELETE /api/thresholds/store/STORE-001
X-User-Id: admin
```

#### 设置设备阈值
```http
PUT /api/thresholds/device/FREEZER-001
Content-Type: application/json
X-User-Id: admin

{
  "minTemp": -30,
  "maxTemp": -18
}
```

#### 获取设备生效阈值
```http
GET /api/thresholds/device/FREEZER-001/effective
```

---

### 告警管理

#### 查询告警列表
```http
GET /api/alarms?deviceId=FREEZER-001&alarmStatus=open&page=1&pageSize=50
```

**筛选参数**：
- `storeId`: 门店ID
- `deviceId`: 设备ID
- `alarmStatus`: 告警状态 (open/acknowledged/recovered/closed)
- `startTime`: 开始时间戳
- `endTime`: 结束时间戳

#### 确认告警
```http
POST /api/alarms/{alarmId}/acknowledge
Content-Type: application/json
X-User-Id: manager_zhang

{
  "operator": "manager_zhang",
  "note": "已安排人员检查"
}
```

#### 关闭告警
```http
POST /api/alarms/{alarmId}/close
Content-Type: application/json
X-User-Id: manager_zhang

{
  "operator": "manager_zhang",
  "note": "冷柜已修复，温度恢复正常"
}
```

#### 告警统计
```http
GET /api/alarms/stats/counts
```

---

### 读数导入

#### 导入温度CSV
```http
POST /api/readings/import
Content-Type: multipart/form-data

file: @temperature_readings.csv
operator: operator_li
```

**响应示例**（207 Multi-Status 表示有部分失败）：
```json
{
  "success": false,
  "data": {
    "batchId": "batch-xxxx",
    "successCount": 8,
    "failedCount": 4,
    "generatedAlarms": 1,
    "recoveredAlarms": 0
  },
  "message": "导入完成，成功8条，失败4条",
  "errors": [
    "第3行：设备\"UNKNOWN-999\"不存在，请到设备台账中添加",
    "第5行：读数时间\"invalid-date\"格式无效",
    "第6行：设备\"FREEZER-001\"在2024/1/16 08:00:00已有读数记录，重复数据",
    "第7行：设备\"FREEZER-001\"读数时间倒序"
  ]
}
```

#### 查询导入批次
```http
GET /api/readings/batches
```

#### 查询温度读数
```http
GET /api/readings?deviceId=FREEZER-001&importBatchId=batch-xxxx
```

---

### 审计日志

#### 查询审计日志
```http
GET /api/audit/logs?deviceId=FREEZER-001&page=1&pageSize=100
```

**筛选参数**：
- `storeId`: 门店ID
- `deviceId`: 设备ID
- `alarmStatus`: 关联告警状态
- `importBatchId`: 导入批次ID
- `startTime`: 开始时间戳
- `endTime`: 结束时间戳

#### 导出审计记录
```http
GET /api/audit/export?format=csv&storeId=STORE-001
```

支持 `format=csv` 或 `format=json`

---

## 完整业务流程示例

### 场景：从异常到恢复的完整链路

**步骤1：创建设备**
```bash
curl -X POST http://localhost:3000/api/devices \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{"id":"FREEZER-001","name":"肉类冷冻柜1号","storeId":"STORE-001","storeName":"北京朝阳路店","status":"active"}'
```

**步骤2：设置阈值**
```bash
curl -X PUT http://localhost:3000/api/thresholds/device/FREEZER-001 \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{"minTemp":-25,"maxTemp":-15}'
```

**步骤3：导入异常温度数据（产生告警）**
```bash
curl -X POST http://localhost:3000/api/readings/import \
  -F "file=@samples/temperature_readings_abnormal.csv" \
  -F "operator=operator_li"
```

**步骤4：查看生成的告警**
```bash
curl "http://localhost:3000/api/alarms?alarmStatus=open&deviceId=FREEZER-001"
```

**步骤5：导入恢复数据（自动恢复告警）**

等待温度恢复正常后，导入恢复数据：
```bash
curl -X POST http://localhost:3000/api/readings/import \
  -F "file=@samples/temperature_readings_abnormal.csv" \
  -F "operator=operator_li"
```

> CSV中12:00之后的数据是正常温度，会自动将告警标记为 recovered

**步骤6：有权限人员确认告警**
```bash
curl -X POST http://localhost:3000/api/alarms/{alarmId}/acknowledge \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"operator":"manager_zhang","note":"已确认"}'
```

**步骤7：关闭告警**
```bash
curl -X POST http://localhost:3000/api/alarms/{alarmId}/close \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"operator":"manager_zhang","note":"冷柜已修复，温度恢复正常"}'
```

**步骤8：查看审计日志**
```bash
curl "http://localhost:3000/api/audit/logs?deviceId=FREEZER-001"
```

**步骤9：导出审计记录**
```bash
curl "http://localhost:3000/api/audit/export?format=csv&deviceId=FREEZER-001" \
  -H "X-User-Id: admin" \
  -o audit_export.csv
```

---

## 持久化说明

所有数据存储在 `data/cold_chain.db`（SQLite数据库），包括：
- ✅ 设备台账信息
- ✅ 阈值配置（三级）
- ✅ 温度读数历史
- ✅ 导入批次记录
- ✅ 告警状态及流转历史
- ✅ 操作审计日志

重启服务后所有数据自动恢复。

## 错误码说明

| HTTP 状态码 | 错误类型 | 说明 |
|-----------|---------|------|
| 400 | VALIDATION_ERROR | 参数校验失败 |
| 403 | UNAUTHORIZED | 无操作权限 |
| 404 | NOT_FOUND | 资源不存在 |
| 409 | CONFLICT | 业务冲突（如重复创建、状态不允许） |
| 207 | - | 多状态（部分导入成功） |

## 开发命令

```bash
# 安装依赖
npm install

# 开发模式
npm run dev

# 编译
npm run build

# 类型检查
npm run typecheck

# 生产运行
npm start
```

## 数据文件

- `data/cold_chain.db` - SQLite 数据库文件
- `data/cold_chain.db-wal` - Write-Ahead Log
- `data/cold_chain.db-shm` - Shared Memory File
- `logs/*.log` - 应用日志

## License

MIT
