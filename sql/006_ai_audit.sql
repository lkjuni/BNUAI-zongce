-- AI 自动审核记录表
-- 与人工审核并行执行，仅作为辅助参考

CREATE TABLE IF NOT EXISTS ai_audit_record (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  application_id BIGINT NOT NULL COMMENT '关联申报记录',
  attachment_id BIGINT NULL COMMENT '关联材料附件，NULL 表示综合结论',
  student_name VARCHAR(100) NOT NULL COMMENT '上传材料学生的姓名（中文）',
  student_name_pinyin TEXT NULL COMMENT '学生姓名拼音（空格分隔）',
  recognized_names JSON NULL COMMENT 'AI 从材料中识别到的所有姓名',
  ocr_raw_text MEDIUMTEXT NULL COMMENT 'OCR 原始识别文本',
  match_success TINYINT(1) NOT NULL DEFAULT 0 COMMENT '姓名匹配是否成功',
  match_detail TEXT NULL COMMENT '匹配详情与原因',
  status VARCHAR(30) NOT NULL DEFAULT 'pending' COMMENT 'pending/processing/completed/failed',
  error_message TEXT NULL COMMENT 'AI 调用失败时的错误信息',
  model_used VARCHAR(100) NULL COMMENT '使用的模型名称',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  KEY idx_ai_audit_application (application_id),
  KEY idx_ai_audit_status (status),
  CONSTRAINT fk_ai_audit_application
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ai_audit_attachment
    FOREIGN KEY (attachment_id) REFERENCES application_attachment(id)
    ON DELETE SET NULL ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='AI 自动审核记录';