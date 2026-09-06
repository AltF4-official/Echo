Import("env")
import serial
import serial.tools.list_ports
import time

def find_pico_port():
    for p in serial.tools.list_ports.comports():
        if p.device and "usbmodem" in p.device:
            return p.device
    return None

def before_upload(source, target, env):
    port = find_pico_port()
    if port is None:
        print("Bootloader trigger skipped: no matching serial port found (device may already be in BOOTSEL)")
        return
    try:
        with serial.Serial(port, 115200, timeout=1) as ser:
            ser.write(b"reset\n")
            time.sleep(2)  # allow reboot into BOOTSEL before picotool looks for the device
    except Exception as e:
        print(f"Bootloader trigger skipped: {e}")

env.AddPreAction("upload", before_upload)
env.AddPreAction("uploadfs", before_upload)