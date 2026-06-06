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
│   ├── calibration.ts      # 校准计划和修正记录接口
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
│       ├── CalibrationService.ts  # 新增：校准计划和读数修正服务
│       ├── ServiceContainer.ts
│       └── index.ts
├── storage/                # 存储层 - 数据持久化
│   ├── database.ts         # SQLite数据库初始化（含事务管理）
│   └── repositories/       # 数据访问层
│       ├── DeviceRepository.ts
│       ├── ThresholdRepository.ts
│       ├── ImportBatchRepository.ts    # 批次管理（增强版）
│       ├── BatchRowResultRepository.ts # 逐行结果存储
│       ├── ReadingRepository.ts
│       ├── AlarmRepository.ts
│       ├── AuditRepository.ts
│       ├── CalibrationPlanRepository.ts     # 新增：校准计划存储
│       ├── ReadingCorrectionRepository.ts   # 新增：读数修正记录存储
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

### 3.1 Dry-Run 预检

**在正式导入前进行预检，不写入数据库**：

预检会返回完整的分析报告：
- ✅ 会新增的读数
- ⚠️ 会触发的告警
- ✅ 会恢复的告警
- ❌ 未知设备
- ❌ 停用设备
- ❌ 重复时间读数
- ❌ 倒序时间读数
- ⚠️ 阈值冲突
- ❌ 逐行错误详情

**预检和正式导入使用同一套校验规则，确保结果一致**。

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

| 角色 | 权限 |
|------|------|
| `admin` | 全部权限（设备管理、阈值配置、告警确认/关闭、预检、导入、导出、查看批次、**异常行备注管理**） |
| `manager_zhang` | 告警确认/关闭、预检、导入、导出、查看批次、**异常行备注管理** |
| `operator_li` | 预检、导入、导出、查看批次（仅查看备注，不可修改） |
| `viewer_wang` | 查看批次、导出（无预检、无导入、无告警确认，仅查看备注） |

**权限控制细节**：
- 👁️ `viewer`: 只能查看批次详情和导出数据，可查看备注但不可修改
- 📥 `operator`: 可以进行预检和正式导入，可查看备注但不可修改
- 🔧 `manager/admin`: 可以确认和关闭告警，可以**添加、修改、清空异常行备注**

**失败路径拦截**：
- ❌ 未授权确认 → 403 无权限
- ❌ 未恢复就关闭 → 409 告警尚未恢复
- ❌ 重复确认已确认告警 → 409 状态不允许
- ❌ 关闭已关闭告警 → 409 状态不允许

### 5. 告警升级与值班派单

当 `open` 告警超过配置的确认时限后，系统会自动按门店或设备规则生成升级单，分配给值班处理人。

#### 5.1 升级规则体系（三级覆盖）

优先级从高到低：
1. **设备级规则**: 针对单个设备的特殊配置
2. **门店级规则**: 针对某个门店的统一配置
3. **系统默认规则**: 全局默认配置

每个范围内只能有一个 `active` 状态的规则。

#### 5.2 规则状态

- `active`: 生效中
- `inactive`: 已停用（可重新激活）
- `revoked`: 已撤销（**不可恢复，历史记录保留**）

#### 5.3 升级单状态

- `pending`: 待领取
- `claimed`: 已领取
- `resolved`: 已解决

#### 5.4 权限控制

| 角色 | 权限 |
|------|------|
| `admin` / `manager` | 创建升级规则、停用规则、撤销规则、查看升级、领取派单、导出升级数据 |
| `operator` | 查看升级、领取派单、导出升级数据 |
| `viewer` | 查看升级、导出升级数据 |

**权限边界**：
- 👁️ `viewer`: 只能查看规则和派单，不能修改
- 📥 `operator`: 可以领取派单，但不能管理规则
- 🔧 `manager`/`admin`: 可以管理规则（创建、停用、撤销）和领取派单
- ❌ 撤销规则不会删除历史升级记录，只会影响新的告警升级

#### 5.5 自动升级机制

系统每 60 秒自动检测超时告警：
1. 查找所有 `open` 状态且未确认的告警
2. 按优先级匹配升级规则（设备 > 门店 > 默认）
3. 如果告警创建时间 + 确认时限 ≤ 当前时间，生成升级单
4. 升级单自动派发给规则配置的处理人
5. 记录审计日志

**防止重复升级**：
- 每个告警只能生成一个升级单（`UNIQUE(alarm_id)`）
- 已停用设备的告警不会自动升级

#### 5.6 规则校验（创建时的检查）

| 校验项 | 错误响应 |
|--------|---------|
| 重复规则（同一范围已存在 active 规则） | 409 CONFLICT |
| 确认时限 ≤ 0 | 400 VALIDATION_ERROR |
| 处理人不存在 | 400 VALIDATION_ERROR |
| 设备不存在（设备级规则） | 400 VALIDATION_ERROR |
| 设备已停用（设备级规则） | 400 VALIDATION_ERROR |
| 门店级规则未指定 storeId | 400 VALIDATION_ERROR |
| 设备级规则未指定 deviceId | 400 VALIDATION_ERROR |

#### 5.7 升级状态展示

升级状态会自动同步到：
- **告警详情**：包含 `escalationStatus`、`escalationTicketId`、`escalationRuleName` 等字段
- **告警列表**：每条告警都包含升级状态信息
- **审计日志**：记录规则创建、停用、撤销、升级单生成、领取等操作

### 6. 设备校准计划和读数修正

当设备传感器出现漂移时，可以创建校准计划，在导入温度 CSV 时自动应用偏移修正。

#### 6.1 核心概念

- **校准计划 (Calibration Plan)**: 定义某个设备在特定时间段内的温度偏移修正规则
- **读数修正 (Reading Correction)**: 每次导入时应用校准计划的具体记录，保存原始温度、修正后温度和命中的校准计划
- **偏移值 (Offset Value)**: 需要修正的温度值（℃），支持正负值
  - `+1.5` 表示在原始温度基础上加 1.5℃
  - `-0.5` 表示在原始温度基础上减 0.5℃

#### 6.2 计划状态生命周期

```
active → inactive → revoked
   ↓         ↓          ↓
  生效中     已停用     已撤销
```

- **`active` (生效中)**: 导入时会自动应用该计划
- **`inactive` (已停用)**: 不再应用于新导入，但历史修正记录保留
- **`revoked` (已撤销)**: 永久停用，历史修正记录保留，**不可恢复**

> **重要保证**：停用或撤销计划不会修改任何历史导入结果，已应用的修正记录保持不变。

#### 6.3 自动校准流程

```
CSV 导入 → 解析每行数据 → 按设备+时间匹配校准计划 →
  匹配成功 → 应用偏移修正 → 保存原始温度、修正后温度、校准计划ID →
            基于修正后温度进行告警判断 → 生成告警
  匹配失败 → 不修正，直接使用原始温度
```

#### 6.4 时间匹配规则

对于每个读数，查找满足以下条件的校准计划：
1. 计划状态为 `active`
2. 设备 ID 匹配
3. 读数时间 ≥ 计划生效开始时间
4. 读数时间 ≤ 计划生效结束时间（或计划无结束时间，即永久生效）

**匹配优先级**：
- 如果有多个计划覆盖同一时间点，选择**生效开始时间最晚**的计划
- 同一设备在同一时间段内只能有一个 active 计划（创建时会自动检测冲突）

#### 6.5 权限控制

| 角色 | 权限 |
|------|------|
| `admin` / `manager` | 创建校准计划、停用计划、撤销计划、查看计划、查看修正记录、导出校准数据 |
| `operator` | 查看计划、查看修正记录、导出校准数据、**执行 CSV 导入**（导入时自动应用校准） |
| `viewer` | 查看计划、查看修正记录、导出校准数据 |

**权限边界**：
- 👁️ `viewer`: 只能查看和导出，不能创建/修改计划
- 📥 `operator`: 可以执行 CSV 导入（导入时自动应用校准），但不能管理计划
- 🔧 `manager`/`admin`: 可以完整管理计划生命周期（创建、停用、撤销）
- ❌ 停用/撤销计划不会修改任何历史修正结果，只会影响未来的导入

#### 6.6 冲突处理与错误响应

| 冲突场景 | 错误响应 | 说明 |
|---------|---------|------|
| 时间段重叠 | 409 CONFLICT | 同一设备在同一时间段内已存在 active 计划 |
| 无效偏移值 | 400 VALIDATION_ERROR | 偏移值必须在 -50℃ 到 +50℃ 之间 |
| 停用设备创建计划 | 400 VALIDATION_ERROR | 已停用的设备不能创建校准计划 |
| 跨门店设备不匹配 | 500 BUSINESS_ERROR | 校准计划的门店与设备的门店不匹配 |
| 重复停用 | 409 CONFLICT | 已停用的计划不能再次停用 |
| 无效时间范围 | 400 VALIDATION_ERROR | 开始时间 ≥ 结束时间 |
| 负责人不存在 | 400 VALIDATION_ERROR | 负责人必须是系统已知用户 |

#### 6.7 数据存储设计

**校准影响会贯穿所有数据层：**

1. **温度读数** (`temperature_readings`):
   - `original_temperature`: 原始读数（CSV 中的值）
   - `corrected_temperature`: 修正后温度（用于告警判断）
   - `calibration_plan_id`: 命中的校准计划 ID（无校准则为 NULL）
   - `temperature`: 等价于 `corrected_temperature`

2. **告警** (`alarms`):
   - `original_temperature`: 告警读数的原始温度
   - `calibration_plan_id`: 触发告警时使用的校准计划
   - `recovered_original_temperature`: 恢复读数的原始温度
   - `recovered_calibration_plan_id`: 恢复读数使用的校准计划

3. **批次行结果** (`batch_row_results`):
   - `original_temperature`: 该行的原始温度
   - `corrected_temperature`: 该行的修正后温度
   - `calibration_plan_id`: 该行命中的校准计划

4. **读数修正记录** (`reading_corrections`):
   - 专用表记录每次应用校准的详细信息，用于审计和追溯

#### 6.8 校准信息展示位置

校准信息会在以下所有界面/接口中展示：
- ✅ 批次详情（逐行结果）
- ✅ 告警详情和告警列表
- ✅ JSON/CSV 导出（批次、告警、审计日志）
- ✅ 校准计划详情（关联的修正记录列表）
- ✅ 修正记录列表和导出
- ✅ 审计日志（包含校准创建、停用、撤销操作）

#### 6.9 持久化保证

所有数据存储在 SQLite 数据库文件中：
- 同一 `DB_PATH` 重启后，校准计划、历史修正结果和审计记录仍可查询
- 数据库文件可以直接备份和迁移
- 事务保证：创建计划、导入读数、应用修正都在事务中执行，失败时全部回滚

### 3.2 批次复盘详情与失败行处置进度

**按导入批次查看完整复盘信息**：

每个导入批次包含完整的详情包括：
- 📋 批次基本信息（状态、文件名、操作者、时间）
- 📊 逐行结果（每行的成功/失败状态、错误信息）
- ⚠️ 关联的告警记录
- 📝 关联的审计事件
- 📑 **异常行处置备注统计**（已备注/未备注失败行数）
- 💬 **每行失败行的处置备注**（处理人、处理时间、原因）
- 📈 **详细处置统计**（处理人分布、完成进度百分比）
- 🔍 **失败行筛选能力**（按备注状态、处理人、处理时间范围筛选）

**支持的批次状态：
- `pending`: 待处理
- `processing`: 处理中
- `completed`: 已完成
- `failed`: 失败
- `rolled_back`: 已回滚

**异常行处置备注能力**：
- ✅ `manager/admin` 可以对失败行**添加、修改、清空**处置备注
- 👁️ 所有角色均可**查看**备注和**导出**包含备注的数据
- 🔄 同一行被重复修改时保留最新备注和一条审计日志
- 🗑️ 空备注视为清空
- 💾 备注包含：`remarkContent`（原因）、`handledBy`（处理人）、`handledAt`（处理时间）

**失败行处置进度筛选**：

**批次列表筛选参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| `remarkStatus` | `remarked` \| `unremarked` | 按备注状态筛选（已备注/未备注） |
| `handledBy` | `string` | 按处理人筛选（必须是已知用户：`admin`, `manager_zhang`, `operator_li`, `viewer_wang`） |
| `remarkStartTime` | `number` | 处理时间范围开始（毫秒时间戳） |
| `remarkEndTime` | `number` | 处理时间范围结束（毫秒时间戳） |

**批次详情筛选参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| `remarkStatus` | `remarked` \| `unremarked` | 按备注状态筛选行 |
| `handledBy` | `string` | 按处理人筛选行 |
| `remarkStartTime` | `number` | 处理时间范围开始 |
| `remarkEndTime` | `number` | 处理时间范围结束 |

**筛选约束**：
- ❌ 筛选 `unremarked`（未备注）时不能同时指定 `handledBy` 或时间范围
- ❌ `remarkStartTime` 不能大于 `remarkEndTime`
- ❌ `handledBy` 必须是系统已知用户
- ❌ 时间戳必须在有效范围内（2000-01-01 ~ 2100-01-01）

**错误响应示例**：
```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "message": "remarkStatus: 筛选未备注行时不能同时指定处理人或处理时间范围",
  "errors": ["remarkStatus: 筛选未备注行时不能同时指定处理人或处理时间范围"]
}
```

**处置统计说明**：

批次级 `dispositionStats`：
```json
{
  "totalFailedRows": 4,
  "remarkedRows": 2,
  "unremarkedRows": 2,
  "byHandler": [
    { "handledBy": "manager_zhang", "count": 1 },
    { "handledBy": "admin", "count": 1 }
  ],
  "remarkProgress": 50
}
```

列表级 `summary`：
```json
{
  "totalBatches": 10,
  "batchesWithUnremarkedRows": 3,
  "totalFailedRows": 25,
  "totalRemarkedRows": 18,
  "totalUnremarkedRows": 7,
  "overallProgress": 72
}
```

### 3.3 JSON/CSV 导出

**导出功能特性：
- 支持 `JSON` 和 `CSV` 两种格式
- 导出内容与查询结果完全一致
- 导出包含**异常行处置备注**信息（统计信息和每行备注）
- viewer 角色可以查看和导出，operator 角色可以预检和导入，manager/admin 可以确认和关闭告警、管理备注

### 4. 事务保障

**整批失败不留下任何残留**：
- 正式导入使用数据库事务
- 如果导入过程中发生错误，所有读数、告警、审计日志会全部回滚
- 批次状态标记为 `rolled_back`
- 不会留下任何部分成功的数据

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

#### Dry-Run 预检

**在正式导入前进行预检，不写入数据库**：

```http
POST /api/readings/dry-run
Content-Type: multipart/form-data
X-User-Id: operator_li

file: @temperature_readings.csv
operator: operator_li
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "fileName": "temperature_readings.csv",
    "totalCount": 8,
    "validCount": 4,
    "invalidCount": 4,
    "newReadings": [
      {"deviceId": "FREEZER-001", "temperature": -22.5, "readingTime": 1705305600000, "rowIndex": 1}
    ],
    "triggeredAlarms": [
      {"deviceId": "FREEZER-001", "type": "high_temp", "threshold": -15, "temperature": -12, "rowIndex": 3}
    ],
    "recoveredAlarms": [],
    "unknownDevices": [{"deviceId": "UNKNOWN-999", "rowIndex": 2}],
    "inactiveDevices": [],
    "duplicateTimes": [],
    "outOfOrderTimes": [
      {"deviceId": "FREEZER-001", "currentTime": 1705305600000, "previousTime": 1705309200000, "rowIndex": 4}
    ],
    "thresholdConflicts": [
      {"deviceId": "FREEZER-001", "temperature": -12, "threshold": -15, "violationType": "above_max", "rowIndex": 3}
    ],
    "rowErrors": [
      {"rowIndex": 2, "error": "第2行：设备\"UNKNOWN-999\"不存在，请到设备台账中添加"}
    ]
  }
}
```

#### 查询导入批次列表

```http
GET /api/readings/batches?batchStatus=completed&page=1&pageSize=50
X-User-Id: viewer_wang
```

**筛选参数**：
- `batchStatus`: 批次状态 (pending/processing/completed/failed/rolled_back)
- `startTime`: 开始时间戳
- `endTime`: 结束时间戳
- `remarkStatus`: 按备注状态筛选 (`remarked`/`unremarked`)
- `handledBy`: 按处理人筛选（已知用户：`admin`, `manager_zhang`, `operator_li`, `viewer_wang`）
- `remarkStartTime`: 处理时间范围开始（毫秒时间戳）
- `remarkEndTime`: 处理时间范围结束（毫秒时间戳）

**快速定位未处理异常（值班人员常用）**：
```bash
# 查找所有包含未备注失败行的批次
curl "http://localhost:3000/api/readings/batches?remarkStatus=unremarked" \
  -H "X-User-Id: viewer_wang"
```

**按处理人筛选**：
```bash
# 查找 manager_zhang 处理过的批次
curl "http://localhost:3000/api/readings/batches?handledBy=manager_zhang" \
  -H "X-User-Id: viewer_wang"
```

**按处理时间范围筛选**：
```bash
# 查找 2024-01-15 当天处理的备注
curl "http://localhost:3000/api/readings/batches?remarkStartTime=1705276800000&remarkEndTime=1705363199000" \
  -H "X-User-Id: viewer_wang"
```

**响应示例**（包含处置统计汇总）：
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "batch-xxxx",
        "fileName": "temperature_readings.csv",
        "totalCount": 8,
        "successCount": 4,
        "failedCount": 4,
        "status": "completed",
        "createdBy": "operator_li",
        "createdAt": 1705305600000,
        "remarkStats": {
          "totalFailedRows": 4,
          "remarkedRows": 2,
          "unremarkedRows": 2
        },
        "dispositionStats": {
          "totalFailedRows": 4,
          "remarkedRows": 2,
          "unremarkedRows": 2,
          "byHandler": [
            { "handledBy": "manager_zhang", "count": 2 }
          ],
          "remarkProgress": 50
        }
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 50,
    "summary": {
      "totalBatches": 1,
      "batchesWithUnremarkedRows": 1,
      "totalFailedRows": 4,
      "totalRemarkedRows": 2,
      "totalUnremarkedRows": 2,
      "overallProgress": 50
    },
    "appliedFilters": {
      "remarkStatus": "unremarked"
    }
  }
}
```

#### 查询批次详情（复盘）

```http
GET /api/readings/batches/{batchId}?rowStatus=failed&remarkStatus=unremarked&page=1&pageSize=10
X-User-Id: viewer_wang
```

**筛选参数**：
- `rowStatus`: 行状态 (`pending`/`success`/`failed`/`skipped`/`all`)，默认 `all`
- `remarkStatus`: 按备注状态筛选行 (`remarked`/`unremarked`)
- `handledBy`: 按处理人筛选行
- `remarkStartTime`: 处理时间范围开始
- `remarkEndTime`: 处理时间范围结束
- `page`: 页码，默认 1
- `pageSize`: 每页条数，默认 100，最大 500

**筛选未处理的失败行（值班人员快速定位）**：
```bash
# 只显示未备注的失败行
curl "http://localhost:3000/api/readings/batches/{batchId}?rowStatus=failed&remarkStatus=unremarked" \
  -H "X-User-Id: viewer_wang"
```

**筛选 manager_zhang 处理过的行**：
```bash
curl "http://localhost:3000/api/readings/batches/{batchId}?handledBy=manager_zhang" \
  -H "X-User-Id: viewer_wang"
```

**响应示例**（包含备注统计和每行备注）：
```json
{
  "success": true,
  "data": {
    "batch": {
      "id": "batch-xxxx",
      "fileName": "temperature_readings.csv",
      "totalCount": 8,
      "successCount": 4,
      "failedCount": 4,
      "status": "completed",
      "createdBy": "operator_li",
      "createdAt": 1705305600000,
      "completedAt": 1705305610000,
      "remarkStats": {
        "totalFailedRows": 4,
        "remarkedRows": 2,
        "unremarkedRows": 2
      }
    },
    "dispositionStats": {
      "totalFailedRows": 4,
      "remarkedRows": 2,
      "unremarkedRows": 2,
      "byHandler": [
        { "handledBy": "manager_zhang", "count": 1 },
        { "handledBy": "admin", "count": 1 }
      ],
      "remarkProgress": 50
    },
    "rowResults": {
      "items": [
        {"rowIndex": 1, "deviceId": "FREEZER-001", "temperature": -22.5, "status": "success", "errorMessage": null, "remark": null},
        {
          "rowIndex": 2,
          "deviceId": "UNKNOWN-999",
          "status": "failed",
          "errorMessage": "设备不存在",
          "remark": {
            "remarkContent": "设备不存在，已通知门店补充设备台账",
            "handledBy": "manager_zhang",
            "handledAt": 1705305700000
          }
        }
      ],
      "total": 8,
      "page": 1,
      "pageSize": 100
    },
    "alarms": [
      {"id": "al-xxxx", "deviceId": "FREEZER-001", "type": "high_temp", "status": "open"}
    ],
    "auditLogs": [
      {"operationType": "reading_import", "operator": "operator_li", "details": "导入完成"}
    ],
    "appliedFilters": {
      "rowStatus": "failed",
      "remarkStatus": "unremarked"
    }
  }
}
```

#### 查询批次列表（包含备注统计）

```http
GET /api/readings/batches?batchStatus=completed&page=1&pageSize=50
X-User-Id: viewer_wang
```

**响应示例**（每个批次包含备注统计）：
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "id": "batch-xxxx",
        "fileName": "temperature_readings.csv",
        "totalCount": 8,
        "successCount": 4,
        "failedCount": 4,
        "status": "completed",
        "createdBy": "operator_li",
        "createdAt": 1705305600000,
        "remarkStats": {
          "totalFailedRows": 4,
          "remarkedRows": 2,
          "unremarkedRows": 2
        }
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 50
  }
}
```

#### 添加/修改/清空异常行处置备注

```http
PUT /api/readings/batches/{batchId}/rows/{rowIndex}/remark
Content-Type: application/json
X-User-Id: manager_zhang

{
  "remarkContent": "设备不存在，已通知门店补充设备台账"
}
```

**说明**：
- 仅 `manager`/`admin` 角色可调用
- `remarkContent` 为空字符串或纯空格时视为**清空备注**
- 同一行重复修改时保留最新备注，并记录审计日志
- 只能对**失败行**添加备注，成功行会返回错误

**成功响应示例**（新增）：
```json
{
  "success": true,
  "data": {
    "remark": {
      "id": "remark-xxxx",
      "importBatchId": "batch-xxxx",
      "rowIndex": 2,
      "remarkContent": "设备不存在，已通知门店补充设备台账",
      "handledBy": "manager_zhang",
      "handledAt": 1705305700000,
      "createdAt": 1705305700000,
      "updatedAt": 1705305700000
    },
    "isNew": true,
    "isClear": false
  },
  "message": "备注已添加"
}
```

**成功响应示例**（修改）：
```json
{
  "success": true,
  "data": {
    "remark": {
      "id": "remark-xxxx",
      "importBatchId": "batch-xxxx",
      "rowIndex": 2,
      "remarkContent": "设备不存在，已通知门店补充设备台账，门店承诺3日内完成",
      "handledBy": "admin",
      "handledAt": 1705305800000,
      "createdAt": 1705305700000,
      "updatedAt": 1705305800000
    },
    "isNew": false,
    "isClear": false
  },
  "message": "备注已更新"
}
```

**成功响应示例**（清空）：
```json
{
  "success": true,
  "data": {
    "remark": {
      "id": "remark-xxxx",
      "importBatchId": "batch-xxxx",
      "rowIndex": 2,
      "remarkContent": "",
      "handledBy": "manager_zhang",
      "handledAt": 1705305900000,
      "createdAt": 1705305700000,
      "updatedAt": 1705305900000
    },
    "isNew": false,
    "isClear": true
  },
  "message": "备注已清空"
}
```

**无权限响应**（403）：
```json
{
  "success": false,
  "code": "UNAUTHORIZED",
  "message": "用户\"operator_li\"没有\"manage_row_remarks\"操作权限，请联系管理员授权"
}
```

**无效批次响应**（404）：
```json
{
  "success": false,
  "code": "NOT_FOUND",
  "message": "导入批次\"invalid-batch-id\"不存在"
}
```

**无效行号响应**（404）：
```json
{
  "success": false,
  "code": "NOT_FOUND",
  "message": "批次\"batch-xxxx\"中不存在行号\"9999\""
}
```

#### 查询单行备注

```http
GET /api/readings/batches/{batchId}/rows/{rowIndex}/remark
X-User-Id: viewer_wang
```

**响应示例**（有备注）：
```json
{
  "success": true,
  "data": {
    "id": "remark-xxxx",
    "importBatchId": "batch-xxxx",
    "rowIndex": 2,
    "remarkContent": "设备不存在，已通知门店补充设备台账",
    "handledBy": "manager_zhang",
    "handledAt": 1705305700000,
    "createdAt": 1705305700000,
    "updatedAt": 1705305700000
  }
}
```

**响应示例**（无备注）：
```json
{
  "success": true,
  "data": null
}
```

#### 导出批次详情

**导出为 JSON**：
```http
GET /api/readings/batches/{batchId}/export?format=json&rowStatus=failed&remarkStatus=unremarked
X-User-Id: viewer_wang
```

**导出为 CSV**：
```http
GET /api/readings/batches/{batchId}/export?format=csv&handledBy=manager_zhang
X-User-Id: viewer_wang
```

**导出筛选参数**（与详情查询一致）：
- `rowStatus`: 按行状态筛选导出
- `remarkStatus`: 按备注状态筛选导出
- `handledBy`: 按处理人筛选导出
- `remarkStartTime`: 按处理时间范围开始筛选
- `remarkEndTime`: 按处理时间范围结束筛选

> 导出内容与筛选后的查询结果完全一致。JSON 导出包含 `filters` 字段记录应用的筛选条件，CSV 导出包含「应用筛选条件」章节显示筛选参数。

**权限说明**：
- 👁️ `viewer` / `operator` 角色：可以查看和导出（包含所有筛选参数）
- 🔧 `manager` / `admin` 角色：可以查看、导出，以及写备注

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

### 告警升级与值班派单

#### 创建升级规则
```http
POST /api/escalation/rules
Content-Type: application/json
X-User-Id: manager_zhang

{
  "name": "门店超时升级规则",
  "scope": "store",
  "storeId": "STORE-001",
  "acknowledgeTimeoutSeconds": 300,
  "assigneeUserId": "operator_li",
  "operator": "manager_zhang"
}
```

**scope 说明**：
- `default`: 系统默认规则
- `store`: 门店级规则（需指定 `storeId`）
- `device`: 设备级规则（需指定 `deviceId`）

#### 查询升级规则列表
```http
GET /api/escalation/rules?ruleStatus=active&page=1&pageSize=50
X-User-Id: viewer_wang
```

**筛选参数**：
- `ruleStatus`: 规则状态 (active/inactive/revoked)
- `storeId`: 门店ID
- `deviceId`: 设备ID

#### 查询单个升级规则
```http
GET /api/escalation/rules/{ruleId}
```

#### 停用升级规则
```http
POST /api/escalation/rules/{ruleId}/deactivate
Content-Type: application/json
X-User-Id: manager_zhang

{
  "operator": "manager_zhang"
}
```

#### 撤销升级规则（不可恢复，历史记录保留）
```http
POST /api/escalation/rules/{ruleId}/revoke
Content-Type: application/json
X-User-Id: manager_zhang

{
  "operator": "manager_zhang"
}
```

> **重要**：撤销规则不会删除已生成的历史升级单，只会阻止新的告警使用该规则升级。

#### 查询升级单列表
```http
GET /api/escalation/tickets?ticketStatus=pending&assigneeUserId=operator_li&page=1&pageSize=50
X-User-Id: operator_li
```

**筛选参数**：
- `ticketStatus`: 升级单状态 (pending/claimed/resolved)
- `assigneeUserId`: 指派处理人
- `claimedBy`: 领取人
- `ruleId`: 关联规则ID
- `alarmId`: 关联告警ID
- `startTime`/`endTime`: 升级时间范围

#### 查询单个升级单
```http
GET /api/escalation/tickets/{ticketId}
X-User-Id: operator_li
```

#### 根据告警ID查询升级单
```http
GET /api/escalation/tickets/alarm/{alarmId}
X-User-Id: operator_li
```

#### 领取升级单
```http
POST /api/escalation/tickets/{ticketId}/claim
Content-Type: application/json
X-User-Id: operator_li

{
  "operator": "operator_li"
}
```

#### 升级单统计
```http
GET /api/escalation/stats/counts
X-User-Id: viewer_wang
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "pending": 3,
    "claimed": 5,
    "resolved": 10
  }
}
```

#### 手动触发超时处理
```http
POST /api/escalation/process-overdue
Content-Type: application/json
X-User-Id: admin

{
  "currentTime": 1705305600000
}
```

> `currentTime` 为可选参数，用于测试时指定当前时间。系统默认每 60 秒自动执行一次。

#### 导出升级数据
```http
GET /api/escalation/export?format=csv&ticketStatus=claimed
X-User-Id: operator_li
```

支持 `format=csv` 或 `format=json`，筛选参数与列表查询一致。

**CSV 导出包含字段**：升级单ID、告警ID、规则名称、状态、指派处理人、领取人、升级时间、领取时间、解决时间、解决备注、设备ID、设备名称、门店ID、门店名称、告警类型、告警温度、告警阈值、创建时间

**JSON 导出包含**：完整的升级单信息、关联规则信息、关联告警信息、关联设备信息

---

### 设备校准计划和读数修正

#### 创建校准计划
```http
POST /api/calibration/plans
Content-Type: application/json
X-User-Id: manager_zhang

{
  "deviceId": "FREEZER-001",
  "offsetValue": 1.5,
  "effectiveStartTime": 1705276800000,
  "effectiveEndTime": 1707868800000,
  "reason": "传感器漂移校准，经计量检测需加1.5℃修正",
  "personInCharge": "manager_zhang",
  "operator": "manager_zhang"
}
```

**字段说明**：
- `offsetValue`: 偏移值（℃），范围 -50 到 +50，正数表示在原始读数基础上加，负数表示减
- `effectiveStartTime`: 生效开始时间（毫秒时间戳）
- `effectiveEndTime`: 生效结束时间（毫秒时间戳，可选，不填则永久生效）
- `reason`: 校准原因（1-500字符）
- `personInCharge`: 负责人，必须是系统已知用户（admin/manager_zhang/operator_li/viewer_wang）

**成功响应示例**：
```json
{
  "success": true,
  "data": {
    "id": "cal-xxxx",
    "deviceId": "FREEZER-001",
    "storeId": "STORE-001",
    "offsetValue": 1.5,
    "effectiveStartTime": 1705276800000,
    "effectiveEndTime": 1707868800000,
    "reason": "传感器漂移校准",
    "personInCharge": "manager_zhang",
    "status": "active",
    "createdBy": "manager_zhang",
    "createdAt": 1705305600000
  },
  "message": "校准计划创建成功"
}
```

**冲突响应示例**（时间段重叠）：
```json
{
  "success": false,
  "code": "CONFLICT",
  "message": "设备 FREEZER-001 在该时间段内已存在 active 校准计划"
}
```

#### 查询校准计划列表
```http
GET /api/calibration/plans?planStatus=active&deviceId=FREEZER-001&page=1&pageSize=50
X-User-Id: viewer_wang
```

**筛选参数**：
- `planStatus`: 计划状态 (active/inactive/revoked)
- `deviceId`: 设备ID
- `storeId`: 门店ID
- `startTime`: 生效时间范围开始（毫秒时间戳）
- `endTime`: 生效时间范围结束（毫秒时间戳）
- `page`: 页码，默认 1
- `pageSize`: 每页条数，默认 50，最大 500

#### 查询单个校准计划
```http
GET /api/calibration/plans/{planId}
X-User-Id: viewer_wang
```

**响应包含**：计划基本信息、关联的修正记录列表、创建/停用/撤销的审计日志

#### 停用校准计划
```http
POST /api/calibration/plans/{planId}/deactivate
Content-Type: application/json
X-User-Id: manager_zhang

{
  "operator": "manager_zhang"
}
```

**成功响应**：
```json
{
  "success": true,
  "data": {
    "id": "cal-xxxx",
    "status": "inactive",
    "deactivatedBy": "manager_zhang",
    "deactivatedAt": 1705305700000
  },
  "message": "校准计划停用成功，历史校准结果保持不变"
}
```

> **重要**：停用计划不会修改任何历史导入结果，已应用的修正记录保持不变。

#### 撤销校准计划（不可恢复）
```http
POST /api/calibration/plans/{planId}/revoke
Content-Type: application/json
X-User-Id: manager_zhang

{
  "operator": "manager_zhang"
}
```

**成功响应**：
```json
{
  "success": true,
  "data": {
    "id": "cal-xxxx",
    "status": "revoked",
    "revokedBy": "manager_zhang",
    "revokedAt": 1705305800000
  },
  "message": "校准计划撤销成功，历史校准结果保持不变"
}
```

> **重要**：撤销后计划永久失效，不可恢复，但历史修正记录保持不变。

#### 查询计划关联的修正记录
```http
GET /api/calibration/plans/{planId}/corrections?page=1&pageSize=50
X-User-Id: viewer_wang
```

#### 查询所有读数修正记录
```http
GET /api/calibration/corrections?deviceId=FREEZER-001&page=1&pageSize=50
X-User-Id: viewer_wang
```

**筛选参数**：
- `deviceId`: 设备ID
- `storeId`: 门店ID
- `startTime`: 修正时间范围开始
- `endTime`: 修正时间范围结束

#### 查询批次关联的修正记录
```http
GET /api/calibration/corrections/batch/{batchId}
X-User-Id: viewer_wang
```

#### 导出校准数据
```http
GET /api/calibration/export?format=csv&planStatus=active
X-User-Id: viewer_wang
```

支持 `format=csv` 或 `format=json`，筛选参数与列表查询一致。

**CSV 导出包含字段**：
- 校准计划：计划ID、设备ID、门店ID、偏移值、生效开始时间、生效结束时间、原因、负责人、状态、创建人、创建时间、停用人、停用时间、撤销人、撤销时间
- 修正记录：修正记录ID、校准计划ID、设备ID、门店ID、批次ID、读数时间、原始温度、修正后温度、偏移值、创建时间

**JSON 导出包含**：完整的校准计划信息和关联的修正记录列表

---

## 完整业务流程示例

### 场景1：从异常到恢复的完整链路

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

**步骤3：Dry-Run 预检（可选，推荐在正式导入前执行）**
```bash
curl -X POST http://localhost:3000/api/readings/dry-run \
  -H "X-User-Id: operator_li" \
  -F "file=@samples/temperature_readings_abnormal.csv" \
  -F "operator=operator_li"
```

> 预检不会写入数据库，可以提前发现问题：未知设备、停用设备、重复时间、倒序时间、阈值冲突等

**步骤4：正式导入异常温度数据（产生告警）**
```bash
curl -X POST http://localhost:3000/api/readings/import \
  -H "X-User-Id: operator_li" \
  -F "file=@samples/temperature_readings_abnormal.csv" \
  -F "operator=operator_li"
```

**步骤5：查看导入批次详情（复盘）**
```bash
curl "http://localhost:3000/api/readings/batches/{batchId}" \
  -H "X-User-Id: viewer_wang"
```

> 返回批次信息、逐行结果、关联告警、审计日志、备注统计、每行备注

**步骤5.5：对失败行添加处置备注（manager/admin 权限）**
```bash
# 对失败行添加备注
curl -X PUT "http://localhost:3000/api/readings/batches/{batchId}/rows/2/remark" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"remarkContent": "设备不存在，已通知门店补充设备台账"}'

# 修改备注
curl -X PUT "http://localhost:3000/api/readings/batches/{batchId}/rows/2/remark" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{"remarkContent": "设备不存在，已通知门店补充设备台账，门店承诺3日内完成"}'

# 清空备注（传空字符串）
curl -X PUT "http://localhost:3000/api/readings/batches/{batchId}/rows/2/remark" \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"remarkContent": ""}'

# 查看单行备注（所有角色均可查看）
curl "http://localhost:3000/api/readings/batches/{batchId}/rows/2/remark" \
  -H "X-User-Id: viewer_wang"
```

**步骤6：导出批次详情**
```bash
# JSON 格式
curl "http://localhost:3000/api/readings/batches/{batchId}/export?format=json" \
  -H "X-User-Id: viewer_wang" \
  -o batch_detail.json

# CSV 格式
curl "http://localhost:3000/api/readings/batches/{batchId}/export?format=csv" \
  -H "X-User-Id: viewer_wang" \
  -o batch_detail.csv
```

**步骤7：查看生成的告警**
```bash
curl "http://localhost:3000/api/alarms?alarmStatus=open&deviceId=FREEZER-001"
```

**步骤8：导入恢复数据（自动恢复告警）**

等待温度恢复正常后，导入恢复数据：
```bash
curl -X POST http://localhost:3000/api/readings/import \
  -H "X-User-Id: operator_li" \
  -F "file=@samples/temperature_readings_abnormal.csv" \
  -F "operator=operator_li"
```

> CSV中12:00之后的数据是正常温度，会自动将告警标记为 recovered

**步骤9：有权限人员确认告警**
```bash
curl -X POST http://localhost:3000/api/alarms/{alarmId}/acknowledge \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"operator":"manager_zhang","note":"已确认"}'
```

**步骤10：关闭告警**
```bash
curl -X POST http://localhost:3000/api/alarms/{alarmId}/close \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"operator":"manager_zhang","note":"冷柜已修复，温度恢复正常"}'
```

**步骤11：查看审计日志**
```bash
curl "http://localhost:3000/api/audit/logs?deviceId=FREEZER-001"
```

**步骤12：导出审计记录**
```bash
curl "http://localhost:3000/api/audit/export?format=csv&deviceId=FREEZER-001" \
  -H "X-User-Id: admin" \
  -o audit_export.csv
```

---

### 场景2：权限控制验证

**viewer_wang 尝试预检（应拒绝）**：
```bash
curl -X POST http://localhost:3000/api/readings/dry-run \
  -H "X-User-Id: viewer_wang" \
  -F "file=@test.csv" \
  -F "operator=viewer_wang"
```
> 返回 403 无权限

**operator_li 尝试确认告警（应拒绝）**：
```bash
curl -X POST http://localhost:3000/api/alarms/{alarmId}/acknowledge \
  -H "Content-Type: application/json" \
  -H "X-User-Id: operator_li" \
  -d '{"operator":"operator_li","note":"测试"}'
```
> 返回 403 无权限

---

### 场景3：跨服务重启持久化验证

**步骤1：导入数据后停止服务**
```bash
# 导入数据
curl -X POST http://localhost:3000/api/readings/import \
  -H "X-User-Id: operator_li" \
  -F "file=@test.csv" \
  -F "operator=operator_li"

# 停止服务 (Ctrl+C 或 kill)
```

**步骤2：重启服务**
```bash
npm run dev
```

**步骤3：验证数据持久化**
```bash
# 验证批次仍然存在
curl "http://localhost:3000/api/readings/batches/{batchId}"

# 验证读数仍然存在
curl "http://localhost:3000/api/readings?importBatchId={batchId}"

# 验证告警仍然存在
curl "http://localhost:3000/api/alarms?importBatchId={batchId}"
```

> 所有数据在服务重启后应该完整保留

---

### 场景5：设备校准完整流程

**步骤1：创建设备并设置阈值**
```bash
# 创建设备
curl -X POST http://localhost:3000/api/devices \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{"id":"FREEZER-002","name":"蔬菜冷藏柜2号","storeId":"STORE-001","storeName":"北京朝阳路店","status":"active"}'

# 设置阈值
curl -X PUT http://localhost:3000/api/thresholds/device/FREEZER-002 \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{"minTemp":2,"maxTemp":8}'
```

**步骤2：创建校准计划（传感器漂移 +2℃）**
```bash
# 设备传感器漂移，实际温度比读数高2℃
curl -X POST http://localhost:3000/api/calibration/plans \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{
    "deviceId": "FREEZER-002",
    "offsetValue": 2.0,
    "effectiveStartTime": 1705276800000,
    "reason": "传感器漂移校准，经计量检测实际温度偏高2℃",
    "personInCharge": "manager_zhang",
    "operator": "manager_zhang"
  }'
```

**步骤3：导入温度数据（自动应用校准）**
```bash
# 创建测试CSV：原始读数5℃，修正后应为7℃（在2-8℃范围内，正常）
echo "deviceId,temperature,readingTime" > cal_test.csv
echo "FREEZER-002,5.0,2024-01-15 08:00:00" >> cal_test.csv
echo "FREEZER-002,6.5,2024-01-15 09:00:00" >> cal_test.csv

# 导入（operator权限即可，导入时自动应用校准）
curl -X POST http://localhost:3000/api/readings/import \
  -H "X-User-Id: operator_li" \
  -F "file=@cal_test.csv" \
  -F "operator=operator_li"
```

> 导入后，原始温度5.0℃会被修正为7.0℃，6.5℃修正为8.5℃（触发高温告警）

**步骤4：查看批次详情（验证校准信息）**
```bash
curl "http://localhost:3000/api/readings/batches/{batchId}" \
  -H "X-User-Id: viewer_wang"
```

> 返回的每行结果应包含：`original_temperature`、`corrected_temperature`、`calibration_plan_id`

**步骤5：查看告警（基于修正后温度）**
```bash
curl "http://localhost:3000/api/alarms?deviceId=FREEZER-002" \
  -H "X-User-Id: viewer_wang"
```

> 告警应显示：原始温度6.5℃，修正后8.5℃，超过阈值上限8℃，触发高温告警

**步骤6：查看读数修正记录**
```bash
curl "http://localhost:3000/api/calibration/corrections?deviceId=FREEZER-002" \
  -H "X-User-Id: viewer_wang"
```

**步骤7：导出批次详情（包含校准信息）**
```bash
# JSON格式
curl "http://localhost:3000/api/readings/batches/{batchId}/export?format=json" \
  -H "X-User-Id: viewer_wang" \
  -o batch_with_calibration.json

# CSV格式
curl "http://localhost:3000/api/readings/batches/{batchId}/export?format=csv" \
  -H "X-User-Id: viewer_wang" \
  -o batch_with_calibration.csv
```

**步骤8：停用校准计划（历史保持不变）**
```bash
curl -X POST http://localhost:3000/api/calibration/plans/{planId}/deactivate \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"operator": "manager_zhang"}'
```

**步骤9：验证停用后历史不变**
```bash
# 再次查询修正记录，应与停用前完全一致
curl "http://localhost:3000/api/calibration/corrections?deviceId=FREEZER-002" \
  -H "X-User-Id: viewer_wang"

# 再次查询批次详情，校准信息应保持不变
curl "http://localhost:3000/api/readings/batches/{batchId}" \
  -H "X-User-Id: viewer_wang"
```

**步骤10：导入新数据（停用后不再应用校准）**
```bash
# 停用后导入相同数据，不再应用校准
curl -X POST http://localhost:3000/api/readings/import \
  -H "X-User-Id: operator_li" \
  -F "file=@cal_test.csv" \
  -F "operator=operator_li"
```

> 由于读数时间重复，会被拒绝（重复数据检测）

**步骤11：撤销校准计划（不可恢复）**
```bash
curl -X POST http://localhost:3000/api/calibration/plans/{planId}/revoke \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"operator": "manager_zhang"}'
```

**步骤12：重启服务验证持久化**
```bash
# 停止服务（Ctrl+C），然后重启
npm run dev

# 重启后查询校准计划
curl "http://localhost:3000/api/calibration/plans?deviceId=FREEZER-002" \
  -H "X-User-Id: viewer_wang"

# 重启后查询修正记录
curl "http://localhost:3000/api/calibration/corrections?deviceId=FREEZER-002" \
  -H "X-User-Id: viewer_wang"

# 重启后查询审计日志
curl "http://localhost:3000/api/audit/logs?deviceId=FREEZER-002" \
  -H "X-User-Id: viewer_wang"
```

> 所有数据在重启后应完整保留：校准计划状态为 revoked，修正记录完整，审计日志包含创建、停用、撤销操作

---

### 场景6：校准权限边界验证

**viewer_wang 尝试创建校准计划（应拒绝）**：
```bash
curl -X POST http://localhost:3000/api/calibration/plans \
  -H "Content-Type: application/json" \
  -H "X-User-Id: viewer_wang" \
  -d '{"deviceId":"FREEZER-002","offsetValue":1.0,"effectiveStartTime":1705276800000,"reason":"测试","personInCharge":"admin","operator":"viewer_wang"}'
```
> 返回 403 无权限

**operator_li 尝试停用校准计划（应拒绝）**：
```bash
curl -X POST http://localhost:3000/api/calibration/plans/{planId}/deactivate \
  -H "Content-Type: application/json" \
  -H "X-User-Id: operator_li" \
  -d '{"operator": "operator_li"}'
```
> 返回 403 无权限

**operator_li 执行导入（自动应用校准，应允许）**：
```bash
curl -X POST http://localhost:3000/api/readings/import \
  -H "X-User-Id: operator_li" \
  -F "file=@cal_test.csv" \
  -F "operator=operator_li"
```
> 导入成功，自动应用校准

---

### 场景7：校准冲突检测

**时间段重叠冲突**：
```bash
# 创建第一个计划
curl -X POST http://localhost:3000/api/calibration/plans \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"deviceId":"FREEZER-002","offsetValue":1.0,"effectiveStartTime":1705276800000,"effectiveEndTime":1707868800000,"reason":"测试1","personInCharge":"manager_zhang","operator":"manager_zhang"}'

# 创建第二个计划（时间段重叠，应拒绝）
curl -X POST http://localhost:3000/api/calibration/plans \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"deviceId":"FREEZER-002","offsetValue":2.0,"effectiveStartTime":1705363200000,"effectiveEndTime":1707955200000,"reason":"测试2","personInCharge":"manager_zhang","operator":"manager_zhang"}'
```
> 返回 409 CONFLICT，提示时间段重叠

**无效偏移值**：
```bash
curl -X POST http://localhost:3000/api/calibration/plans \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"deviceId":"FREEZER-002","offsetValue":100.0,"effectiveStartTime":1705276800000,"reason":"测试","personInCharge":"manager_zhang","operator":"manager_zhang"}'
```
> 返回 400 VALIDATION_ERROR，提示偏移值必须在 -50 到 50 之间

---

### 场景4：冲突导入回归测试

**步骤1：导入数据**
```bash
curl -X POST http://localhost:3000/api/readings/import \
  -H "X-User-Id: operator_li" \
  -F "file=@first_batch.csv" \
  -F "operator=operator_li"
```

**步骤2：预检重复数据（应检测到重复）**
```bash
# 创建包含重复时间的CSV
echo "FREEZER-001,-22.5,2024-01-15 08:00:00" > duplicate.csv
echo "FREEZER-001,-23.0,2024-01-15 13:00:00" >> duplicate.csv

# 预检应检测到重复时间
curl -X POST http://localhost:3000/api/readings/dry-run \
  -H "X-User-Id: operator_li" \
  -F "file=@duplicate.csv" \
  -F "operator=operator_li"
```

**步骤3：导入重复数据（重复数据应被拒绝）**
```bash
curl -X POST http://localhost:3000/api/readings/import \
  -H "X-User-Id: operator_li" \
  -F "file=@duplicate.csv" \
  -F "operator=operator_li"
```

> 重复时间点的读数不会被重复入库

---

## 持久化说明

所有数据存储在 `data/cold_chain.db`（SQLite数据库），包括：
- ✅ 设备台账信息
- ✅ 阈值配置（三级）
- ✅ 温度读数历史
- ✅ 导入批次记录（含状态、操作者、完成时间）
- ✅ 批次逐行结果（每行的成功/失败状态、错误信息）
- ✅ 告警状态及流转历史
- ✅ 操作审计日志

**新增数据表**：
- `import_batches`: 导入批次主表（新增 `status`、`completed_at` 字段）
- `batch_row_results`: 批次逐行结果表（记录每行的校验结果，包含 `original_temperature`、`corrected_temperature`、`calibration_plan_id`）
- `batch_row_remarks`: **异常行处置备注表**（记录对失败行的处置备注，包含处理人、处理时间、原因）
- `calibration_plans`: **校准计划表**（记录校准计划的生命周期，包含设备、偏移值、生效时间、状态、负责人）
- `reading_corrections`: **读数修正记录表**（记录每次应用校准的详细信息，用于审计和追溯）
- `escalation_rules`: 告警升级规则表
- `escalation_tickets`: 告警升级派单表

重启服务后所有数据自动恢复，包括备注信息。

### 事务回滚机制

导入过程使用数据库事务保证数据一致性：
1. 导入开始时创建批次记录（状态：processing）
2. 所有读数、告警、逐行结果在事务内写入
3. 如果成功：COMMIT 事务，更新批次状态为 completed
4. 如果失败：ROLLBACK 事务，更新批次状态为 rolled_back，删除逐行结果
5. 无论成功失败，都会记录审计日志

**整批失败不会留下任何读数、告警或审计残留**。

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
