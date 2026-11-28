#!/usr/bin/env python3
"""
Pluviômetro Raspberry Pi — Envio Direto para MariaDB + Fila Local SQLite (WAL)
Usa SQLite exclusivamente como fila offline resiliente e grava diretamente no MariaDB
quando a rede/banco estão acessíveis.
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
from zoneinfo import ZoneInfo

from gpiozero import Button
import mysql.connector  # pip install mysql-connector-python


def load_local_env() -> None:
    env_path = Path(__file__).resolve().parent / ".env"
    if not env_path.is_file():
        return
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


load_local_env()

GPIO_PIN = int(os.environ.get("PLUVIOMETRO_GPIO", "17"))
BOUNCE_TIME = float(os.environ.get("PLUVIOMETRO_DEBOUNCE", "0.2"))
HW_BOUNCE_TIME = float(os.environ.get("PLUVIOMETRO_HW_BOUNCE", "0.005"))
MM_POR_PULSO = float(os.environ.get("PLUVIOMETRO_MM_POR_PULSO", "0.25"))
STATION_ID = os.environ.get("PLUVIOMETRO_STATION_ID", "default")
STATION_TZ = ZoneInfo(os.environ.get("TZ_STATION", "America/Sao_Paulo"))

MARIADB_HOST = os.environ.get("MARIADB_HOST", "mariadb")
MARIADB_PORT = int(os.environ.get("MARIADB_PORT", "3306"))
MARIADB_DATABASE = os.environ.get("MARIADB_DATABASE", "pluviometro")
MARIADB_USER = os.environ.get("MARIADB_USER", "root")
MARIADB_PASSWORD = os.environ.get("MARIADB_PASSWORD", "")

QUEUE_DB_PATH = os.environ.get("PLUVIOMETRO_QUEUE_DB", "./pluviometro_fila.db")
BACKOFF_STEPS = [2, 5, 15, 30, 60]

db_lock = threading.Lock()
pulse_lock = threading.Lock()
last_pulse_mono = 0.0
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
            queued_at_unix INTEGER NOT NULL
        );
        """
    )
    conn.commit()
    return conn


queue_conn = init_queue_db()


def enqueue_pulse() -> None:
    global last_pulse_mono
    now_mono = time.monotonic()
    with pulse_lock:
        if now_mono - last_pulse_mono < BOUNCE_TIME:
            return
        last_pulse_mono = now_mono
    now_unix = int(time.time())
    event_uid = f"{STATION_ID}:{now_unix}:{uuid.uuid4().hex[:8]}"
    with db_lock:
        queue_conn.execute(
            "INSERT INTO pulse_queue (event_uid, station_id, mm, timestamp_unix, queued_at_unix) VALUES (?, ?, ?, ?, ?)",
            (event_uid, STATION_ID, MM_POR_PULSO, now_unix, now_unix),
        )
        queue_conn.commit()
    wake_event.set()


def flush_to_mariadb() -> None:
    if not MARIADB_PASSWORD:
        print("[AVISO] Defina MARIADB_PASSWORD no ambiente para gravar diretamente no MariaDB.")

    failure_count = 0
    while not stop_event.is_set():
        with db_lock:
            rows = queue_conn.execute(
                "SELECT id, event_uid, station_id, mm, timestamp_unix, queued_at_unix FROM pulse_queue ORDER BY id ASC LIMIT 50"
            ).fetchall()

        if not rows or not MARIADB_PASSWORD:
            wake_event.wait(timeout=15)
            wake_event.clear()
            continue

        try:
            conn = mysql.connector.connect(
                host=MARIADB_HOST,
                port=MARIADB_PORT,
                database=MARIADB_DATABASE,
                user=MARIADB_USER,
                password=MARIADB_PASSWORD,
                connection_timeout=5,
            )
            cur = conn.cursor()
            synced_ids: list[int] = []

            for row_id, event_uid, station_id, mm, ts_unix, queued_unix in rows:
                event_utc = datetime.fromtimestamp(ts_unix, tz=timezone.utc)
                local_dt = event_utc.astimezone(STATION_TZ)
                hour_key = local_dt.strftime("%Y-%m-%dT%H")
                day_key = local_dt.strftime("%Y-%m-%d")
                event_dt_naive = event_utc.replace(tzinfo=None)
                queued_dt_naive = datetime.fromtimestamp(queued_unix, tz=timezone.utc).replace(tzinfo=None)
                hour_start = event_dt_naive.replace(minute=0, second=0, microsecond=0)
                day_start = datetime(local_dt.year, local_dt.month, local_dt.day)
                source = "queue_replay" if int(time.time()) - queued_unix > 10 else "raspberry"

                cur.execute(
                    """
                    INSERT IGNORE INTO RainPulse
                        (stationId, eventUid, mm, timestampUnix, eventAt, queuedAt, source)
                    VALUES (%s, %s, %s, %s, %s, %s, %s)
                    """,
                    (station_id, event_uid, mm, ts_unix, event_dt_naive, queued_dt_naive, source),
                )

                if cur.rowcount > 0:
                    cur.execute(
                        """
                        INSERT INTO HourlySummary (stationId, hourKey, hourStart, totalMm, pulseCount, updatedAt)
                        VALUES (%s, %s, %s, %s, 1, UTC_TIMESTAMP(3))
                        ON DUPLICATE KEY UPDATE
                            totalMm = totalMm + VALUES(totalMm),
                            pulseCount = pulseCount + 1,
                            updatedAt = UTC_TIMESTAMP(3)
                        """,
                        (station_id, hour_key, hour_start, mm),
                    )
                    cur.execute(
                        """
                        INSERT INTO DailySummary (stationId, dayKey, dayStart, totalMm, pulseCount, peakIntensityMm, updatedAt)
                        VALUES (%s, %s, %s, %s, 1, %s, UTC_TIMESTAMP(3))
                        ON DUPLICATE KEY UPDATE
                            totalMm = totalMm + VALUES(totalMm),
                            pulseCount = pulseCount + 1,
                            updatedAt = UTC_TIMESTAMP(3)
                        """,
                        (station_id, day_key, day_start, mm, mm),
                    )

                synced_ids.append(row_id)

            conn.commit()
            cur.close()
            conn.close()

            placeholders = ",".join("?" for _ in synced_ids)
            with db_lock:
                queue_conn.execute(f"DELETE FROM pulse_queue WHERE id IN ({placeholders})", synced_ids)
                queue_conn.commit()
            failure_count = 0
            print(f"[MARIADB SYNC] {len(synced_ids)} pulso(s) gravado(s) e removidos da fila SQLite.")
        except Exception as exc:
            failure_count += 1
            print(f"[OFFLINE MARIADB] {exc}. Dados preservados na fila SQLite.")
            wait_seconds = BACKOFF_STEPS[min(failure_count - 1, len(BACKOFF_STEPS) - 1)]
            stop_event.wait(timeout=wait_seconds)


def handle_exit(_signum, _frame) -> None:
    stop_event.set()
    wake_event.set()
    sys.exit(0)


if __name__ == "__main__":
    signal.signal(signal.SIGINT, handle_exit)
    signal.signal(signal.SIGTERM, handle_exit)

    threading.Thread(target=flush_to_mariadb, daemon=True).start()
    hw_bounce = HW_BOUNCE_TIME if HW_BOUNCE_TIME > 0 else None
    sensor = Button(GPIO_PIN, pull_up=True, bounce_time=hw_bounce)
    sensor.when_pressed = enqueue_pulse

    print(f"Monitorando GPIO {GPIO_PIN} -> Fila SQLite -> MariaDB ({MARIADB_HOST}/{MARIADB_DATABASE})")
    while not stop_event.is_set():
        stop_event.wait(timeout=60)
