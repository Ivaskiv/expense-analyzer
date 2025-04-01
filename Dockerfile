# Використовуємо легкий образ Python
FROM python:3.9-slim

# Встановлюємо необхідні залежності
RUN apt-get update && apt-get install -y \
    wget \
    sox \
    libsndfile1 \
    && rm -rf /var/lib/apt/lists/*

# Встановлюємо Coqui STT
RUN pip install --no-cache-dir coqui-stt fastapi uvicorn

# Створюємо робочу директорію
WORKDIR /app

# Копіюємо код
COPY . /app

# Відкриваємо порт для сервера
EXPOSE 5000

# Запускаємо FastAPI сервер
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5000"]
