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

### 7. 交接班巡检签收模块

冷链门店每天按班次生成巡检清单，绑定设备、期望检查时间窗、最低照片/备注要求和负责人，实现标准化巡检流程管控。

#### 7.1 核心概念

- **巡检模板 (Inspection Template)**: 定义某个门店某个班次在某一天的巡检任务清单，包含多台设备的巡检配置
- **巡检时间窗 (Time Window)**: 每台设备期望的巡检时间范围（HH:mm格式），超过时间窗提交会标记为迟到
- **巡检要求 (Requirements)**: 每台设备的最低照片数量要求和最短备注长度要求
- **巡检记录 (Inspection Record)**: 操作人员实际提交的巡检结果，自动关联最近温度读数和当前告警状态
- **负责人 (Person In Charge)**: 每台设备指定的巡检人员，只有该人员可以提交巡检结果

#### 7.2 模板状态生命周期

```
draft → published → closed
   ↓          ↓        ↓
  草稿       已发布    已关闭
              ↓
           revoked
              ↓
           已撤销
```

- **`draft` (草稿)**: 可编辑，不可提交巡检
- **`published` (已发布)**: 巡检清单生效，操作人员可提交巡检
- **`closed` (已关闭)**: 班次结束，不再接受新的巡检提交
- **`revoked` (已撤销)**: 模板作废，历史巡检记录保留，**不可恢复**

> **重要保证**：关闭或撤销模板不会修改任何历史巡检结果，已提交的记录保持不变，审计日志会记录操作人、原因和影响范围。

#### 7.3 班次定义

| 班次 | 说明 |
|------|------|
| `morning` | 早班（通常 08:00-16:00） |
| `afternoon` | 中班（通常 12:00-20:00） |
| `evening` | 晚班（通常 16:00-24:00） |
| `night` | 夜班（通常 00:00-08:00） |

#### 7.4 巡检状态

| 状态 | 说明 |
|------|------|
| `pending` | 待巡检（模板已发布，设备巡检时间窗内） |
| `submitted` | 已提交（正常时间内完成巡检） |
| `late` | 迟到（超过结束时间提交） |
| `missed` | 漏检（模板关闭时仍未提交） |

#### 7.5 权限控制

| 角色 | 权限 |
|------|------|
| `admin` / `manager` | 创建巡检模板、发布模板、关闭模板、撤销模板、提交巡检、查看巡检、导出巡检数据 |
| `operator` | 提交巡检（仅作为负责人的设备）、查看巡检、导出巡检数据 |
| `viewer` | 查看巡检、导出巡检数据 |

**权限边界**：
- 👁️ `viewer`: 只能查看和导出，不能创建/修改模板，不能提交巡检
- 📥 `operator`: 只能提交自己作为负责人的设备巡检，不能管理模板
- 🔧 `manager`/`admin`: 可以完整管理模板生命周期（创建、发布、关闭、撤销）
- 🔒 **安全强制**：所有写操作（创建、发布、关闭、撤销、提交）的操作人**以请求头 `X-User-Id` 为准**，body 中的 `operator` 字段会被**完全忽略**，防止低权限用户伪造身份

#### 7.6 业务规则与错误响应

| 校验项 | 错误响应 | 说明 |
|--------|---------|------|
| 低权限用户伪造身份 | 403 UNAUTHORIZED | 以 header 中的真实用户为准，忽略 body 伪造值 |
| 非负责人提交巡检 | 403 UNAUTHORIZED | 只能提交自己作为负责人的设备巡检 |
| 模板时间窗冲突 | 409 CONFLICT | 同一门店同一日期同一班次只能有一个已发布模板 |
| 重复提交巡检 | 409 CONFLICT | 同一模板下同一设备只能提交一次 |
| 设备已停用 | 400 VALIDATION_ERROR | 停用设备不能提交巡检 |
| 跨门店设备 | 400 VALIDATION_ERROR | 模板中的设备必须属于模板指定的门店 |
| 提交草稿模板 | 400 VALIDATION_ERROR | 只能提交已发布模板的巡检 |
| 照片数量不足 | 400 VALIDATION_ERROR | 低于最低照片数量要求 |
| 备注长度不足 | 400 VALIDATION_ERROR | 备注短于最低长度要求 |
| 迟到提交 | 正常成功，但状态标记为 `late` | 超过时间窗结束时间提交 |

#### 7.7 巡检提交流程

```
operator 提交巡检
    ↓
使用 header 中的 X-User-Id 作为操作人（忽略 body.operator）
    ↓
校验权限：用户有 submit_inspection 权限
    ↓
校验模板：模板存在且状态为 published
    ↓
校验设备：设备在模板中，且提交人是该设备的负责人
    ↓
校验重复：该设备在该模板下尚未提交过巡检
    ↓
校验设备状态：设备为 active（未停用）
    ↓
校验要求：照片数量 ≥ minCount，备注长度 ≥ minLength
    ↓
关联业务数据：
  - 自动关联最近一次温度读数（最近5分钟内）
  - 自动关联当前告警状态（如有 active 告警）
  - 自动计算是否迟到（当前时间 > 时间窗结束时间）
    ↓
创建巡检记录（状态：submitted 或 late）
    ↓
记录审计日志（包含操作人、模板ID、设备ID、影响范围）
    ↓
返回巡检结果（含温度、告警、是否迟到）
```

#### 7.8 数据关联能力

巡检提交时自动关联以下业务数据：
- ✅ **最近温度读数**：自动查找该设备最近5分钟内的温度读数，无读数则显示 null
- ✅ **当前告警状态**：自动查找该设备当前是否有 active 状态的告警，如有则记录告警ID
- ✅ **提交人身份**：强制使用 header 中的 `X-User-Id`，防止身份伪造
- ✅ **提交时间戳**：精确到毫秒的提交时间，用于迟到判定

#### 7.9 查询与筛选

**模板筛选参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| `templateStatus` | `draft`/`published`/`closed`/`revoked` | 模板状态 |
| `shift` | `morning`/`afternoon`/`evening`/`night` | 班次 |
| `storeId` | `string` | 门店ID |
| `startTime` / `endTime` | `number` | 日期范围（毫秒时间戳） |
| `page` / `pageSize` | `number` | 分页参数 |

**巡检记录筛选参数**：
| 参数 | 类型 | 说明 |
|------|------|------|
| `inspectionStatus` | `pending`/`submitted`/`late`/`missed` | 巡检状态 |
| `templateId` | `string` | 关联模板ID |
| `deviceId` | `string` | 设备ID |
| `storeId` | `string` | 门店ID |
| `submittedBy` | `string` | 提交人ID |
| `personInCharge` | `string` | 负责人ID |
| `startTime` / `endTime` | `number` | 提交时间范围 |
| `page` / `pageSize` | `number` | 分页参数 |

#### 7.10 导出功能

支持 JSON 和 CSV 两种格式导出：

| 导出类型 | 说明 |
|---------|------|
| `templates` | 导出巡检模板列表（含设备配置） |
| `records` | 导出巡检记录列表（含温度、告警关联） |

**CSV 导出字段（巡检记录）**：
记录ID、模板ID、模板名称、门店ID、门店名称、班次、巡检日期、设备ID、设备名称、时间窗、要求（照片/备注）、负责人、提交人、提交时间、巡检状态、是否迟到、温度、关联告警ID、照片数量、备注

#### 7.11 持久化保证

所有数据存储在 SQLite 数据库文件中：
- ✅ 巡检模板 (`inspection_templates`)
- ✅ 模板设备配置 (`inspection_template_devices`)
- ✅ 巡检记录 (`inspection_records`)
- ✅ 操作审计日志 (`audit_logs`)
- ✅ 温度读数 (`temperature_readings`)
- ✅ 告警 (`alarms`)

同一 `DB_PATH` 重启后，所有模板、巡检记录、导出结果和审计记录仍可查询。

---

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

**巡检模块强制身份识别**：
- 所有巡检接口（含查询、导出）必须携带 `X-User-Id` 请求头
- 缺失时返回稳定 403 错误：`请求头缺失 X-User-Id，无法识别当前用户身份`
- `body.operator` 字段会被**完全忽略**，操作人以 `X-User-Id` 为准，防止身份伪造

测试用户：
- `admin` - 全部权限
- `manager_zhang` - 告警确认/关闭、导入、导出、巡检管理
- `operator_li` - 导入、导出、提交巡检
- `viewer_wang` - 仅导出、查看巡检

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

### 交接班巡检签收

#### 创建巡检模板
```http
POST /api/inspection/templates
Content-Type: application/json
X-User-Id: manager_zhang

{
  "name": "2024-01-15 早班巡检清单",
  "storeId": "STORE-001",
  "storeName": "北京朝阳路店",
  "shift": "morning",
  "date": 1705276800000,
  "devices": [
    {
      "deviceId": "FREEZER-001",
      "timeWindow": {
        "startTime": "08:00",
        "endTime": "10:00"
      },
      "photoRequirement": {
        "minCount": 2,
        "required": true
      },
      "remarkRequirement": {
        "minLength": 10,
        "required": true
      },
      "personInCharge": "operator_li",
      "sortOrder": 0
    },
    {
      "deviceId": "FREEZER-002",
      "timeWindow": {
        "startTime": "10:00",
        "endTime": "12:00"
      },
      "photoRequirement": {
        "minCount": 0,
        "required": false
      },
      "remarkRequirement": {
        "minLength": 0,
        "required": false
      },
      "personInCharge": "operator_li",
      "sortOrder": 1
    }
  ],
  "operator": "manager_zhang"
}
```

**字段说明**：
- `shift`: 班次 (`morning`/`afternoon`/`evening`/`night`)
- `date`: 巡检日期（毫秒时间戳，当天0点）
- `devices[].timeWindow`: 巡检时间窗（HH:mm 格式）
- `devices[].photoRequirement.minCount`: 最少照片数量
- `devices[].remarkRequirement.minLength`: 最少备注字符数
- `devices[].personInCharge`: 负责人，必须是系统已知用户

**成功响应示例**：
```json
{
  "success": true,
  "data": {
    "id": "ins-tpl-xxxx",
    "name": "2024-01-15 早班巡检清单",
    "storeId": "STORE-001",
    "storeName": "北京朝阳路店",
    "shift": "morning",
    "date": 1705276800000,
    "status": "draft",
    "createdBy": "manager_zhang",
    "createdAt": 1705305600000,
    "devices": [...]
  },
  "message": "巡检模板创建成功"
}
```

#### 查询巡检模板列表
```http
GET /api/inspection/templates?storeId=STORE-001&templateStatus=published&page=1&pageSize=50
X-User-Id: viewer_wang
```

**筛选参数**：
- `templateStatus`: 模板状态 (`draft`/`published`/`closed`/`revoked`)
- `shift`: 班次
- `storeId`: 门店ID
- `startTime`/`endTime`: 日期范围

#### 查询单个巡检模板（含设备配置）
```http
GET /api/inspection/templates/{templateId}
X-User-Id: viewer_wang
```

**响应包含**：模板基本信息、设备配置列表（时间窗、要求、负责人）、创建/发布/关闭/撤销的审计日志

#### 发布巡检模板
```http
POST /api/inspection/templates/{templateId}/publish
Content-Type: application/json
X-User-Id: manager_zhang

{
  "reason": "确认清单无误，正式发布",
  "operator": "manager_zhang"
}
```

> **重要**：发布后模板状态变为 `published`，同一门店同一日期同一班次只能有一个已发布模板。

#### 关闭巡检模板
```http
POST /api/inspection/templates/{templateId}/close
Content-Type: application/json
X-User-Id: manager_zhang

{
  "reason": "班次结束，正常关闭",
  "operator": "manager_zhang"
}
```

**成功响应**：
```json
{
  "success": true,
  "data": {
    "id": "ins-tpl-xxxx",
    "status": "closed",
    "closedBy": "manager_zhang",
    "closedAt": 1705305600000,
    "closedReason": "班次结束，正常关闭"
  },
  "message": "巡检模板关闭成功，历史巡检记录保持不变"
}
```

> **重要保证**：关闭模板不会修改任何已提交的巡检记录，只会阻止新的提交。审计日志会记录操作人、原因和影响记录数。

#### 撤销巡检模板（不可恢复）
```http
POST /api/inspection/templates/{templateId}/revoke
Content-Type: application/json
X-User-Id: manager_zhang

{
  "reason": "模板配置错误，需要重新创建",
  "operator": "manager_zhang"
}
```

**成功响应**：
```json
{
  "success": true,
  "data": {
    "id": "ins-tpl-xxxx",
    "status": "revoked",
    "revokedBy": "manager_zhang",
    "revokedAt": 1705305600000,
    "revokedReason": "模板配置错误，需要重新创建"
  },
  "message": "巡检模板撤销成功，历史巡检记录保持不变，不可恢复"
}
```

> **重要**：撤销后模板永久失效，不可恢复，但历史巡检记录保持不变。审计日志会记录操作人、原因和影响记录数。

#### 提交巡检结果
```http
POST /api/inspection/records/submit
Content-Type: application/json
X-User-Id: operator_li

{
  "templateId": "ins-tpl-xxxx",
  "deviceId": "FREEZER-001",
  "photos": ["photo1.jpg", "photo2.jpg"],
  "remark": "设备运行正常，温度5℃，在2-8℃范围内，无异常",
  "operator": "manager_zhang"
}
```

**🔒 安全强制**：操作人以 `X-User-Id` 请求头为准，body 中的 `operator` 字段会被**完全忽略**。即使 body 中写 `operator: "manager_zhang"`，实际提交人仍为 `operator_li`。

**成功响应示例**（正常提交）：
```json
{
  "success": true,
  "data": {
    "id": "ins-rec-xxxx",
    "templateId": "ins-tpl-xxxx",
    "deviceId": "FREEZER-001",
    "status": "submitted",
    "isLate": false,
    "submittedBy": "operator_li",
    "submittedAt": 1705305600000,
    "temperature": 5.0,
    "hasActiveAlarm": false,
    "alarmId": null,
    "photos": ["photo1.jpg", "photo2.jpg"],
    "remark": "设备运行正常..."
  },
  "message": "巡检提交成功"
}
```

**成功响应示例**（迟到提交）：
```json
{
  "success": true,
  "data": {
    "id": "ins-rec-xxxx",
    "status": "late",
    "isLate": true,
    ...
  },
  "message": "巡检提交成功（迟到）"
}
```

#### 查询巡检记录列表
```http
GET /api/inspection/records?storeId=STORE-001&inspectionStatus=submitted&page=1&pageSize=50
X-User-Id: operator_li
```

**筛选参数**：
- `inspectionStatus`: 巡检状态 (`pending`/`submitted`/`late`/`missed`)
- `templateId`: 关联模板ID
- `deviceId`: 设备ID
- `storeId`: 门店ID
- `submittedBy`: 提交人ID
- `personInCharge`: 负责人ID
- `startTime`/`endTime`: 提交时间范围

#### 查询单个巡检记录
```http
GET /api/inspection/records/{recordId}
X-User-Id: viewer_wang
```

**响应包含**：记录详情、关联温度、关联告警、模板信息、设备信息

#### 获取巡检统计
```http
GET /api/inspection/stats/counts?storeId=STORE-001
X-User-Id: viewer_wang
```

**响应示例**：
```json
{
  "success": true,
  "data": {
    "total": 10,
    "pending": 3,
    "submitted": 5,
    "late": 1,
    "missed": 1,
    "byShift": {
      "morning": { "submitted": 3, "late": 0, "missed": 0 },
      "afternoon": { "submitted": 2, "late": 1, "missed": 1 }
    }
  }
}
```

#### 导出巡检数据
```http
GET /api/inspection/export?type=records&format=csv&storeId=STORE-001
X-User-Id: viewer_wang
```

**参数说明**：
- `type`: `records`（巡检记录）或 `templates`（巡检模板）
- `format`: `csv` 或 `json`
- 其他筛选参数与列表查询一致

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

### 场景8：交接班巡检完整流程（含安全测试和重启验证）

**步骤1：创建设备并配置阈值

```bash
# 创建设备
curl -X POST http://localhost:3000/api/devices \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{"id":"INSPECTION-FR-001","name":"早班巡检冷藏柜","storeId":"STORE-001","storeName":"北京朝阳路店","status":"active"}'

# 设置阈值
curl -X PUT http://localhost:3000/api/thresholds/device/INSPECTION-FR-001 \
  -H "Content-Type: application/json" \
  -H "X-User-Id: admin" \
  -d '{"minTemp":2,"maxTemp":8}'

# 导入温度数据（产生读数用于巡检时关联）
curl -X POST http://localhost:3000/api/readings/dry-run \
  -H "X-User-Id: operator_li" \
  -H "Content-Type: application/json" \
  -d '{"deviceId":"INSPECTION-FR-001","temperature":5.0,"timestamp":1705305600000}'
```

**步骤2：manager 创建巡检模板**

```bash
# 获取当天0点时间戳
TODAY=$(node -e "const d=new Date(); d.setHours(0,0,0,0); console.log(d.getTime())")

# manager 创建早班巡检模板
curl -X POST http://localhost:3000/api/inspection/templates \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{
    "name": "2024-01-15 早班巡检清单",
    "storeId": "STORE-001",
    "storeName": "北京朝阳路店",
    "shift": "morning",
    "date": '${TODAY}',
    "devices": [
      {
        "deviceId": "INSPECTION-FR-001",
        "timeWindow": {"startTime": "08:00", "endTime": "23:59"},
        "photoRequirement": {"minCount": 1, "required": true},
        "remarkRequirement": {"minLength": 10, "required": true},
        "personInCharge": "operator_li",
        "sortOrder": 0
      }
    ],
    "operator": "manager_zhang"
  }'
```

**步骤3：安全测试 - viewer 伪造 manager 身份创建模板（应拒绝）

```bash
curl -X POST http://localhost:3000/api/inspection/templates \
  -H "Content-Type: application/json" \
  -H "X-User-Id: viewer_wang" \
  -d '{
    "name": "viewer伪造manager创建",
    "storeId": "STORE-001",
    "storeName": "北京朝阳路店",
    "shift": "morning",
    "date": '${TODAY}',
    "devices": [...],
    "operator": "manager_zhang"
  }'
```
> 返回 403 无权限。**安全机制生效：以 header 中的 viewer_wang 为准，忽略 body 中伪造的 manager_zhang

**步骤4：operator 伪造 manager 身份创建模板（应拒绝）

```bash
curl -X POST http://localhost:3000/api/inspection/templates \
  -H "Content-Type: application/json" \
  -H "X-User-Id: operator_li" \
  -d '{
    "name": "operator伪造manager创建",
    "operator": "manager_zhang"
  }'
```
> 返回 403 无权限。**安全机制生效：以 header 中的 operator_li 为准。

**步骤5：发布巡检模板

```bash
curl -X POST http://localhost:3000/api/inspection/templates/{templateId}/publish \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"reason": "确认清单无误", "operator": "manager_zhang"}'
```

**步骤6：安全测试 - 时间窗冲突（同日同班次再发布一个模板并尝试发布

```bash
# 创建第二个早班模板（同日同班次）
curl -X POST http://localhost:3000/api/inspection/templates \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{
    "name": "冲突的早班模板",
    "storeId": "STORE-001",
    "storeName": "北京朝阳路店",
    "shift": "morning",
    "date": '${TODAY}',
    "devices": [...],
    "operator": "manager_zhang"
  }'

# 尝试发布（应拒绝，同日同班次已有已发布模板）
curl -X POST http://localhost:3000/api/inspection/templates/{conflictTemplateId}/publish \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"operator": "manager_zhang"}'
```
> 返回 409 CONFLICT，时间窗冲突检测生效

**步骤7：operator 提交巡检 - 安全测试：在 body 中伪造 manager 身份

```bash
curl -X POST http://localhost:3000/api/inspection/records/submit \
  -H "Content-Type: application/json" \
  -H "X-User-Id: operator_li" \
  -d '{
    "templateId": "{templateId}",
    "deviceId": "INSPECTION-FR-001",
    "photos": ["photo1.jpg",
    "remark": "设备运行正常，温度5℃，在2-8℃范围内，无异常。",
    "operator": "manager_zhang"
  }'
```

> **关键安全验证**：即使 body 中写 `operator: "manager_zhang"`，实际提交人应为 `operator_li`（以 header 为准。检查响应中的 `submittedBy` 应为 `operator_li`

**步骤8：验证巡检记录详情（含温度和告警关联）

```bash
curl "http://localhost:3000/api/inspection/records/{recordId}" \
  -H "X-User-Id: viewer_wang"
```

> 响应应包含：
- `submittedBy: "operator_li"（安全机制生效）
- `temperature: 5.0`（关联最近温度读数）
- `hasActiveAlarm: false`（关联当前告警状态）
- `status: "submitted"`

**步骤9：尝试重复提交（应拒绝）

```bash
curl -X POST http://localhost:3000/api/inspection/records/submit \
  -H "Content-Type: application/json" \
  -H "X-User-Id: operator_li" \
  -d '{
    "templateId": "{templateId}",
    "deviceId": "INSPECTION-FR-001",
    "photos": ["photo1.jpg"],
    "remark": "重复提交测试",
    "operator": "operator_li"
  }'
```
> 返回 409 CONFLICT，重复提交检测生效

**步骤10：验证提交不符合照片/备注要求验证

```bash
# 照片不足
curl -X POST http://localhost:3000/api/inspection/records/submit \
  -H "Content-Type: application/json" \
  -H "X-User-Id: operator_li" \
  -d '{"templateId":"{templateId}","deviceId":"INSPECTION-FR-001","photos":[],"remark":"备注长度足够但是照片不够","operator":"operator_li"}'
```
> 返回 400，照片数量不足

**步骤11：查看巡检统计

```bash
curl "http://localhost:3000/api/inspection/stats/counts?storeId=STORE-001" \
  -H "X-User-Id: viewer_wang"
```

**步骤12：导出巡检数据**

```bash
# CSV 格式
curl "http://localhost:3000/api/inspection/export?type=records&format=csv" \
  -H "X-User-Id: viewer_wang" \
  -o inspection_records.csv

# JSON 格式
curl "http://localhost:3000/api/inspection/export?type=templates&format=json" \
  -H "X-User-Id: viewer_wang" \
  -o inspection_templates.json
```

**步骤13：关闭巡检模板（历史记录保持不变）

```bash
curl -X POST http://localhost:3000/api/inspection/templates/{templateId}/close \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"reason": "班次结束，正常关闭", "operator": "manager_zhang"}'
```

**步骤14：验证关闭后历史记录不受影响

```bash
curl "http://localhost:3000/api/inspection/records/{recordId}" \
  -H "X-User-Id: operator_li"
```
> 记录状态仍为 submitted

**步骤15：验证审计日志包含关闭操作

```bash
curl "http://localhost:3000/api/audit/logs?operationType=inspection_template_close" \
  -H "X-User-Id: admin"
```
> 应包含：操作人 manager_zhang，原因，影响记录数

**步骤16：撤销模板（不可恢复）

```bash
# 先创建并发布另一个模板
curl -X POST http://localhost:3000/api/inspection/templates \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{
    "name": "待撤销测试模板",
    "storeId": "STORE-001",
    "storeName": "北京朝阳路店",
    "shift": "night",
    "date": '${TODAY}',
    "devices": [...],
    "operator": "manager_zhang"
  }'

curl -X POST http://localhost:3000/api/inspection/templates/{revokeTemplateId}/publish \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"operator": "manager_zhang"}'

# 撤销模板
curl -X POST http://localhost:3000/api/inspection/templates/{revokeTemplateId}/revoke \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"reason": "模板配置错误，撤销重发", "operator": "manager_zhang"}'
```

**步骤17：重启服务验证持久化**

```bash
# 停止服务（Ctrl+C 或 kill）

# 重启服务（使用相同 DB_PATH）
npm run dev

# 重启后查询模板
curl "http://localhost:3000/api/inspection/templates?storeId=STORE-001" \
  -H "X-User-Id: viewer_wang"

# 重启后查询巡检记录
curl "http://localhost:3000/api/inspection/records?storeId=STORE-001" \
  -H "X-User-Id: viewer_wang"

# 重启后查询审计记录
curl "http://localhost:3000/api/audit/logs?operationType=inspection_template_close" \
  -H "X-User-Id: admin"

# 重启后导出
curl "http://localhost:3000/api/inspection/export?type=records&format=csv" \
  -H "X-User-Id: viewer_wang"
```

> 所有数据在重启后应完整保留：模板状态为 closed/revoked，巡检记录完整，审计日志包含所有操作

---

### 场景9：巡检权限边界验证

**viewer_wang 尝试创建巡检模板（应拒绝）

```bash
curl -X POST http://localhost:3000/api/inspection/templates \
  -H "Content-Type: application/json" \
  -H "X-User-Id: viewer_wang" \
  -d '{"name":"测试","storeId":"STORE-001","storeName":"北京朝阳路店","shift":"morning","date":'${TODAY}',"devices":[...],"operator":"viewer_wang"}'
```
> 返回 403 无权限

**operator_li 尝试发布模板（应拒绝）

```bash
curl -X POST http://localhost:3000/api/inspection/templates/{templateId}/publish \
  -H "Content-Type: application/json" \
  -H "X-User-Id: operator_li" \
  -d '{"operator": "operator_li"}'
```
> 返回 403 无权限

**operator_li 提交非自己负责的设备巡检（应拒绝）

```bash
curl -X POST http://localhost:3000/api/inspection/records/submit \
  -H "Content-Type: application/json" \
  -H "X-User-Id: manager_zhang" \
  -d '{"templateId":"{templateId}","deviceId":"INSPECTION-FR-001","photos":["photo.jpg"],"remark":"非负责人提交测试","operator":"manager_zhang"}'
```
> 返回 403 无权限，不是该设备的负责人

**operator_li 提交自己负责的设备巡检（应允许）

```bash
curl -X POST http://localhost:3000/api/inspection/records/submit \
  -H "Content-Type: application/json" \
  -H "X-User-Id: operator_li" \
  -d '{"templateId":"{templateId}","deviceId":"INSPECTION-FR-001","photos":["photo.jpg"],"remark":"负责人正常提交","operator":"operator_li"}'
```
> 提交成功

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
- `inspection_templates`: **巡检模板表**（记录巡检模板的生命周期，包含门店、班次、日期、状态）
- `inspection_template_devices`: **模板设备配置表**（记录每台设备的巡检时间窗、要求、负责人）
- `inspection_records`: **巡检记录表**（记录每次巡检提交结果，包含温度关联、告警关联、迟到标记）

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
