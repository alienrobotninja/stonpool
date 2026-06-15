FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

# the live keeper signs with pytoniq (WalletV5R1); the API/indexer do not need it
ARG INSTALL_KEEPER=false
COPY requirements.txt requirements-keeper.txt ./
RUN pip install --no-cache-dir -r requirements.txt \
 && if [ "$INSTALL_KEEPER" = "true" ]; then pip install --no-cache-dir -r requirements-keeper.txt; fi

COPY app ./app
COPY alembic ./alembic
COPY alembic.ini ./

EXPOSE 8000
CMD ["uvicorn", "app.api.app:create_app", "--factory", "--host", "0.0.0.0", "--port", "8000"]