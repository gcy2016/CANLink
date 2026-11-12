#ifndef _CAN_H
#define _CAN_H

#include "stm32g4xx_hal.h"

// FDCAN kernel clock (PLLQ). Host-side bit timing is calculated from this.
#define CAN_KERNEL_CLOCK 80000000UL

// Classic CAN / CANFD nominal bitrate presets (slcan 'Sx')
enum can_bitrate {
    CAN_BITRATE_10K = 0,
    CAN_BITRATE_20K,
    CAN_BITRATE_50K,
    CAN_BITRATE_100K,
    CAN_BITRATE_125K,
    CAN_BITRATE_250K,
    CAN_BITRATE_500K,
    CAN_BITRATE_750K,
    CAN_BITRATE_1000K,
    CAN_BITRATE_83_3K,

    CAN_BITRATE_INVALID,
};

// CANFD data bitrate presets (slcan 'Yx')
enum can_data_bitrate {
    CAN_DATA_BITRATE_2M = 2,
    CAN_DATA_BITRATE_5M = 5,

    CAN_DATA_BITRATE_INVALID,
};

enum can_bus_state {
    OFF_BUS,
    ON_BUS
};

// Bit timing in FDCAN register units (tq counts, not register-minus-one)
typedef struct {
    uint16_t brp;
    uint16_t tseg1;
    uint16_t tseg2;
    uint16_t sjw;
} can_timing_t;

// CAN transmit buffering
#define TXQUEUE_LEN 32
#define TXQUEUE_DATALEN 64

typedef struct cantxbuf_
{
    uint8_t data[TXQUEUE_LEN][TXQUEUE_DATALEN];
    FDCAN_TxHeaderTypeDef header[TXQUEUE_LEN];
    uint16_t head;
    uint16_t tail;
} can_txbuf_t;

// Received frames (and TX echo events), filled from the FDCAN interrupt
#define RXRING_LEN 64

typedef struct {
    uint32_t ts_us;     // microsecond timestamp taken in the ISR
    uint32_t id;
    uint8_t ext;        // 1 = 29-bit ID
    uint8_t rtr;        // 1 = remote frame
    uint8_t fd;         // 1 = CAN FD frame
    uint8_t brs;        // 1 = bit rate switch
    uint8_t esi;        // 1 = error state indicator set
    uint8_t dlc;        // 0..15 DLC code
    uint8_t is_tx;      // 1 = this is an echo of a frame we transmitted
    uint8_t data[64];
} can_rxframe_t;

// Prototypes
void can_init(void);
void can_enable(void);
void can_disable(void);
void can_set_bitrate(enum can_bitrate bitrate);
void can_set_data_bitrate(enum can_data_bitrate bitrate);
int  can_set_nominal_timing(const can_timing_t *t);
int  can_set_data_timing(const can_timing_t *t);
void can_set_silent(uint8_t silent);
void can_set_autoretransmit(uint8_t autoretransmit);
void can_set_non_iso(uint8_t non_iso);
void can_set_tx_echo(uint8_t on);
uint32_t can_tx(FDCAN_TxHeaderTypeDef *tx_msg_header, uint8_t *tx_msg_data);
void can_process(void);
int  can_rx_pop(can_rxframe_t *out);
uint8_t can_is_on_bus(void);
uint8_t can_is_silent(void);
uint32_t can_rx_dropped(void);
uint32_t can_psr(void);
uint32_t can_ecr(void);
FDCAN_HandleTypeDef* can_gethandle(void);
void can_irq(void);

#endif // _CAN_H
