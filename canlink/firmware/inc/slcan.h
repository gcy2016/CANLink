#ifndef _SLCAN_H
#define _SLCAN_H

#include "can.h"

// Maximum line length: '>' + 'B' + 8 id + dlc + 128 data + 8 timestamp + '\r', plus padding
#define SLCAN_MTU 160
#define SLCAN_STD_ID_LEN 3
#define SLCAN_EXT_ID_LEN 8

int32_t slcan_format_frame(uint8_t *buf, const can_rxframe_t *f);
int32_t slcan_parse_str(uint8_t *buf, uint8_t len);
int8_t hal_dlc_code_to_bytes(uint32_t hal_dlc_code);

#endif // _SLCAN_H
