(function () {
  // Sets up the Three.js scene, bloom pass, and shader-driven particle
  // sphere inside `container`. Returns { connectAnalyser } so an external
  // audio source (see upload-audio.js) can drive the visualizer without
  // this module knowing where the audio came from.
  function init(container) {
    const scene = new THREE.Scene();

    const camera = new THREE.PerspectiveCamera(45, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.set(0, 0, 12);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.toneMapping = THREE.ReinhardToneMapping;
    renderer.domElement.style.background = "transparent";
    container.appendChild(renderer.domElement);

    const renderScene = new THREE.RenderPass(scene, camera);
    const bloomPass = new THREE.UnrealBloomPass(
      new THREE.Vector2(window.innerWidth, window.innerHeight),
      0.8,
      0.4,
      0.3
    );

    // Bloom composer: renders the scene with bloom into an offscreen target.
    // UnrealBloomPass always outputs alpha = 1, so this result is never
    // drawn to the canvas directly — only its color is composited below.
    const bloomComposer = new THREE.EffectComposer(renderer);
    bloomComposer.renderToScreen = false;
    bloomComposer.addPass(renderScene);
    bloomComposer.addPass(bloomPass);

    // Final composite: base render (with real alpha) + bloom color on top,
    // alpha taken from the base so empty areas of the canvas stay transparent.
    const finalMaterial = new THREE.ShaderMaterial({
      uniforms: {
        baseTexture: { value: null },
        bloomTexture: { value: bloomComposer.renderTarget2.texture }
      },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D baseTexture;
        uniform sampler2D bloomTexture;
        varying vec2 vUv;
        void main() {
          vec4 base = texture2D(baseTexture, vUv);
          vec4 bloom = texture2D(bloomTexture, vUv);
          gl_FragColor = vec4(base.rgb + bloom.rgb, base.a);
        }
      `
    });

    const finalPass = new THREE.ShaderPass(finalMaterial, "baseTexture");
    finalPass.needsSwap = true;

    const composer = new THREE.EffectComposer(renderer);
    composer.addPass(renderScene);
    composer.addPass(finalPass);

    const uniforms = {
      u_time: { type: "f", value: 0.0 },
      u_frequency: { type: "f", value: 0.0 },
      u_mouse: { type: "v2", value: new THREE.Vector2(-10, -10) }
    };

    const material = new THREE.ShaderMaterial({
      uniforms: uniforms,
      vertexShader: document.getElementById("vertexshader").textContent,
      fragmentShader: document.getElementById("fragmentshader").textContent,
      transparent: true,
      depthWrite: false
    });

    const geometry = new THREE.IcosahedronGeometry(3.0, 36);
    const particles = new THREE.Points(geometry, material);
    scene.add(particles);

    // Audio state, supplied externally via connectAnalyser.
    let analyser = null;
    let dataArray = null;
    let audioEl = null;
    let dynamicMaxVolume = 1.0;
    let dynamicMinVolume = 255.0;

    function connectAnalyser(newAnalyser, newDataArray, newAudioEl) {
      analyser = newAnalyser;
      dataArray = newDataArray;
      audioEl = newAudioEl;
      dynamicMaxVolume = 1.0;
      dynamicMinVolume = 255.0;
    }

    // Screen-space mouse coordinates, used for cursor glow and parallax.
    let targetMouseX = 0;
    let targetMouseY = 0;

    document.addEventListener("mousemove", function (e) {
      uniforms.u_mouse.value.x = (e.clientX / window.innerWidth) * 2 - 1;
      uniforms.u_mouse.value.y = -(e.clientY / window.innerHeight) * 2 + 1;

      const windowHalfX = window.innerWidth / 2;
      const windowHalfY = window.innerHeight / 2;
      targetMouseX = (e.clientX - windowHalfX) / 120;
      targetMouseY = (e.clientY - windowHalfY) / 120;
    });

    const clock = new THREE.Clock();

    function animate() {
      requestAnimationFrame(animate);

      const elapsedTime = clock.getElapsedTime();
      uniforms.u_time.value = elapsedTime;

      const isSpeaking = analyser && audioEl && !audioEl.paused;

      if (isSpeaking) {
        analyser.getByteFrequencyData(dataArray);

        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const currentAvg = sum / dataArray.length;

        if (currentAvg > dynamicMaxVolume) {
          dynamicMaxVolume = currentAvg;
        } else {
          dynamicMaxVolume -= 0.08;
        }

        if (currentAvg < dynamicMinVolume) {
          dynamicMinVolume = currentAvg;
        } else {
          dynamicMinVolume += 0.04;
        }

        dynamicMaxVolume = Math.max(dynamicMaxVolume, 10.0);
        dynamicMinVolume = Math.min(dynamicMinVolume, dynamicMaxVolume - 5.0);

        let normalized = (currentAvg - dynamicMinVolume) / (dynamicMaxVolume - dynamicMinVolume);
        normalized = Math.max(0.0, Math.min(1.0, normalized));

        // Power curve (1.8) and scale (2.5) increase maximum bounce range
        const targetFrequency = Math.pow(normalized, 1.8) * 2.5;

        // Snappier interpolation factor (0.35) makes visual jumps immediate
        uniforms.u_frequency.value += (targetFrequency - uniforms.u_frequency.value) * 0.35;
      } else {
        // Idle breathing: three offset sine waves at different speeds/phases
        // instead of one, so the motion doesn't read as a single metronomic pulse.
        const idleBase = 0.11
          + Math.sin(elapsedTime * 0.45) * 0.05
          + Math.sin(elapsedTime * 1.3 + 1.1) * 0.025
          + Math.sin(elapsedTime * 2.7 + 3.4) * 0.012;

        // Heartbeat-style pulse: a short, sharp bump roughly every 6 seconds,
        // on top of the breathing, so idle isn't purely periodic sine motion.
        const pulsePhase = elapsedTime % 6.0;
        const pulse = pulsePhase < 0.4 ? Math.sin((pulsePhase / 0.4) * Math.PI) * 0.35 : 0.0;

        const idleFrequency = idleBase + pulse;
        // Faster ease-in (0.08) than a plain breathing loop so the pulse
        // actually reads as a bump rather than being smoothed away.
        uniforms.u_frequency.value += (idleFrequency - uniforms.u_frequency.value) * 0.08;
      }

      camera.position.x += (targetMouseX - camera.position.x) * 0.05;
      camera.position.y += (-targetMouseY - camera.position.y) * 0.05;
      // Idle-only camera dolly: a slow, subtle push in and out, disabled while
      // speaking so it doesn't fight with the audio-driven displacement.
      const idleDollyTarget = isSpeaking ? 12 : 12 + Math.sin(elapsedTime * 0.28) * 0.35;
      camera.position.z += (idleDollyTarget - camera.position.z) * 0.02;
      camera.lookAt(scene.position);

      if (isSpeaking) {
        particles.rotation.y = elapsedTime * 0.06;
        particles.rotation.x += (0.0 - particles.rotation.x) * 0.05;
        particles.rotation.z += (0.0 - particles.rotation.z) * 0.05;
      } else {
        // Idle wobble: slow drift on all three axes instead of a flat Y-spin,
        // so the sphere tumbles gently rather than rotating like a record.
        particles.rotation.y = elapsedTime * 0.05;
        particles.rotation.x = Math.sin(elapsedTime * 0.25) * 0.08;
        particles.rotation.z = Math.sin(elapsedTime * 0.18 + 2.0) * 0.05;
      }

      bloomComposer.render();
      composer.render();
    }

    animate();

    window.addEventListener("resize", function () {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
      bloomComposer.setSize(window.innerWidth, window.innerHeight);
      composer.setSize(window.innerWidth, window.innerHeight);
    });

    return { connectAnalyser };
  }

  window.App = window.App || {};
  window.App.AudioVisualizer = { init };
})();