//
// can: FDCAN1 driver for the vdlink firmware (based on CANable 2.0 slcan firmware)
//
// Changes from upstream:
//  - FDCAN kernel clock is 80 MHz (PLLQ) so common bitrates divide exactly
//  - bit timing (prescaler / segments / SJW) can be set freely by the host
//  - transmitter delay compensation for fast data phases
//  - silent (listen-only) mode actually applied when opening the channel
//  - frames are received in the FDCAN interrupt and timestamped there (us)
//  - optional echo of transmitted frames (from the TX event FIFO)
//  - automatic bus-off recovery
//

#include "stm32g4xx_hal.h"
#include "slcan.h"
#include "usbd_cdc_if.h"
#include "can.h"
#include "led.h"
#include "error.h"
#include "system.h"
#include "clock.h"


static FDCAN_HandleTypeDef can_handle;
static can_timing_t nominal = { 2, 63, 16, 16 };   // 500k, 80 %
static can_timing_t data    = { 1, 29, 10, 10 };   // 2M, 75 %
static enum can_bus_state bus_state;
static uint8_t can_autoretransmit = ENABLE;
static uint8_t can_silent = 0;
static uint8_t can_non_iso = 0;
static uint8_t can_tx_echo = 0;
static can_txbuf_t txqueue = {0};

// Frames received in the ISR, consumed by the main loop
static can_rxframe_t rxring[RXRING_LEN];
static volatile uint16_t rx_head = 0, rx_tail = 0;
static volatile uint32_t rx_dropped = 0;

// Copies of frames handed to the TX FIFO so the TX event can be echoed with data
#define ECHO_SLOTS 16
static uint8_t echo_data[ECHO_SLOTS][64];
static uint8_t echo_marker = 0;


void can_init(void)
{
    GPIO_InitTypeDef GPIO_InitStruct;
    __HAL_RCC_FDCAN_CLK_ENABLE();
    __HAL_RCC_GPIOB_CLK_ENABLE();
    __HAL_RCC_GPIOC_CLK_ENABLE();
    __HAL_RCC_GPIOA_CLK_ENABLE();

    GPIO_InitStruct.Pin = GPIO_PIN_0;
    GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull = GPIO_PULLDOWN;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(GPIOA, &GPIO_InitStruct);
    HAL_GPIO_WritePin(GPIOA, GPIO_PIN_0, 0); // CAN standby off

    GPIO_InitStruct.Pin = GPIO_PIN_13;
    GPIO_InitStruct.Mode = GPIO_MODE_OUTPUT_PP;
    GPIO_InitStruct.Pull = GPIO_PULLDOWN;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_LOW;
    HAL_GPIO_Init(GPIOC, &GPIO_InitStruct);
    HAL_GPIO_WritePin(GPIOC, GPIO_PIN_13, 1); // CAN IO power

    // PB8 = CAN_RX, PB9 = CAN_TX
    GPIO_InitStruct.Pin = GPIO_PIN_8|GPIO_PIN_9;
    GPIO_InitStruct.Mode = GPIO_MODE_AF_PP;
    GPIO_InitStruct.Pull = GPIO_NOPULL;
    GPIO_InitStruct.Speed = GPIO_SPEED_FREQ_HIGH;
    GPIO_InitStruct.Alternate = GPIO_AF9_FDCAN1;
    HAL_GPIO_Init(GPIOB, &GPIO_InitStruct);

    can_handle.Instance = FDCAN1;
    bus_state = OFF_BUS;

    HAL_NVIC_SetPriority(FDCAN1_IT0_IRQn, 1, 0);
}


void can_enable(void)
{
    if (bus_state != OFF_BUS)
        return;

    can_handle.Init.ClockDivider = FDCAN_CLOCK_DIV1;
    can_handle.Init.FrameFormat = FDCAN_FRAME_FD_BRS;
    can_handle.Init.Mode = can_silent ? FDCAN_MODE_BUS_MONITORING : FDCAN_MODE_NORMAL;
    can_handle.Init.AutoRetransmission = can_autoretransmit;
    can_handle.Init.TransmitPause = DISABLE;
    can_handle.Init.ProtocolException = DISABLE;

    can_handle.Init.NominalPrescaler = nominal.brp;
    can_handle.Init.NominalSyncJumpWidth = nominal.sjw;
    can_handle.Init.NominalTimeSeg1 = nominal.tseg1;
    can_handle.Init.NominalTimeSeg2 = nominal.tseg2;

    can_handle.Init.DataPrescaler = data.brp;
    can_handle.Init.DataSyncJumpWidth = data.sjw;
    can_handle.Init.DataTimeSeg1 = data.tseg1;
    can_handle.Init.DataTimeSeg2 = data.tseg2;

    can_handle.Init.StdFiltersNbr = 0;
    can_handle.Init.ExtFiltersNbr = 0;
    can_handle.Init.TxFifoQueueMode = FDCAN_TX_FIFO_OPERATION;

    if (HAL_FDCAN_Init(&can_handle) != HAL_OK)
    {
        error_assert(ERR_PERIPHINIT);
        return;
    }

    // Accept everything (including remote frames) into FIFO0
    HAL_FDCAN_ConfigGlobalFilter(&can_handle, FDCAN_ACCEPT_IN_RX_FIFO0, FDCAN_ACCEPT_IN_RX_FIFO0,
                                 FDCAN_FILTER_REMOTE, FDCAN_FILTER_REMOTE);

    // Transmitter delay compensation: needed when the data phase is fast
    // (bit time shorter than the transceiver loop delay). Offset = sample point in mtq.
    uint32_t data_bit_cycles = (uint32_t)data.brp * (1U + data.tseg1 + data.tseg2);
    if (data_bit_cycles <= 80U) // data bitrate >= 1 Mbit/s at 80 MHz
    {
        uint32_t tdco = (uint32_t)data.brp * (1U + data.tseg1);
        if (tdco > 127U) tdco = 127U;
        HAL_FDCAN_ConfigTxDelayCompensation(&can_handle, tdco, 0);
        HAL_FDCAN_EnableTxDelayCompensation(&can_handle);
    }

    // Non-ISO (Bosch) CAN FD: CCCR.NISO, writable while INIT/CCE are set
    if (can_non_iso)
        SET_BIT(can_handle.Instance->CCCR, FDCAN_CCCR_NISO);
    else
        CLEAR_BIT(can_handle.Instance->CCCR, FDCAN_CCCR_NISO);

    // Timestamp counter is not used (we stamp with TIM2 in the ISR)
    HAL_FDCAN_ActivateNotification(&can_handle,
        FDCAN_IT_RX_FIFO0_NEW_MESSAGE | FDCAN_IT_RX_FIFO0_MESSAGE_LOST |
        FDCAN_IT_TX_EVT_FIFO_NEW_DATA | FDCAN_IT_TX_EVT_FIFO_ELT_LOST, 0);
    HAL_FDCAN_ConfigInterruptLines(&can_handle, FDCAN_IT_GROUP_RX_FIFO0 | FDCAN_IT_GROUP_TX_FIFO_ERROR, FDCAN_INTERRUPT_LINE0);

    rx_head = rx_tail = 0;
    txqueue.head = txqueue.tail = 0;
    HAL_NVIC_EnableIRQ(FDCAN1_IT0_IRQn);

    HAL_FDCAN_Start(&can_handle);
    bus_state = ON_BUS;
    led_blue_on();
}


void can_disable(void)
{
    if (bus_state == ON_BUS)
    {
        HAL_NVIC_DisableIRQ(FDCAN1_IT0_IRQn);
        HAL_FDCAN_Stop(&can_handle);
        bus_state = OFF_BUS;
        led_green_on();
    }
}


// Presets kept for compatibility with stock slcan tools (cangaroo, slcand)
void can_set_bitrate(enum can_bitrate bitrate)
{
    can_timing_t t = { 1, 63, 16, 16 }; // 80 tq per bit, 80 %
    switch (bitrate)
    {
        case CAN_BITRATE_10K:   t.brp = 100; break;
        case CAN_BITRATE_20K:   t.brp = 50;  break;
        case CAN_BITRATE_50K:   t.brp = 20;  break;
        case CAN_BITRATE_83_3K: t.brp = 12;  break;
        case CAN_BITRATE_100K:  t.brp = 10;  break;
        case CAN_BITRATE_125K:  t.brp = 8;   break;
        case CAN_BITRATE_250K:  t.brp = 4;   break;
        case CAN_BITRATE_500K:  t.brp = 2;   break;
        case CAN_BITRATE_750K:  // 80 MHz / 750k is not an integer: 107 tq -> 747.7k
            t.brp = 1; t.tseg1 = 85; t.tseg2 = 21; t.sjw = 21; break;
        case CAN_BITRATE_1000K:
        default:                t.brp = 1;   break;
    }
    can_set_nominal_timing(&t);
}


void can_set_data_bitrate(enum can_data_bitrate bitrate)
{
    can_timing_t t;
    if (bitrate == CAN_DATA_BITRATE_5M)
    {
        t.brp = 1; t.tseg1 = 11; t.tseg2 = 4; t.sjw = 4;    // 16 tq, 75 %
    }
    else
    {
        t.brp = 1; t.tseg1 = 29; t.tseg2 = 10; t.sjw = 10;  // 40 tq, 75 %
    }
    can_set_data_timing(&t);
}


// Ranges from the FDCAN NBTP / DBTP registers
int can_set_nominal_timing(const can_timing_t *t)
{
    if (bus_state == ON_BUS) return -1;
    if (t->brp < 1 || t->brp > 512) return -1;
    if (t->tseg1 < 2 || t->tseg1 > 256) return -1;
    if (t->tseg2 < 2 || t->tseg2 > 128) return -1;
    if (t->sjw < 1 || t->sjw > 128 || t->sjw > t->tseg2) return -1;
    nominal = *t;
    led_green_on();
    return 0;
}


int can_set_data_timing(const can_timing_t *t)
{
    if (bus_state == ON_BUS) return -1;
    if (t->brp < 1 || t->brp > 32) return -1;
    if (t->tseg1 < 1 || t->tseg1 > 32) return -1;
    if (t->tseg2 < 1 || t->tseg2 > 16) return -1;
    if (t->sjw < 1 || t->sjw > 16 || t->sjw > t->tseg2) return -1;
    data = *t;
    led_green_on();
    return 0;
}


void can_set_silent(uint8_t silent)
{
    if (bus_state == ON_BUS) return;
    can_silent = silent ? 1 : 0;
    led_green_on();
}


void can_set_autoretransmit(uint8_t autoretransmit)
{
    if (bus_state == ON_BUS) return;
    can_autoretransmit = autoretransmit ? ENABLE : DISABLE;
    led_green_on();
}


void can_set_non_iso(uint8_t non_iso)
{
    if (bus_state == ON_BUS) return;
    can_non_iso = non_iso ? 1 : 0;
}


void can_set_tx_echo(uint8_t on)
{
    can_tx_echo = on ? 1 : 0;
}


// Queue a frame for transmission (called from the main loop via slcan parser)
uint32_t can_tx(FDCAN_TxHeaderTypeDef *tx_msg_header, uint8_t* tx_msg_data)
{
    if (bus_state != ON_BUS || can_silent)
    {
        error_assert(ERR_CAN_TXFAIL);
        return HAL_ERROR;
    }

    if (((txqueue.head + 1) % TXQUEUE_LEN) == txqueue.tail)
    {
        error_assert(ERR_FULLBUF_CANTX);
        return HAL_ERROR;
    }

    int8_t len = hal_dlc_code_to_bytes(tx_msg_header->DataLength);
    if (len < 0 || len > TXQUEUE_DATALEN)
        return HAL_ERROR;

    txqueue.header[txqueue.head] = *tx_msg_header;
    for (uint8_t i = 0; i < len; i++)
        txqueue.data[txqueue.head][i] = tx_msg_data[i];

    txqueue.head = (txqueue.head + 1) % TXQUEUE_LEN;
    return HAL_OK;
}


void can_process(void)
{
    if (bus_state != ON_BUS)
        return;

    while ((txqueue.tail != txqueue.head) && (HAL_FDCAN_GetTxFifoFreeLevel(&can_handle) > 0))
    {
        FDCAN_TxHeaderTypeDef *h = &txqueue.header[txqueue.tail];
        uint8_t *d = txqueue.data[txqueue.tail];

        uint8_t slot = echo_marker % ECHO_SLOTS;
        h->TxEventFifoControl = FDCAN_STORE_TX_EVENTS;
        h->MessageMarker = echo_marker;
        int8_t len = hal_dlc_code_to_bytes(h->DataLength);
        for (int8_t i = 0; i < len; i++)
            echo_data[slot][i] = d[i];
        echo_marker++;

        if (HAL_FDCAN_AddMessageToTxFifoQ(&can_handle, h, d) != HAL_OK)
            error_assert(ERR_CAN_TXFAIL);

        txqueue.tail = (txqueue.tail + 1) % TXQUEUE_LEN;
        led_green_on();
    }

    // Bus-off: restart (the controller then waits 128 x 11 recessive bits)
    if (can_handle.Instance->PSR & FDCAN_PSR_BO)
    {
        if (can_handle.Instance->CCCR & FDCAN_CCCR_INIT)
            CLEAR_BIT(can_handle.Instance->CCCR, FDCAN_CCCR_INIT);
    }
}


static void rx_push(const can_rxframe_t *f)
{
    uint16_t next = (rx_head + 1) % RXRING_LEN;
    if (next == rx_tail)
    {
        rx_dropped++;
        return;
    }
    rxring[rx_head] = *f;
    rx_head = next;
}


// Pop one frame received in the ISR. Returns 1 if a frame was copied.
int can_rx_pop(can_rxframe_t *out)
{
    if (rx_tail == rx_head)
        return 0;
    *out = rxring[rx_tail];
    rx_tail = (rx_tail + 1) % RXRING_LEN;
    return 1;
}


// FDCAN interrupt line 0
void can_irq(void)
{
    uint32_t now = clock_us();
    FDCAN_GlobalTypeDef *fd = can_handle.Instance;
    uint32_t ir = fd->IR;
    fd->IR = ir & (FDCAN_IR_RF0N | FDCAN_IR_RF0L | FDCAN_IR_TEFN | FDCAN_IR_TEFL);

    if (ir & (FDCAN_IR_RF0L | FDCAN_IR_TEFL))
    {
        rx_dropped++;
        error_assert(ERR_CANRXFIFO_OVERFLOW);
    }

    FDCAN_RxHeaderTypeDef rh;
    can_rxframe_t f;
    while (HAL_FDCAN_GetRxFifoFillLevel(&can_handle, FDCAN_RX_FIFO0) > 0)
    {
        if (HAL_FDCAN_GetRxMessage(&can_handle, FDCAN_RX_FIFO0, &rh, f.data) != HAL_OK)
            break;
        f.ts_us = now;
        f.id = rh.Identifier;
        f.ext = rh.IdType == FDCAN_EXTENDED_ID;
        f.rtr = rh.RxFrameType == FDCAN_REMOTE_FRAME;
        f.fd = rh.FDFormat == FDCAN_FD_CAN;
        f.brs = rh.BitRateSwitch == FDCAN_BRS_ON;
        f.esi = rh.ErrorStateIndicator == FDCAN_ESI_PASSIVE;
        f.dlc = (uint8_t)(rh.DataLength >> 16);
        f.is_tx = 0;
        rx_push(&f);
    }

    FDCAN_TxEventFifoTypeDef te;
    while ((fd->TXEFS & FDCAN_TXEFS_EFFL) != 0U)
    {
        if (HAL_FDCAN_GetTxEvent(&can_handle, &te) != HAL_OK)
            break;
        if (!can_tx_echo)
            continue;
        uint8_t slot = te.MessageMarker % ECHO_SLOTS;
        f.ts_us = now;
        f.id = te.Identifier;
        f.ext = te.IdType == FDCAN_EXTENDED_ID;
        f.rtr = te.TxFrameType == FDCAN_REMOTE_FRAME;
        f.fd = te.FDFormat == FDCAN_FD_CAN;
        f.brs = te.BitRateSwitch == FDCAN_BRS_ON;
        f.esi = 0;
        f.dlc = (uint8_t)(te.DataLength >> 16);
        f.is_tx = 1;
        int8_t len = hal_dlc_code_to_bytes(te.DataLength);
        for (int8_t i = 0; i < len; i++)
            f.data[i] = echo_data[slot][i];
        rx_push(&f);
    }
}


uint8_t can_is_on_bus(void) { return bus_state == ON_BUS; }
uint8_t can_is_silent(void) { return can_silent; }
uint32_t can_rx_dropped(void) { return rx_dropped; }
uint32_t can_psr(void) { return bus_state == ON_BUS ? can_handle.Instance->PSR : 0; }
uint32_t can_ecr(void) { return bus_state == ON_BUS ? can_handle.Instance->ECR : 0; }
FDCAN_HandleTypeDef* can_gethandle(void) { return &can_handle; }
