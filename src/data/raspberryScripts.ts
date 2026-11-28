export const RASPBERRY_API_SCRIPT = `#!/usr/bin/env python3
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

for _stream in (sys.stdout, sys.stderr):
    if hasattr(_stream, "reconfigure"):
        _stream.reconfigure(line_buffering=True, write_through=True)

SCRIPT_DIR = Path(__file__).resolve().parent


def log(message: str) -> None:
    hora_local = datetime.now(timezone.utc).astimezone().strftime("%H:%M:%S")
    print(f"[{hora_local}] {message}", flush=True)


def load_local_env() -> Path | None:
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

GPIO_PIN = int(os.environ.get("PLUVIOMETRO_GPIO", "17"))
BOUNCE_TIME = float(os.environ.get("PLUVIOMETRO_DEBOUNCE", "0.2"))
HW_BOUNCE_TIME = float(os.environ.get("PLUVIOMETRO_HW_BOUNCE", "0.005"))
MM_POR_PULSO = float(os.environ.get("PLUVIOMETRO_MM_POR_PULSO", "0.25"))
STATION_ID = os.environ.get("PLUVIOMETRO_STATION_ID", "default")

API_URL = os.environ.get("PLUVIOMETRO_API_URL", "https://SEU-SERVIDOR/api/pulses/batch").strip()
API_KEY = os.environ.get("PLUVIOMETRO_API_KEY", "").strip()
QUEUE_DB_PATH = resolve_queue_db_path()

BATCH_SIZE = 50
BACKOFF_STEPS = [1, 2, 5, 15, 30]

db_lock = threading.Lock()
pulse_lock = threading.Lock()
last_pulse_mono = 0.0
wake_event = threading.Event()
stop_event = threading.Event()


def init_queue_db() -> sqlite3.Connection:
    conn = sqlite3.connect(QUEUE_DB_PATH, check_same_thread=False)
    conn.execute("PRAGMA journal_mode = WAL;")
    conn.execute("PRAGMA synchronous = NORMAL;")
    conn.execute("""
        CREATE TABLE IF NOT EXISTS pulse_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            event_uid TEXT NOT NULL UNIQUE,
            station_id TEXT NOT NULL,
            mm REAL NOT NULL,
            timestamp_unix INTEGER NOT NULL,
            queued_at_unix INTEGER NOT NULL,
            attempts INTEGER NOT NULL DEFAULT 0
        );
    """)
    conn.commit()
    return conn


queue_conn = init_queue_db()


def enqueue_pulse(mm: float) -> None:
    now_unix = int(time.time())
    event_uid = f"{STATION_ID}:{now_unix}:{uuid.uuid4().hex[:8]}"
    with db_lock:
        queue_conn.execute(
            "INSERT INTO pulse_queue (event_uid, station_id, mm, timestamp_unix, queued_at_unix) VALUES (?, ?, ?, ?, ?)",
            (event_uid, STATION_ID, mm, now_unix, now_unix),
        )
        queue_conn.commit()
    wake_event.set()
    log(f"Pulso registrado ({mm} mm) -> {event_uid}")


def sender_worker() -> None:
    session = requests.Session()
    session.headers.update({"Content-Type": "application/json", "Connection": "keep-alive"})
    failure_count = 0

    while not stop_event.is_set():
        wake_event.clear()
        with db_lock:
            batch = queue_conn.execute(
                "SELECT id, event_uid, station_id, mm, timestamp_unix, queued_at_unix FROM pulse_queue ORDER BY id ASC LIMIT ?",
                (BATCH_SIZE,),
            ).fetchall()

        if not batch:
            wake_event.wait(timeout=30)
            continue

        if not API_KEY or API_KEY == "COLE_SUA_CHAVE_AQUI":
            log(f"[FILA] {len(batch)} pulso(s) aguardando PLUVIOMETRO_API_KEY válida.")
            wake_event.wait(timeout=30)
            continue

        row_ids = [r[0] for r in batch]
        now_unix = int(time.time())
        payload = {
            "pulses": [
                {
                    "eventUid": r[1],
                    "stationId": r[2],
                    "mm": r[3],
                    "timestamp": r[4],
                    "queuedAt": r[5],
                    "source": "queue_replay" if now_unix - r[5] > 10 else "raspberry",
                }
                for r in batch
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
                placeholders = ",".join("?" for _ in row_ids)
                with db_lock:
                    queue_conn.execute(f"DELETE FROM pulse_queue WHERE id IN ({placeholders})", row_ids)
                    queue_conn.commit()
                failure_count = 0
                log(f"[NODE SYNC] {len(row_ids)} pulso(s) enviado(s) em tempo real (HTTP {resp.status_code}).")
                continue
            log(f"[ERRO HTTP {resp.status_code}] Mantendo {len(row_ids)} pulso(s) na fila SQLite.")
            failure_count += 1
        except requests.RequestException as exc:
            failure_count += 1
            log(f"[OFFLINE] Node inacessível ({exc}). {len(row_ids)} pulso(s) preservados na fila SQLite.")

        wait_seconds = BACKOFF_STEPS[min(failure_count - 1, len(BACKOFF_STEPS) - 1)]
        stop_event.wait(timeout=wait_seconds)


def registrar_pulso() -> None:
    global last_pulse_mono
    now_mono = time.monotonic()
    with pulse_lock:
        if now_mono - last_pulse_mono < BOUNCE_TIME:
            return
        last_pulse_mono = now_mono
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
    hw_bounce = HW_BOUNCE_TIME if HW_BOUNCE_TIME > 0 else None
    log(
        f"Iniciando pluviômetro | GPIO={GPIO_PIN} | debounce_sw={BOUNCE_TIME}s | "
        f"debounce_hw={hw_bounce}s | Node={API_URL} | Fila={QUEUE_DB_PATH}"
    )
    threading.Thread(target=sender_worker, daemon=True).start()
    sensor = Button(GPIO_PIN, pull_up=True, bounce_time=hw_bounce)
    sensor.when_pressed = registrar_pulso
    log("Monitorando pulsos no sensor...")
    while not stop_event.is_set():
        stop_event.wait(timeout=60)
`;

export const RASPBERRY_DIRECT_DB_SCRIPT = `#!/usr/bin/env python3
"""
Pluviômetro Raspberry Pi — Envio Direto para MariaDB + Fila Local SQLite (WAL)
"""
from datetime import datetime, timezone
import os, sqlite3, threading, time, uuid
from zoneinfo import ZoneInfo
from gpiozero import Button
import mysql.connector  # pip install mysql-connector-python

GPIO_PIN = int(os.environ.get("PLUVIOMETRO_GPIO", "17"))
MM_POR_PULSO = float(os.environ.get("PLUVIOMETRO_MM_POR_PULSO", "0.25"))
STATION_ID = os.environ.get("PLUVIOMETRO_STATION_ID", "default")
STATION_TZ = ZoneInfo(os.environ.get("TZ_STATION", "America/Sao_Paulo"))

MARIADB_HOST = os.environ.get("MARIADB_HOST", "mariadb")
MARIADB_DATABASE = os.environ.get("MARIADB_DATABASE", "pluviometro")
MARIADB_USER = os.environ.get("MARIADB_USER", "root")
MARIADB_PASSWORD = os.environ.get("MARIADB_PASSWORD", "")
QUEUE_DB_PATH = os.environ.get("PLUVIOMETRO_QUEUE_DB", "./pluviometro_fila.db")

# Enfileira em SQLite local na interrupção do GPIO (<1ms) e sincroniza em lote
# diretamente nas tabelas RainPulse, HourlySummary e DailySummary do MariaDB.
# Consulte o arquivo completo em raspberry/pluviometro_direct_db.py
`;

export const PRISMA_SCHEMA_PREVIEW = `datasource db {
  provider = "mysql"
  url      = env("DATABASE_URL")
}

model StationConfig {
  id            String   @id @default("default") @db.VarChar(64)
  name          String   @default("Estação Principal") @db.VarChar(120)
  location      String   @default("Jardim / Ponto 01") @db.VarChar(160)
  mmPerPulse    Float    @default(0.25)
  timezone      String   @default("America/Sao_Paulo") @db.VarChar(64)
  ingestKeyHash String?  @db.VarChar(255)
  ingestKeyHint String?  @db.VarChar(64)
}

model AdminUser {
  id           Int           @id @default(autoincrement())
  username     String        @unique @db.VarChar(64)
  displayName  String        @db.VarChar(120)
  passwordHash String        @db.VarChar(255)
  role         String        @default("admin") @db.VarChar(32)
  sessions     AuthSession[]
}

model AuthSession {
  id        String     @id @db.VarChar(64)
  tokenHash String     @unique @db.VarChar(64)
  userId    Int?
  user      AdminUser? @relation(fields: [userId], references: [id], onDelete: Cascade)
  username  String     @db.VarChar(64)
  expiresAt DateTime
}

model RainPulse {
  id            Int       @id @default(autoincrement())
  stationId     String    @default("default") @db.VarChar(64)
  eventUid      String    @unique @db.VarChar(128)
  mm            Float
  timestampUnix Int
  eventAt       DateTime
  queuedAt      DateTime?
  source        String    @default("raspberry") @db.VarChar(32)
}`;
