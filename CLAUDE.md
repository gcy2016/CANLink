# 给 Claude 的说明

**当前仓库：VehDiag_sef（Self 自用版）**——用户自己使用，功能最多（故障码查询、报文数据分析、AI 助手，以及对话里用的 `tools/analyze.py`），涉及的加密内容也最多：网站数据 `docs/data.enc.json` 用 6 位网站密码，原始 DBC / 问卷 `source/*.enc` 用原始文件密码（长密码）。

## 四个仓库的定位（同一个用户 gcy2016 的售后诊断工具系列）
| 仓库 | 含义 | 定位 | 网址 |
|---|---|---|---|
| VehDiag_pub | Public 公共版 | 给非专业人员自助查询故障码；没有报文解析和数据分析功能。打开即用，无密码 | https://gcy2016.github.io/VehDiag_pub/ |
| VehDiag_sef | Self 自用版 | 用户自己用；功能最多，加密内容也最多（网站数据用 6 位网站密码，原始 DBC / 问卷用长的原始文件密码） | https://gcy2016.github.io/VehDiag_sef/ |
| VehDiag_shr | Share 分享版 | 给有一定专业能力的人查看报文；只能看原始报文（另有 AI 助手），不带 DBC、不做解析；另有故障码查询（诊断问卷由使用者自己上传，同 GNL）。无密码 | https://gcy2016.github.io/VehDiag_shr/ |
| VehDiag_gnl | General 通用版 | 功能和自用版一致，但仓库里只有代码，DBC、诊断问卷都由使用者自己上传。无密码 | https://gcy2016.github.io/VehDiag_gnl/ |

## 车型：项目代号 ↔ 市场名
SEF 网页按项目代号显示车型；用户在 SEF 里说项目代号。诊断问卷是通用的，Excel Sheet 名仍用市场名（以后新增也可能用市场名），映射记在 `tools/code_map.json`（build.py 生成网页时替换；analyze.py / aeb_response.py 的 `--model` 两种都认）。问卷新增车型时，在 `code_map.json` 里补上代号。

| 项目代号 | 市场名 |
|---|---|
| C589 | 逸达 |
| C589-1 | 三代逸动 |
| C363 | 四代逸动大陆 |
| C363-1 | 四代逸动拿森 |
| C363H | 四代逸动HEV伯特利 |
| C363-1H | 四代逸动HEV拿森 |
| C589P低配 | A05基础款 |
| C589ICA1 | A05怀挡款 |
| C589P高配 | A05大陆 |
| C589E DY41 / C589E DY51 | 欧尚520DY41 / 欧尚520DY51 |

公开版（PUB）仍显示市场名。

## 对话里分析报文
用户会在对话里发来 blf / asc 报文并提问。处理方法：

1. 原始文件密码不在仓库里，向用户要（或用户已在对话中给出），设为环境变量 `VEHDIAG_SRC_KEY`。不要把密码写进任何文件或提交。
2. 安装依赖：`pip install python-can openpyxl cryptography matplotlib`
   （如果 PyPI 被网络拦截：`git clone --depth 1 --branch v4.4.2 https://github.com/hardbyte/python-can` 到仓库外，再用 `PYTHONPATH=那个目录` 运行；openpyxl / cryptography / matplotlib 通常已预装。）
3. 报文等上传文件先复制到仓库外的独立目录再分析。车型不明时先问用户；也可以不带 `--model`，脚本会按 DBC 覆盖率自动选 DBC（这时不对照问卷）。
4. 运行 `python tools/analyze.py 报文 --model 车型`：看概况、故障码（已对照诊断问卷）、疑似异常信号；
   用 `--find 关键词` 找信号，`--sig 信号... [--t0 --t1] [--plot x.png]` 看具体信号变化。
   用 `--trace [ID / 700-7FF / 报文名] [--t0 --t1]` 列出原始报文，诊断报文附简要解释（否定码等见 `tools/uds.json`）。
5. 用户要统计 **AEB 制动响应时间**（或说“跑 AEB 响应 / AEB 统计”）时，运行
   `python tools/aeb_response.py 报文目录或文件... --model 车型 --out 结果.xlsx`，把生成的 Excel 发给用户，并在回复里列出各车速的时间差。
   起点 = ACC_AEBActive 0→1；终点 = |ESP_LongAccel| 第一次超过它之前最近一帧的 |ACC_AEBTargetDeceleration|。
   口径B（推荐）在 |目标| 达到本次峰值一半后才判断、且要求先低于再超过，口径A 为字面结果，两者不同时要向用户说明；备注会标出“激活时已在制动”（再次激活）的情况，回复时单独提醒。信号可用 `--active/--target/--accel/--speed 报文名.信号名` 替换。
6. 用户要做**单件台架测试 / 残余总线仿真**（给被测件模拟整车信号，CANalyzer 10.0）时，运行
   `python tools/restbus.py 快照报文 报文目录... --model 车型 --dut 被测节点 --out 名字.can [--key 键=信号:值] [--set 信号=值] [--at 秒]`，
   把 .can 和使用说明发给用户（.can 含实车数据，不提交）。第一个报文文件末尾（或 `--at`）作为初始状态，要选静止、无 AEB / 驻车请求的时刻；
   校验和 / 计数器从实车报文反推。需求和进度见 issue #9。
7. 回答时以问卷中的故障描述 / 可能原因 / 维修建议为准，再结合信号变化和汽车诊断通用知识给出排查思路；
   问卷只收录制动控制模块，其他模块的故障码要说明“问卷未收录、仅按通用知识判断”。

不要把解密后的 DBC、Excel 或报文明文提交到仓库（`.gitignore` 已排除 `*.dbc`、`*.xlsx`、`*.blf`、`*.asc`）。
改了 `tools/template.html` 或 `tools/web/*.js` 后，需要网站密码（6 位）重新生成 `docs/`：`python tools/build.py --pin 网站密码`。

## CAN 工具（canlink，issue #11）
手机 / 电脑用的 CAN FD 工具（看报文、录报文、发报文；后面加诊断、刷写），硬件 MKS CANable 2.0。网页在 `docs/canlink/`（直接发布，不经 build.py、不加密，不放 DBC 等保密内容），固件在 `canlink/firmware/`（GPLv3），说明和自测见 `canlink/README.md`。改了网页跑 `node canlink/test/test_web.js` 和 `test_dfu.js`。

## 推送
用户已同意：VehDiag_sef、VehDiag_pub、VehDiag_shr、VehDiag_gnl 四个仓库的改动都可以直接推送到 `main`（推送前先在本地测试），不必走 PR / 等 Muse 合并。
SEF 改了网页相关文件后记得用网站密码重新生成 `docs/` 一起提交。

## 需要在 GitHub 网页上操作时（改仓库设置、Pages、分支重命名等）
默认交给 Muse（Meta 的 AI，用 gcy2016 账号在网页上操作）：在相关仓库开一个 issue，标题以“muse：”开头，正文写清楚链接和逐步操作，最后请 muse 回复并关闭 issue。
- 不要写 `@muse`（GitHub 上的 muse 账号是无关的陌生人）。
- 不要在 issue 里写任何密码（仓库是公开的）。
- 参考：gcy2016/VehDiag_pub#1。

## 用户偏好（做功能 / 改界面时遵守）
- 功能够用就行，别做成大而全的 CANalyzer；新功能先问清范围再动手。
- 配色以主题蓝为主，不要太亮、太花。
- 手机和电脑都要适配：手机上内容不能超出屏幕宽度（长内容换行），输入框字号 ≥16px 防 iOS 自动放大；电脑上布局要合理，不能每行都特别短。
- 凡是能选报文的地方（SEF、SHR、GNL）都支持拖动多选，多选时不跳详情；改一个仓库的通用交互，其他仓库同步改。

## 已讨论的结论 / 待办
- 网页 AI 助手目前只根据“当前数据”和用户复制的报文回答，不会自己查。
- 待办（等用户接好大模型 API 后再做）：
  1. 类似微信的聊天界面；
  2. AI 助手加“工具调用”：网页提供查信号、取时间段统计、列报文等固定工具，模型只能提申请、由网页执行后返回结果，报文不离开用户设备。
- 不做：给网页 AI 助手配后端服务器（存密钥、跑 analyze.py）。疑难问题直接把报文发到对话里，用 analyze.py 分析。
- 待定：网站访问密码目前是 6 位数字（暴力破解几分钟到一天就能解开网站数据）。用户可能改成与原始文件密码无关的 10–12 位字母数字随机密码，需要改 build.py 的校验和 template.html 的输入框，网址不变。

@AI_TEAM.md
