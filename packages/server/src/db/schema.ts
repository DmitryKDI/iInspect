/**
 * Схема базы данных.
 *
 * Шестнадцать таблиц раздела 10 ТЗ названы и собраны так, как в ТЗ:
 * params, checks, objects, files, protocols, rejection_log, dispute_log,
 * suspicions, logical_rules, normative_base, ml_retraining_log, audit_log,
 * monitoring_metrics, evidence_fragments, dataset_items, model_versions.
 * Остальные таблицы — служебные: пользователи и сессии (ТЗ 12, п.1–2),
 * процессы проверки (ТЗ 1.4), решения инспектора (ТЗ 9.3), события протокола,
 * выпуски набора данных, задачи очереди и уведомления.
 *
 * Поля JSON хранятся текстом; даты — ISO 8601 в UTC.
 */
export const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    full_name TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    last_login_at TEXT
  );
  CREATE TABLE auth_sessions (
    id INTEGER PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    matrix_revision INTEGER NOT NULL DEFAULT 0,
    max_upload_mb INTEGER NOT NULL DEFAULT 50,
    max_package_mb INTEGER NOT NULL DEFAULT 200,
    max_pages INTEGER NOT NULL DEFAULT 5000,
    retention_days INTEGER NOT NULL DEFAULT 90
  );

  -- 1. Params — матрица контроля (ТЗ 8.1)
  CREATE TABLE params (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    section TEXT NOT NULL,
    parameter_name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    unit TEXT NOT NULL DEFAULT '',
    source_pd TEXT NOT NULL DEFAULT '',
    source_rd TEXT NOT NULL DEFAULT '',
    source_id TEXT NOT NULL DEFAULT '',
    trigger_logic TEXT NOT NULL DEFAULT '',
    review_priority TEXT NOT NULL DEFAULT 'MEDIUM',
    sp_reference TEXT NOT NULL DEFAULT '',
    gost_reference TEXT NOT NULL DEFAULT '',
    fz_reference TEXT NOT NULL DEFAULT '',
    other_normative TEXT NOT NULL DEFAULT '',
    data_type TEXT NOT NULL DEFAULT 'string',
    min_value REAL,
    max_value REAL,
    regex_pattern TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 3. Objects — объекты капитального строительства
  CREATE TABLE objects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    address TEXT NOT NULL DEFAULT '',
    customer TEXT NOT NULL DEFAULT '',
    contractor TEXT NOT NULL DEFAULT '',
    permit_number TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  -- 4. Files — загруженные файлы и реестр (перечень ИД, ред. 1.1)
  CREATE TABLE files (
    id INTEGER PRIMARY KEY,
    object_id TEXT,
    file_id TEXT,
    file_name TEXT NOT NULL,
    doc_stage TEXT,
    discipline TEXT,
    document_code TEXT,
    revision TEXT,
    approval_status TEXT,
    approval_date TEXT,
    predecessor_id INTEGER REFERENCES files(id),
    successor_id INTEGER REFERENCES files(id),
    signature_status TEXT,
    sheet_page_range TEXT,
    file_hash TEXT NOT NULL,
    file_path TEXT NOT NULL,
    source_format TEXT NOT NULL,
    -- Производный файл для разбора: DXF, приведённый из DWG/DXF (ТЗ 11, п.8).
    derived_hash TEXT,
    derived_format TEXT,
    size INTEGER NOT NULL,
    pages INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'PARSING',
    parse_error TEXT,
    parse_info TEXT NOT NULL DEFAULT '{}',
    metadata_version INTEGER NOT NULL DEFAULT 0,
    uploaded_at TEXT NOT NULL
  );
  CREATE INDEX files_object ON files(object_id);
  CREATE INDEX files_hash ON files(file_hash);
  CREATE TABLE file_metadata_events (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id),
    version INTEGER NOT NULL,
    snapshot TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- Процесс проверки (ТЗ 1.4: process_id, pull-модель)
  CREATE TABLE processes (
    id INTEGER PRIMARY KEY,
    object_id TEXT NOT NULL,
    run_state TEXT NOT NULL DEFAULT 'queued',
    stage TEXT NOT NULL DEFAULT '',
    completed INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    input_snapshot TEXT NOT NULL DEFAULT '[]',
    result TEXT,
    error TEXT,
    cancelled_at TEXT,
    finalized_at TEXT,
    finalized_by TEXT NOT NULL DEFAULT '',
    sync_status TEXT NOT NULL DEFAULT 'NOT_SENT',
    sync_package TEXT,
    sync_key TEXT NOT NULL DEFAULT '',
    sync_attempts INTEGER NOT NULL DEFAULT 0,
    sync_next_at TEXT,
    pending_documents TEXT NOT NULL DEFAULT '[]',
    model_version TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  -- 5. Protocols — версии протоколов (ТЗ 9.2, п.5)
  CREATE TABLE protocols (
    id INTEGER PRIMARY KEY,
    process_id INTEGER NOT NULL REFERENCES processes(id),
    object_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    matrix_version TEXT NOT NULL DEFAULT '',
    dataset_version TEXT NOT NULL DEFAULT '',
    model_version TEXT NOT NULL DEFAULT '',
    input_manifest_hash TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    result TEXT,
    input_snapshot TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    finalized_at TEXT,
    UNIQUE (process_id, version)
  );

  -- 2. Checks — результаты извлечения и сопоставления
  CREATE TABLE checks (
    id INTEGER PRIMARY KEY,
    protocol_id INTEGER NOT NULL REFERENCES protocols(id),
    param_id INTEGER REFERENCES params(id),
    object_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    parameter_code TEXT NOT NULL DEFAULT '',
    expected_value TEXT,
    actual_value TEXT,
    delta REAL,
    completeness_status TEXT,
    finding_status TEXT,
    technical_status TEXT,
    review_priority TEXT,
    evidence_group_id TEXT,
    explanation TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX checks_protocol ON checks(protocol_id);

  -- 14. Evidence_Fragments — доказательные фрагменты и координаты
  CREATE TABLE evidence_fragments (
    id INTEGER PRIMARY KEY,
    protocol_id INTEGER NOT NULL REFERENCES protocols(id),
    finding_id TEXT NOT NULL,
    evidence_group_id TEXT NOT NULL,
    file_id TEXT,
    document_id INTEGER,
    sha256 TEXT,
    stage TEXT,
    sheet_page INTEGER,
    bbox_polygon_norm TEXT,
    extracted_value TEXT,
    quote TEXT,
    role_expected_actual TEXT
  );
  CREATE INDEX evidence_group ON evidence_fragments(evidence_group_id);

  -- Решения инспектора (ТЗ 9.3): версионируются, не перезаписываются
  CREATE TABLE inspector_decisions (
    id INTEGER PRIMARY KEY,
    process_id INTEGER NOT NULL REFERENCES processes(id),
    version INTEGER NOT NULL,
    finding_id TEXT NOT NULL,
    status TEXT NOT NULL,
    author TEXT NOT NULL,
    user_id INTEGER,
    reason TEXT NOT NULL,
    reason_code TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE (process_id, version)
  );
  CREATE TABLE protocol_events (
    id INTEGER PRIMARY KEY,
    process_id INTEGER NOT NULL REFERENCES processes(id),
    action TEXT NOT NULL,
    author TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  -- 6. Rejection_Log и 7. Dispute_Log
  CREATE TABLE rejection_log (
    id INTEGER PRIMARY KEY,
    process_id INTEGER NOT NULL REFERENCES processes(id),
    violation_id TEXT NOT NULL,
    parameter_code TEXT NOT NULL DEFAULT '',
    rejection_reason TEXT NOT NULL DEFAULT '',
    inspector_comment TEXT NOT NULL DEFAULT '',
    ai_verdict TEXT NOT NULL DEFAULT '',
    suggested_fix TEXT NOT NULL DEFAULT '',
    retraining_status TEXT NOT NULL DEFAULT 'PENDING',
    created_at TEXT NOT NULL
  );
  CREATE TABLE dispute_log (
    id INTEGER PRIMARY KEY,
    process_id INTEGER NOT NULL REFERENCES processes(id),
    violation_id TEXT NOT NULL,
    inspector_comment TEXT NOT NULL DEFAULT '',
    ai_comment TEXT NOT NULL DEFAULT '',
    resolution_status TEXT NOT NULL DEFAULT 'OPEN',
    resolved_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    resolved_at TEXT
  );

  -- 8. Suspicions — гипотезы свободного поиска (ТЗ 9.5)
  CREATE TABLE suspicions (
    id INTEGER PRIMARY KEY,
    object_id TEXT NOT NULL,
    process_id INTEGER NOT NULL REFERENCES processes(id),
    discovery_method TEXT NOT NULL,
    confidence REAL,
    description TEXT NOT NULL,
    pd_reference TEXT NOT NULL DEFAULT '',
    rd_reference TEXT NOT NULL DEFAULT '',
    review_priority TEXT NOT NULL DEFAULT 'MEDIUM',
    normative_base TEXT NOT NULL DEFAULT '',
    parameter_code TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '[]',
    finding_status TEXT NOT NULL DEFAULT 'SUSPICION',
    inspector_status TEXT NOT NULL DEFAULT 'PENDING',
    inspector_comment TEXT NOT NULL DEFAULT '',
    reviewed_by INTEGER,
    reviewed_at TEXT,
    created_at TEXT NOT NULL
  );

  -- 9. Logical_Rules и 10. Normative_Base
  CREATE TABLE logical_rules (
    id INTEGER PRIMARY KEY,
    rule_name TEXT NOT NULL,
    condition TEXT NOT NULL,
    expected TEXT NOT NULL,
    normative_base TEXT NOT NULL DEFAULT '',
    review_priority TEXT NOT NULL DEFAULT 'MEDIUM',
    is_active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE normative_base (
    id INTEGER PRIMARY KEY,
    document_name TEXT NOT NULL,
    document_number TEXT NOT NULL,
    section TEXT NOT NULL DEFAULT '',
    parameter_name TEXT NOT NULL DEFAULT '',
    min_value REAL,
    max_value REAL,
    effective_from TEXT,
    effective_to TEXT,
    is_active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  );

  -- 15. Dataset_Items — эталонные метки и выборка (ТЗ 9.4, 14)
  CREATE TABLE dataset_items (
    id INTEGER PRIMARY KEY,
    process_id INTEGER NOT NULL REFERENCES processes(id),
    object_id TEXT NOT NULL,
    object_group_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    parameter_code TEXT NOT NULL DEFAULT '',
    evidence_group_id TEXT NOT NULL DEFAULT '',
    gold_label TEXT NOT NULL,
    expert_id INTEGER,
    reason_code TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    decision_version INTEGER NOT NULL,
    machine_status TEXT NOT NULL DEFAULT '',
    evidence TEXT NOT NULL DEFAULT '[]',
    source_versions TEXT NOT NULL DEFAULT '{}',
    record TEXT NOT NULL DEFAULT '{}',
    dataset_version TEXT NOT NULL DEFAULT '',
    split TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'DRAFT',
    curated_by INTEGER,
    curated_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (process_id, finding_id)
  );
  CREATE TABLE object_splits (
    object_id TEXT PRIMARY KEY,
    split TEXT NOT NULL,
    assigned_at TEXT NOT NULL
  );
  CREATE TABLE dataset_versions (
    id INTEGER PRIMARY KEY,
    version TEXT NOT NULL UNIQUE,
    matrix_version TEXT NOT NULL DEFAULT '',
    item_ids TEXT NOT NULL DEFAULT '[]',
    split_hashes TEXT NOT NULL DEFAULT '{}',
    counts TEXT NOT NULL DEFAULT '{}',
    created_by INTEGER,
    created_at TEXT NOT NULL
  );

  -- 11. ML_Retraining_Log — итерации дообучения
  CREATE TABLE ml_retraining_log (
    id INTEGER PRIMARY KEY,
    model_version TEXT NOT NULL UNIQUE,
    dataset_version TEXT NOT NULL,
    matrix_version TEXT NOT NULL DEFAULT '',
    split_hashes TEXT NOT NULL DEFAULT '{}',
    precision REAL,
    recall REAL,
    f1 REAL,
    false_positive_rate REAL,
    per_category_metrics TEXT NOT NULL DEFAULT '{}',
    training_params TEXT NOT NULL DEFAULT '{}',
    code_ref TEXT NOT NULL DEFAULT '',
    previous_model TEXT NOT NULL DEFAULT '',
    acceptance TEXT NOT NULL DEFAULT '{}',
    approval_status TEXT NOT NULL DEFAULT 'PENDING',
    approved_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );

  -- 16. Model_Versions — реестр моделей и допуска в контур
  CREATE TABLE model_versions (
    id INTEGER PRIMARY KEY,
    model_version TEXT NOT NULL UNIQUE,
    artifact_hash TEXT NOT NULL DEFAULT '',
    dataset_version TEXT NOT NULL,
    metrics_json TEXT NOT NULL DEFAULT '{}',
    approval_status TEXT NOT NULL DEFAULT 'PENDING',
    approved_by TEXT NOT NULL DEFAULT '',
    approved_at TEXT,
    deployed_at TEXT,
    rollback_to TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE weekly_reports (
    id INTEGER PRIMARY KEY,
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  -- 12. Audit_Log — журнал аудита (ТЗ 12, п.4)
  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER,
    login TEXT NOT NULL DEFAULT '',
    action TEXT NOT NULL,
    object_id TEXT NOT NULL DEFAULT '',
    details TEXT NOT NULL DEFAULT '{}',
    status_code INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL,
    ip_address TEXT NOT NULL DEFAULT '',
    user_agent TEXT NOT NULL DEFAULT ''
  );
  CREATE INDEX audit_timestamp ON audit_log(timestamp);
  -- Журнал только дополняется (ТЗ 7, модуль 9): правка и удаление запрещены.
  CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit_log
    BEGIN SELECT RAISE(ABORT, 'журнал аудита только дополняется'); END;
  CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit_log
    WHEN OLD.timestamp >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-365 days')
    BEGIN SELECT RAISE(ABORT, 'журнал аудита только дополняется'); END;

  -- 13. Monitoring_Metrics — метрики производительности
  CREATE TABLE monitoring_metrics (
    id INTEGER PRIMARY KEY,
    metric_name TEXT NOT NULL,
    value REAL NOT NULL,
    timestamp TEXT NOT NULL,
    service_name TEXT NOT NULL,
    tags TEXT NOT NULL DEFAULT '{}'
  );
  CREATE INDEX metrics_time ON monitoring_metrics(timestamp);

  CREATE TABLE integrity_checks (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    checked INTEGER NOT NULL DEFAULT 0,
    failures TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'RUNNING'
  );

  -- Задачи очереди сообщений: таймаут, повторы (ТЗ 9.1)
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    ref_id INTEGER NOT NULL,
    attempt INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'QUEUED',
    payload TEXT NOT NULL,
    deadline TEXT NOT NULL,
    error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_status ON tasks(status, deadline);

  -- Уведомления (ТЗ 9.2, п.5; 9.1: уведомление администратора; 9.6)
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    audience TEXT NOT NULL,
    kind TEXT NOT NULL,
    process_id INTEGER,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    read_at TEXT
  );
  `,
  `
  -- Разделение составного кандидата на атомарные findings (ТЗ 9.3, п.2)
  CREATE TABLE finding_splits (
    process_id INTEGER NOT NULL REFERENCES processes(id),
    finding_id TEXT NOT NULL,
    parts TEXT NOT NULL,
    reason TEXT NOT NULL,
    author TEXT NOT NULL,
    user_id INTEGER,
    created_at TEXT NOT NULL,
    PRIMARY KEY (process_id, finding_id)
  );
  `,
]
