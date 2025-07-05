# elevenlabs_utils.py (for SDK v2+)
import os
from elevenlabs.client import ElevenLabs
from dotenv import load_dotenv

load_dotenv()
client = ElevenLabs(api_key=os.getenv("ELEVENLABS_API_KEY"))

def speak_text(text, voice_id="Rachel"):
    try:
        audio = client.text_to_speech.convert(
            voice_id=voice_id,
            model_id="eleven_multilingual_v2",
            text=text
        )
        os.makedirs("audio", exist_ok=True)
        filename = f"audio/response_{abs(hash(text)) % (10 ** 8)}.mp3"
        with open(filename, "wb") as f:
            f.write(audio)
        return filename
    except Exception as e:
        print("TTS generation error:", e)
        raise
