#pragma once

#include <Arduino.h>
#include <AudioOutputI2S.h>
#include <math.h>

namespace JawAnim {

// ============================================================
// MAIN SETTINGS
// ============================================================

constexpr float JAW_FPS       = 50.0f;

// Jaw travel in normalized units.
constexpr float JAW_MIN_OPEN  = 0.008f;
constexpr float JAW_MAX_OPEN  = 0.72f;

// ------------------------------------------------------------
// Envelope response
// ------------------------------------------------------------

// Faster opening so the jaw does not lag behind speech.
constexpr float ATTACK_RATE   = 0.72f;

// Slower closing gives natural mouth movement.
constexpr float DECAY_RATE    = 0.18f;

// Small threshold below which speech is considered silence.
constexpr float SILENCE_LEVEL = 0.035f;

// ------------------------------------------------------------
// Speech classification
// ------------------------------------------------------------

// Amount of high-frequency energy that causes a sound to be
// treated as fricative/consonant-like.
//
// Higher value = more aggressive suppression of sounds like
// S, F, SH, T, K, CH.
constexpr float FRICATIVE_HF_THRESHOLD = 0.24f;

// Zero-crossing rate above this becomes increasingly
// consonant/fricative-like.
constexpr float FRICATIVE_ZCR_THRESHOLD = 0.25f;

// ------------------------------------------------------------
// Jaw shaping
// ------------------------------------------------------------

// Vowels should dominate jaw movement.
constexpr float VOWEL_WEIGHT = 1.00f;

// Voiced consonants still move the mouth somewhat.
constexpr float VOICED_CONSONANT_WEIGHT = 0.45f;

// Unvoiced fricatives barely open the jaw.
constexpr float FRICATIVE_WEIGHT = 0.10f;

// Very short sounds should not completely slam the jaw shut.
constexpr float MIN_SPEECH_SHAPE = 0.18f;

// ------------------------------------------------------------
// Dynamic normalization
// ------------------------------------------------------------

// Running loudness ceiling.
// It rises immediately and falls gradually.
constexpr float CEILING_DECAY = 0.992f;
constexpr float CEILING_FLOOR = 0.012f;

// Extra final gain.
constexpr float JAW_GAIN = 1.0f;

// ------------------------------------------------------------
// Physics
// ------------------------------------------------------------

constexpr float JAW_STIFFNESS = 1600.0f;
constexpr float JAW_DAMPING   = 68.0f;


// ============================================================
// JAW PHYSICS
// ============================================================

struct JawPhysics {

    float pos = 0.0f;
    float vel = 0.0f;

    float step(float target, float dt) {

        float acc =
            JAW_STIFFNESS * (target - pos)
            - JAW_DAMPING * vel;

        vel += acc * dt;
        pos += vel * dt;

        // Hard lower stop.
        if (pos < 0.0f) {
            pos = 0.0f;

            if (vel < 0.0f)
                vel = 0.0f;
        }

        // Hard upper stop.
        if (pos > JAW_MAX_OPEN) {
            pos = JAW_MAX_OPEN;

            if (vel > 0.0f)
                vel = 0.0f;
        }

        return pos;
    }

    void reset() {
        pos = 0.0f;
        vel = 0.0f;
    }
};


// ============================================================
// AUDIO FEATURE ANALYZER
// ============================================================
//
// This sits directly in the decoded PCM path.
//
// Instead of only calculating RMS, it also measures:
//
//   1. RMS loudness
//   2. zero-crossing activity
//   3. high-frequency energy
//   4. low-frequency/voiced energy
//
// This lets the jaw distinguish approximately between:
//
//   vowels       -> large mouth movement
//   voiced       -> medium movement
//   fricatives   -> small movement
//   silence      -> closed
//
// It is deliberately lightweight enough to run while audio
// is being streamed to the DAC.
// ============================================================

class EnvelopeTap : public AudioOutputI2S {

public:

    bool SetRate(int hz) override {

        _sampleRate = hz;

        // Analyze roughly every 10 ms.
        _blockSize = max(1, hz / 100);

        return AudioOutputI2S::SetRate(hz);
    }


    bool SetGain(float f) override {

        _gain = f;

        return AudioOutputI2S::SetGain(f);
    }


    bool ConsumeSample(int16_t sample[2]) override {

        // ----------------------------------------------------
        // Convert stereo -> mono
        // ----------------------------------------------------

        float s =
            ((float)sample[0] + (float)sample[1])
            * 0.5f / 32768.0f;

        s *= _gain;


        // ----------------------------------------------------
        // Basic RMS energy
        // ----------------------------------------------------

        _sumSquares += s * s;


        // ----------------------------------------------------
        // Zero crossing detection
        // ----------------------------------------------------

        bool currentPositive = (s >= 0.0f);

        if (currentPositive != _previousPositive)
            _zeroCrossings++;

        _previousPositive = currentPositive;


        // ----------------------------------------------------
        // High-frequency approximation
        // ----------------------------------------------------
        //
        // The first difference strongly responds to high
        // frequency components.
        //
        // This makes S / F / SH / CH etc. easy to distinguish
        // from vowel-heavy audio.
        // ----------------------------------------------------

        float difference = s - _previousSample;

        _hfEnergy += difference * difference;

        _previousSample = s;


        // ----------------------------------------------------
        // Voiced / low-frequency energy
        // ----------------------------------------------------
        //
        // A simple one-pole low-pass filter.
        // Speech vowels contain considerably more low/mid
        // frequency energy than unvoiced fricatives.
        // ----------------------------------------------------

        constexpr float LOWPASS_ALPHA = 0.11f;

        _lowpass +=
            LOWPASS_ALPHA * (s - _lowpass);

        _voicedEnergy +=
            _lowpass * _lowpass;


        // ----------------------------------------------------
        // Finish analysis frame
        // ----------------------------------------------------

        _count++;

        if (_count >= _blockSize) {

            float count = (float)_count;


            // RMS
            float rms =
                sqrtf(_sumSquares / count);


            // Zero-crossing rate.
            //
            // Two crossings per period are not important here;
            // this is primarily used as a relative measure of
            // noisy/high-frequency speech.
            float zcr =
                (float)_zeroCrossings / count;


            // High frequency ratio.
            //
            // The difference energy is normalized against the
            // overall signal energy.
            //
            float signalEnergy =
                _sumSquares + 0.00000001f;

            float hfRatio =
                _hfEnergy / signalEnergy;

            // Keep the classifier within sane limits.
            if (hfRatio > 1.0f)
                hfRatio = 1.0f;


            // Voiced energy ratio.
            float voicedRatio =
                _voicedEnergy /
                (signalEnergy + 0.00000001f);

            if (voicedRatio > 1.0f)
                voicedRatio = 1.0f;


            // ------------------------------------------------
            // Save features
            // ------------------------------------------------

            _latestRms = rms;
            _latestZcr = zcr;
            _latestHFRatio = hfRatio;
            _latestVoicedRatio = voicedRatio;


            // ------------------------------------------------
            // Reset frame
            // ------------------------------------------------

            _sumSquares = 0.0f;
            _hfEnergy = 0.0f;
            _voicedEnergy = 0.0f;
            _zeroCrossings = 0;
            _count = 0;
        }


        // Audio itself is unchanged.
        return AudioOutputI2S::ConsumeSample(sample);
    }


    float latestRms() const {
        return _latestRms;
    }


    float latestZcr() const {
        return _latestZcr;
    }


    float latestHFRatio() const {
        return _latestHFRatio;
    }


    float latestVoicedRatio() const {
        return _latestVoicedRatio;
    }


    void resetRms() {

        _sumSquares = 0.0f;
        _hfEnergy = 0.0f;
        _voicedEnergy = 0.0f;

        _count = 0;
        _zeroCrossings = 0;

        _latestRms = 0.0f;
        _latestZcr = 0.0f;
        _latestHFRatio = 0.0f;
        _latestVoicedRatio = 0.0f;

        _previousSample = 0.0f;
        _lowpass = 0.0f;
        _previousPositive = false;
    }


private:

    int _sampleRate = 44100;
    int _blockSize = 441;

    float _gain = 1.0f;


    // Current frame.

    float _sumSquares = 0.0f;
    float _hfEnergy = 0.0f;
    float _voicedEnergy = 0.0f;

    int _zeroCrossings = 0;
    int _count = 0;


    // Previous-sample analysis.

    float _previousSample = 0.0f;
    float _lowpass = 0.0f;
    bool _previousPositive = false;


    // Most recent completed frame.

    float _latestRms = 0.0f;
    float _latestZcr = 0.0f;
    float _latestHFRatio = 0.0f;
    float _latestVoicedRatio = 0.0f;
};


// ============================================================
// JAW ANIMATOR
// ============================================================

class JawAnimator {

public:

    void begin(EnvelopeTap* tap) {

        _tap = tap;

        _physics.reset();

        _envelope = 0.0f;
        _ceiling = CEILING_FLOOR;

        _speechShape = 0.0f;

        _lastTarget = 0.0f;
    }


    // Call this continuously from the main loop.
    //
    // dt = real elapsed time since previous call.
    //
    // Returns normalized jaw opening:
    //
    //   0.0 -> closed
    //   0.72 -> maximum
    //
    float update(float dt) {

        if (!_tap)
            return 0.0f;


        // ====================================================
        // GET AUDIO FEATURES
        // ====================================================

        float rms =
            _tap->latestRms();

        float zcr =
            _tap->latestZcr();

        float hf =
            _tap->latestHFRatio();

        float voiced =
            _tap->latestVoicedRatio();


        // ====================================================
        // DYNAMIC LOUDNESS NORMALIZATION
        // ====================================================

        if (rms > _ceiling) {

            // Immediately follow a new loud peak.
            _ceiling = rms;

        } else {

            // Slowly forget old peaks.
            _ceiling *= CEILING_DECAY;

            if (_ceiling < CEILING_FLOOR)
                _ceiling = CEILING_FLOOR;
        }


        float normalized =
            rms / _ceiling;


        if (normalized > 1.0f)
            normalized = 1.0f;

        if (normalized < 0.0f)
            normalized = 0.0f;


        // ====================================================
        // SMOOTH LOUDNESS
        // ====================================================

        float envelopeRate;

        if (normalized > _envelope)
            envelopeRate = ATTACK_RATE;
        else
            envelopeRate = DECAY_RATE;


        _envelope +=
            (normalized - _envelope)
            * envelopeRate;


        if (_envelope < 0.0f)
            _envelope = 0.0f;


        // ====================================================
        // SILENCE DETECTION
        // ====================================================

        if (_envelope < SILENCE_LEVEL) {

            float target = 0.0f;

            return applyPhysics(target, dt);
        }


        // ====================================================
        // FRICATIVE DETECTION
        // ====================================================
        //
        // High-frequency energy and high ZCR indicate things
        // like:
        //
        //   S
        //   F
        //   SH
        //   CH
        //   TH
        //
        // These should not open the jaw like a vowel.
        // ====================================================

        float hfAmount = 0.0f;

        if (hf > FRICATIVE_HF_THRESHOLD) {

            hfAmount =
                (hf - FRICATIVE_HF_THRESHOLD)
                /
                (1.0f - FRICATIVE_HF_THRESHOLD);

        }

        if (hfAmount > 1.0f)
            hfAmount = 1.0f;


        float zcrAmount = 0.0f;

        if (zcr > FRICATIVE_ZCR_THRESHOLD) {

            zcrAmount =
                (zcr - FRICATIVE_ZCR_THRESHOLD)
                /
                (0.70f - FRICATIVE_ZCR_THRESHOLD);

        }

        if (zcrAmount > 1.0f)
            zcrAmount = 1.0f;


        // Combine the two indicators.
        float fricative =
            hfAmount * 0.72f
            +
            zcrAmount * 0.28f;


        if (fricative > 1.0f)
            fricative = 1.0f;


        // ====================================================
        // VOWEL / VOICED ESTIMATION
        // ====================================================
        //
        // Vowels should have:
        //
        //   - strong envelope
        //   - stronger low/mid energy
        //   - lower noisy high-frequency content
        //
        // This produces the major jaw openings.
        // ====================================================

        float vowelScore =
            voiced * (1.0f - fricative);


        if (vowelScore < 0.0f)
            vowelScore = 0.0f;

        if (vowelScore > 1.0f)
            vowelScore = 1.0f;


        // ====================================================
        // SPEECH SHAPE
        // ====================================================

        float shape;

        // Strong vowel.
        if (vowelScore > 0.55f) {

            shape =
                VOWEL_WEIGHT * vowelScore
                +
                VOICED_CONSONANT_WEIGHT
                * (1.0f - vowelScore)
                * 0.35f;

        }

        // Voiced speech.
        else if (voiced > 0.28f) {

            shape =
                VOICED_CONSONANT_WEIGHT
                *
                voiced;

        }

        // Mostly fricative/unvoiced.
        else {

            shape =
                FRICATIVE_WEIGHT
                *
                (1.0f - fricative);
        }


        // ====================================================
        // MIX IN A SMALL BASE MOVEMENT
        // ====================================================
        //
        // Completely eliminating jaw movement during voiced
        // consonants looks unnatural.
        // ====================================================

        shape =
            MIN_SPEECH_SHAPE
            +
            shape * (1.0f - MIN_SPEECH_SHAPE);


        // Fricatives are suppressed heavily.
        float fricativeSuppression =
            1.0f - fricative * 0.82f;


        if (fricativeSuppression < 0.12f)
            fricativeSuppression = 0.12f;


        shape *= fricativeSuppression;


        // ====================================================
        // FINAL TARGET
        // ====================================================

        float target =
            JAW_MIN_OPEN
            +
            _envelope
            * shape
            *
            (JAW_MAX_OPEN - JAW_MIN_OPEN);


        target *= JAW_GAIN;


        if (target < 0.0f)
            target = 0.0f;

        if (target > JAW_MAX_OPEN)
            target = JAW_MAX_OPEN;


        // Store for diagnostics/debugging.
        _speechShape = shape;
        _lastTarget = target;


        // ====================================================
        // PHYSICS
        // ====================================================

        return applyPhysics(target, dt);
    }


    void reset() {

        _physics.reset();

        _envelope = 0.0f;

        _ceiling = CEILING_FLOOR;

        _speechShape = 0.0f;

        _lastTarget = 0.0f;
    }


    // Useful for debugging from Serial.
    float envelope() const {
        return _envelope;
    }


    float speechShape() const {
        return _speechShape;
    }


    float target() const {
        return _lastTarget;
    }


private:

    EnvelopeTap* _tap = nullptr;

    JawPhysics _physics;

    float _envelope = 0.0f;

    float _ceiling = CEILING_FLOOR;

    float _speechShape = 0.0f;

    float _lastTarget = 0.0f;


    // ========================================================
    // PHYSICS SUB-STEPPING
    // ========================================================
    //
    // Your original physics uses a very stiff spring.
    // If dt suddenly becomes large, it can overshoot and shake.
    //
    // Sub-stepping prevents that.
    // ========================================================

    float applyPhysics(float target, float dt) {

        constexpr float MAX_SUBSTEP =
            1.0f / (JAW_FPS * 2.0f);

        float remaining = dt;

        float result = _physics.pos;


        // Avoid pathological frame delays.
        if (remaining > 0.15f)
            remaining = 0.15f;


        while (remaining > 0.0f) {

            float stepDt =
                remaining > MAX_SUBSTEP
                ? MAX_SUBSTEP
                : remaining;


            result =
                _physics.step(
                    target,
                    stepDt
                );


            remaining -= stepDt;
        }


        return result;
    }
};

} // namespace JawAnim