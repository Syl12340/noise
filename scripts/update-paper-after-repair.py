"""Revise the preserved draft to describe the October 5 implementation."""
from pathlib import Path
import re

root=Path(__file__).resolve().parents[1]
paper=root/'docs/paper-acoustic-algorithms-and-engineering.md'
text=paper.read_text(encoding='utf-8')
def paragraph(prefix,replacement):
    global text
    pattern='^'+re.escape(prefix)+r'.*$'
    text,count=re.subn(pattern,lambda _:replacement,text,flags=re.MULTILINE)
    if count!=1:
        raise ValueError(prefix)

paragraph('稿件类型：', '稿件类型：方法与软件工程论文。修订稿对应 2026 年 10 月 5 日工作区源码，算法标记为 `acoustics-2026-10-05.1`，结果结构版本为 2。工作区包含尚未提交的变更，不能以已有提交号代替本文实现快照。第 7.1–7.3 节保留既有报告的日期和版本，第 7.4 节报告本轮修复及新增确定性数值验证。没有实际手机采集链或受试者实验。[10 月 4 日初稿](paper-acoustic-algorithms-and-engineering-2026-10-04.md)及其证据清单保留为历史快照。')
paragraph('**目的：**', '**目的：** 介绍运行于微信小程序的噪声测量与探索性语音分析系统及其可追溯设计。**方法：** 系统请求 44.1 kHz 单通道 PCM。噪声分支采用连续直流抑制、数字 A 计权和能量积分，提供等效电平、预计暴露换算及频谱显示。语音分支采用抗混叠重采样、YIN 基频估计、Burg 线性预测、多模型共振峰候选和限带分数延迟相关 HNR；工程层管理共享录音会话、输入支持区间、独立选区及版本元数据。**结果：** 修复后 138 项既有工程回归与 14 项新增针对性检查通过。旧三点峰高插值使无添加噪声的 237 Hz 多谐波输入得到约 14.35 dB HNR；改用带限信号插值和实际点积寻优后达到约 60 dB 的数值上限。F0 端点数值误拒绝亦得到修正。独立参考帧分母下，共振峰冻结集仍未达到 80% 覆盖率门槛，并存在超过 10% 的错误接受。**结论：** 已测数值缺陷修正不代表获得真机计量或临床有效性；单点校准有条件限制，共振峰及 HNR 继续保留实验性质。')
paragraph('**Objective:**', '**Objective:** To describe the acoustic methods and engineering implementation of a WeChat mini program for noise measurement and exploratory speech analysis. **Methods:** Mono PCM is requested at 44.1 kHz. Noise analysis combines DC suppression, digital A weighting and sample-based energy integration. Speech analysis uses anti-alias resampling, YIN-based F0 estimation, Burg LPC, multi-model formant candidates and band-limited fractional-delay correlation HNR. Shared recorder sessions, input-support intervals, independent selection analysis and versioned metadata address asynchronous acquisition. **Results:** After repair, 138 existing engineering checks and 14 targeted checks passed. Three-point peak-height interpolation previously produced approximately 14.35 dB HNR for a noiseless periodic 237 Hz harmonic input. Band-limited signal interpolation followed by direct normalized-dot-product optimization raised this output to the numerical ceiling of approximately 60 dB. Numerical F0 endpoint rejection was also corrected. Formant evaluations with independently generated reference-frame denominators still failed the predefined coverage and frequency-error criteria. **Conclusion:** Corrections verified on deterministic inputs do not establish native-device metrological or clinical validity. Single-point calibration remains conditional; formants and HNR remain experimental measures.')
paragraph('| 谐噪比 |', '| 谐噪比 | 5.5 kHz 名义低通、12 kHz 分析率、约 85.33 ms 输入窗；129 点 sinc 分数延迟点积与有界寻优，约 60 dB 数值上限 |')
paragraph('算法优先选择范围内', r'实现先在各局部谷的原始差分函数上做抛物线插值，得到亚样本周期及 $F_0=f_s/\hat\tau$，再按插值频率筛选候选，优先选取第一个归一化谷值低于 0.1 的候选；未找到时，仅接受最优谷不高于 0.3 的候选。局部比较能量不足、范围边界和潜在高频越界倍周期候选有单独拒绝原因。端点处使用 $\max(10^{-6},10^{-9}\max[f_{\min},f_{\max}])$ Hz 的数值容差，保留未经调整的 `rawF0` 及边界调整标记；0.5% 的候选搜索缓冲不能作为最终接受范围。')
start=text.index('### 5.5 限带自相关谐噪比')
end=text.index('### 5.6 数字声强与帧周期变异',start)
text=text[:start]+r'''### 5.5 限带分数延迟相关谐噪比

HNR 分支在名义 5.5 kHz 低通后的 12 kHz 信号上，以约 85.33 ms 输入窗估计周期相关。去除帧均值后，零填充 FFT 提供整数延迟的线性自相关和局部峰初值；它不把 YIN 差分直接转换为 HNR。仅用三点抛物线估计峰高，会使非整数样本周期的多谐波信号产生严重伪噪声，原始研究也讨论了该类采样误差。[11](https://www.fon.hum.uva.nl/paul/papers/Proceedings_1993.pdf)

当前实现用 129 点 Blackman 加窗 sinc 核重建分数延迟信号。令 $\tau=m+\delta$，$\tilde x_\tau[n]=\sum_{j=-64}^{64}h_j(\delta)x[n+m+j]$，核系数按直流增益归一化。每个峰的寻优区间固定比较样本集合 $\mathcal I$，预留两端插值支持，计算

$$
r(\tau)=\frac{\sum_{n\in\mathcal I}x[n]\tilde x_\tau[n]}{\sqrt{\sum_{n\in\mathcal I}x^2[n]\sum_{n\in\mathcal I}\tilde x_\tau^2[n]}}.
\tag{15}
$$

整数候选峰在有效 YIN 周期附近约 ±15% 范围搜索，随后在各峰邻域及允许频率范围内用有界 Brent 方法寻优实际点积值。三点抛物线仅提供延迟初值。比较区间在一次寻优中不随延迟改变，不延拓分析帧外数据；结果记录分数延迟、比较样本数及收敛状态。每次点积后允许异步调度和取消。未收敛或相关峰不足 0.2 时保留缺失，有效峰计算

$$
\widehat{HNR}=10\log_{10}\frac{r}{1-r}.
\tag{16}
$$

其中 $r$ 限制到不超过 $1-10^{-6}$，对应约 60 dB 数值上限，并记录触顶帧。均值仅在可评估有声帧的有效比例至少为 50%、按帧移计算的有效时长至少为 0.10 s 时显示。输入窗长、实际比较样本数和按帧移表示的输出时长是不同量。数值上限不是达到同等准确测量范围的证明。有限插值核、噪声颜色、韵律与周期/幅度变化仍影响周期性估计；已知白噪声及纯周期验证不能覆盖真实嗓音条件。算法和尺度与 Praat 不完全相同，HNR 继续标为实验性。[9](https://praat.org/manual/Sound__To_Harmonicity__ac____.html)

''' +text[end:]
paragraph('本文读取已有报告，不新增运行。', '本节汇总 2026 年 10 月 4 日的既有工程报告；10 月 5 日修复及新增执行见第 7.4 节。原回归使用 Node、模拟录音事件与模拟 Canvas，结果见表 2。[实现与检查记录](rc-repairs-2026-10-04.md)')
section='''### 7.4 2026 年 10 月 5 日工程修复与确定性验证

本轮保留先前报告，在隔离副本中执行新版本。138 项既有工程回归及 14 项新增针对性检查通过；包检查通过 55 个语法文件、14 条路由、51 个绑定和 2 个 Worker 入口，Worker 由 20 个源码模块构建。新增检查包括未用于旧故障示例的 89.7、151.3、263.2、431.5、733.1 Hz 多谐波信号、已知白噪声、DC 偏置、取消、数值边界及故意删除输出行的分母验证。它们仍是确定性回归条件，首次观察后不再称为未见测试集。

旧 HNR 对 237 Hz、389 Hz 无添加噪声多谐波输入分别输出约 14.35、21.61 dB。修复后，相同 Int16 PCM 的完整流水线两者均达到约 60 dB 数值上限；浮点核心已知 F0 的 10/20/30 dB 白噪声条件得到约 10.12/20.11/30.04 dB。40 Hz、1200 Hz 的中部 30 帧均输出，39 Hz 和 1210 Hz 仍被拒绝。上述结果支持本轮特定数值缺陷的修正，不证明一般嗓音、不同噪声颜色或临床阈值准确。

共振峰及 Praat 对照改用冻结输入长度和预先指定参数生成参考时间网格，缺少生产行时仍保留分母。原频率误差与覆盖率门槛没有改变。本轮三个数据集的结果与表 3 相同，400 Hz 三极点条件仍失败；这项工程修复没有解决共振峰共同模型偏差。每帧质量信息明确记录 `model-correspondence-only` 与 `quantitativeUseValidated=false`，页面称为“模型接受帧”。

同一 5 s、44.1 kHz、237 Hz 多谐波 PCM 的桌面 Node 24.21.0 单次分析，修复前约 0.96 s，修复后约 1.75 s；观测定时器最大间隔均约 25 ms。该测量包含分步分析，未包含微信页面绘制或原生输入；不是手机性能验收或最坏运行时间保证。[本轮修复报告](engineering-repairs-2026-10-05.md)、[本轮证据清单](scientific-repairs-2026-10-05/run-manifest.json)

'''
text=text.replace('## 8 讨论\n',section+'## 8 讨论\n',1)
paragraph('本文介绍了微信小程序中样本能量噪声估计', '本文介绍了样本能量噪声估计、数字 A 计权、单点参考校准和 YIN/Burg 等探索性语音分析，并说明录音会话、支持区间、选区重分析及历史证据管理。新增分数延迟 HNR 和 F0 数值边界修正得到所测确定性输入支持，工程检查共 152 项通过。共振峰覆盖不足和错误接受仍在，HNR 的有限验证也不等于临床有效性；真机采集链、独立声学对照和高基频共振峰研究仍需继续。')
text=text.replace('## 附录 A 实现与证据对应','[11] Boersma P. Accurate short-term analysis of the fundamental frequency and the harmonics-to-noise ratio of a sampled sound. *IFA Proceedings*, 1993, 17: 97–110. [作者原始论文](https://www.fon.hum.uva.nl/paul/papers/Proceedings_1993.pdf).\n\n## 附录 A 实现与证据对应',1)
paragraph('| HNR 与数字声强 |', '| HNR 与数字声强 | [harmonicity.js](../utils/phonetic/harmonicity.js)、[fractional-correlation.js](../utils/phonetic/fractional-correlation.js)、[voice-metrics.js](../utils/phonetic/voice-metrics.js) |')
paragraph('随稿附有[实现与报告证据清单]', '随修订稿附有[当前实现与报告证据清单](paper-acoustics-engineering-evidence-2026-10-05.json)，包含 33 个相关源码文件的 SHA-256、历史及本轮报告的 SHA-256、原稿和当前稿件哈希。原始[10 月 4 日证据清单](paper-acoustics-engineering-evidence-2026-10-04.json)不改写；它对应归档初稿。')
paragraph('本文的准确性数字来自仓库中可查验的报告', '本文数值来自可查验的历史报告及第 7.4 节新增确定性验证，不包含真机或受试者实验。代码未因本文被声明为公开授权软件；正式投稿需补充作者贡献、所属单位、代码与数据可用性说明，以及实际适用的资助和利益冲突声明。若补做人体语音或临床研究，再按实际设计提供伦理、知情同意及受试者信息。')
paper.write_text(text,encoding='utf-8')
print('Revised manuscript:',paper)
