<?php
// Define o fuso horário para o Brasil
date_default_timezone_set('America/Sao_Paulo');
header('Content-Type: application/json; charset=utf-8');

// --- CONFIGURAÇÕES ---
$API_KEY_ESPERADA = '4OSAG8W9DR28DHPM1I6JUTTMNP6OH06MJWP5';
$DB_HOST = 'mariadb';
$DB_NAME = 'pluviometro';
$DB_USER = 'root';
$DB_PASS = 'Mion@03122025';

// 1. Verifica se o método é POST
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['erro' => 'Metodo nao permitido']);
    exit;
}

// 2. Lê os cabeçalhos (compatível com Apache, Nginx e PHP-FPM)
$headers = array_change_key_case(getallheaders(), CASE_LOWER);
$apiKeyRecebida = $headers['apikey'] ?? '';

if (!hash_equals($API_KEY_ESPERADA, $apiKeyRecebida)) {
    http_response_code(401);
    echo json_encode(['erro' => 'Nao autorizado']);
    exit;
}

// 3. Lê e valida o JSON recebido
$jsonBruto = file_get_contents('php://input');
$dados = json_decode($jsonBruto, true);

if (!is_array($dados) || !isset($dados['mm'], $dados['timestamp'])) {
    http_response_code(400);
    echo json_encode(['erro' => 'Payload JSON invalido ou incompleto']);
    exit;
}

$mm = (float) $dados['mm'];
$timestampUnix = (int) $dados['timestamp'];

// Converte o timestamp Unix do Raspberry Pi para DATETIME do MariaDB
$dataEvento = date('Y-m-d H:i:s', $timestampUnix);

// 4. Grava no MariaDB
try {
    $pdo = new PDO(
        "mysql:host=$DB_HOST;dbname=$DB_NAME;charset=utf8mb4",
        $DB_USER,
        $DB_PASS,
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]
    );

    // 1. Grava o pulso bruto (mantém o histórico exato de cada basculada)
    $sql = "INSERT IGNORE INTO pluviometro_pulsos (mm, timestamp_unix, data_evento) 
            VALUES (:mm, :ts, :data_evento)";
    $stmt = $pdo->prepare($sql);
    $stmt->execute([
        ':mm' => $mm,
        ':ts' => $timestampUnix,
        ':data_evento' => $dataEvento
    ]);

    // 2. Se o pulso não era duplicado, soma na tabela de resumo por hora
    if ($stmt->rowCount() > 0) {
        $horaCheia = date('Y-m-d H:00:00', $timestampUnix);
        $sqlResumo = "INSERT INTO pluviometro_horas (data_hora, total_mm, qtd_pulsos) 
                      VALUES (:hora, :mm, 1)
                      ON DUPLICATE KEY UPDATE 
                          total_mm = total_mm + VALUES(total_mm),
                          qtd_pulsos = qtd_pulsos + 1";
        $stmtResumo = $pdo->prepare($sqlResumo);
        $stmtResumo->execute([
            ':hora' => $horaCheia,
            ':mm' => $mm
        ]);
    }


    http_response_code(200);
    echo json_encode([
        'status' => 'sucesso',
        'data_gravada' => $dataEvento
    ]);

} catch (PDOException $e) {
    http_response_code(500);
    echo json_encode(['erro' => 'Falha ao gravar no banco de dados']);
}
