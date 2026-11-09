//
// slcan: parse incoming and generate outgoing slcan messages
//
// Stock CANable 2.0 commands are kept (O C Sx Yx Mx Ax V E t T r R d D b B).
// vdlink additions (all optional, documented in ../README.md):
//   Z0 / Z1 / Z2      timestamps off / Lawicel 16-bit ms / 32-bit microseconds
//   xI                info:   "xIvdlink,<version>,<can clock Hz>\r"
//   xS                status: "xS<on>,<silent>,<psr>,<ecr>,<err>,<rxdrop>,<ppm>,<locked>,<trim>\r"
//   xN<brp>,<tseg1>,<tseg2>,<sjw>   nominal bit timing (decimal, tq counts)
//   xD<brp>,<tseg1>,<tseg2>,<sjw>   data bit timing
//   xO0 / xO1         ISO / non-ISO CAN FD
//   xT0 / xT1         echo transmitted frames (prefixed with '>') off / on
// x-commands answer "\r" on success and "\a" on error.
//

#include "stm32g4xx_hal.h"
#include <string.h>
#include "can.h"
#include "error.h"
#include "slcan.h"
#include "usbd_cdc_if.h"
#include "printf.h"
#include "clock.h"


static const char fw_id[] = "vdlink " FW_VERSION " (CANable2 slcan)\r";
static uint8_t ts_mode = 0;


static uint32_t __std_dlc_code_to_hal_dlc_code(uint8_t dlc_code);

static const char hexchars[] = "0123456789ABCDEF";


// Format a received (or echoed) frame as an slcan line. Returns length.
int32_t slcan_format_frame(uint8_t *buf, const can_rxframe_t *f)
{
    uint32_t i = 0;

    if (f->is_tx)
        buf[i++] = '>';

    char c;
    if (!f->fd)
        c = f->rtr ? 'r' : 't';
    else
        c = f->brs ? 'b' : 'd';
    if (f->ext)
        c -= 32;
    buf[i++] = c;

    uint8_t id_len = f->ext ? SLCAN_EXT_ID_LEN : SLCAN_STD_ID_LEN;
    uint32_t id = f->id;
    for (int8_t j = id_len - 1; j >= 0; j--)
    {
        buf[i + j] = hexchars[id & 0xF];
        id >>= 4;
    }
    i += id_len;

    buf[i++] = hexchars[f->dlc & 0xF];

    int8_t bytes = hal_dlc_code_to_bytes((uint32_t)f->dlc << 16);
    if (bytes < 0)
        return -1;
    if (f->rtr)
        bytes = 0;
    for (int8_t j = 0; j < bytes; j++)
    {
        buf[i++] = hexchars[f->data[j] >> 4];
        buf[i++] = hexchars[f->data[j] & 0xF];
    }

    if (ts_mode == 1)
    {
        uint32_t ms = (f->ts_us / 1000U) % 60000U;
        for (int8_t j = 3; j >= 0; j--)
        {
            buf[i + j] = hexchars[ms & 0xF];
            ms >>= 4;
        }
        i += 4;
    }
    else if (ts_mode == 2)
    {
        uint32_t us = f->ts_us;
        for (int8_t j = 7; j >= 0; j--)
        {
            buf[i + j] = hexchars[us & 0xF];
            us >>= 4;
        }
        i += 8;
    }

    buf[i++] = '\r';
    return (int32_t)i;
}


static void reply(int ok)
{
    cdc_transmit((uint8_t *)(ok ? "\r" : "\a"), 1);
}


// Parse up to n comma-separated decimal numbers. Returns count parsed.
static int parse_numbers(const uint8_t *s, uint8_t len, uint32_t *out, int n)
{
    int count = 0;
    uint32_t val = 0;
    uint8_t have = 0;
    for (uint8_t i = 0; i < len; i++)
    {
        uint8_t ch = s[i];
        if (ch >= '0' && ch <= '9')
        {
            val = val * 10U + (ch - '0');
            have = 1;
            if (val > 100000U) return -1;
        }
        else if (ch == ',')
        {
            if (!have || count >= n) return -1;
            out[count++] = val;
            val = 0;
            have = 0;
        }
        else
        {
            return -1;
        }
    }
    if (have)
    {
        if (count >= n) return -1;
        out[count++] = val;
    }
    return count;
}


static void handle_x(uint8_t *buf, uint8_t len)
{
    if (len < 2)
    {
        reply(0);
        return;
    }

    char out[96];
    uint32_t v[4];

    switch (buf[1])
    {
        case 'I':
            snprintf_(out, sizeof(out), "xIvdlink,%s,%lu\r", FW_VERSION, (unsigned long)CAN_KERNEL_CLOCK);
            cdc_transmit((uint8_t *)out, strlen(out));
            return;

        case 'S':
            snprintf_(out, sizeof(out), "xS%u,%u,%08lX,%08lX,%08lX,%lu,%ld,%u,%u\r",
                      can_is_on_bus(), can_is_silent(),
                      (unsigned long)can_psr(), (unsigned long)can_ecr(),
                      (unsigned long)error_reg(), (unsigned long)can_rx_dropped(),
                      (long)clock_ppm(), clock_locked(), clock_trim());
            cdc_transmit((uint8_t *)out, strlen(out));
            return;

        case 'N':
        case 'D':
        {
            if (parse_numbers(buf + 2, len - 2, v, 4) != 4)
            {
                reply(0);
                return;
            }
            can_timing_t t = { (uint16_t)v[0], (uint16_t)v[1], (uint16_t)v[2], (uint16_t)v[3] };
            int r = (buf[1] == 'N') ? can_set_nominal_timing(&t) : can_set_data_timing(&t);
            reply(r == 0);
            return;
        }

        case 'O':
            if (len != 3 || can_is_on_bus()) { reply(0); return; }
            can_set_non_iso(buf[2] == '1');
            reply(1);
            return;

        case 'T':
            if (len != 3) { reply(0); return; }
            can_set_tx_echo(buf[2] == '1');
            reply(1);
            return;

        default:
            reply(0);
            return;
    }
}


// Parse an incoming slcan command from the USB CDC port
int32_t slcan_parse_str(uint8_t *buf, uint8_t len)
{
    if (len == 0)
        return -1;

    // vdlink extensions use decimal arguments: handle before the hex conversion
    if (buf[0] == 'x')
    {
        handle_x(buf, len);
        return 0;
    }

    FDCAN_TxHeaderTypeDef frame_header =
    {
        .TxFrameType = FDCAN_DATA_FRAME,
        .FDFormat = FDCAN_CLASSIC_CAN,
        .IdType = FDCAN_STANDARD_ID,
        .BitRateSwitch = FDCAN_BRS_OFF,
        .ErrorStateIndicator = FDCAN_ESI_ACTIVE,
        .TxEventFifoControl = FDCAN_NO_TX_EVENTS,
        .MessageMarker = 0,
    };
    uint8_t frame_data[64] = {0};

    // Convert from ASCII (2nd character to end), rejecting non-hex characters
    for (uint8_t i = 1; i < len; i++)
    {
        uint8_t ch = buf[i];
        if (ch >= '0' && ch <= '9')      buf[i] = ch - '0';
        else if (ch >= 'a' && ch <= 'f') buf[i] = ch - 'a' + 10;
        else if (ch >= 'A' && ch <= 'F') buf[i] = ch - 'A' + 10;
        else return -1;
    }

    switch (buf[0])
    {
        case 'O':
            can_enable();
            return 0;

        case 'C':
            can_disable();
            return 0;

        case 'S':
            if (len < 2 || buf[1] >= CAN_BITRATE_INVALID)
                return -1;
            can_set_bitrate(buf[1]);
            return 0;

        case 'Y':
            if (len < 2) return -1;
            if (buf[1] == 2)      can_set_data_bitrate(CAN_DATA_BITRATE_2M);
            else if (buf[1] == 5) can_set_data_bitrate(CAN_DATA_BITRATE_5M);
            else return -1;
            return 0;

        case 'M':
            can_set_silent(len >= 2 && buf[1] == 1);
            return 0;

        case 'A':
            can_set_autoretransmit(!(len >= 2 && buf[1] == 0));
            return 0;

        case 'Z':
            if (len < 2 || buf[1] > 2) return -1;
            ts_mode = buf[1];
            return 0;

        case 'V':
            cdc_transmit((uint8_t*)fw_id, strlen(fw_id));
            return 0;

        case 'E':
        {
            char errstr[64] = {0};
            snprintf_(errstr, 64, "CANable Error Register: %X\r", (unsigned int)error_reg());
            cdc_transmit((uint8_t*)errstr, strlen(errstr));
            return 0;
        }

        case 'T':
            frame_header.IdType = FDCAN_EXTENDED_ID;
            break;
        case 't':
            break;
        case 'r':
            frame_header.TxFrameType = FDCAN_REMOTE_FRAME;
            break;
        case 'R':
            frame_header.IdType = FDCAN_EXTENDED_ID;
            frame_header.TxFrameType = FDCAN_REMOTE_FRAME;
            break;
        case 'd':
            frame_header.FDFormat = FDCAN_FD_CAN;
            break;
        case 'D':
            frame_header.FDFormat = FDCAN_FD_CAN;
            frame_header.IdType = FDCAN_EXTENDED_ID;
            break;
        case 'b':
            frame_header.FDFormat = FDCAN_FD_CAN;
            frame_header.BitRateSwitch = FDCAN_BRS_ON;
            break;
        case 'B':
            frame_header.FDFormat = FDCAN_FD_CAN;
            frame_header.BitRateSwitch = FDCAN_BRS_ON;
            frame_header.IdType = FDCAN_EXTENDED_ID;
            break;

        default:
            return -1;
    }

    uint8_t id_len = (frame_header.IdType == FDCAN_EXTENDED_ID) ? SLCAN_EXT_ID_LEN : SLCAN_STD_ID_LEN;
    if (len < 1 + id_len + 1)
        return -1;

    uint8_t parse_loc = 1;
    frame_header.Identifier = 0;
    while (parse_loc <= id_len)
    {
        frame_header.Identifier *= 16;
        frame_header.Identifier += buf[parse_loc++];
    }
    if (frame_header.IdType == FDCAN_STANDARD_ID && frame_header.Identifier > 0x7FF)
        return -1;
    if (frame_header.Identifier > 0x1FFFFFFF)
        return -1;

    uint8_t dlc_code_raw = buf[parse_loc++];
    if (frame_header.FDFormat == FDCAN_CLASSIC_CAN && dlc_code_raw > 0x8)
        return -1;

    frame_header.DataLength = __std_dlc_code_to_hal_dlc_code(dlc_code_raw);
    int8_t bytes_in_msg = hal_dlc_code_to_bytes(frame_header.DataLength);
    if (bytes_in_msg < 0)
        return -1;
    if (frame_header.TxFrameType == FDCAN_REMOTE_FRAME)
        bytes_in_msg = 0;

    if (len < parse_loc + 2 * bytes_in_msg)
        return -1;

    for (uint8_t i = 0; i < bytes_in_msg; i++)
    {
        frame_data[i] = (buf[parse_loc] << 4) + buf[parse_loc+1];
        parse_loc += 2;
    }

    can_tx(&frame_header, frame_data);
    return 0;
}


int8_t hal_dlc_code_to_bytes(uint32_t hal_dlc_code)
{
    static const int8_t lut[16] = { 0, 1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 32, 48, 64 };
    uint32_t code = hal_dlc_code >> 16;
    if (code > 15 || (hal_dlc_code & 0xFFFF))
        return -1;
    return lut[code];
}


static uint32_t __std_dlc_code_to_hal_dlc_code(uint8_t dlc_code)
{
    return (uint32_t)dlc_code << 16;
}
