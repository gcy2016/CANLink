//
// clock: microsecond timestamps and HSI16 trimming against USB start-of-frame
//
// The board has no crystal: SYSCLK and the FDCAN clock come from the internal
// HSI16 oscillator (about +-1 %). USB full speed sends a start-of-frame packet
// every 1.000 ms (+-500 ppm, derived from the host's crystal), so counting our
// microsecond timer between SOFs measures our own clock error. While the CAN
// channel is closed, HSITRIM is stepped towards zero error; the measured error
// is also reported to the host so it can correct timestamps.
//

#include "stm32g4xx_hal.h"
#include "clock.h"
#include "can.h"

#define MEASURE_FRAMES 1000U     // one measurement per second
#define TRIM_THRESHOLD_PPM 1200  // roughly half a trim step
#define TRIM_MAX_STEPS 12

static volatile uint8_t have_start = 0;
static volatile uint16_t fn_start;
static volatile uint32_t t_start;
static volatile int32_t ppm_new;
static volatile uint8_t ppm_ready = 0;

static int32_t ppm_last = 0;
static uint8_t valid = 0;
static uint8_t trim_locked = 0;
static uint8_t trim_steps = 0;
static int32_t prev_ppm = 0;
static uint8_t prev_trim = 0;
static uint8_t have_prev = 0;


void clock_init(void)
{
    __HAL_RCC_TIM2_CLK_ENABLE();
    // TIM2 clock = PCLK1 = SYSCLK (APB1 prescaler 1)
    TIM2->PSC = (HAL_RCC_GetPCLK1Freq() / 1000000UL) - 1UL;
    TIM2->ARR = 0xFFFFFFFFUL;
    TIM2->CNT = 0;
    TIM2->EGR = TIM_EGR_UG;
    TIM2->CR1 = TIM_CR1_CEN;
}


uint32_t clock_us(void)
{
    return TIM2->CNT;
}


static uint8_t get_trim(void)
{
    return (uint8_t)((RCC->ICSCR & RCC_ICSCR_HSITRIM_Msk) >> RCC_ICSCR_HSITRIM_Pos);
}


static void set_trim(uint8_t trim)
{
    MODIFY_REG(RCC->ICSCR, RCC_ICSCR_HSITRIM_Msk, ((uint32_t)trim << RCC_ICSCR_HSITRIM_Pos) & RCC_ICSCR_HSITRIM_Msk);
    have_start = 0; // restart the measurement after a change
}


void clock_sof(void)
{
    uint32_t now = TIM2->CNT;
    uint16_t fn = USB->FNR & USB_FNR_FN;

    if (!have_start)
    {
        fn_start = fn;
        t_start = now;
        have_start = 1;
        return;
    }

    uint16_t frames = (uint16_t)((fn - fn_start) & USB_FNR_FN);
    if (frames >= MEASURE_FRAMES)
    {
        int32_t dt = (int32_t)(now - t_start);
        int32_t expected = (int32_t)frames * 1000;
        ppm_new = (int32_t)(((int64_t)(dt - expected) * 1000000LL) / expected);
        ppm_ready = 1;
        fn_start = fn;
        t_start = now;
    }
}


void clock_process(void)
{
    if (!ppm_ready)
        return;
    ppm_ready = 0;

    int32_t ppm = ppm_new;
    // Ignore obviously broken samples (missed SOFs, suspend)
    if (ppm > 50000 || ppm < -50000)
        return;
    ppm_last = ppm;
    valid = 1;

    // Only touch the oscillator while the CAN channel is closed
    if (trim_locked || can_is_on_bus())
        return;

    int32_t mag = ppm < 0 ? -ppm : ppm;
    uint8_t trim = get_trim();

    if (have_prev && ((ppm > 0) != (prev_ppm > 0)))
    {
        // Crossed zero: keep whichever setting was closer, then stop
        int32_t pmag = prev_ppm < 0 ? -prev_ppm : prev_ppm;
        if (pmag < mag)
            set_trim(prev_trim);
        trim_locked = 1;
        return;
    }

    if (mag < TRIM_THRESHOLD_PPM || trim_steps >= TRIM_MAX_STEPS)
    {
        trim_locked = 1;
        return;
    }

    prev_ppm = ppm;
    prev_trim = trim;
    have_prev = 1;
    trim_steps++;

    // Positive error = running fast = lower the trim value
    if (ppm > 0 && trim > 0)
        set_trim(trim - 1);
    else if (ppm < 0 && trim < 127)
        set_trim(trim + 1);
    else
        trim_locked = 1;
}


int32_t clock_ppm(void) { return valid ? ppm_last : 0; }
uint8_t clock_trim(void) { return get_trim(); }
uint8_t clock_valid(void) { return valid; }
uint8_t clock_locked(void) { return trim_locked; }
