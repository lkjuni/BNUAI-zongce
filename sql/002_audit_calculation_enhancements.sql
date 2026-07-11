USE bnuai_zongce;

DELIMITER //

DROP PROCEDURE IF EXISTS add_column_if_missing//
CREATE PROCEDURE add_column_if_missing(
  IN p_table_name VARCHAR(64),
  IN p_column_name VARCHAR(64),
  IN p_column_definition TEXT
)
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = DATABASE()
      AND table_name = p_table_name
      AND column_name = p_column_name
  ) THEN
    SET @ddl = CONCAT('ALTER TABLE ', p_table_name, ' ADD COLUMN ', p_column_name, ' ', p_column_definition);
    PREPARE stmt FROM @ddl;
    EXECUTE stmt;
    DEALLOCATE PREPARE stmt;
  END IF;
END//

DELIMITER ;

CALL add_column_if_missing('rule_node', 'allow_repeat', "TINYINT(1) NOT NULL DEFAULT 1 COMMENT 'whether repeated applications are allowed'");
CALL add_column_if_missing('rule_node', 'duplicate_check_type', "VARCHAR(50) NULL COMMENT 'duplicate check type'");
CALL add_column_if_missing('rule_node', 'duplicate_check_config_json', "JSON NULL COMMENT 'duplicate check config'");
CALL add_column_if_missing('rule_node', 'apply_start_time', "DATETIME NULL COMMENT 'node-level apply start time'");
CALL add_column_if_missing('rule_node', 'apply_end_time', "DATETIME NULL COMMENT 'node-level apply end time'");
CALL add_column_if_missing('rule_node', 'submitter_type', "VARCHAR(30) NOT NULL DEFAULT 'student' COMMENT 'student/admin/system'");

CALL add_column_if_missing('application_record', 'current_revision_no', "INT NOT NULL DEFAULT 0 COMMENT 'current submitted revision number'");
CALL add_column_if_missing('application_record', 'audit_stage', "VARCHAR(30) NULL COMMENT 'class_review/college_review/final'");
CALL add_column_if_missing('application_record', 'current_auditor_role', "VARCHAR(50) NULL COMMENT 'current pending auditor role'");
CALL add_column_if_missing('application_record', 'returned_at', "DATETIME NULL COMMENT 'returned time'");
CALL add_column_if_missing('application_record', 'returned_by', "BIGINT NULL COMMENT 'return operator id'");
CALL add_column_if_missing('application_record', 'return_reason', "TEXT NULL COMMENT 'return reason'");
CALL add_column_if_missing('application_record', 'approved_at', "DATETIME NULL COMMENT 'approved time'");
CALL add_column_if_missing('application_record', 'approved_by', "BIGINT NULL COMMENT 'approver id'");
CALL add_column_if_missing('application_record', 'rejected_at', "DATETIME NULL COMMENT 'rejected time'");
CALL add_column_if_missing('application_record', 'rejected_by', "BIGINT NULL COMMENT 'reject operator id'");
CALL add_column_if_missing('application_record', 'reject_reason', "TEXT NULL COMMENT 'reject reason'");

CALL add_column_if_missing('application_attachment', 'revision_no', "INT NULL COMMENT 'application revision number'");
CALL add_column_if_missing('application_attachment', 'status', "VARCHAR(30) NOT NULL DEFAULT 'active' COMMENT 'active/replaced/deleted'");
CALL add_column_if_missing('application_attachment', 'file_size', "BIGINT NULL COMMENT 'file size'");
CALL add_column_if_missing('application_attachment', 'mime_type', "VARCHAR(100) NULL COMMENT 'mime type'");
CALL add_column_if_missing('application_attachment', 'storage_key', "VARCHAR(500) NULL COMMENT 'object storage key'");
CALL add_column_if_missing('application_attachment', 'review_result', "VARCHAR(30) NULL COMMENT 'pending/valid/invalid/unclear'");
CALL add_column_if_missing('application_attachment', 'review_comment', "TEXT NULL COMMENT 'attachment review comment'");

DROP PROCEDURE IF EXISTS add_column_if_missing;

CREATE TABLE IF NOT EXISTS application_revision (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  application_id BIGINT NOT NULL,
  revision_no INT NOT NULL,
  submit_type VARCHAR(30) NOT NULL COMMENT 'initial/resubmit/supplement/import',
  field_values_json JSON NULL,
  attachment_snapshot_json JSON NULL,
  member_snapshot_json JSON NULL,
  submitted_by BIGINT NULL,
  submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_app_revision (application_id, revision_no),
  CONSTRAINT fk_revision_app
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='application submission revision';

CREATE TABLE IF NOT EXISTS application_operation_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  application_id BIGINT NOT NULL,
  operator_id BIGINT NOT NULL,
  operation_type VARCHAR(30) NOT NULL COMMENT 'create/save/submit/withdraw/resubmit/return/approve/reject',
  operation_detail_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_app_op_log (application_id, created_at),
  CONSTRAINT fk_app_op_log_app
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='application operation log';

CREATE TABLE IF NOT EXISTS audit_task (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  academic_year_id BIGINT NOT NULL,
  rule_node_id BIGINT NULL,
  audit_role VARCHAR(50) NOT NULL COMMENT 'class_committee/college_admin/system',
  assignee_id BIGINT NOT NULL,
  scope_type VARCHAR(30) NULL COMMENT 'class/major/grade/rule_node/all',
  scope_value VARCHAR(100) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_task_year_role (academic_year_id, audit_role, status),
  CONSTRAINT fk_audit_task_year
    FOREIGN KEY (academic_year_id) REFERENCES academic_year(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_audit_task_rule_node
    FOREIGN KEY (rule_node_id) REFERENCES rule_node(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='audit task assignment';

CREATE TABLE IF NOT EXISTS attachment_review_record (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  attachment_id BIGINT NOT NULL,
  reviewer_id BIGINT NOT NULL,
  review_result VARCHAR(30) NOT NULL COMMENT 'valid/invalid/unclear',
  review_comment TEXT NULL,
  reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_attachment_review (attachment_id, reviewed_at),
  CONSTRAINT fk_attachment_review_attachment
    FOREIGN KEY (attachment_id) REFERENCES application_attachment(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='attachment-level review record';

CREATE TABLE IF NOT EXISTS audit_batch (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  academic_year_id BIGINT NOT NULL,
  audit_role VARCHAR(50) NOT NULL,
  action VARCHAR(30) NOT NULL COMMENT 'approve/reject/return',
  operator_id BIGINT NOT NULL,
  application_count INT NOT NULL DEFAULT 0,
  comment TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_batch_year
    FOREIGN KEY (academic_year_id) REFERENCES academic_year(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='batch audit operation';

CREATE TABLE IF NOT EXISTS formula_template (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  formula_code VARCHAR(100) NOT NULL UNIQUE,
  formula_name VARCHAR(100) NOT NULL,
  description TEXT NULL,
  input_schema_json JSON NULL,
  output_schema_json JSON NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='controlled formula template';

CREATE TABLE IF NOT EXISTS calculation_task (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_id BIGINT NOT NULL,
  academic_year_id BIGINT NOT NULL,
  student_id BIGINT NULL,
  task_type VARCHAR(30) NOT NULL COMMENT 'student/full/recalculate',
  status VARCHAR(30) NOT NULL DEFAULT 'pending',
  error_message TEXT NULL,
  started_at DATETIME NULL,
  finished_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_calc_task_batch (batch_id, status),
  CONSTRAINT fk_calc_task_batch
    FOREIGN KEY (batch_id) REFERENCES score_calculation_batch(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_calc_task_year
    FOREIGN KEY (academic_year_id) REFERENCES academic_year(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='calculation task';

CREATE TABLE IF NOT EXISTS calculation_error (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_id BIGINT NOT NULL,
  student_id BIGINT NULL,
  application_id BIGINT NULL,
  rule_node_id BIGINT NULL,
  error_type VARCHAR(50) NOT NULL,
  error_message TEXT NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_calc_error_batch (batch_id),
  CONSTRAINT fk_calc_error_batch
    FOREIGN KEY (batch_id) REFERENCES score_calculation_batch(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_calc_error_app
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_calc_error_node
    FOREIGN KEY (rule_node_id) REFERENCES rule_node(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='calculation error';

CREATE TABLE IF NOT EXISTS calculation_warning (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_id BIGINT NOT NULL,
  student_id BIGINT NULL,
  application_id BIGINT NULL,
  rule_node_id BIGINT NULL,
  warning_type VARCHAR(50) NOT NULL,
  warning_message TEXT NOT NULL,
  severity VARCHAR(20) NOT NULL DEFAULT 'info',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_calc_warning_batch (batch_id),
  CONSTRAINT fk_calc_warning_batch
    FOREIGN KEY (batch_id) REFERENCES score_calculation_batch(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_calc_warning_app
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_calc_warning_node
    FOREIGN KEY (rule_node_id) REFERENCES rule_node(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='calculation warning';

INSERT IGNORE INTO formula_template
  (formula_code, formula_name, description, input_schema_json, output_schema_json)
VALUES
  ('BASE_SCORE_TIMES_WEIGHT', 'base score times weight', 'Score equals base score multiplied by configured weight.', '{"base_score":"number","weight":"number"}', '{"score":"number"}'),
  ('POSITION_SCORE_BY_WEIGHT', 'position score by evaluation weight', 'Position score equals base position score multiplied by evaluation weight.', '{"base_score":"number","evaluation_weight":"number"}', '{"score":"number"}'),
  ('LEVEL_SCORE', 'level score', 'Score is selected from a configured level list.', '{"level":"string"}', '{"score":"number"}'),
  ('FIXED_SCORE', 'fixed score', 'Score is configured as a fixed value.', '{"score":"number"}', '{"score":"number"}');

