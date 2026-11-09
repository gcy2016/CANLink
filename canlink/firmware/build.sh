#!/bin/sh
# Build the vdlink firmware.
# Fetches the upstream CANable 2.0 firmware (for the ST HAL drivers and USB
# library) at a fixed commit into .upstream/, then builds with arm-none-eabi-gcc.
set -e
cd "$(dirname "$0")"
REV=b158aa7ab106bc018715cd4d5f02f544f9de1830
if [ ! -d .upstream/Drivers ]; then
    rm -rf .upstream
    git clone -q https://github.com/normaldotcom/canable2-fw .upstream
    git -C .upstream checkout -q "$REV"
fi
make -j"$(nproc 2>/dev/null || echo 2)" "$@"
