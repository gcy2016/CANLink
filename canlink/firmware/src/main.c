//
// vdlink firmware (based on CANable 2.0 slcan firmware)
//

#include "stm32g4xx.h"
#include "printf.h"
#include "usb_device.h"
#include "usbd_cdc_if.h"
#include "can.h"
#include "slcan.h"
#include "system.h"
#include "led.h"
#include "clock.h"


int main(void)
{
    system_init();
    clock_init();
    can_init();
    led_init();
    usb_init();

    led_blue_blink(2);

    can_rxframe_t frame;
    uint8_t msg_buf[SLCAN_MTU];

    while (1)
    {
        led_process();
        can_process();
        cdc_process();
        clock_process();

        // Forward frames received in the interrupt, as long as the USB queue has room
        while (cdc_tx_free() >= SLCAN_MTU && can_rx_pop(&frame))
        {
            int32_t msg_len = slcan_format_frame(msg_buf, &frame);
            if (msg_len > 0)
                cdc_transmit(msg_buf, (uint16_t)msg_len);
        }
    }
}
