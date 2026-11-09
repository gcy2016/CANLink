# CAN 工具（vdlink）

手机和电脑都能用的 CAN / CAN FD 工具，硬件用 **MKS CANable 2.0（Pro）**。方案和阶段见 issue #11，这里是阶段 1：看报文、录报文、发报文。

- 网页：<https://gcy2016.github.io/VehDiag_sef/canlink/>（源码在 `docs/canlink/`，直接发布，不用 build.py）
- 固件：`canlink/firmware/`（vdlink，在 CANable 2.0 开源 slcan 固件上改的，GPLv3）

## 怎么用

1. 用 **Chrome / Edge** 打开网页。安卓手机用 USB-C 公对公**数据线**（OTG）直连 CANable；电脑直接插 USB。iPhone 暂不支持（见 #11）。
2. 第一次用先到“固件”页刷 vdlink 固件（下面“刷固件”）。原版固件也能用，但时间戳是手机打的、采样点固定 88%、只听模式不生效。
3. “连接”页：连接 USB 设备 → 选波特率、采样点、CAN FD → 选模式 → 打开通道。
   - **只听**（默认）：不发任何报文、不回 ACK，录报文用这个。
   - **正常收发**：发报文、诊断用。接到车上已有的总线时，终端电阻跳线帽要拔掉。
4. “报文”页：按 ID（每个 ID 一行，黄色是 1 秒内变化的字节）或滚动显示；可暂停、按 ID 过滤（`7E0,7E8`、`700-7FF`）。
5. “录制”页：打开通道时自动开始录（可关）；可打标记；保存全部、两个标记之间、最后 N 秒或自定义时间段，下载或用手机分享菜单发出去。ASC 能直接用 CANalyzer 和 SEF 网站打开。
6. “发送”页：单次或循环发送，可存多条。
7. 不接硬件可以点“演示模式”先看界面（报文是编的）。

## 刷固件

板子上 **BOOT** 两针用跳线帽短接，再插 USB，进入芯片自带的烧录模式（USB ID 0483:df11）。

- **安卓手机（推荐）**：网页“固件”页 → 刷入 → 选 STM32 BOOTLOADER → 等“完成”。
- **电脑**：Windows 上浏览器一般看不到烧录模式的设备（缺 WinUSB 驱动）。用 ST 官方 STM32CubeProgrammer，连 USB，把 `docs/canlink/fw/vdlink-1.0.bin` 写到 `0x08000000`。
- 刷完拔下、**取下跳线帽**、再插上。网页“连接”后显示“固件：vdlink 1.0”就对了。
- 想刷回原版：MKS 的仓库 makerbase-mks/CANable-MKS 里有原版 `.bin`，同样方法刷。

## vdlink 固件改了什么

| | 原版 slcan 固件 | vdlink 1.0 |
|---|---|---|
| CAN 时钟 | 170 MHz，常用波特率要凑 | 80 MHz（CAN 常用值），系统 160 MHz |
| 波特率 / 采样点 | 只有预设，采样点固定 88% | 网页随便设（命令 `xN` / `xD`） |
| 收发器延时补偿 | 没开，数据段快了发不出去 | 数据段 ≥1M 自动开 |
| 只听模式 `M1` | 设了不生效（开通道时被覆盖） | 修好了 |
| 时间戳 | 没有 | 中断里打微秒时间戳（`Z2`） |
| 收报文 | 主循环轮询，硬件只有 3 帧缓冲，忙时丢帧 | 中断收进 64 帧缓冲 |
| 发出去的报文 | 不回显 | 可回显（`xT1`，行首 `>`），录进 ASC 标 Tx |
| 时钟精度 | 板子没晶振，内部振荡器约 ±1% | 用 USB 帧（1 ms，来自电脑 / 手机的晶振）测误差，开通道前自动校准，剩余误差报给网页修正时间戳 |
| Bus Off | 不恢复 | 自动恢复 |
| USB 发送 | 每次 64 字节，队列满了会写坏 | 每次 512 字节，满了整行丢弃并计数 |

原版的命令（`O C Sx Yx Mx Ax V E t T r R d D b B`）全保留，cangaroo、slcand 照样能用。

### 新增命令（都以 `\r` 结尾）

| 命令 | 作用 | 回复 |
|---|---|---|
| `Z0` / `Z1` / `Z2` | 时间戳：关 / Lawicel 4 位毫秒 / 8 位十六进制微秒（加在数据后面） | 无 |
| `xI` | 固件信息 | `xIvdlink,1.0,80000000` |
| `xS` | 状态 | `xS开,只听,PSR,ECR,错误位,丢帧数,时钟ppm,校准完成,HSITRIM` |
| `xN<分频>,<tseg1>,<tseg2>,<sjw>` | 仲裁段位时间（十进制，tq 个数） | `\r` 成功 / `\a` 失败 |
| `xD<分频>,<tseg1>,<tseg2>,<sjw>` | 数据段位时间 | 同上 |
| `xO0` / `xO1` | ISO / 非 ISO CAN FD | 同上 |
| `xT0` / `xT1` | 回显发出去的报文（行首加 `>`） | 同上 |

位时间：波特率 = 80 MHz ÷ 分频 ÷ (1 + tseg1 + tseg2)，采样点 = (1 + tseg1) ÷ (1 + tseg1 + tseg2)。设置命令要在通道关闭时发。

### 编译

```sh
sudo apt-get install gcc-arm-none-eabi libnewlib-arm-none-eabi
canlink/firmware/build.sh        # 自动下载原版仓库（只用它的 ST 驱动库），输出 build/vdlink-1.0.bin
```

改了固件后把 `build/vdlink-1.0.bin` 复制到 `docs/canlink/fw/`，版本号改 `Makefile` 的 `FW_VERSION`（网页里的文件名也要跟着改）。

## 自测

```sh
node canlink/test/test_web.js    # 位时间、slcan 解析、录制 → ASC → 用 SEF 的读取代码读回核对
node canlink/test/test_dfu.js    # 模拟 STM32 烧录模式，检查刷固件流程
```

## 到货后的台架验证（还没做）

硬件到手前，固件只编译过、没在板子上跑过。到货后按这个顺序验：

1. 刷 vdlink，网页连接后显示固件版本；“状态”里板子时钟误差几秒内变成“±几百 ppm”（不再显示“校准中”）。
2. 台架上 CANalyzer + Vector 接口发报文（500k / 2M FD、500k / 5M FD 各一遍），CANable 只听，两边同时录，对比帧数、内容和时间间隔。
3. 切正常收发，从网页发普通帧和 FD + BRS 帧，CANalyzer 能收到；网页里显示“→”回显。
4. 高负载（总线 60% 以上）录 10 分钟，看“丢帧”是不是 0。
5. 手机上录 10 分钟，看是否掉线、屏幕是否保持常亮。

发现问题记在 issue #11。
