from gpiozero import Button
import requests
import time

# Configura o GPIO 17 com resistor pull-up interno e debounce de 0.2 segundos
sensor = Button(17, pull_up=True, bounce_time=0.2)

WEBHOOK_URL = "https://seu-webhook.com"
MM_POR_PULSO = 0.25  # Ajuste conforme a calibração do seu pluviômetro

def registrar_pulso():
    print("Pulso detectado! Enviando dados...")
    payload = {
        "evento": "chuva",
        "mm": MM_POR_PULSO,
        "timestamp": int(time.time())
    }
    try:
        resposta = requests.post(WEBHOOK_URL, json=payload, timeout=5)
        print(f"Enviado! Status: {resposta.status_code}")
    except Exception as e:
        print(f"Erro ao enviar para o webhook: {e}")

# Associa a função ao momento em que o circuito fecha
sensor.when_pressed = registrar_pulso

print("Monitorando pluviômetro...")
# Mantém o script rodando consumindo quase zero de CPU
while True:
    time.sleep(60)
