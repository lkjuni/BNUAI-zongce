ALTER TABLE rule_node
  ALTER COLUMN allow_repeat SET DEFAULT 0;

ALTER TABLE application_record
  ADD COLUMN rule_item_code VARCHAR(100) NULL AFTER rule_node_id;

UPDATE application_record a
JOIN rule_node n ON n.id = a.rule_node_id
SET a.rule_item_code = n.code
WHERE a.rule_item_code IS NULL;

ALTER TABLE application_record
  MODIFY COLUMN rule_item_code VARCHAR(100) NOT NULL COMMENT '跨规则版本稳定的规则项编码，用于保证每学年只申报一次',
  ADD UNIQUE KEY uk_app_year_student_rule_item (academic_year_id, student_id, rule_item_code);
