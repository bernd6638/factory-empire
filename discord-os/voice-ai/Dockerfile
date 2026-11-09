# Lokaler Sprachdienst (Whisper + Piper) für den KI-Sprach-Bot – läuft auf der CPU
FROM python:3.11-slim
ENV PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 MODELS_DIR=/models
WORKDIR /app
COPY requirements.txt .
RUN pip install -r requirements.txt
COPY app.py .
VOLUME /models
EXPOSE 8000
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health')"
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
