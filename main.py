from fastapi import FastAPI, UploadFile, File
import stt
import io

app = FastAPI()

# Завантажуємо модель
model = stt.Model("model.tflite")

@app.post("/transcribe/")
async def transcribe_audio(file: UploadFile = File(...)):
    audio_data = await file.read()
    audio_buffer = io.BytesIO(audio_data)
    
    text = model.stt(audio_buffer.read())
    return {"transcription": text}
