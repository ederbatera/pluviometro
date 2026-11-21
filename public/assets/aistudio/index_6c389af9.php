<?php
date_default_timezone_set('America/Sao_Paulo');

// --- CONFIGURAÇÕES DO BANCO DE DADOS ---
$DB_HOST = 'mariadb';
$DB_NAME = 'pluviometro';
$DB_USER = 'root';
$DB_PASS = 'Mion@03122025';

function obterDadosPluviometro($host, $dbname, $user, $pass) {
    $pdo = new PDO(
        "mysql:host=$host;dbname=$dbname;charset=utf8mb4",
        $user,
        $pass,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    // Define as datas limite no PHP para o MariaDB usar os índices diretamente
    $inicioHoje   = date('Y-m-d 00:00:00');
    $inicio24h    = date('Y-m-d H:00:00', strtotime('-23 hours'));
    $inicioSemana = date('Y-m-d 00:00:00', strtotime('monday this week'));
    $inicioMes    = date('Y-m-01 00:00:00');
    $limiteBusca  = min($inicioMes, $inicioSemana, $inicio24h);

    // 1. Consulta ultra-rápida na tabela agregada por hora
    $sqlResumo = "
        SELECT
            COALESCE(SUM(CASE WHEN data_hora >= :hoje THEN total_mm ELSE 0 END), 0) AS hoje,
            COALESCE(SUM(CASE WHEN data_hora >= :h24 THEN total_mm ELSE 0 END), 0) AS ultimas_24h,
            COALESCE(SUM(CASE WHEN data_hora >= :semana THEN total_mm ELSE 0 END), 0) AS semana,
            COALESCE(SUM(CASE WHEN data_hora >= :mes THEN total_mm ELSE 0 END), 0) AS mes
        FROM pluviometro_horas
        WHERE data_hora >= :limite
    ";
    $stmt = $pdo->prepare($sqlResumo);
    $stmt->execute([
        ':hoje'   => $inicioHoje,
        ':h24'    => $inicio24h,
        ':semana' => $inicioSemana,
        ':mes'    => $inicioMes,
        ':limite' => $limiteBusca
    ]);
    $resumo = $stmt->fetch(PDO::FETCH_ASSOC);

    // 2. Último pulso e Intensidade (usam o índice idx_data_evento)
    $ultimoPulso = $pdo->query("SELECT MAX(data_evento) FROM pluviometro_pulsos")->fetchColumn();

    $sqlIntensidade = "
        SELECT COALESCE(SUM(mm) * 4, 0) 
        FROM pluviometro_pulsos 
        WHERE data_evento >= NOW() - INTERVAL 15 MINUTE
    ";
    $intensidade = (float)$pdo->query($sqlIntensidade)->fetchColumn();

    // 3. Gráfico das últimas 24h direto da tabela de horas
    $sqlGrafico = "
        SELECT data_hora, total_mm 
        FROM pluviometro_horas 
        WHERE data_hora >= :h24 
        ORDER BY data_hora ASC
    ";
    $stmtGraf = $pdo->prepare($sqlGrafico);
    $stmtGraf->execute([':h24' => $inicio24h]);
    $dadosBanco = $stmtGraf->fetchAll(PDO::FETCH_KEY_PAIR);

    // Preenche as 24 horas (colocando 0 nas horas sem chuva)
    $labelsGrafico = [];
    $valoresGrafico = [];
    for ($i = 23; $i >= 0; $i--) {
        $timestampHora = strtotime("-$i hours");
        $chave = date('Y-m-d H:00:00', $timestampHora);
        $labelsGrafico[] = date('H:00', $timestampHora);
        $valoresGrafico[] = isset($dadosBanco[$chave]) ? (float)$dadosBanco[$chave] : 0;
    }

    // Classificação da intensidade
    $statusChuva = "Sem chuva no momento";
    $corStatus = "#64748b";
    if ($intensidade > 0 && $intensidade < 2.5) {
        $statusChuva = "Chuva Fraca";
        $corStatus = "#0ea5e9";
    } elseif ($intensidade >= 2.5 && $intensidade < 10) {
        $statusChuva = "Chuva Moderada";
        $corStatus = "#2563eb";
    } elseif ($intensidade >= 10 && $intensidade < 50) {
        $statusChuva = "Chuva Forte";
        $corStatus = "#d97706";
    } elseif ($intensidade >= 50) {
        $statusChuva = "Chuva Torrencial";
        $corStatus = "#dc2626";
    }

    return [
        'ultimo_pulso' => $ultimoPulso ? date('d/m/Y H:i:s', strtotime($ultimoPulso)) : 'Nenhum dado',
        'intensidade'  => number_format($intensidade, 1, ',', '.'),
        'status_texto' => $statusChuva,
        'status_cor'   => $corStatus,
        'hoje'         => number_format((float)$resumo['hoje'], 1, ',', '.'),
        'ultimas_24h'  => number_format((float)$resumo['ultimas_24h'], 1, ',', '.'),
        'semana'       => number_format((float)$resumo['semana'], 1, ',', '.'),
        'mes'          => number_format((float)$resumo['mes'], 1, ',', '.'),
        'labels'       => $labelsGrafico,
        'valores'      => $valoresGrafico
    ];
}

try {
    $dados = obterDadosPluviometro($DB_HOST, $DB_NAME, $DB_USER, $DB_PASS);

    // Se a requisição vier do JavaScript (atualização em segundo plano), retorna apenas JSON
    if (isset($_GET['ajax']) && $_GET['ajax'] == '1') {
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($dados);
        exit;
    }
} catch (PDOException $e) {
    if (isset($_GET['ajax'])) {
        http_response_code(500);
        echo json_encode(['erro' => $e->getMessage()]);
        exit;
    }
    die("Erro ao conectar ao banco de dados: " . $e->getMessage());
}
?>
<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Estação Pluviométrica</title>
    <script src="https://jsdelivr.net"></script>
    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: #f1f5f9;
            color: #1e293b;
            margin: 0;
            padding: 20px;
        }
        .container {
            max-width: 1000px;
            margin: 0 auto;
        }
        header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            flex-wrap: wrap;
            margin-bottom: 24px;
            gap: 10px;
        }
        h1 {
            margin: 0;
            font-size: 1.5rem;
            color: #0f172a;
        }
        .ultima-atualizacao {
            font-size: 0.875rem;
            color: #64748b;
        }
        .grid-cards {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 16px;
            margin-bottom: 24px;
        }
        .card {
            background: #ffffff;
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
        .card-titulo {
            font-size: 0.85rem;
            text-transform: uppercase;
            letter-spacing: 0.05em;
            color: #64748b;
            margin-bottom: 8px;
        }
        .card-valor {
            font-size: 1.85rem;
            font-weight: 700;
            color: #0f172a;
        }
        .card-unidade {
            font-size: 1rem;
            font-weight: 500;
            color: #64748b;
        }
        .badge-status {
            display: inline-block;
            margin-top: 6px;
            padding: 3px 8px;
            border-radius: 6px;
            font-size: 0.75rem;
            font-weight: 600;
            color: #fff;
            background-color: <?= $dados['status_cor'] ?>;
            transition: background-color 0.3s ease;
        }
        .chart-box {
            background: #ffffff;
            padding: 20px;
            border-radius: 12px;
            box-shadow: 0 1px 3px rgba(0,0,0,0.1);
        }
    </style>
</head>
<body>

<div class="container">
    <header>
        <h1>Monitoramento Pluviométrico</h1>
        <div class="ultima-atualizacao">
            Último registro: <strong id="val-ultimo-pulso"><?= $dados['ultimo_pulso'] ?></strong>
        </div>
    </header>

    <div class="grid-cards">
        <div class="card">
            <div class="card-titulo">Intensidade Atual</div>
            <div class="card-valor"><span id="val-intensidade"><?= $dados['intensidade'] ?></span> <span class="card-unidade">mm/h</span></div>
            <span id="badge-status" class="badge-status"><?= $dados['status_texto'] ?></span>
        </div>

        <div class="card">
            <div class="card-titulo">Chuva Hoje</div>
            <div class="card-valor"><span id="val-hoje"><?= $dados['hoje'] ?></span> <span class="card-unidade">mm</span></div>
        </div>

        <div class="card">
            <div class="card-titulo">Últimas 24 Horas</div>
            <div class="card-valor"><span id="val-24h"><?= $dados['ultimas_24h'] ?></span> <span class="card-unidade">mm</span></div>
        </div>

        <div class="card">
            <div class="card-titulo">Semana Atual</div>
            <div class="card-valor"><span id="val-semana"><?= $dados['semana'] ?></span> <span class="card-unidade">mm</span></div>
        </div>

        <div class="card">
            <div class="card-titulo">Mês Atual</div>
            <div class="card-valor"><span id="val-mes"><?= $dados['mes'] ?></span> <span class="card-unidade">mm</span></div>
        </div>
    </div>

    <div class="chart-box">
        <div class="card-titulo" style="margin-bottom: 16px;">Precipitação por Hora (Últimas 24h)</div>
        <canvas id="graficoChuva" height="100"></canvas>
    </div>
</div>

<script>
    const ctx = document.getElementById('graficoChuva').getContext('2d');
    const grafico = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: <?= json_encode($dados['labels']) ?>,
            datasets: [{
                label: 'Chuva (mm)',
                data: <?= json_encode($dados['valores']) ?>,
                backgroundColor: '#0284c7',
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            plugins: {
                legend: { display: false }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    title: { display: true, text: 'Milímetros (mm)' }
                }
            }
        }
    });

    // Atualiza os dados silenciosamente a cada 60 segundos sem recarregar a página
    setInterval(async () => {
        try {
            const resposta = await fetch('?ajax=1');
            if (!resposta.ok) return;
            const novosDados = await resposta.json();

            document.getElementById('val-ultimo-pulso').textContent = novosDados.ultimo_pulso;