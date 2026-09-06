#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_PWMServoDriver.h>
#include <pico/bootrom.h>
#include <LittleFS.h>
#include <AudioFileSourceLittleFS.h>
#include <AudioGeneratorMP3.h>
#include <AudioOutputI2S.h>
#include <math.h>

#include "JawAnimator.h"


// ============================================================
// PCA9685
// ============================================================

Adafruit_PWMServoDriver pwm = Adafruit_PWMServoDriver(0x40);

#define SERVO_FREQ 50
#define SERVOMIN   150
#define SERVOMAX   600


// ============================================================
// PINS
// ============================================================

#define STATUS_LED 25

#define LED_RED    26
#define LED_BLUE   27

#define MAINTENANCE_SWITCH 28

#define STEPPER_EN   21
#define STEPPER_STEP 20
#define STEPPER_DIR  19

#define STEPPER_STEPS_PER_REV 200
#define STEPPER_GEAR_RATIO    5
#define STEPPER_MICROSTEPPING 16
#define STEPPER_STEPS_30DEG   ((int)(STEPPER_STEPS_PER_REV * STEPPER_MICROSTEPPING * STEPPER_GEAR_RATIO * 30.0f / 360.0f))
#define STEPPER_DIR_LEFT      1


// ============================================================
// LED SETTINGS
// ============================================================

#define LED_FADE_MS 750


// ============================================================
// FACE SERVOS
// ============================================================

#define CH_TL 2
#define CH_TR 3
#define CH_BL 4
#define CH_BR 5

#define ENABLE_FACE_SERVOS 0


// ============================================================
// JAW
// ============================================================

#define CH_JAW 6

#define JAW_CLOSED_ANGLE 76.0
#define JAW_OPEN_ANGLE   106.0


// ============================================================
// NECK
// ============================================================

#define CH_NL 8
#define CH_NR 9

#define NECK_DEFAULT_ANGLE  90.0
#define NECK_LOOKUP_L      -90.0
#define NECK_LOOKUP_R       90.0


// ============================================================
// I2S
// ============================================================

#define I2S_BCLK 16
#define I2S_LRC  17
#define I2S_DIN  18


// ============================================================
// AUDIO FILES
// ============================================================

#define AUDIO_FILE_PATH        "/audio.mp3"
#define ACTIVATED_AUDIO_PATH   "/Activated.mp3"
#define DEACTIVATED_AUDIO_PATH "/Deactivated.mp3"

#define AUDIO_START_DELAY_MS 3000
#define AUDIO_GAIN           2.5f
#define MAINTENANCE_GAIN     2.5f


// ============================================================
// SWITCH
// ============================================================

#define SWITCH_DEBOUNCE_MS 50


// ============================================================
// EMOTIONS
// ============================================================

struct Emotion {
  const char* name;
  float tl;
  float tr;
  float bl;
  float br;
};

Emotion EMOTIONS[] = {
  {"Neutral",  70.0, 90.0,  80.0, 80.0},
  {"Joy",      70.0, 90.0,  60.0, 100.0},
  {"Sadness",  85.0, 80.0,  75.0, 85.0},
  {"Surprise", 50.0, 115.0, 85.0, 75.0},
  {"Fear",     50.0, 115.0, 85.0, 75.0},
  {"Anger",    80.0, 80.0,  70.0, 90.0},
};

const int NUM_EMOTIONS =
    sizeof(EMOTIONS) / sizeof(EMOTIONS[0]);


float currentTL = 70.0;
float currentTR = 90.0;
float currentBL = 80.0;
float currentBR = 80.0;

bool stepperAtHome = true;


// ============================================================
// AUDIO OBJECTS
// ============================================================

AudioFileSourceLittleFS* audioFile = nullptr;

AudioGeneratorMP3* audioMp3 = nullptr;

// Normal speech audio uses EnvelopeTap so the jaw can analyze it.
JawAnim::EnvelopeTap* jawAudioOut = nullptr;

// Maintenance audio uses normal I2S.
// It is deliberately NOT connected to JawAnimator.
AudioOutputI2S* maintenanceAudioOut = nullptr;


// ============================================================
// JAW
// ============================================================

JawAnim::JawAnimator jawAnimator;

unsigned long lastJawUpdateMs = 0;

const unsigned long JAW_INTERVAL_MS =
    (unsigned long)(1000.0f / JawAnim::JAW_FPS);


// ============================================================
// GENERAL STATE
// ============================================================

unsigned long bootMillis = 0;

bool normalAudioStarted = false;

bool jawManualOverride = false;
float jawManualAngle = JAW_CLOSED_ANGLE;
unsigned long lastJawCommandMs = 0;


// ============================================================
// MAINTENANCE MODE
// ============================================================

bool maintenanceMode = false;
bool maintenanceEverActivated = false;


// ============================================================
// SWITCH DEBOUNCE
// ============================================================

bool lastRawSwitchState = HIGH;
bool stableSwitchState = HIGH;

unsigned long lastSwitchChangeMs = 0;


// ============================================================
// LED FADE
// ============================================================

float redBrightness = 255.0f;
float blueBrightness = 0.0f;

float redFadeStart = 255.0f;
float blueFadeStart = 0.0f;

float redFadeTarget = 255.0f;
float blueFadeTarget = 0.0f;

unsigned long ledFadeStartMs = 0;

bool ledFading = false;


// ============================================================
// SERVO FUNCTIONS
// ============================================================

uint16_t angleToTick(float angle) {

  if (angle < 0.0f)
    angle = 0.0f;

  if (angle > 180.0f)
    angle = 180.0f;

  return (uint16_t)(
      SERVOMIN +
      (angle / 180.0f) *
      (SERVOMAX - SERVOMIN)
  );
}


void writeChannel(int channel, float angle) {

  pwm.setPWM(
      channel,
      0,
      angleToTick(angle)
  );
}


float stepToward(float current, float target) {

  constexpr float STEP_DEGREES = 1.0f;

  if (fabs(target - current) <= STEP_DEGREES)
    return target;

  return current +
         (target > current
              ? STEP_DEGREES
              : -STEP_DEGREES);
}


// ============================================================
// STEPPER (non-blocking)
// ============================================================

#define STEPPER_STEP_PULSE_US 5
#define STEPPER_RAMP_US       800
#define STEPPER_CRUISE_US     300

bool     stepperMoving  = false;
int      stepperTarget  = 0;
int      stepperStepPos = 0;
int      stepperDirSign = 1;
int      stepperRampEnd = 0;
unsigned long stepperNextStepUs = 0;

void stepperEnable(bool enable) {
  digitalWrite(STEPPER_EN, enable ? LOW : HIGH);
}

void stepperStartMove(int steps, int dir) {
  digitalWrite(STEPPER_DIR, dir ? HIGH : LOW);
  delayMicroseconds(10);

  stepperTarget  = steps;
  stepperStepPos = 0;
  stepperDirSign = 1;
  stepperRampEnd = steps / 3;
  if (stepperRampEnd < 20) stepperRampEnd = 20;
  stepperMoving     = true;
  stepperNextStepUs = micros();

  Serial.print("Stepper: ");
  Serial.print(steps);
  Serial.println(" steps");
}

uint32_t stepperCalcDelay(int step) {
  int dStart = step;
  if (dStart > stepperRampEnd) dStart = stepperRampEnd;

  int dEnd = stepperTarget - 1 - step;
  if (dEnd > stepperRampEnd) dEnd = stepperRampEnd;

  int active = dStart;
  if (dEnd < active) active = dEnd;

  return (uint32_t)(
      STEPPER_CRUISE_US +
      (STEPPER_RAMP_US - STEPPER_CRUISE_US) *
      (stepperRampEnd - active) / stepperRampEnd
  );
}

void stepperUpdate() {
  if (!stepperMoving) return;

  unsigned long now = micros();
  if (now < stepperNextStepUs) return;

  if (stepperStepPos >= stepperTarget) {
    stepperMoving = false;
    Serial.println("Stepper: done");
    return;
  }

  uint32_t delayUs = stepperCalcDelay(stepperStepPos);

  digitalWrite(STEPPER_STEP, HIGH);
  delayMicroseconds(STEPPER_STEP_PULSE_US);
  digitalWrite(STEPPER_STEP, LOW);

  stepperStepPos++;
  stepperNextStepUs = now + delayUs;
}

void stepperMove30Left() {
  if (stepperMoving) return;
  if (!stepperAtHome) return;
  Serial.println("Stepper: 30° left");
  writeChannel(CH_NL, NECK_LOOKUP_L);
  writeChannel(CH_NR, NECK_LOOKUP_R);
  stepperStartMove(STEPPER_STEPS_30DEG, STEPPER_DIR_LEFT);
  stepperAtHome = false;
}

void stepperReturnHome() {
  if (stepperMoving) return;
  if (stepperAtHome) return;
  Serial.println("Stepper: return home");
  writeChannel(CH_NL, NECK_DEFAULT_ANGLE);
  writeChannel(CH_NR, NECK_DEFAULT_ANGLE);
  stepperStartMove(STEPPER_STEPS_30DEG, !STEPPER_DIR_LEFT);
  stepperAtHome = true;
}


// ============================================================
// EMOTION MOVEMENT
// ============================================================

void moveToEmotion(const Emotion& emotion) {

  Serial.print("-> ");
  Serial.println(emotion.name);

  bool done = false;

  while (!done) {

    currentTL =
        stepToward(currentTL, emotion.tl);

    currentTR =
        stepToward(currentTR, emotion.tr);

    currentBL =
        stepToward(currentBL, emotion.bl);

    currentBR =
        stepToward(currentBR, emotion.br);


    writeChannel(
        CH_TL,
        currentTL
    );

    writeChannel(
        CH_TR,
        currentTR
    );

    writeChannel(
        CH_BL,
        currentBL
    );

    writeChannel(
        CH_BR,
        currentBR
    );


    done =
        currentTL == emotion.tl &&
        currentTR == emotion.tr &&
        currentBL == emotion.bl &&
        currentBR == emotion.br;


    delay(15);
  }
}


// ============================================================
// SERIAL CONTROL
// ============================================================

void checkSerialCommand() {

  if (Serial.available() <= 0)
    return;


  String input =
      Serial.readStringUntil('\n');

  input.trim();


  if (input.startsWith("JAW ") || input.startsWith("jaw ")) {
    String value = input.substring(4);
    value.trim();

    if (value.equalsIgnoreCase("AUTO")) {
      jawManualOverride = false;
      Serial.println("JAW AUTO");
      return;
    }

    float angle = value.toFloat();
    if (angle >= JAW_CLOSED_ANGLE && angle <= JAW_OPEN_ANGLE) {
      jawManualAngle = angle;
      jawManualOverride = true;
      lastJawCommandMs = millis();
      writeChannel(CH_JAW, jawManualAngle);
      Serial.print("JAW ");
      Serial.println(jawManualAngle, 1);
    } else {
      Serial.println("ERR JAW range 76-106");
    }
    return;
  }

  if (
      input.equalsIgnoreCase("reset") ||
      input.equalsIgnoreCase("bootloader")
  ) {

    Serial.println(
        "Rebooting into BOOTSEL mode..."
    );

    delay(100);

    reset_usb_boot(0, 0);
  }

  if (input.equalsIgnoreCase("status")) {
    Serial.print("STATUS jaw=");
    Serial.print(jawManualOverride ? jawManualAngle : -1.0f, 1);
    Serial.print(" mode=");
    Serial.println(jawManualOverride ? "manual" : "auto");
  }
}


// ============================================================
// PCA9685 INITIALISATION
// ============================================================

void scanAndInitPCA9685() {

  Serial.println("=== Boot/status report ===");

  Serial.println("Scanning I2C bus...");

  byte found = 0;


  for (
      byte addr = 1;
      addr < 127;
      addr++
  ) {

    Wire.beginTransmission(addr);

    if (Wire.endTransmission() == 0) {

      Serial.print(
          "  Found device at 0x"
      );

      Serial.println(
          addr,
          HEX
      );

      found++;
    }
  }


  if (found == 0) {

    Serial.println(
        "  No I2C devices found. Check SDA/SCL wiring."
    );
  }


  if (pwm.begin()) {

    Serial.println(
        "PCA9685 initialised OK."
    );

    pwm.setPWMFreq(
        SERVO_FREQ
    );

  } else {

    Serial.println(
        "PCA9685 init FAILED (no ack at 0x40). Check wiring/address."
    );
  }


  Serial.println(
      "==========================="
  );
}


// ============================================================
// CLEAN UP AUDIO
// ============================================================

void stopAudio() {

  if (audioMp3) {

    if (audioMp3->isRunning())
      audioMp3->stop();

    delete audioMp3;
    audioMp3 = nullptr;
  }


  if (audioFile) {

    delete audioFile;
    audioFile = nullptr;
  }


  if (jawAudioOut) {

    jawAudioOut->resetRms();

    delete jawAudioOut;
    jawAudioOut = nullptr;
  }


  if (maintenanceAudioOut) {

    delete maintenanceAudioOut;
    maintenanceAudioOut = nullptr;
  }


  jawAnimator.reset();
}


// ============================================================
// START NORMAL SPEECH AUDIO
// ============================================================

bool startNormalAudio() {

  if (!LittleFS.exists(AUDIO_FILE_PATH)) {

    Serial.print(
        "Audio file not found: "
    );

    Serial.println(
        AUDIO_FILE_PATH
    );

    return false;
  }


  stopAudio();


  audioFile =
      new AudioFileSourceLittleFS(
          AUDIO_FILE_PATH
      );


  jawAudioOut =
      new JawAnim::EnvelopeTap();


  jawAudioOut->SetPinout(
      I2S_BCLK,
      I2S_LRC,
      I2S_DIN
  );


  jawAudioOut->SetGain(
      AUDIO_GAIN
  );


  audioMp3 =
      new AudioGeneratorMP3();


  jawAnimator.begin(
      jawAudioOut
  );


  if (
      audioMp3->begin(
          audioFile,
          jawAudioOut
      )
  ) {

    Serial.println(
        "Playing audio.mp3"
    );

    lastJawUpdateMs =
        millis();

    return true;
  }


  Serial.println(
      "Failed to start audio.mp3"
  );


  stopAudio();

  return false;
}


// ============================================================
// START MAINTENANCE AUDIO
// ============================================================
//
// IMPORTANT:
// This uses AudioOutputI2S directly.
//
// Therefore Activated.mp3 and Deactivated.mp3 cannot drive
// the jaw animation.
// ============================================================

bool startMaintenanceAudio(
    const char* path,
    const char* name
) {

  if (!LittleFS.exists(path)) {

    Serial.print(
        "Maintenance audio not found: "
    );

    Serial.println(path);

    return false;
  }


  stopAudio();


  audioFile =
      new AudioFileSourceLittleFS(
          path
      );


  maintenanceAudioOut =
      new AudioOutputI2S();


  maintenanceAudioOut->SetPinout(
      I2S_BCLK,
      I2S_LRC,
      I2S_DIN
  );


  maintenanceAudioOut->SetGain(
      MAINTENANCE_GAIN
  );


  audioMp3 =
      new AudioGeneratorMP3();


  if (
      audioMp3->begin(
          audioFile,
          maintenanceAudioOut
      )
  ) {

    Serial.print(
        "Playing "
    );

    Serial.println(name);

    return true;
  }


  Serial.print(
      "Failed to start "
  );

  Serial.println(name);


  stopAudio();

  return false;
}


// ============================================================
// LED OUTPUT
// ============================================================

void updateLEDOutput() {

  int red =
      (int)roundf(
          constrain(
              redBrightness,
              0.0f,
              255.0f
          )
      );


  int blue =
      (int)roundf(
          constrain(
              blueBrightness,
              0.0f,
              255.0f
          )
      );


  analogWrite(
      LED_RED,
      red
  );

  analogWrite(
      LED_BLUE,
      blue
  );
}


// ============================================================
// SMOOTH LED FADE
// ============================================================

void startLEDModeFade(
    bool maintenance
) {

  redFadeStart =
      redBrightness;

  blueFadeStart =
      blueBrightness;


  if (maintenance) {

    redFadeTarget = 0.0f;
    blueFadeTarget = 255.0f;

  } else {

    redFadeTarget = 255.0f;
    blueFadeTarget = 0.0f;
  }


  ledFadeStartMs =
      millis();

  ledFading = true;
}


void updateLEDs() {

  if (!ledFading)
    return;


  unsigned long elapsed =
      millis() - ledFadeStartMs;


  float progress =
      (float)elapsed /
      (float)LED_FADE_MS;


  if (progress >= 1.0f) {

    progress = 1.0f;

    ledFading = false;
  }


  // Smoothstep.
  float smooth =
      progress * progress *
      (3.0f - 2.0f * progress);


  redBrightness =
      redFadeStart +
      (
          redFadeTarget -
          redFadeStart
      ) * smooth;


  blueBrightness =
      blueFadeStart +
      (
          blueFadeTarget -
          blueFadeStart
      ) * smooth;


  updateLEDOutput();
}


// ============================================================
// ENTER / EXIT MAINTENANCE MODE
// ============================================================

void setMaintenanceMode(
    bool enabled
) {

  if (enabled == maintenanceMode)
    return;


  maintenanceMode =
      enabled;


  Serial.print(
      "Maintenance mode: "
  );


  if (maintenanceMode) {

    Serial.println("ON");


    // No jaw movement during maintenance audio.
    jawAnimator.reset();


    // Stop normal speech immediately.
    stopAudio();


    // Revert stepper to home.
    stepperReturnHome();


    // Fade red -> blue.
    startLEDModeFade(true);


    // Play activation sound.
    startMaintenanceAudio(
        ACTIVATED_AUDIO_PATH,
        "Activated.mp3"
    );

  } else {

    Serial.println("OFF");


    // Stop activation audio.
    stopAudio();


    // Fade blue -> red.
    startLEDModeFade(false);


    // Move stepper 30° left.
    stepperMove30Left();


    // Play deactivation sound (skip first cycle).
    if (!maintenanceEverActivated) {
      maintenanceEverActivated = true;
    } else {
      startMaintenanceAudio(
          DEACTIVATED_AUDIO_PATH,
          "Deactivated.mp3"
      );
    }
  }
}


// ============================================================
// SWITCH
// ============================================================

void updateMaintenanceSwitch() {

  bool rawState =
      digitalRead(
          MAINTENANCE_SWITCH
      );


  if (rawState != lastRawSwitchState) {

    lastRawSwitchState =
        rawState;

    lastSwitchChangeMs =
        millis();

    return;
  }


  if (
      millis() -
      lastSwitchChangeMs <
      SWITCH_DEBOUNCE_MS
  ) {

    return;
  }


  if (
      stableSwitchState !=
      rawState
  ) {

    stableSwitchState =
        rawState;


    // LOW = switch connected to GND.
    bool enabled =
        (stableSwitchState == LOW);


    setMaintenanceMode(
        enabled
    );
  }
}


// ============================================================
// INITIALISE MAINTENANCE STATE
// ============================================================

void initialiseMaintenanceMode() {

  bool state =
      digitalRead(
          MAINTENANCE_SWITCH
      );


  maintenanceMode =
      (state == LOW);


  lastRawSwitchState =
      state;

  stableSwitchState =
      state;

  lastSwitchChangeMs =
      millis();


  if (maintenanceMode) {

    redBrightness = 0.0f;
    blueBrightness = 255.0f;

  } else {

    redBrightness = 255.0f;
    blueBrightness = 0.0f;
  }


  redFadeStart =
      redBrightness;

  blueFadeStart =
      blueBrightness;

  redFadeTarget =
      redBrightness;

  blueFadeTarget =
      blueBrightness;


  ledFading = false;


  updateLEDOutput();


  Serial.print(
      "Initial maintenance mode: "
  );

  Serial.println(
      maintenanceMode
          ? "ON"
          : "OFF"
  );
}


// ============================================================
// SETUP
// ============================================================

void setup() {

  Serial.begin(115200);

  delay(2000);


  // ----------------------------------------------------------
  // Status LED
  // ----------------------------------------------------------

  pinMode(
      STATUS_LED,
      OUTPUT
  );


  for (int i = 0; i < 3; i++) {

    digitalWrite(
        STATUS_LED,
        HIGH
    );

    delay(150);

    digitalWrite(
        STATUS_LED,
        LOW
    );

    delay(150);
  }


  // ----------------------------------------------------------
  // LEDs
  // ----------------------------------------------------------

  pinMode(
      LED_RED,
      OUTPUT
  );

  pinMode(
      LED_BLUE,
      OUTPUT
  );


  // ----------------------------------------------------------
  // Maintenance switch
  // ----------------------------------------------------------

  pinMode(
      MAINTENANCE_SWITCH,
      INPUT_PULLUP
  );


  pinMode(STEPPER_EN, OUTPUT);
  pinMode(STEPPER_STEP, OUTPUT);
  pinMode(STEPPER_DIR, OUTPUT);
  digitalWrite(STEPPER_EN, LOW);
  digitalWrite(STEPPER_STEP, LOW);
  digitalWrite(STEPPER_DIR, LOW);


  initialiseMaintenanceMode();


  // ----------------------------------------------------------
  // LittleFS
  // ----------------------------------------------------------

  if (!LittleFS.begin()) {
    Serial.println("LittleFS mount failed!");
  } else {
    Serial.println("LittleFS mounted OK.");
  }


  // ----------------------------------------------------------
  // I2C
  // ----------------------------------------------------------

  Wire.setSDA(0);
  Wire.setSCL(1);
  Wire.setClock(100000);
  Wire.begin();


  scanAndInitPCA9685();


  // ----------------------------------------------------------
  // Face servos
  // ----------------------------------------------------------

#if ENABLE_FACE_SERVOS

  writeChannel(
      CH_TL,
      currentTL
  );

  writeChannel(
      CH_TR,
      currentTR
  );

  writeChannel(
      CH_BL,
      currentBL
  );

  writeChannel(
      CH_BR,
      currentBR
  );

#endif


  // ----------------------------------------------------------
  // Jaw starts closed
  // ----------------------------------------------------------

  writeChannel(
      CH_JAW,
      JAW_CLOSED_ANGLE
  );


  // ----------------------------------------------------------
  // Neck servos default position
  // ----------------------------------------------------------

  writeChannel(CH_NL, NECK_DEFAULT_ANGLE);
  writeChannel(CH_NR, NECK_DEFAULT_ANGLE);


  // ----------------------------------------------------------
  // Stepper: move 30° left on startup (non-blocking)
  // ----------------------------------------------------------

  if (!maintenanceMode) {
    stepperMove30Left();
  }


  Serial.println(
      "Audio will play 3 seconds after startup."
  );

  Serial.println(
      "Maintenance switch: GPIO 28"
  );

  Serial.println(
      "Red LED: GPIO 26"
  );

  Serial.println(
      "Blue LED: GPIO 27"
  );

  Serial.println(
      "Send 'reset' or 'bootloader' at any time to enter BOOTSEL mode."
  );


  bootMillis =
      millis();

  lastJawUpdateMs =
      millis();
}


// ============================================================
// LOOP
// ============================================================

void loop() {

  // ----------------------------------------------------------
  // Serial
  // ----------------------------------------------------------

  checkSerialCommand();

  if (
      jawManualOverride &&
      millis() - lastJawCommandMs > 1000
  ) {
    jawManualOverride = false;
    Serial.println("JAW AUTO timeout");
  }


  // ----------------------------------------------------------
  // Maintenance switch
  // ----------------------------------------------------------

  updateMaintenanceSwitch();


  // ----------------------------------------------------------
  // LED fade
  // ----------------------------------------------------------

  updateLEDs();


  // ----------------------------------------------------------
  // Stepper (non-blocking)
  // ----------------------------------------------------------

  stepperUpdate();


  // ----------------------------------------------------------
  // Normal startup audio
  // ----------------------------------------------------------

  if (
      !normalAudioStarted &&
      !jawManualOverride &&
      !maintenanceMode &&
      millis() - bootMillis >=
          AUDIO_START_DELAY_MS
  ) {

    normalAudioStarted =
        true;

    startNormalAudio();
  }


  // ----------------------------------------------------------
  // Audio playback
  // ----------------------------------------------------------

  if (
      audioMp3 &&
      audioMp3->isRunning()
  ) {

    if (!audioMp3->loop()) {

      audioMp3->stop();


      if (jawAudioOut)
        jawAudioOut->resetRms();


      jawAnimator.reset();


      Serial.println(
          "Playback finished."
      );
    }
  }


  // ----------------------------------------------------------
  // JAW
  // ----------------------------------------------------------
  //
  // The jaw is ONLY animated when:
  //
  //   1. Maintenance mode is OFF
  //   2. Normal speech audio is being used
  //
  // Activated.mp3 and Deactivated.mp3 never reach this code.
  // ----------------------------------------------------------

  if (
      !maintenanceMode &&
      jawAudioOut &&
      audioMp3 &&
      audioMp3->isRunning()
  ) {

    unsigned long now =
        millis();


    if (
        now - lastJawUpdateMs >=
        JAW_INTERVAL_MS
    ) {

      float dt =
          (now - lastJawUpdateMs)
          / 1000.0f;


      lastJawUpdateMs =
          now;


      float openness =
          jawAnimator.update(dt);


      float angle =
          JAW_CLOSED_ANGLE +
          (
              openness /
              JawAnim::JAW_MAX_OPEN
          ) *
          (
              JAW_OPEN_ANGLE -
              JAW_CLOSED_ANGLE
          );


      writeChannel(
          CH_JAW,
          angle
      );
    }
  }
}