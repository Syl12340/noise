# 独立 Rust 声学计算核心

本工程并行于原 JavaScript 小程序，目录独立，原小程序没有加载新核心。项目打包配置仅排除 `rs-core`，避免把开发源码、冻结数据和验收报告上传为小程序资源。原有录音、实验室/估算校准、保存和历史记录逻辑保持不变。

目前实现噪声计算核心及 WASM 会话接口；语音侧实现预加重、YIN单帧/轨迹、七种输入采样率到12kHz的抗混叠重采样，以及HNR自相关/分数延迟插值和汇总，并提供独立 WASM 宿主。HNR完整录音调度、LPC/共振峰、其他重采样配置及整条语音分析仍待完成。

- [迁移实施方案](MIGRATION_IMPLEMENTATION_PLAN.md)
- [噪声接口说明](phase2/README.md)
- [语音接口与本轮验收](phase3/README.md)
- [重采样阶段评审报告](phase3/PORT_REVIEW_REPORT.md)
- [HNR接口与最新验收](phase4/README.md)
- [HNR阶段评审报告](phase4/PORT_REVIEW_REPORT.md)

安装项目声明的Rust工具链及 `wasm32v1-none`、`wasm32-unknown-unknown` 目标，使用Python和Node。现有环境的实际验收使用Rust1.95及Node24；没有添加第三方Rust依赖。首次运行会从Git历史的固定基线 `3a0d6765` 在 `_work/baseline` 创建参考源码，不改动主线。

在 `rs-core` 中运行：

```text
python tools/run-phase4.py
```

新克隆仓库保留提交中的原始私有SDK配置（3.5.5），而开发现场冻结的私有SDK配置是3.17.2；可使用：

```text
python tools/run-phase4.py --repository-clean
```

该选项只允许私有SDK配置保持固定基线及当前HEAD中的原始内容，并允许主线文件仅因Git换行设置产生的CRLF/LF差异；每项例外会明确记录。其他内容变更仍严格拒绝，系数、冻结数据和数值规则不变。它不改变文件，也不改变算法误差要求。`rs-core/.gitattributes` 禁止本目录的自动换行转换，以保持所有冻结字节及哈希。构建输出和参考源码缓存均由 `.gitignore` 排除；参考导出工具仅用于首次冻结，不属于验收步骤。

验收通过代表当前桌面环境的数值兼容及接口检查通过。它不代表微信真机、Worker、Android采集链、手机性能或实验室/临床科学有效性已获验证。
