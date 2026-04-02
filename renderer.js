window.audioCtx = null;

// evitar doble init
if (!window.__AUDIO_STARTED__) {
  window.__AUDIO_STARTED__ = true;
  initAudio();
}

async function initAudio() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    window.audioCtx = audioContext;

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;

    source.connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    let corrBuffer = new Float32Array(analyser.fftSize);

    const noteStrings = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
    const noteStringsLat = ["Do", "Do#", "Re", "Re#", "Mi", "Fa", "Fa#", "Sol", "Sol#", "La", "La#", "Si"];

    let DEBUG_MODE = true;

    const tunings = {
      standard: [
        { name: "E2", lat: "Mi", freq: 82.41 },
        { name: "A2", lat: "La", freq: 110.0 },
        { name: "D3", lat: "Re", freq: 146.83 },
        { name: "G3", lat: "Sol", freq: 196.0 },
        { name: "B3", lat: "Si", freq: 246.94 },
        { name: "E4", lat: "Mi", freq: 329.63 },
      ]
    };

    let currentTuning = tunings.standard;

    let smoothPitch = 0;
    let smoothNeedle = 0;
    let smoothDetuneLED = 0;

    let lastNoteTime = 0; // 🔥 añadido

    let strobeOffset = 0;

    let lockedString = null;
    let stability = 0;

    let pitchHistory = [];

    function getLockedString(candidate) {
      if (!lockedString) {
        lockedString = candidate;
        stability = 1;
        return lockedString;
      }

      if (candidate.name === lockedString.name) {
        stability++;
      } else {
        stability--;
      }

      if (stability > 5) {
        lockedString = candidate;
        stability = 5;
      }

      if (stability < -3) {
        lockedString = candidate;
        stability = 0;
      }

      return lockedString;
    }

    let ledEnergy = 0;

    const ledsContainer = document.getElementById("leds");
    const LED_COUNT = 21;
    const leds = [];

    for (let i = 0; i < LED_COUNT; i++) {
      const led = document.createElement("div");
      led.classList.add("led");

      if (i < LED_COUNT / 2) led.classList.add("left");
      else if (i > LED_COUNT / 2) led.classList.add("right");
      else led.classList.add("center");

      ledsContainer.appendChild(led);
      leds.push(led);
    }

    // ==========================
    // CANVAS PITCH HISTORY
    // ==========================
    const canvas = document.getElementById("pitchCanvas");
    const ctx = canvas.getContext("2d");

    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;

    function drawPitchHistory() {
      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      ctx.strokeStyle = "#333";
      ctx.beginPath();
      ctx.moveTo(0, height / 2);
      ctx.lineTo(width, height / 2);
      ctx.stroke();

      ctx.beginPath();
      ctx.strokeStyle = "lime";
      ctx.lineWidth = 2;

      pitchHistory.forEach((val, i) => {
        const x = (i / pitchHistory.length) * width;
        const y = height / 2 - val * 2;

        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });

      ctx.stroke();
    }

    // DEBUG UI
    const debugToggle = document.getElementById("debugToggle");
    const debugOn = document.getElementById("debugOn");
    const debugOff = document.getElementById("debugOff");

    function updateDebugVisual() {
      debugOn.style.display = DEBUG_MODE ? "inline" : "none";
      debugOff.style.display = DEBUG_MODE ? "none" : "inline";
    }

    debugToggle.addEventListener("click", () => {
      DEBUG_MODE = !DEBUG_MODE;
      lockedString = null;
      stability = 0;
      updateDebugVisual();
    });

    updateDebugVisual();

    function centsOff(freq, target) {
      return 1200 * Math.log2(freq / target);
    }

    function noteFromPitch(frequency) {
      const noteNum = 12 * (Math.log2(frequency / 440));
      return Math.round(noteNum) + 69;
    }

    function frequencyFromNoteNumber(note) {
      return 440 * Math.pow(2, (note - 69) / 12);
    }

    function centsOffFromPitch(frequency, note) {
      return 1200 * Math.log2(frequency / frequencyFromNoteNumber(note));
    }

    function getClosestStringSmart(freq) {
      let closest = null;
      let minCents = Infinity;

      for (let s of currentTuning) {
        const cents = Math.abs(centsOff(freq, s.freq));
        if (cents < minCents) {
          minCents = cents;
          closest = s;
        }
      }

      return closest;
    }

    const strobeEl = document.getElementById("strobe");

    function updateStrobe(detune) {
      const speed = detune * 0.2;
      strobeOffset += speed;
      strobeEl.style.backgroundPositionX = `${strobeOffset}px`;
    }

    function autoCorrelate(buf, sampleRate) {
      let SIZE = buf.length;
      let rms = 0;

      for (let i = 0; i < SIZE; i++) {
        let val = buf[i];
        rms += val * val;
      }
      rms = Math.sqrt(rms / SIZE);

      if (rms < 0.01) return -1;

      let r1 = 0, r2 = SIZE - 1, threshold = 0.2;

      for (let i = 0; i < SIZE / 2; i++) {
        if (Math.abs(buf[i]) < threshold) {
          r1 = i;
          break;
        }
      }

      for (let i = 1; i < SIZE / 2; i++) {
        if (Math.abs(buf[SIZE - i]) < threshold) {
          r2 = SIZE - i;
          break;
        }
      }

      const newSize = r2 - r1;
      if (newSize <= 0) return -1;

      for (let i = 0; i < newSize; i++) {
        corrBuffer[i] = 0;
        for (let j = 0; j < newSize - i; j++) {
          corrBuffer[i] += buf[r1 + j] * buf[r1 + j + i];
        }
      }

      let d = 0;
      while (corrBuffer[d] > corrBuffer[d + 1]) d++;

      let maxval = -1, maxpos = -1;
      for (let i = d; i < newSize; i++) {
        if (corrBuffer[i] > maxval) {
          maxval = corrBuffer[i];
          maxpos = i;
        }
      }

      return sampleRate / maxpos;
    }

    function yin(buffer, sampleRate) {
      const SIZE = buffer.length;
      const half = Math.floor(SIZE / 2);

      const yinBuffer = new Float32Array(half);

      for (let tau = 0; tau < half; tau++) {
        let sum = 0;
        for (let i = 0; i < half; i++) {
          const delta = buffer[i] - buffer[i + tau];
          sum += delta * delta;
        }
        yinBuffer[tau] = sum;
      }

      yinBuffer[0] = 1;
      let runningSum = 0;

      for (let tau = 1; tau < half; tau++) {
        runningSum += yinBuffer[tau];
        yinBuffer[tau] *= tau / runningSum;
      }

      const threshold = 0.1;
      let tauEstimate = -1;

      for (let tau = 2; tau < half; tau++) {
        if (yinBuffer[tau] < threshold) {
          while (tau + 1 < half && yinBuffer[tau + 1] < yinBuffer[tau]) {
            tau++;
          }
          tauEstimate = tau;
          break;
        }
      }

      if (tauEstimate === -1) return -1;

      return sampleRate / tauEstimate;
    }

    function loop() {
      analyser.getFloatTimeDomainData(buffer);

      let rawPitch = autoCorrelate(buffer, audioContext.sampleRate);
      const yinPitch = yin(buffer, audioContext.sampleRate);

      if (rawPitch !== -1 && yinPitch !== -1) {
        console.log("AUTO:", rawPitch.toFixed(2), "YIN:", yinPitch.toFixed(2));
      }

      if (yinPitch !== -1) {
        rawPitch = yinPitch;
      }

      const noteEl = document.getElementById("note");
      const needleEl = document.getElementById("needle");

      if (rawPitch === -1 || rawPitch < 70 || rawPitch > 400) {

        const elapsed = Date.now() - lastNoteTime;
        const fade = Math.max(0, 1 - elapsed / 1000);

        noteEl.style.opacity = fade;

        if (fade === 0) {
          noteEl.innerText = "--";
          noteEl.style.color = "white";

          document.getElementById("freq").innerText = "--";
          document.getElementById("detune").innerText = "--";
        }

        ledEnergy *= 0.9;

        leds.forEach((led) => {
          let op = parseFloat(led.style.opacity || 0.1);
          led.style.opacity = op * 0.85;
        });

        smoothNeedle = smoothNeedle * 0.85 + 0.5 * 0.15;
        needleEl.style.left = smoothNeedle * 100 + "%";

        lockedString = null;
        stability = 0;

        requestAnimationFrame(loop);
        return;
      }

      lastNoteTime = Date.now();
      noteEl.style.opacity = 1;

      smoothPitch = smoothPitch === 0
        ? rawPitch
        : smoothPitch * 0.85 + rawPitch * 0.15;

      const pitch = smoothPitch;

      const note = noteFromPitch(pitch);
      const index = note % 12;

      const noteName = noteStrings[index];
      const noteLat = noteStringsLat[index];

      const detune = centsOffFromPitch(pitch, note);

      updateStrobe(detune);

      smoothDetuneLED = smoothDetuneLED === 0
        ? detune
        : smoothDetuneLED * 0.85 + detune * 0.15;

      let ledDetune = Math.abs(smoothDetuneLED) < 3 ? 0 : smoothDetuneLED;

      let activeString = null;

      if (!DEBUG_MODE) {
        const candidate = getClosestStringSmart(pitch);
        activeString = getLockedString(candidate);
      }

      noteEl.innerText = `${noteName} (${noteLat})`;

      if (!DEBUG_MODE && activeString) {
        noteEl.innerText += ` • ${activeString.name}`;
      }

      document.getElementById("freq").innerText = pitch.toFixed(2);
      document.getElementById("detune").innerText = detune.toFixed(1);

      const absDetune = Math.abs(detune);
      const isLocked = absDetune < 2;

      let color;
      if (absDetune <= 5) color = "lime";
      else if (absDetune <= 15) color = "yellow";
      else color = "red";

      noteEl.style.color = color;
      needleEl.style.background = color;

      const normalized = Math.max(-50, Math.min(50, ledDetune));
      const center = Math.floor(LED_COUNT / 2);

      ledEnergy = ledEnergy * 0.85 + 0.15;

      const pos = (normalized / 50) * center;

      leds.forEach((led, i) => {
        const rel = i - center;
        const dist = Math.abs(rel - pos);

        let intensity = 0;
        let color = "#222";

        if (dist < 4) {
          intensity = 1 - (dist / 4);

          const absRel = Math.abs(rel);

          if (absRel < 2) color = "lime";
          else if (absRel < center * 0.5) color = "yellow";
          else color = "red";
        }

        intensity *= ledEnergy;

        let finalOpacity = 0.15 + intensity * 0.85;

        if (isLocked && i === center) {
          finalOpacity = 1;
          color = "lime";
        }

        led.style.background = color;
        led.style.opacity = finalOpacity;
      });

      const target = (normalized + 50) / 100;
      smoothNeedle = smoothNeedle * 0.8 + target * 0.2;
      needleEl.style.left = smoothNeedle * 100 + "%";

      pitchHistory.push(detune);
      if (pitchHistory.length > 120) pitchHistory.shift();
      drawPitchHistory();

      requestAnimationFrame(loop);
    }

    loop();

  } catch (err) {
    console.error(err);
  }
}

const toggleBtn = document.getElementById("toggle");

if (toggleBtn) {
  toggleBtn.addEventListener("click", () => {
    if (window.audioCtx && window.audioCtx.state === "suspended") {
      window.audioCtx.resume();
    }
  });
}