# Echo

Echo combines the browser voice interface with the Pico animatronic head.

## Run the app

```sh
cd ~/Documents/Echo
npm install
npm start
```

Open http://localhost:3000 in a browser that supports Web Serial. Click the robot button and select the Pico at 115200 baud. During Echo speech, the browser sends jaw angles to the Pico; when speech ends, the firmware returns to automatic mode.

## Build firmware

```sh
cd ~/Documents/Echo
npm run build:firmware
```

Upload with PlatformIO from `firmware/` when the Pico is connected.
