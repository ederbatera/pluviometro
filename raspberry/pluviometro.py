#!/usr/bin/env python3
"""
Pluviômetro Raspberry Pi — Envio Direto para o Servidor Node.js em Tempo Real
Grava cada pulso imediatamente na fila local SQLite (WAL) em <1ms para garantir
integridade offline e envia no mesmo instante para o Node.js (HTTP Keep-Alive),
que persiste no banco e atualiza o painel via WebSocket em tempo real.
"""

from datetime import datetime, timezone
import os
from pathlib import Path
import signal
import sqlite3
import sys
import threading
import time
import uuid

from gpiozero import Button
import requests

# Garante envio imediato de stdout/stderr para o journalctl mesmo sem `python3 -u`
for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(line_buffering=True, write_through=True)

SCRIPT_DIR = Path(__file__).resolve().parent


def log(message: str) -> None:
    hora_local = datetime.now(timezone.utc).astimezone().strftime("%H:%M:%S")
    print(f"[{hora_local}] {message}", flush=True)


def load_local_env() -> Path | None:
    """Carrega variáveis de um arquivo .env na mesma pasta do script (sem dependências extras)."""
    env_path = SCRIPT_DIR / ".env"
    if not env_path.is_file():
        return None
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        if line.startswith("export "):
            line = line[7:].strip()
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ('"', "'"):
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)
    return env_path


def resolve_queue_db_path() -> str:
    raw = os.environ.get("PLUVIOMETRO_QUEUE_DB", "./pluviometro_fila.db").strip() or "./pluviometro_fila.db"
    db_path = Path(raw)
    if not db_path.is_absolute():
        db_path = SCRIPT_DIR / db_path
    db_path.parent.mkdir(parents=True, exist_ok=True)
    return str(db_path)


LOADED_ENV_PATH = load_local_env()

# --- CONFIGURAÇÕES VIA VARIÁVEIS DE AMBIENTE (.env ou sistema) ---
GPIO_PIN = int(os.environ.get("PLUVIOMETRO_GPIO", "17"))
BOUNCE_TIME = float(os.environ.get("PLUVIOMETRO_DEBOUNCE", "0.2"))
MM_POR_PULSO = float(os.environ.get("PLUVIOMETRO_MM_POR_PULSO", "0.25"))
STATION_ID = os.environ.get("PLUVIOMETRO_STATION_ID", "default")

# URL do endpoint do servidor Node.js (ex: http://192.168.1.100:3000/api/pulses/batch)
API_URL = os.environ.get("PLUVIOMETRO_API_URL", "http://localhost:3000/api/pulses/batch").strip()
API_KEY = os.environ.get("PLUVIOMETRO_API_KEY", "").strip()

# Banco SQLite local do Raspberry Pi usado exclusivamente como fila resiliente
QUEUE_DB_PATH = resolve_queue_db_path()

BATCH_SIZE = 50
BACKOFF_STEPS = [1, 2, 5, 15, 30]

db_lock = threading.Lock()
wake_event = threading.Event()
stop_event = threading.Event()


def init_queue_db() -> sqlite3.Connection:
    conn = sqlite3.connect(QUEUE_DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute(
        """
        CREATE TABLE IF NOT EXISTS pulse_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_uid TEXT NOT NULL UNIQUE,
            station_id TEXT NOT NULL,
            mm REAL NOT NULL,
            timestamp_unix INTEGER NOT NULL,
            queued_at_unix INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0
        );
        """
    )
    conn.commit()
    return conn


queue_conn = init_queue_db()


def enqueue_pulse(mm: float) -> None:
    now_unix = int(time.time())
    event_uid = f"{STATION_ID}:{now_unix}:{uuid.uuid4().hex[:8]}"

    with db_lock:
        queue_conn.execute(
            """
            INSERT INTO pulse_queue (event_uid, station_id, mm, timestamp_unix, queued_at_unix)
            VALUES (?, ?, ?, ?, ?)
            """,
            (event_uid, STATION_ID, mm, now_unix, now_unix),
        )
        queue_conn.commit()

    # Acorda a thread de envio imediatamente para atualizar o Node em tempo real
    wake_event.set()
    log(f"Pulso registrado ({mm} mm) -> {event_uid}")


def fetch_pending_batch(limit: int = BATCH_SIZE) -> list[tuple]:
    with db_lock:
        cur = queue_conn.execute(
            """
            SELECT id, event_uid, station_id, mm, timestamp_unix, queued_at_unix
            FROM pulse_queue
            ORDER BY id ASC
            LIMIT ?
            """,
            (limit,),
        )
        return cur.fetchall()


def delete_synced_ids(row_ids: list[int]) -> None:
    if not row_ids:
        return
    placeholders = ",".join("?" for _ in row_ids)
    with db_lock:
        queue_conn.execute(
            f"DELETE FROM pulse_queue WHERE id IN ({placeholders})",
            row_ids,
        )
        queue_conn.commit()


def sender_worker() -> None:
    if not API_KEY or API_KEY == "COLE_SUA_CHAVE_AQUI":
        log("[AVISO] PLUVIOMETRO_API_KEY não configurada. Pulsos ficarão salvos apenas na fila SQLite local.")

    session = requests.Session()
    session.headers.update(
        {
            "Content-Type": "application/json",
            "Connection": "keep-alive",
        }
    )
    failure_count = 0

    while not stop_event.is_set():
        wake_event.clear()
        batch = fetch_pending_batch()

        if not batch:
            # Aguarda evento imediato de pulso sem consumir CPU ou rede quando não há chuva
            wake_event.wait(timeout=30)
            continue

        if not API_KEY or API_KEY == "COLE_SUA_CHAVE_AQUI":
            log(f"[FILA] {len(batch)} pulso(s) aguardando PLUVIOMETRO_API_KEY válida.")
            wake_event.wait(timeout=30)
            continue

        row_ids = [row[0] for row in batch]
        now_unix = int(time.time())
        payload = {
            "pulses": [
                {
                    "eventUid": row[1],
                    "stationId": row[2],
                    "mm": row[3],
                    "timestamp": row[4],
                    "queuedAt": row[5],
                    "source": "queue_replay" if now_unix - row[5] > 10 else "raspberry",
                }
                for row in batch
            ]
        }

        try:
            resp = session.post(
                API_URL,
                json=payload,
                headers={"x-api-key": API_KEY},
                timeout=8,
            )
            if resp.status_code in (200, 202):
                delete_synced_ids(row_ids)
                failure_count = 0
                log(f"[NODE SYNC] {len(row_ids)} pulso(s) enviado(s) em tempo real (HTTP {resp.status_code}).")
                continue

            detail = resp.text.strip().replace("\n", " ")[:180]
            log(f"[ERRO HTTP {resp.status_code}] {detail} | Mantendo {len(row_ids)} pulso(s) na fila SQLite.")
            failure_count += 1
        except requests.RequestException as exc:
            failure_count += 1
            log(f"[OFFLINE] Node inacessível ({exc}). {len(row_ids)} pulso(s) preservados na fila SQLite.")

        wait_seconds = BACKOFF_STEPS[min(failure_count - 1, len(BACKOFF_STEPS) - 1)]
        stop_event.wait(timeout=wait_seconds)


def registrar_pulso() -> None:
    try:
        enqueue_pulse(MM_POR_PULSO)
    except Exception as exc:
        log(f"[ERRO GPIO] Falha ao gravar pulso na fila SQLite: {exc}")


def handle_exit(_signum, _frame) -> None:
    log("Encerrando monitoramento com segurança...")
    stop_event.set()
    wake_event.set()
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, handle_exit)
    signal.signal(signal.SIGTERM, handle_exit)

    env_info = str(LOADED_ENV_PATH) if LOADED_ENV_PATH else "não encontrado (usando env do sistema)"
    key_info = "configurada" if (API_KEY and API_KEY != "COLE_SUA_CHAVE_AQUI") else "AUSENTE"
    log(
        f"Iniciando pluviômetro | GPIO={GPIO_PIN} (pino físico 11 + GND pino 9) | "
        f"debounce={BOUNCE_TIME}s | {MM_POR_PULSO} mm/pulso | .env={env_info} | "
        f"API_KEY={key_info} | Node={API_URL} | Fila={QUEUE_DB_PATH}"
    )

    worker = threading.Thread(target=sender_worker, daemon=True)
    worker.start()

    sensor = Button(GPIO_PIN, pull_up=True, bounce_time=BOUNCE_TIME)
    sensor.when_pressed = registrar_pulso
    log("Monitorando pulsos no sensor...")

    while not stop_event.is_set():
        stop_event.wait(timeout=60)
