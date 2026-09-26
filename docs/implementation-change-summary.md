# noise-1 本轮实现变更摘要

## 目标
在不改变主流程交互的前提下，完成“算法复用 + 数据读写统一 + 结果管理统一 + 常量收敛”的最小改动重构。

## 新增文件
1. utils/audio-math.js
- 集中音频计算与风险评估函数：RMS、dB、累计能量 Leq、预计暴露结果、A 计权和风险分级；不再包含未经验证的峰度因子。

2. utils/data-model.js
- 集中存储读写：offset、expectedExposure、noiseAlarmLevel、alarm。
- 增加默认值与数值守卫。

3. utils/result-manager.js
- 集中记录管理：getAll/add/rename/remove/clear。

4. utils/constants.js
- 集中阈值与常量：风险阈值、CNE 系数、默认配置、导入范围、画布配置。

5. docs/manual-regression-checklist.md
- 提供主链路手工回归脚本（校准 -> 监测 -> 保存 -> 结果管理）。

## 修改文件（核心）
1. app.js
- initApp 默认值来源改为 data-model/constants，避免默认值分叉。

2. pages/main/main.js
- 接入 audio-math 与 data-model。
- 保存记录改为 result-manager。
- 监测相关常量改为 constants 统一来源。

3. pages/calibrate/calibrate.js
- 复用 audio-math 与 data-model。
- 画布与阈值常量改为 constants。

4. pages/advanced-calibrate/calibrate/calibrate.js
- 复用 audio-math 与 data-model。
- 校准目标常量改为 constants。

5. pages/advanced-calibrate/advanced-calibrate.js
- 导入 offset 增加合法性校验并使用 constants 范围。
- offset 写入统一走 data-model。

6. pages/result/result.js
- 记录读取/删除/重命名改为 result-manager。

7. pages/settings/settings.js
- 设置读写统一走 data-model。
- 增加输入值守卫（空值、NaN、负值场景）。

8. pages/profile/profile.json
- 补充导航标题“个人资料”。

9. pages/advanced-calibrate/calibrate/calibrate.json
- 补充导航标题“1kHz 标准校准”。

## 兼容性与风险
1. 数值计算逻辑已抽离，理论上仅存在浮点微差风险。
2. 存储读写统一后，需重点验证旧缓存场景与空缓存场景。
3. 结果页索引操作已集中管理，需回归验证展开态与删除联动。

## 已完成校验
1. 对本轮改动文件执行静态错误检查，结果均为无错误。
2. 已提供手工回归清单，适合在微信开发者工具逐项验收。

## 说明
1. images 目录中的外部资源改动按要求忽略，不纳入本轮实现范围。
2. 当前工作区存在其他 UI 文件改动（wxml/wxss 等），不属于本轮重构触达内容。
