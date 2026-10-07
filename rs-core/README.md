# 独立 Rust 声学计算核心

本工程并行于原 JavaScript 小程序，目录独立，原小程序没有加载新核心。项目打包配置仅排除 `rs-core`，避免把开发源码、冻结数据和验收报告上传为小程序资源。原有录音、实验室/估算校准、保存和历史记录逻辑保持不变。

目前实现噪声计算核心及独立WASM会话接口；语音侧实现预加重、YIN、可取消重采样、HNR、Burg LPC、求根、共振峰跟踪、数字声强和语谱图，并在Rust中完成标准PCM结果组装。旧PCM-HNR Worker与新完整分析接口分别验证；完整分析的v2 Worker、真机与包体验证仍待完成。

- [迁移实施方案](MIGRATION_IMPLEMENTATION_PLAN.md)
- [噪声接口说明](phase2/README.md)
- [语音接口与本轮验收](phase3/README.md)
- [重采样阶段评审报告](phase3/PORT_REVIEW_REPORT.md)
- [HNR接口与最新验收](phase4/README.md)
- [HNR阶段评审报告](phase4/PORT_REVIEW_REPORT.md)
- [完整连续片段HNR会话](phase5/README.md)
- [HNR边界修复与连续片段支持证据](phase6/README.md)
- [分段规划、基频质量与HNR跨段汇总](phase7/README.md)
- [原始PCM质量、去直流与HNR流水线](phase8/README.md)
- [YIN逐帧会话与取消调度](phase9/README.md)
- [重采样分批会话与工作区验收](phase10/README.md)
- [独立Worker执行与故障恢复](phase11/README.md)
- [数字声强与帧级周期变化率](phase12/README.md)
- [完整结果组装、LPC／共振峰和语谱图](phase13/README.md)

安装项目声明的Rust工具链及 `wasm32v1-none`、`wasm32-unknown-unknown` 目标，使用Python和Node。现有环境的实际验收使用Rust1.95及Node24；没有添加第三方Rust依赖。首次运行会从Git历史的固定基线 `3a0d6765` 在 `_work/baseline` 创建参考源码，不改动主线。

在 `rs-core` 中运行：

```text
python tools/run-phase13.py
```

新克隆仓库保留提交中的原始私有SDK配置（3.5.5），而开发现场冻结的私有SDK配置是3.17.2；可使用：

```text
python tools/run-phase13.py --repository-clean
```

该选项只允许私有SDK配置保持固定基线及当前HEAD中的原始内容，并允许主线文件仅因Git换行设置产生的CRLF/LF差异；每项例外会明确记录。其他内容变更仍严格拒绝，系数、冻结数据和数值规则不变。它不改变文件，也不改变算法误差要求。`rs-core/.gitattributes` 禁止本目录的自动换行转换，以保持所有冻结字节及哈希。构建输出和参考源码缓存均由 `.gitignore` 排除；参考导出工具仅用于首次冻结，不属于验收步骤。

验收通过代表当前桌面环境的数值兼容及接口检查通过。它不代表微信真机、Worker、Android采集链、手机性能或实验室/临床科学有效性已获验证。
