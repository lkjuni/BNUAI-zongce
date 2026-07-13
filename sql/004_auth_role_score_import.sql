CREATE TABLE IF NOT EXISTS auth_session (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME NOT NULL,
  revoked_at DATETIME NULL,
  ip_address VARCHAR(64) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_auth_session_token (token_hash),
  KEY idx_auth_session_user (user_id, expires_at),
  CONSTRAINT fk_auth_session_user
    FOREIGN KEY (user_id) REFERENCES system_user(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='登录会话';

CREATE TABLE IF NOT EXISTS score_import_batch (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  academic_year_id BIGINT NOT NULL,
  snapshot_id BIGINT NOT NULL,
  rule_node_id BIGINT NOT NULL,
  uploader_user_id BIGINT NOT NULL,
  uploader_role VARCHAR(50) NOT NULL,
  upload_scope VARCHAR(30) NOT NULL COMMENT 'committee/college',
  file_name VARCHAR(255) NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'processing' COMMENT 'processing/completed/failed',
  total_rows INT NOT NULL DEFAULT 0,
  success_rows INT NOT NULL DEFAULT 0,
  failed_rows INT NOT NULL DEFAULT 0,
  summary_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at DATETIME NULL,
  KEY idx_score_import_year_scope (academic_year_id, upload_scope, created_at),
  KEY idx_score_import_uploader (uploader_user_id, created_at),
  CONSTRAINT fk_score_import_year FOREIGN KEY (academic_year_id) REFERENCES academic_year(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_score_import_snapshot FOREIGN KEY (snapshot_id) REFERENCES academic_year_rule_snapshot(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_score_import_node FOREIGN KEY (rule_node_id) REFERENCES rule_node(id) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_score_import_user FOREIGN KEY (uploader_user_id) REFERENCES system_user(id) ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='学委和学院统一加分上传批次';

CREATE TABLE IF NOT EXISTS score_import_row (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_id BIGINT NOT NULL,
  row_no INT NOT NULL,
  student_no VARCHAR(50) NULL,
  student_id BIGINT NULL,
  title VARCHAR(200) NULL,
  imported_score DECIMAL(8,3) NULL,
  description TEXT NULL,
  status VARCHAR(30) NOT NULL COMMENT 'succeeded/failed',
  error_message VARCHAR(500) NULL,
  application_id BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_score_import_row_batch (batch_id, row_no),
  KEY idx_score_import_row_student (student_id),
  CONSTRAINT fk_score_import_row_batch FOREIGN KEY (batch_id) REFERENCES score_import_batch(id) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_score_import_row_student FOREIGN KEY (student_id) REFERENCES student_profile(id) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_score_import_row_application FOREIGN KEY (application_id) REFERENCES application_record(id) ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='统一加分上传逐行处理结果';
