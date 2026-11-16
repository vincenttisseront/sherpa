# Application de test des sources GitHub (image de base déjà présente sur l'hôte de dev).
FROM python:3.12-slim
RUN mkdir /www && echo "source github" > /www/index.html
WORKDIR /www
HEALTHCHECK --interval=5s --timeout=3s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/')"
CMD ["python", "-m", "http.server", "8000"]
