let status = document.getElementById("status");
let silenceTimeout;
let thinkingInterval;
let lastUserText = "";

const issueTags = [
  { keywords: ["printer", "receipt", "paper"], tag: "🔧 Printer Issue" },
  { keywords: ["freeze", "crash", "slow"], tag: "🧊 App Performance" },
  { keywords: ["order", "menu", "kitchen", "sync"], tag: "🍽️ Order Sync" },
  { keywords: ["bill", "charge", "tax", "amount"], tag: "💵 Billing Issue" }
];

const closingTriggers = [
  "yes", "that's all", "thank you", "thanks", "okay", "cool", "done", "perfect", "great"
];

function detectIssueTag(text) {
  const lower = text.toLowerCase();
  for (const { keywords, tag } of issueTags) {
    if (keywords.some(word => lower.includes(word))) return tag;
  }
  return null;
}

function isClosureSignal(text) {
  const lower = text.trim().toLowerCase();
  return closingTriggers.some(phrase => lower === phrase || lower.includes(phrase));
}

function resetConversation() {
  const log = document.getElementById("log");
  log.innerHTML = "";
  setStatus("Reset. Ready to begin.");
  fetchInitialMessage();
}

async function fetchInitialMessage() {
  const res = await fetch("/initial-message");
  const data = await res.json();
  logMessage("assistant", data.assistant_text);
  if (data.assistant_audio_base64) {
    const audio = new Audio("data:audio/mp3;base64," + data.assistant_audio_base64);
    setStatus("🔊 Speaking...");
    audio.play().catch(e => console.error("🔇 Failed to play intro audio:", e));
    audio.onended = () => startVoiceLoop();
  } else {
    startVoiceLoop();
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
  document.getElementById("statusLabel").textContent = msg;
}

function animateThinking() {
  let dotCount = 0;
  thinkingInterval = setInterval(() => {
    dotCount = (dotCount + 1) % 4;
    setStatus("🤔 Thinking" + ".".repeat(dotCount));
  }, 500);
}

function stopThinking() {
  clearInterval(thinkingInterval);
}

async function startVoiceLoop() {
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
    const blob = new Blob(chunks, { type: "audio/webm" });
    const formData = new FormData();
    formData.append("audio", blob, "recording.webm");

    animateThinking();
    try {
      const res = await fetch("/voice-stream", { method: "POST", body: formData });
      if (!res.ok) throw new Error("Server offline or failed");
      const data = await res.json();
      stopThinking();
      if (data.user_text) {
        logMessage("user", data.user_text);
        lastUserText = data.user_text;
      }
      if (data.assistant_text) logMessage("assistant", data.assistant_text);

      if (data.audio_base64) {
        const audio = new Audio("data:audio/mp3;base64," + data.audio_base64);
        setStatus("🔊 Speaking...");
        audio.play().catch(e => {
          console.error("🔇 Audio playback failed:", e);
          startVoiceLoop();
        });
        audio.onended = () => {
          if (data.assistant_text.toLowerCase().includes("provide a preferred date and time")) {
            triggerCallbackPrompt();
          } else if (!data.assistant_text.includes("END OF CONVERSATION")) {
            if (isClosureSignal(lastUserText)) {
              logMessage("assistant", "You're welcome! We'll be in touch soon. Have a great day! END OF CONVERSATION");
              setStatus("✅ Conversation complete. You can reset or request a callback.");
            } else {
              startVoiceLoop();
            }
          } else {
            document.getElementById("formSection").style.display = "block";
            document.getElementById("resetBtn").style.display = "inline-block";
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

document.addEventListener("DOMContentLoaded", () => {
  const container = document.getElementById("container");
  if (!container) {
    console.error("❌ Missing #container element in HTML.");
    return;
  }

  const startBtn = document.createElement("button");
  startBtn.textContent = "▶️ Start Voice Assistant";
  startBtn.onclick = () => {
    startBtn.remove();
    fetchInitialMessage();
  };
  container.appendChild(startBtn);

  const resetBtn = document.createElement("button");
  resetBtn.id = "resetBtn";
  resetBtn.textContent = "🔄 Reset";
  resetBtn.onclick = resetConversation;
  resetBtn.style.marginLeft = "10px";
  resetBtn.style.display = "none";
  container.appendChild(resetBtn);

  const callbackBtn = document.createElement("button");
  callbackBtn.id = "callbackBtn";
  callbackBtn.textContent = "📞 Request Call Back";
  callbackBtn.onclick = triggerCallbackPrompt;
  callbackBtn.style.marginLeft = "10px";
  container.appendChild(callbackBtn);

  const audioEl = document.querySelector("audio");
  if (audioEl) audioEl.remove();
});
