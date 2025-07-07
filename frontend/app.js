let status = document.getElementById("status");
let silenceTimeout;
let thinkingInterval;
let lastUserText = "";
let timingInfo = { listen: 0, think: 0, speak: 0 };
let currentAudio = null;
let micInterruptContext = null;
let thinkStartTime = 0;

const issueTags = [
  { keywords: ["printer", "receipt", "paper"], tag: "🔧 Printer Issue" },
  { keywords: ["freeze", "crash", "slow"], tag: "🧊 App Performance" },
  { keywords: ["order", "menu", "kitchen", "sync"], tag: "🍽️ Order Sync" },
  { keywords: ["bill", "charge", "tax", "amount"], tag: "💵 Billing Issue" }
];

function detectIssueTag(text) {
  const lower = text.toLowerCase();
  for (const { keywords, tag } of issueTags) {
    if (keywords.some(word => lower.includes(word))) return tag;
  }
  return null;
}

function resetConversation() {
  const log = document.getElementById("log");
  log.innerHTML = "";
  document.getElementById("timingMetrics").textContent = "";
  setStatus("Reset. Ready to begin.");
  fetchInitialMessage();
}

async function fetchInitialMessage() {
  const res = await fetch("/initial-message");
  const data = await res.json();
  logMessage("assistant", data.assistant_text);
  if (data.assistant_audio_base64) {
    if (currentAudio && !currentAudio.paused) currentAudio.pause();
    currentAudio = new Audio("data:audio/mp3;base64," + data.assistant_audio_base64);
    setStatus("🔊 Speaking...");
    const t0 = performance.now();
    currentAudio.play().catch(e => console.error("🔇 Failed to play intro audio:", e));
    watchForInterrupt();
    currentAudio.onended = () => {
      const t1 = performance.now();
      timingInfo.speak = ((t1 - t0) / 1000).toFixed(1);
      updateTimingUI();
      currentAudio = null;
      startVoiceLoop();
    };
  } else {
    startVoiceLoop();
  }
}

function updateTimingUI() {
  const timingLabel = document.getElementById("timingMetrics");
  if (timingLabel) {
    timingLabel.textContent = `⏱️ Listen: ${timingInfo.listen}s | Think: ${timingInfo.think}s | Speak: ${timingInfo.speak}s`;
  }
}

function logMessage(role, text) {
  const div = document.createElement("div");
  div.className = role;
  const tag = role === "user" ? null : detectIssueTag(lastUserText);
  div.textContent = (role === 'user' ? "🧑 " : "🤖 ") + text;
  if (tag) {
    const badge = document.createElement("span");
    badge.textContent = `  [${tag}]`;
    badge.style.color = "#888";
    badge.style.fontSize = "0.9em";
    div.appendChild(badge);
  }
  const log = document.getElementById("log");
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function setStatus(msg) {
  const label = document.getElementById("statusLabel");
  if (label) label.textContent = msg;
}

function animateThinking() {
  let dotCount = 0;
  thinkStartTime = performance.now();
  thinkingInterval = setInterval(() => {
    dotCount = (dotCount + 1) % 4;
    setStatus("🤔 Thinking" + ".".repeat(dotCount));
  }, 400);
}

function stopThinking() {
  clearInterval(thinkingInterval);
  const end = performance.now();
  timingInfo.think = ((end - thinkStartTime) / 1000).toFixed(1);
}

function watchForInterrupt() {
  navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
    micInterruptContext = new AudioContext();
    const source = micInterruptContext.createMediaStreamSource(stream);
    const analyser = micInterruptContext.createAnalyser();
    analyser.fftSize = 2048;
    const data = new Uint8Array(analyser.fftSize);
    source.connect(analyser);

    const detectSpeech = () => {
      analyser.getByteTimeDomainData(data);
      const avg = data.reduce((sum, v) => sum + Math.abs(v - 128), 0) / data.length;
      if (avg > 10 && currentAudio && !currentAudio.paused) {
        currentAudio.pause();
        currentAudio = null;
        stream.getTracks().forEach(track => track.stop());
        micInterruptContext.close();
        setStatus("⏹️ Interrupted by user. Listening...");
        startVoiceLoop();
        return;
      }
      if (currentAudio && !currentAudio.paused) {
        requestAnimationFrame(detectSpeech);
      } else {
        stream.getTracks().forEach(track => track.stop());
        micInterruptContext.close();
      }
    };
    requestAnimationFrame(detectSpeech);
  });
}

async function startVoiceLoop() {
  const tListenStart = performance.now();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mediaRecorder = new MediaRecorder(stream);
  const chunks = [];
  const audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(stream);
  const analyser = audioContext.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);

  mediaRecorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

  mediaRecorder.onstop = async () => {
    stream.getTracks().forEach(t => t.stop());
    const tListenEnd = performance.now();
    timingInfo.listen = ((tListenEnd - tListenStart) / 1000).toFixed(1);
    const blob = new Blob(chunks, { type: "audio/webm" });
    const formData = new FormData();
    formData.append("audio", blob, "recording.webm");

    animateThinking();
    try {
      const res = await fetch("/voice-stream", { method: "POST", body: formData });
      if (!res.ok) throw new Error("Server offline or failed");
      const data = await res.json();
      stopThinking();
      updateTimingUI();
      if (data.user_text) {
        logMessage("user", data.user_text);
        lastUserText = data.user_text;
      }
      if (data.assistant_text) logMessage("assistant", data.assistant_text);

      if (data.audio_base64) {
        if (currentAudio && !currentAudio.paused) currentAudio.pause();
        currentAudio = new Audio("data:audio/mp3;base64," + data.audio_base64);
        setStatus("🔊 Speaking...");
        const speakStart = performance.now();
        currentAudio.play().catch(e => {
          console.error("🔇 Audio playback failed:", e);
          startVoiceLoop();
        });
        watchForInterrupt();
        currentAudio.onended = () => {
          const speakEnd = performance.now();
          timingInfo.speak = ((speakEnd - speakStart) / 1000).toFixed(1);
          updateTimingUI();
          currentAudio = null;
          if (data.assistant_text.toLowerCase().includes("provide a preferred date and time")) {
            triggerCallbackPrompt();
          } else if (!data.assistant_text.includes("END OF CONVERSATION")) {
            startVoiceLoop();
          } else {
            const section = document.getElementById("formSection");
            if (section) section.style.display = "block";
            const resetBtn = document.getElementById("resetBtn");
            if (resetBtn) resetBtn.style.display = "inline-block";
            setStatus("✅ Conversation complete. You can reset or request a callback.");
          }
        };
      } else {
        startVoiceLoop();
      }

      const tag = detectIssueTag(lastUserText);
      if (tag) {
        await fetch("/log-issue", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ issue_type: tag, summary: lastUserText })
        }).catch(e => console.warn("📉 Could not log issue", e));
      }
    } catch (err) {
      stopThinking();
      logMessage("assistant", "⚠️ Something went wrong or you're offline.");
      setStatus("Offline or error");
    }
  };

  setStatus("🎤 Listening...");
  mediaRecorder.start();

  const data = new Uint8Array(analyser.fftSize);
  const detectSilence = () => {
    analyser.getByteTimeDomainData(data);
    const avg = data.reduce((a, b) => a + Math.abs(b - 128), 0) / data.length;
    if (avg < 2) {
      if (!silenceTimeout) {
        silenceTimeout = setTimeout(() => {
          mediaRecorder.stop();
        }, 1000);
      }
    } else {
      clearTimeout(silenceTimeout);
      silenceTimeout = null;
    }
    if (mediaRecorder.state === "recording") requestAnimationFrame(detectSilence);
  };
  requestAnimationFrame(detectSilence);
}

function triggerCallbackPrompt() {
  const name = prompt("Your Name:", "");
  const phone = prompt("Phone Number:", "");
  const time = prompt("Preferred Date/Time for Callback:", "");
  if (name && phone) {
    fetch("/request-callback", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, phone, issue: lastUserText + " | Requested callback: " + time })
    })
      .then(res => res.json())
      .then(data => alert(data.message || "Callback submitted!"))
      .catch(err => console.error("Callback submission failed:", err));
  }
}

window.fetchInitialMessage = fetchInitialMessage;
