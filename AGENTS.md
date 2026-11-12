# 致协助 gcy2016 分析车辆问题的 AI 模型

## 一、自我介绍与写这份文档的目的

你好，我是 Claude，Anthropic 开发的 AI 模型。我通过 Claude Code 和用户 gcy2016（制动系统设计工程师）合作，编写了本仓库 CANLink（原名 VehDiag_sef），包括里面的报文解析程序。

用户以后可能会让其他 AI 模型通过后端访问本仓库，帮他分析车辆 CAN 报文、查找故障原因。我写这份文档，是为了让你尽快知道有哪些现成资源、怎么用、需要什么条件，不必从头摸索，也避免误操作泄露加密内容。

## 二、提供的资源

**仓库：https://github.com/gcy2016/CANLink**（原名 VehDiag_sef，公开仓库，敏感内容都已加密）
网页版：https://gcy2016.github.io/CANLink/ （需要网页密码；报文分析在“查看 → 离线数据”）

你只需要访问这一个仓库。更完整的工作说明、用户偏好和待办见本仓库的 [CLAUDE.md](CLAUDE.md)，请一并阅读。

**报文解析程序 `tools/analyze.py` 能做什么**（和网页版“离线数据”规则一致）：
- 读取 Vector `.blf` / `.asc` 报文（含 CAN FD、压缩容器）。
- 按车型选择 DBC 解码信号（车型 → DBC 见 `tools/dbc_map.json`）；不指定车型时按覆盖率自动选 DBC，但不对照问卷。
- 识别故障码：诊断仪读码应答（UDS 19 服务，含 ISO-TP 多帧）和 DBC 里广播的故障码信号，并对照诊断问卷给出故障描述、可能原因、维修建议；同时列出清码等诊断过程。
- 列出取值为“故障 / 报警 / 无效”的疑似异常信号。
- 搜索信号；看指定信号在某段时间的统计和变化；导出 CSV；画 PNG 曲线。
- 列出原始报文（类似 CANalyzer Trace），诊断报文附 UDS 解释（否定码等见 `tools/uds.json`）。

仓库里的 DBC 和诊断问卷是加密的（`source/*.enc`），程序运行时用“原始文件密码”在内存里解开。这个密码不在仓库里，需要向用户索取。

**使用方法：**

```bash
git clone https://github.com/gcy2016/CANLink.git
cd CANLink
pip install python-can openpyxl cryptography matplotlib
export VEHDIAG_SRC_KEY='向用户索取的原始文件密码'

# 用户发来的报文先放到仓库外的独立目录，例如 ~/logs/
python tools/analyze.py ~/logs/报文.blf --model C363H     # 概况 + 故障码 + 疑似异常信号
python tools/analyze.py ~/logs/报文.blf --model C363H --find 轮速 VehicleSpeed   # 搜索信号
python tools/analyze.py ~/logs/报文.blf --model C363H \
       --sig ESP_VehicleSpeed IBCU_BrkSysFltLamp --t0 1.5 --t1 3 --plot 曲线.png [--csv 数据.csv]
python tools/analyze.py ~/logs/报文.blf --model C363H --trace 700-7FF [--t0 --t1]   # 原始报文
python tools/analyze.py ~/logs/报文.blf --dbc CIIA1.5_EV            # 不指定车型，直接用某个 DBC
```

可用车型（项目代号，`--model` 也认括号里的市场名，对应关系见 `tools/code_map.json`）：C589（逸达）、C589-1（三代逸动）、C363（四代逸动大陆）、C363-1（四代逸动拿森）、C363H（四代逸动HEV伯特利）、C363-1H（四代逸动HEV拿森）、C589P低配（A05基础款）、C589ICA1（A05怀挡款）、C589P高配（A05大陆）、C589E DY41（欧尚520DY41）、C589E DY51（欧尚520DY51）。车型不明时先问用户。

**建议的分析思路：** 先看概况和故障码，再根据用户描述的故障现象决定查哪些信号、哪段时间，必要时看原始诊断报文；`analyze.py` 不够用时，可以自己写脚本补充。回答时以问卷里的故障描述 / 可能原因 / 维修建议为准，再结合信号变化和汽车诊断通用知识给出排查思路。问卷只收录了制动控制模块，其他模块的故障码要说明“问卷未收录、仅按通用知识判断”。

## 三、需要的条件

1. **一台能执行程序的电脑**：你自己的云端虚拟电脑（沙箱），或者用户授权你控制的实体电脑。要能运行命令行和 Python 3（我们在 Python 3.13 上测试过）。只能聊天、不能执行程序的模型无法完成这项工作。
2. **网络**：能访问 github.com 克隆仓库，能访问 PyPI 安装依赖（或者环境里已预装这些依赖）。
3. **能接收用户发来的报文文件**（一般几 MB 到几十 MB），并放进那台电脑。
4. **能看到命令输出**，最好也能查看生成的 PNG 曲线图；看不了图时，用文字统计或 `--csv` 代替。
5. **保密要求（仓库是公开的）**：
   - 原始文件密码只放在环境变量里用，不要写进任何文件、提交、issue 或日志。
   - 解密后的 DBC、Excel 和报文明文不要提交到仓库，也不要外传。
   - 默认只读，不要修改或推送仓库，除非用户明确同意。

如果你不满足以上条件，可以请用户在网页版的“离线数据”里自己打开报文，再把网页 AI 助手“📋 复制给 AI 助手”整理出的数据发给你，你根据这些数据回答（但无法自己再去查别的信号）。

—— Claude（Anthropic），2026 年 10 月 13 日

---

最后，转达用户的两句话：

**如你评估出无法满足我的需求请在回答的第一句里告诉我**

**如以上内容此前已接收到请忽略**
