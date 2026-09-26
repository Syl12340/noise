# 5级风险分段功能 + 功能检验实施总结

**实施日期**：2026年4月1日  
**版本号**：v0.2.0-beta  
**主题**：完整重构5级风险判级链路、Settings可配置流程、全页面颜色映射、关键注释与手测清单

---

## 实施内容概览

### 第一阶段：架构层面（底层模型）

#### 1.1 新增风险配置模块 `utils/risk-config.js`

**职责**：风险等级元数据定义、配置规范化、验证与动态生成

**关键导出**：
- `RISK_META` - 5个风险等级的文本与样式映射
- `getDefaultRiskConfig()` - 默认配置（80/85/94/105）
- `normalizeRiskConfig()` - 输入规范化和范围限制
- `validateRiskConfig()` - 递增顺序和锚点检查
- `buildRiskLevels()` - 根据启禁用动态生成判级序列

**特性**：
- "需要注意"为锚点分段，固定启用、不可禁用
- 阈值严格递增校验（安全 < 需要注意 < 中风险 < 高风险）
- 中风险/高风险可选启禁用（禁用后判级逻辑自动跳过该层）
- 每个阈值有输入范围限制（如 ATTENTION_MAX 限制在 [75, 90]）

#### 1.2 扩展常量 `utils/constants.js`

**新增字段**：
```javascript
RISK_THRESHOLDS: { SAFE_MAX: 80, ATTENTION_MAX: 85, MEDIUM_MAX: 94, HIGH_MAX: 105 }
RISK_LIMIT_RANGE: { 
  ATTENTION_MAX: { min: 75, max: 90 },
  MEDIUM_MAX: { min: 80, max: 100 },
  HIGH_MAX: { min: 90, max: 120 }
}
```

**用途**：风险配置的默认值与有效范围定义

#### 1.3 升级数据模型 `utils/data-model.js`

**新增 API**：
- `getRiskConfig()` - 读取本地风险配置（无则返回默认）
- `setRiskConfig(config)` - 保存风险配置到存储
- 兼容旧缓存（无新配置时自动回退默认值）

**存储键**：`riskConfig`（独立于原有 offset、expectedExposure 等）

#### 1.4 重构判级引擎 `utils/audio-math.js`

**升级函数签名**：
```javascript
evaluateRisk(cne, riskConfig)  // 纯参数驱动，取代硬编码3档逻辑
```

**工作流**：
1. 从 `riskConfig` 调用 `buildRiskLevels()` 获取当前有效的判级序列
2. 遍历序列，返回第一个 `cne < upper` 的等级
3. 若超过所有阈值，返回"高危"

**补充注释**：
- `calculateRMS/calculateDb` - 音频能量转分贝转换
- `calculateLeqFromEnergy` - 由累计 A 计权能量计算等效声级
- `calculateCNEFromLeq` - 按预计暴露时间换算结果；当前不包含峰度惩罚
- `evaluateRisk` - 根据用户配置的阈值划分风险等级
- `AWeightingFilter` - 低频 IIR 与 129 点 FIR 组成的 A 计权近似；全频带误差仍需验证

---

### 第二阶段：页面层面（UI 交互）

#### 2.1 Settings 页面 `pages/settings/`

**settings.js 改进**：
- 新增 `onRiskEnabledChange()` - 处理复选框启禁用
- 新增 `onRiskLimitInput()` - 处理阈值填空输入
- 改进 `save()` - 调用 `validateRiskConfig()` 做递增校验，校验失败弹 toast
- 改进 `reset()` - 还原到工厂默认风险配置

**settings.wxml 新增**：
```wxml
<!-- 风险分段（5级）配置区 -->
<checkbox-group bindchange="onRiskEnabledChange">
  <!-- 需要注意：复选框禁用+上限填空 -->
  <!-- 中风险：复选框可用+条件填空 -->
  <!-- 高风险：复选框可用+条件填空 -->
  <!-- 安全上限：固定显示（只读） -->
</checkbox-group>
```

**settings.wxss 新增样式**：
- `.risk-row` - 行容器（gap 控制间距）
- `.risk-input` - 阈值填空框（边框、圆角、右对齐）
- `.risk-fixed-value` - 固定值显示（主红色、加粗）
- 按钮禁用状态 `:disabled` 配置

#### 2.2 Main 页面 `pages/main/`

**main.js 改进**：
1. 添加全局变量 `riskConfig`，在 `initMonitor()` 时调用 `dataModel.getRiskConfig()` 获取
2. 改进 `noiseDetect()` 中的判级逻辑，改为 `evaluateRisk(cne, riskConfig)`
3. 补充关键全局变量的详细 JSDoc 注释
4. 补充 Canvas 绘制函数（`mesh`, `mark`, `draw`, `record Array`）的功能说明

**main.wxss 新增样式**：
```css
.detail-attention { 背景黄色 }
.detail-medium { 背景橙黄色 }
.detail-high { 背景主红 }
.detail-extreme { 背景深红 } /* NEW */
```

#### 2.3 Result 页面 `pages/result/`

**result.js 改进**：
1. 新增辅助函数 `getThreatColorClass()` 和 `getThreatTextClass()` - 5级映射
2. 为所有方法добавил详细 JSDoc 注释
3. 支持完整5个风险等级的颜色绑定（之前只有3档）

**result.wxml 改进**：
- 风险色带逻辑升级为5级条件判断（嵌套三元表达式）
- CNE 数值颜色同步升级

**result.wxss 改进**：
```css
.bg-safe { light-blue }
.bg-attention { warn-yellow } /* NEW */
.bg-medium { warn-darken }
.bg-high { primary-red }
.bg-extreme { dark-red } /* NEW */
```

---

### 第三阶段：检验体系

#### 3.1 手测清单文档 `docs/manual-testing-checklist.md`

**覆盖范围**：64 个测试点，分布在 6 个主要阶段

**阶段划分**：
- 一、主页面（Main） - 16 项
  - 初始化检查
  - 监测启动与数据流
  - 5级风险判断（默认与自定义）
  
- 二、设置页面（Settings） - 14 项
  - 基础参数（预期、阈值、单位、偏移）
  - 5级分段配置（复选框、填空、校验）
  - 保存/恢复
  
- 三、监测流程（Main） - 7 项
  - 实时报警与振动
  - 底部操作栏（保存/停止/位置）
  
- 四、历史记录（Result） - 13 项
  - 列表展示
  - 5级颜色映射
  - 展开/长按菜单
  - 清空全部
  
- 五、跨页面集成 - 5 项
  - Main ↔ Settings 阈值同步
  - Main → Result 记录保存
  - 配置持久化
  
- 六、边界与异常 - 9 项
  - 输入边界（极值、非法输入）
  - 权限与资源（麦克风、位置、存储）
  - 性能与稳定性（长时间监测、频繁操作、批量加载）

**执行记录模板**：
- 执行者信息 + 设备环境
- 结果统计表（总计/通过/失败/跳跳）
- 失败项详情（优先级 P0/P1/P2）
- 遗留问题清单
- 签名区

**快速检查清单**：7 项 daily smoke test

**常见问题排查**：6 个典型问题 + 排查步骤

---

## 技术改进汇总

### 代码质量

| 类别 | 改进内容 |
|------|---------|
| **注释** | 新增 50+ 条 JSDoc 格式的函数与变量说明 |
| **命名** | 改进 `getThreatColorClass/TextClass` 等函数名规范性 |
| **模块化** | 新增独立风险配置模块，降低耦合度 |
| **可维护性** | 阈值/范围集中在常量内，避免硬编码 |

### 配置驱动

| 层工 | 驱动机制 |
|------|---------|
| **常量层** | `RISK_THRESHOLDS`, `RISK_LIMIT_RANGE` |
| **模型层** | `normalizeRiskConfig()`, `validateRiskConfig()` |
| **业务层** | `evaluateRisk(cne, riskConfig)` |
| **存储层** | `dataModel.getRiskConfig/setRiskConfig()` |

### 用户体验

| 功能 | 体验提升 |
|------|---------|
| **可配置** | Settings 中可直接调整5个阈值、复选启禁 |
| **即时反馈** | 保存后立即切换页面查看新配置生效 |
| **容错** | 设置的所有输入都有范围限制 + 递增校验 |
| **直观** | 5级颜色在 Main、Result、Settings 统一映射 |

---

## 关键约束与验收标准

### 五本功能约束

1. **"需要注意"为锚点**
   - 复选框 disabled（始终勾选）
   - 不能禁用（UI与逻辑双重保护）
   - 验收标准：Settings 页面该项复选框呈灰色不可点

2. **阈值严格递增**
   - 安全 < 需要注意 < 中风险 < 高风险
   - Settings 中点击"保存"时做校验，失败弹 toast
   - 验收标准：输入违反顺序时保存失败

3. **范围限制**
   - 每个阈值都有最小值与最大值限制
   - 输入框 blur 时自动调整到有效范围
   - 验收标准：输入越界后自动纠正到范围内

4. **禁用时跳过判级**
   - 若用户禁用"中风险"，则判级序列中无该等级
   - CNE 从"需要注意"直接跳到"高风险"
   - 验收标准：long 监测过程中不出现被禁用的等级

5. **兼容旧缓存**
   - 若机器上已有旧 3 档配置，首次加载时自动升级为 5 档
   - 调用 `getRiskConfig()` 无返回时回退默认配置
   - 验收标准：无缓存或旧缓存场景都能正常启动

---

## 核心改动文件清单

| 文件 | 类型 | 主要改动 |
|------|------|---------|
| `utils/risk-config.js` | **NEW** | 风险配置模块（规范化、验证、生成判级序列） |
| `utils/constants.js` | MODIFY | 扩展为5档默认阈值与范围限制 |
| `utils/data-model.js` | MODIFY | 新增风险配置读写、兼容旧缓存 |
| `utils/audio-math.js` | MODIFY | 升级 `evaluateRisk` 为参数驱动5级、补注释 |
| `pages/settings/settings.js` | MODIFY | 新增5级配置UI交互、校验逻辑 |
| `pages/settings/settings.wxml` | MODIFY | 新增5级分段配置区块（复选框+填空） |
| `pages/settings/settings.wxss` | MODIFY | 新增风险配置样式（边框、深色等） |
| `pages/main/main.js` | MODIFY | 读取riskConfig并传给judgeRisk，补详注释 |
| `pages/main/main.wxss` | MODIFY | 新增第5级样式 `.detail-extreme` |
| `pages/result/result.js` | MODIFY | 新增5级颜色映射函数、补JSDoc注释 |
| `pages/result/result.wxml` | MODIFY | 升级颜色绑定为5级条件判断 |
| `pages/result/result.wxss` | MODIFY | 新增 `.bg-attention`, `.bg-extreme` |
| `docs/manual-testing-checklist.md` | **NEW** | 64项手测清单 + 执行记录模板 |

---

## 验收流程

### 快速验收（<10 分钟）

```bash
1. 清空小程序数据 (开发者工具 → Storage → 清空全部)
2. 刷新页面，进入 Main
3. 启动监测 15 秒，观察 CNE 从 0 开始递增
4. 进入 Settings，修改需要注意上限为 82 (默认 85)
5. 点击保存，返回 Main
6. 继续监测，观察 CNE 在 82 附近是否按新阈值切换等级标签
7. 在 Result 页验证保存的记录颜色映射正确
□ 所有步骤无报错 ✓
□ CNE 递增正常 ✓
□ 阈值修改后即时生效 ✓
□ 颜色映射5档完整 ✓
```

### 完整验收（~1 小时）

- 执行 `docs/manual-testing-checklist.md` 中的全部 64 项测试
- 填写执行记录表，统计通过率
- 对所有"失败"项进行根因分析
- 确认遗留问题优先级（P0/P1/P2）

---

## 后续可选增强

1. **Settings 中实时预览**
   - 修改阈值时实时计算会产生什么风险等级
   - 用示例 CNE 值展示预期颜色变化

2. **批量导出**
   - Result 页支持导出记录为 CSV/Excel
   - 含完整元数据（设备、时间、坐标等）

3. **风险趋势图**
   - 历史记录中统计风险等级分布
   - 按时间/地点聚合分析

4. **自动校准**
   - 基于已知 SPL 参考源自动调整 offset
   - 校准向导 UI

---

## 技术文档索引

| 文档 | 用途 |
|------|------|
| [manual-testing-checklist.md](docs/manual-testing-checklist.md) | 功能验收清单 |
| `utils/audio-math.js` (JSDoc) | 声学计算算法说明 |
| `utils/risk-config.js` (JSDoc) | 风险配置模型说明 |
| `pages/main/main.js` (注释) | 主监测流程说明 |
| `pages/settings/settings.js` (注释) | 设置页交互说明 |
| `pages/result/result.js` (注释) | 历史记录页说明 |

---

**实施完成标志**：
- ✅ 5级风险分段链路打通（constants → risk-config → data-model → audio-math → pages）
- ✅ Settings 可配置UI与验证完整
- ✅ Main/Result 页面颜色映射同步升级
- ✅ 关键函数补充详细注释与 JSDoc
- ✅ 手测清单与执行记录模板就绪
- ✅ 所有核心路径无语法错误

