import os
import base64
import tempfile
import traceback
import random
import time
from concurrent.futures import ThreadPoolExecutor
from fastapi import FastAPI, UploadFile, File, Request
from fastapi.responses import JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv
from openai import OpenAI
from elevenlabs.client import ElevenLabs

try:
    from faster_whisper import WhisperModel
    whisper_model = WhisperModel("tiny", compute_type="int8")
except Exception as e:
    print("⚠️ Failed to load FasterWhisper with int8_float16, falling back to int8.")
    from faster_whisper import WhisperModel
    whisper_model = WhisperModel("tiny", compute_type="int8")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=int(os.getenv("PORT", 8081)), reload=True)

# Load API keys
load_dotenv()
client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
eleven_client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))

# Thread pool for async audio processing
executor = ThreadPoolExecutor()

# In-memory context and cache
session_context = {"last_user": "", "last_assistant": ""}
response_cache = {}

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/frontend", StaticFiles(directory="public"), name="frontend")

@app.get("/")
async def serve_index():
    return FileResponse("public/index.html")

@app.get("/initial-message")
async def initial_message():
    greetings = [
        "Hey there! I’m your Frisome assistant. What issue are you facing with your POS system today?",
        "Welcome! If anything’s off with your printer, order flow, or screen, just tell me — I can help.",
        "Hi! I’m here to assist you with Frisome. Is it something related to billing, printer, or app freezing?",
        "Hello! Having trouble with your tablet, printer, or syncing? Let me know what’s acting up."
    ]
    greeting = random.choice(greetings)

    try:
        audio_reply = eleven_client.text_to_speech.convert(
            voice_id="pNInz6obpgDQGcFmaJgB",
            model_id="eleven_monolingual_v1",
            text=greeting
        )
        audio_bytes = b"".join(audio_reply)
        audio_base64 = base64.b64encode(audio_bytes).decode("utf-8")
    except Exception as e:
        print("🔊 ElevenLabs audio error:", e)
        audio_base64 = None

    return JSONResponse({
        "assistant_text": greeting,
        "assistant_audio_base64": audio_base64
    })

@app.post("/voice-stream")
async def voice_stream(audio: UploadFile = File(...)):
    try:
        contents = await audio.read()
        with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as temp_audio:
            temp_audio.write(contents)
            temp_audio_path = temp_audio.name

        print("🌀 Transcribing using FasterWhisper...")
        transcribe_start = time.perf_counter()
        segments, _ = whisper_model.transcribe(temp_audio_path, language="en")
        user_text = " ".join(segment.text.strip() for segment in segments if segment.text)
        transcribe_end = time.perf_counter()
        transcribe_time = round(transcribe_end - transcribe_start, 2)
        print(f"🎤 USER SAID: {user_text}")

        if user_text in response_cache:
            print("⚡ Using cached response")
            assistant_text, audio_base64 = response_cache[user_text]
            return JSONResponse({
                "user_text": user_text,
                "assistant_text": assistant_text,
                "audio_base64": audio_base64,
                "metrics": {
                    "transcription": transcribe_time,
                    "generation": 0.0
                }
            })

        system_prompt = (
            """You are a smart, friendly customer support assistant for Frisome, a POS and restaurant management system. \
            The user may mention issues with the tablet, printing, menu not updating, order not syncing, or system freezes. \
            Respond helpfully, ask follow-up questions if needed, but do not resolve anything directly — just guide. \
            If the user says thank you, goodbye, or anything indicating the conversation is over, reply with a polite farewell and say 'END OF CONVERSATION'."""
        )

        messages = [
            {"role": "system", "content": system_prompt}
        ]
        if session_context["last_user"] and session_context["last_assistant"]:
            messages.append({"role": "user", "content": session_context["last_user"]})
            messages.append({"role": "assistant", "content": session_context["last_assistant"]})
        messages.append({"role": "user", "content": user_text})

        generate_start = time.perf_counter()
        stream = client.chat.completions.create(
            model="gpt-4o",
            messages=messages,
            temperature=0.5,
            stream=True
        )

        assistant_text = ""
        for chunk in stream:
            if chunk.choices[0].delta.content:
                assistant_text += chunk.choices[0].delta.content
        generate_end = time.perf_counter()
        generation_time = round(generate_end - generate_start, 2)
        assistant_text = assistant_text.strip()

        session_context["last_user"] = user_text
        session_context["last_assistant"] = assistant_text

        def synthesize_audio(text):
            try:
                reply = eleven_client.text_to_speech.convert(
                    voice_id="pNInz6obpgDQGcFmaJgB",
                    model_id="eleven_monolingual_v1",
                    text=text
                )
                return b"".join(reply)
            except Exception as e:
                print("🎧 ElevenLabs speech error:", e)
                return None

        audio_future = executor.submit(synthesize_audio, assistant_text)
        audio_bytes = audio_future.result()
        audio_base64 = base64.b64encode(audio_bytes).decode("utf-8") if audio_bytes else None

        response_cache[user_text] = (assistant_text, audio_base64)

        return JSONResponse({
            "user_text": user_text,
            "assistant_text": assistant_text,
            "audio_base64": audio_base64,
            "metrics": {
                "transcription": transcribe_time,
                "generation": generation_time
            }
        })

    except Exception as e:
        print("❌ Error in /voice-stream:", e)
        traceback.print_exc()
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/request-callback")
async def request_callback(request: Request):
    data = await request.json()
    name = data.get("name", "Anonymous")
    phone = data.get("phone", "Unknown")
    issue = data.get("issue", "No issue described")

    try:
        os.makedirs("callback_requests", exist_ok=True)
        filename = f"{name.replace(' ', '_')}_{phone.replace('+','')}.txt"
        file_path = os.path.join("callback_requests", filename)
        with open(file_path, "w") as f:
            f.write(f"Name: {name}\nPhone: {phone}\nIssue: {issue}\n")
        return {"message": "📞 Callback request saved successfully."}
    except Exception as e:
        print("❌ Failed to save callback request:", e)
        return JSONResponse({"error": str(e)}, status_code=500)

@app.post("/log-issue")
async def log_issue(request: Request):
    data = await request.json()
    issue_type = data.get("issue_type", "Uncategorized")
    summary = data.get("summary", "")
    try:
        os.makedirs("logs", exist_ok=True)
        with open("logs/known_issues.csv", "a", encoding="utf-8") as f:
            f.write(f"{issue_type},{summary}\n")
        return {"message": "Logged"}
    except Exception as e:
        print("⚠️ Failed to log issue:", e)
        return JSONResponse({"error": str(e)}, status_code=500)
