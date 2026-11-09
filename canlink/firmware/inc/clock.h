#ifndef _CLOCK_H
#define _CLOCK_H

#include <stdint.h>

// Free-running 32-bit microsecond counter (TIM2) and HSI16 calibration against USB SOF.
void clock_init(void);
uint32_t clock_us(void);
void clock_sof(void);          // call from the USB SOF interrupt
void clock_process(void);      // call from the main loop
int32_t clock_ppm(void);       // last measured clock error in ppm (+ = running fast), 0 if unknown
uint8_t clock_trim(void);      // current HSITRIM value
uint8_t clock_valid(void);     // 1 once at least one measurement exists
uint8_t clock_locked(void);    // 1 once HSI trimming has finished

#endif
