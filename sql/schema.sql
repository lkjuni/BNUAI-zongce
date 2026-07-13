CREATE DATABASE IF NOT EXISTS bnuai_zongce
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_0900_ai_ci;

USE bnuai_zongce;

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

DROP TABLE IF EXISTS appeal_process_record;
DROP TABLE IF EXISTS appeal_record;
DROP TABLE IF EXISTS score_import_row;
DROP TABLE IF EXISTS score_import_batch;
DROP TABLE IF EXISTS auth_session;
DROP TABLE IF EXISTS publicity_result;
DROP TABLE IF EXISTS publicity_batch;
DROP TABLE IF EXISTS calculation_warning;
DROP TABLE IF EXISTS calculation_error;
DROP TABLE IF EXISTS calculation_task;
DROP TABLE IF EXISTS formula_template;
DROP TABLE IF EXISTS score_change_record;
DROP TABLE IF EXISTS score_total_result;
DROP TABLE IF EXISTS score_node_result;
DROP TABLE IF EXISTS score_item_result;
DROP TABLE IF EXISTS score_calculation_batch;
DROP TABLE IF EXISTS audit_batch;
DROP TABLE IF EXISTS attachment_review_record;
DROP TABLE IF EXISTS audit_task;
DROP TABLE IF EXISTS application_audit_record;
DROP TABLE IF EXISTS application_operation_log;
DROP TABLE IF EXISTS application_revision;
DROP TABLE IF EXISTS application_member;
DROP TABLE IF EXISTS application_attachment;
DROP TABLE IF EXISTS application_field_value;
DROP TABLE IF EXISTS application_record;
DROP TABLE IF EXISTS group_distribution_rule;
DROP TABLE IF EXISTS rule_scope;
DROP TABLE IF EXISTS audit_requirement;
DROP TABLE IF EXISTS material_requirement;
DROP TABLE IF EXISTS rule_form_field;
DROP TABLE IF EXISTS rule_calculation_config;
DROP TABLE IF EXISTS rule_node;
DROP TABLE IF EXISTS rule_operation_log;
DROP TABLE IF EXISTS academic_year_rule_snapshot;
DROP TABLE IF EXISTS rule_set_version;
DROP TABLE IF EXISTS rule_set;
DROP TABLE IF EXISTS system_operation_log;
DROP TABLE IF EXISTS system_user;
DROP TABLE IF EXISTS student_profile;
DROP TABLE IF EXISTS academic_year;

SET FOREIGN_KEY_CHECKS = 1;

-- 学年、可复用规则版本和不可变学年规则快照。
CREATE TABLE academic_year (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  name VARCHAR(50) NOT NULL COMMENT '学年名称，如2025-2026学年度',
  evaluation_start_date DATE NOT NULL COMMENT '参评开始日期',
  evaluation_end_date DATE NOT NULL COMMENT '参评结束日期',
  apply_start_time DATETIME NULL COMMENT '学生申报开始时间',
  apply_end_time DATETIME NULL COMMENT '学生申报结束时间',
  audit_start_time DATETIME NULL COMMENT '审核开始时间',
  audit_end_time DATETIME NULL COMMENT '审核结束时间',
  publicity_start_time DATETIME NULL COMMENT '公示开始时间',
  publicity_end_time DATETIME NULL COMMENT '公示结束时间',
  status VARCHAR(30) NOT NULL DEFAULT 'configuring' COMMENT 'configuring/applying/auditing/calculating/publicizing/appealing/archived',
  current_snapshot_id BIGINT NULL COMMENT '当前使用的学年规则快照',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_academic_year_name (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='综测学年批次';

CREATE TABLE rule_set (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  college_id BIGINT NOT NULL COMMENT '所属学院ID，引用外部学院表',
  name VARCHAR(100) NOT NULL COMMENT '规则集模板名称',
  description TEXT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft' COMMENT 'draft/enabled/disabled/archived',
  created_by BIGINT NOT NULL COMMENT '创建人ID，引用外部用户表',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_rule_set_college (college_id),
  KEY idx_rule_set_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则集模板';

CREATE TABLE rule_set_version (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  rule_set_id BIGINT NOT NULL,
  version_no VARCHAR(50) NOT NULL COMMENT '版本号，如v2026.09',
  version_name VARCHAR(100) NULL COMMENT '版本名称',
  status VARCHAR(30) NOT NULL DEFAULT 'draft' COMMENT 'draft/published/archived',
  change_note TEXT NULL COMMENT '版本变更说明',
  published_by BIGINT NULL COMMENT '发布人ID，引用外部用户表',
  published_at DATETIME NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rule_version (rule_set_id, version_no),
  KEY idx_rule_version_status (status),
  CONSTRAINT fk_rule_version_set
    FOREIGN KEY (rule_set_id) REFERENCES rule_set(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则集发布版本';

CREATE TABLE academic_year_rule_snapshot (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  academic_year_id BIGINT NOT NULL,
  rule_set_version_id BIGINT NOT NULL,
  snapshot_json JSON NOT NULL COMMENT '发布时完整规则快照，用于历史追溯',
  snapshot_hash VARCHAR(128) NULL COMMENT '快照校验值',
  status VARCHAR(30) NOT NULL DEFAULT 'active' COMMENT 'active/replaced/archived',
  current_marker TINYINT NULL COMMENT '当前快照标记。当前为1，历史为空；用于保证每个学年只有一个当前快照',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_year_current_snapshot (academic_year_id, current_marker),
  KEY idx_snapshot_rule_version (rule_set_version_id),
  CONSTRAINT fk_snapshot_year
    FOREIGN KEY (academic_year_id) REFERENCES academic_year(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_snapshot_rule_version
    FOREIGN KEY (rule_set_version_id) REFERENCES rule_set_version(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='学年规则快照';

ALTER TABLE academic_year
  ADD CONSTRAINT fk_academic_year_current_snapshot
  FOREIGN KEY (current_snapshot_id) REFERENCES academic_year_rule_snapshot(id)
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TABLE rule_operation_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  target_type VARCHAR(50) NOT NULL COMMENT 'rule_set/rule_set_version/snapshot/rule_node',
  target_id BIGINT NOT NULL,
  operation_type VARCHAR(50) NOT NULL COMMENT 'create/update/publish/archive/bind/recalculate',
  operator_id BIGINT NOT NULL COMMENT '操作人ID，引用外部用户表',
  operation_detail_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rule_log_target (target_type, target_id),
  KEY idx_rule_log_operator (operator_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则相关操作日志';

-- 学生基础数据、系统用户和跨模块操作日志。
CREATE TABLE student_profile (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  student_no VARCHAR(50) NOT NULL,
  name VARCHAR(100) NOT NULL,
  grade VARCHAR(20) NULL,
  major VARCHAR(100) NULL,
  class_name VARCHAR(100) NULL,
  administrative_class VARCHAR(100) NULL,
  student_type VARCHAR(30) NOT NULL DEFAULT 'normal',
  gender VARCHAR(20) NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(120) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  college_id BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_student_profile_no (student_no),
  KEY idx_student_profile_class (grade, major, class_name),
  KEY idx_student_profile_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='student profile';

CREATE TABLE system_user (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  username VARCHAR(80) NOT NULL,
  display_name VARCHAR(100) NOT NULL,
  password_hash VARCHAR(128) NOT NULL,
  role VARCHAR(50) NOT NULL DEFAULT 'student',
  status VARCHAR(30) NOT NULL DEFAULT 'active',
  related_student_id BIGINT NULL,
  phone VARCHAR(50) NULL,
  email VARCHAR(120) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_system_user_username (username),
  KEY idx_system_user_role_status (role, status),
  KEY idx_system_user_student (related_student_id),
  CONSTRAINT fk_system_user_student
    FOREIGN KEY (related_student_id) REFERENCES student_profile(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='system user';

CREATE TABLE system_operation_log (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  operator_id BIGINT NULL,
  operator_name VARCHAR(100) NULL,
  module VARCHAR(50) NOT NULL,
  operation_type VARCHAR(50) NOT NULL,
  target_type VARCHAR(50) NULL,
  target_id BIGINT NULL,
  operation_detail_json JSON NULL,
  ip_address VARCHAR(80) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_system_log_module_time (module, created_at),
  KEY idx_system_log_operator (operator_id, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='system operation log';

CREATE TABLE auth_session (
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

-- 通用规则树，以及挂载在 aggregate/item 节点上的各类配置。
CREATE TABLE rule_node (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  rule_set_version_id BIGINT NOT NULL,
  parent_id BIGINT NULL,
  node_type VARCHAR(30) NOT NULL COMMENT 'aggregate/item；汇总层级由parent_id决定',
  code VARCHAR(100) NOT NULL COMMENT '同一版本内唯一编码',
  name VARCHAR(150) NOT NULL,
  max_score DECIMAL(8,3) NULL COMMENT '节点上限分',
  aggregation_type VARCHAR(30) NULL COMMENT 'sum/max/cap/formula/deduct/manual',
  is_apply_entry TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否作为学生申报入口',
  allow_repeat TINYINT(1) NOT NULL DEFAULT 0 COMMENT '规则项固定不可重复；字段仅为兼容旧结构保留',
  duplicate_check_type VARCHAR(50) NULL COMMENT 'duplicate check type',
  duplicate_check_config_json JSON NULL COMMENT 'duplicate check config',
  apply_start_time DATETIME NULL COMMENT 'node-level apply start time',
  apply_end_time DATETIME NULL COMMENT 'node-level apply end time',
  submitter_type VARCHAR(30) NOT NULL DEFAULT 'student' COMMENT 'student/admin/system',
  sort_order INT NOT NULL DEFAULT 0,
  status VARCHAR(30) NOT NULL DEFAULT 'enabled' COMMENT 'enabled/disabled',
  description TEXT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_rule_node_code (rule_set_version_id, code),
  KEY idx_rule_node_parent (parent_id),
  KEY idx_rule_node_apply (rule_set_version_id, is_apply_entry, status),
  CONSTRAINT chk_rule_node_type CHECK (node_type IN ('aggregate', 'item')),
  CONSTRAINT chk_rule_node_apply_entry CHECK (node_type = 'item' OR is_apply_entry = 0),
  CONSTRAINT fk_rule_node_version
    FOREIGN KEY (rule_set_version_id) REFERENCES rule_set_version(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_rule_node_parent
    FOREIGN KEY (parent_id) REFERENCES rule_node(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则树节点';

CREATE TABLE rule_calculation_config (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  node_id BIGINT NOT NULL,
  config_type VARCHAR(30) NOT NULL COMMENT 'fixed/level/quantity/step/weight/formula/manual/deduct',
  formula_code VARCHAR(100) NULL COMMENT '受控公式编码，不存放任意可执行代码',
  config_json JSON NOT NULL COMMENT '按config_type约束结构',
  rounding_rule VARCHAR(30) NULL COMMENT 'none/round/floor/ceil',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_calc_node_type (node_id, config_type),
  CONSTRAINT fk_calc_node
    FOREIGN KEY (node_id) REFERENCES rule_node(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则计分配置';

CREATE TABLE rule_form_field (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  node_id BIGINT NOT NULL,
  field_key VARCHAR(100) NOT NULL,
  field_label VARCHAR(100) NOT NULL,
  field_type VARCHAR(30) NOT NULL COMMENT 'text/number/date/select/multi_select/member_list/file/textarea',
  required TINYINT(1) NOT NULL DEFAULT 0,
  options_json JSON NULL COMMENT '下拉、多选等字段选项',
  validation_json JSON NULL COMMENT '字段校验规则',
  sort_order INT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_node_field (node_id, field_key),
  CONSTRAINT fk_form_field_node
    FOREIGN KEY (node_id) REFERENCES rule_node(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则项申报字段配置';

CREATE TABLE material_requirement (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  node_id BIGINT NOT NULL,
  material_name VARCHAR(100) NOT NULL,
  required TINYINT(1) NOT NULL DEFAULT 1,
  description TEXT NULL,
  file_type_limit VARCHAR(200) NULL COMMENT '允许的文件类型，如pdf,jpg,png',
  max_file_count INT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_material_node
    FOREIGN KEY (node_id) REFERENCES rule_node(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='证明材料要求';

CREATE TABLE audit_requirement (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  node_id BIGINT NOT NULL,
  audit_role VARCHAR(50) NOT NULL COMMENT 'class_committee/college_admin/system',
  audit_instruction TEXT NULL,
  reject_reason_template JSON NULL,
  need_second_audit TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_audit_req_node
    FOREIGN KEY (node_id) REFERENCES rule_node(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='审核要求';

CREATE TABLE rule_scope (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  node_id BIGINT NOT NULL,
  scope_type VARCHAR(30) NOT NULL COMMENT 'college/major/grade/class/student_type/student',
  scope_value VARCHAR(100) NOT NULL,
  include_or_exclude VARCHAR(20) NOT NULL DEFAULT 'include',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_rule_scope (node_id, scope_type, scope_value),
  CONSTRAINT fk_scope_node
    FOREIGN KEY (node_id) REFERENCES rule_node(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则适用范围';

CREATE TABLE group_distribution_rule (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  node_id BIGINT NOT NULL,
  distribution_type VARCHAR(50) NOT NULL COMMENT 'leader_member/rank_ratio/equal/first_second_half/custom',
  config_json JSON NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT fk_group_rule_node
    FOREIGN KEY (node_id) REFERENCES rule_node(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='团体成果分配规则';

-- 学生申报、证明材料、提交版本和审核轨迹。
CREATE TABLE application_record (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  academic_year_id BIGINT NOT NULL,
  snapshot_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL COMMENT '学生ID，引用外部学生表',
  rule_node_id BIGINT NOT NULL COMMENT '对应可申报规则节点',
  rule_item_code VARCHAR(100) NOT NULL COMMENT '跨规则版本稳定的规则项编码，用于保证每学年只申报一次',
  source_type VARCHAR(30) NOT NULL DEFAULT 'student_apply' COMMENT 'student_apply/admin_import/system_import',
  title VARCHAR(200) NULL COMMENT '申报标题或摘要',
  status VARCHAR(30) NOT NULL DEFAULT 'draft' COMMENT 'draft/submitted/returned/approved/rejected/withdrawn',
  current_revision_no INT NOT NULL DEFAULT 0 COMMENT 'current submitted revision number',
  audit_stage VARCHAR(30) NULL COMMENT 'class_review/college_review/final',
  current_auditor_role VARCHAR(50) NULL COMMENT 'current pending auditor role',
  returned_at DATETIME NULL COMMENT 'returned time',
  returned_by BIGINT NULL COMMENT 'return operator id',
  return_reason TEXT NULL COMMENT 'return reason',
  approved_at DATETIME NULL COMMENT 'approved time',
  approved_by BIGINT NULL COMMENT 'approver id',
  rejected_at DATETIME NULL COMMENT 'rejected time',
  rejected_by BIGINT NULL COMMENT 'reject operator id',
  reject_reason TEXT NULL COMMENT 'reject reason',
  submitted_at DATETIME NULL,
  created_by BIGINT NULL COMMENT '创建人ID，引用外部用户表',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_app_student_year (student_id, academic_year_id),
  UNIQUE KEY uk_app_year_student_rule_item (academic_year_id, student_id, rule_item_code),
  KEY idx_app_rule_status (rule_node_id, status),
  KEY idx_app_snapshot (snapshot_id),
  CONSTRAINT fk_app_year
    FOREIGN KEY (academic_year_id) REFERENCES academic_year(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_app_snapshot
    FOREIGN KEY (snapshot_id) REFERENCES academic_year_rule_snapshot(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_app_rule_node
    FOREIGN KEY (rule_node_id) REFERENCES rule_node(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='学生申报记录';

CREATE TABLE application_field_value (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  application_id BIGINT NOT NULL,
  field_key VARCHAR(100) NOT NULL,
  field_value JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_app_field (application_id, field_key),
  CONSTRAINT fk_field_value_app
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='申报字段值';

CREATE TABLE application_attachment (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  application_id BIGINT NOT NULL,
  material_requirement_id BIGINT NULL,
  file_name VARCHAR(255) NOT NULL,
  file_url VARCHAR(500) NOT NULL,
  file_hash VARCHAR(128) NULL,
  revision_no INT NULL COMMENT 'application revision number',
  status VARCHAR(30) NOT NULL DEFAULT 'active' COMMENT 'active/replaced/deleted',
  file_size BIGINT NULL COMMENT 'file size',
  mime_type VARCHAR(100) NULL COMMENT 'mime type',
  storage_key VARCHAR(500) NULL COMMENT 'object storage key',
  review_result VARCHAR(30) NULL COMMENT 'pending/valid/invalid/unclear',
  review_comment TEXT NULL COMMENT 'attachment review comment',
  uploaded_by BIGINT NULL COMMENT '上传人ID，引用外部用户表',
  uploaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_attachment_app (application_id),
  CONSTRAINT fk_attachment_app
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_attachment_material
    FOREIGN KEY (material_requirement_id) REFERENCES material_requirement(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='申报证明材料';

CREATE TABLE application_member (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  application_id BIGINT NOT NULL,
  member_student_id BIGINT NULL COMMENT '成员学生ID，引用外部学生表',
  member_name VARCHAR(100) NULL,
  role_name VARCHAR(50) NULL COMMENT '负责人/成员/队长等',
  rank_no INT NULL COMMENT '成员排名',
  contribution_ratio DECIMAL(6,3) NULL COMMENT '贡献比例',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_member_app (application_id),
  CONSTRAINT fk_member_app
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='团体项目成员信息';

CREATE TABLE application_audit_record (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  application_id BIGINT NOT NULL,
  auditor_id BIGINT NOT NULL COMMENT '审核人ID，引用外部用户表',
  audit_role VARCHAR(50) NOT NULL,
  audit_result VARCHAR(30) NOT NULL COMMENT 'approved/rejected/returned',
  audit_comment TEXT NULL,
  audited_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_audit_app (application_id),
  KEY idx_audit_auditor (auditor_id),
  CONSTRAINT fk_audit_app
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='申报审核记录';

CREATE TABLE application_revision (
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

CREATE TABLE application_operation_log (
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

-- 审核任务分配和批量审核支持。
CREATE TABLE audit_task (
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

CREATE TABLE attachment_review_record (
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

CREATE TABLE audit_batch (
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

-- 受控公式目录，以及按核算批次保存的两阶段得分结果。
CREATE TABLE formula_template (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  formula_code VARCHAR(100) NOT NULL UNIQUE,
  formula_name VARCHAR(100) NOT NULL,
  description TEXT NULL,
  input_schema_json JSON NULL,
  output_schema_json JSON NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='controlled formula template';

INSERT INTO formula_template
  (formula_code, formula_name, description, input_schema_json, output_schema_json)
VALUES
  ('BASE_SCORE_TIMES_WEIGHT', 'base score times weight', 'Score equals base score multiplied by configured weight.', '{"base_score":"number","weight":"number"}', '{"score":"number"}'),
  ('POSITION_SCORE_BY_WEIGHT', 'position score by evaluation weight', 'Position score equals base position score multiplied by evaluation weight.', '{"base_score":"number","evaluation_weight":"number"}', '{"score":"number"}'),
  ('LEVEL_SCORE', 'level score', 'Score is selected from a configured level list.', '{"level":"string"}', '{"score":"number"}'),
  ('FIXED_SCORE', 'fixed score', 'Score is configured as a fixed value.', '{"score":"number"}', '{"score":"number"}'),
  ('PAPER_SCORE_BY_AUTHORS', 'paper score by authors', 'Paper level score divided by co-first-author count.', '{"paper_level":"string","co_first_author_count":"number"}', '{"score":"number"}'),
  ('PRACTICE_SCORE_WITH_BONUS', 'practice score with bonus', 'Practice base score plus college-project and award bonuses.', '{"practice_level":"string","college_project":"string","extra_award":"string"}', '{"score":"number"}'),
  ('DIRECT_FIELD_SCORE', 'direct field score', 'Use a reviewed numeric form field as score.', '{"field_value":"number"}', '{"score":"number"}'),
  ('QUANTITY_STEP_CAP', 'quantity step cap', 'Quantity multiplied by step score and limited by a cap.', '{"quantity":"number"}', '{"score":"number"}');

CREATE TABLE score_calculation_batch (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  academic_year_id BIGINT NOT NULL,
  snapshot_id BIGINT NOT NULL,
  batch_type VARCHAR(30) NOT NULL COMMENT 'preview/formal/recalculate/appeal',
  trigger_reason VARCHAR(200) NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'running' COMMENT 'running/succeeded/failed/cancelled',
  created_by BIGINT NULL COMMENT '创建人ID，引用外部用户表',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  finished_at DATETIME NULL,
  KEY idx_score_batch_year (academic_year_id),
  KEY idx_score_batch_snapshot (snapshot_id),
  CONSTRAINT fk_score_batch_year
    FOREIGN KEY (academic_year_id) REFERENCES academic_year(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_score_batch_snapshot
    FOREIGN KEY (snapshot_id) REFERENCES academic_year_rule_snapshot(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='核算批次';

CREATE TABLE calculation_task (
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

CREATE TABLE calculation_error (
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

CREATE TABLE calculation_warning (
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

CREATE TABLE score_item_result (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_id BIGINT NOT NULL,
  application_id BIGINT NULL COMMENT '对应申报记录；导入或系统计算项可为空',
  student_id BIGINT NOT NULL COMMENT '学生ID，引用外部学生表',
  rule_node_id BIGINT NOT NULL,
  score_source_type VARCHAR(30) NOT NULL DEFAULT 'application' COMMENT 'application/import/system/manual',
  raw_score DECIMAL(8,3) NOT NULL DEFAULT 0,
  effective_score DECIMAL(8,3) NOT NULL DEFAULT 0,
  calculation_detail_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_batch_app (batch_id, application_id),
  KEY idx_item_student_batch (student_id, batch_id),
  KEY idx_item_rule_node (rule_node_id),
  CONSTRAINT fk_item_batch
    FOREIGN KEY (batch_id) REFERENCES score_calculation_batch(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_item_app
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_item_rule_node
    FOREIGN KEY (rule_node_id) REFERENCES rule_node(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='单项得分结果';

CREATE TABLE score_node_result (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_id BIGINT NOT NULL,
  academic_year_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL COMMENT '学生ID，引用外部学生表',
  rule_node_id BIGINT NOT NULL,
  raw_score DECIMAL(8,3) NOT NULL DEFAULT 0,
  effective_score DECIMAL(8,3) NOT NULL DEFAULT 0,
  applied_rule_json JSON NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_batch_student_node (batch_id, student_id, rule_node_id),
  KEY idx_node_result_year_student (academic_year_id, student_id),
  CONSTRAINT fk_node_result_batch
    FOREIGN KEY (batch_id) REFERENCES score_calculation_batch(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_node_result_year
    FOREIGN KEY (academic_year_id) REFERENCES academic_year(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_node_result_rule_node
    FOREIGN KEY (rule_node_id) REFERENCES rule_node(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='规则节点汇总得分';

CREATE TABLE score_total_result (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  batch_id BIGINT NOT NULL,
  academic_year_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL COMMENT '学生ID，引用外部学生表',
  rank_scope_type VARCHAR(30) NULL COMMENT 'college/major/class',
  rank_scope_value VARCHAR(100) NULL,
  total_score DECIMAL(8,3) NOT NULL DEFAULT 0,
  rank_no INT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'calculated' COMMENT 'calculated/publicized/archived',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_batch_student_total (batch_id, student_id),
  KEY idx_total_year_rank (academic_year_id, rank_scope_type, rank_scope_value, rank_no),
  CONSTRAINT fk_total_batch
    FOREIGN KEY (batch_id) REFERENCES score_calculation_batch(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_total_year
    FOREIGN KEY (academic_year_id) REFERENCES academic_year(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='最终综测成绩';

CREATE TABLE score_change_record (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  academic_year_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL COMMENT '学生ID，引用外部学生表',
  old_batch_id BIGINT NULL,
  new_batch_id BIGINT NULL,
  old_score DECIMAL(8,3) NULL,
  new_score DECIMAL(8,3) NULL,
  change_reason VARCHAR(200) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_score_change_student (academic_year_id, student_id),
  CONSTRAINT fk_change_year
    FOREIGN KEY (academic_year_id) REFERENCES academic_year(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_change_old_batch
    FOREIGN KEY (old_batch_id) REFERENCES score_calculation_batch(id)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT fk_change_new_batch
    FOREIGN KEY (new_batch_id) REFERENCES score_calculation_batch(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='分数变化记录';

-- 固化的公示结果和异议处理历史。
CREATE TABLE publicity_batch (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  academic_year_id BIGINT NOT NULL,
  calculation_batch_id BIGINT NOT NULL,
  publicity_round INT NOT NULL DEFAULT 1,
  start_time DATETIME NULL,
  end_time DATETIME NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'draft' COMMENT 'draft/publicizing/closed/archived',
  created_by BIGINT NULL COMMENT '创建人ID，引用外部用户表',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_publicity_year_round (academic_year_id, publicity_round),
  CONSTRAINT fk_publicity_year
    FOREIGN KEY (academic_year_id) REFERENCES academic_year(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_publicity_calc_batch
    FOREIGN KEY (calculation_batch_id) REFERENCES score_calculation_batch(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公示批次';

CREATE TABLE publicity_result (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  publicity_batch_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL COMMENT '学生ID，引用外部学生表',
  total_score DECIMAL(8,3) NOT NULL,
  rank_no INT NULL,
  detail_snapshot_json JSON NULL COMMENT '公示时固化的结果摘要',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uk_publicity_student (publicity_batch_id, student_id),
  KEY idx_publicity_rank (publicity_batch_id, rank_no),
  CONSTRAINT fk_publicity_result_batch
    FOREIGN KEY (publicity_batch_id) REFERENCES publicity_batch(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='公示结果';

CREATE TABLE appeal_record (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  publicity_batch_id BIGINT NOT NULL,
  student_id BIGINT NOT NULL COMMENT '学生ID，引用外部学生表',
  appeal_type VARCHAR(30) NOT NULL COMMENT 'score/audit/rank/material/other',
  related_application_id BIGINT NULL,
  content TEXT NOT NULL,
  status VARCHAR(30) NOT NULL DEFAULT 'pending' COMMENT 'pending/processing/approved/rejected/closed',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_appeal_publicity_status (publicity_batch_id, status),
  KEY idx_appeal_student (student_id),
  CONSTRAINT fk_appeal_publicity
    FOREIGN KEY (publicity_batch_id) REFERENCES publicity_batch(id)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT fk_appeal_application
    FOREIGN KEY (related_application_id) REFERENCES application_record(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='异议和复查申请';

CREATE TABLE score_import_batch (
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

CREATE TABLE score_import_row (
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

CREATE TABLE appeal_process_record (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  appeal_id BIGINT NOT NULL,
  processor_id BIGINT NOT NULL COMMENT '处理人ID，引用外部用户表',
  process_action VARCHAR(30) NOT NULL COMMENT 'accept/reject/comment/recalculate/close',
  process_comment TEXT NULL,
  processed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  KEY idx_appeal_process (appeal_id, processed_at),
  CONSTRAINT fk_appeal_process_appeal
    FOREIGN KEY (appeal_id) REFERENCES appeal_record(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='异议处理记录';
