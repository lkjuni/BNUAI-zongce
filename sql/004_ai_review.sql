-- AI 附件审核：存储 AI 自动审核结果，与人工审核完全独立并行。
-- AI 不做最终判定，仅提供辅助信息供人工审核员参考。

CREATE TABLE IF NOT EXISTS ai_attachment_review (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  attachment_id BIGINT NOT NULL,
  application_id BIGINT NOT NULL,
  ai_model VARCHAR(100) NULL COMMENT '调用的大模型名称',
  ai_request_id VARCHAR(200) NULL COMMENT 'AI 服务返回的请求 ID',
  review_status VARCHAR(30) NOT NULL DEFAULT 'pending' COMMENT 'pending/processing/completed/failed',
  confidence_score DECIMAL(5,2) NULL COMMENT 'AI 综合置信度 0-100',
  extracted_info_json JSON NULL COMMENT 'AI 从图片中提取的结构化信息（姓名、学号、证书类型等）',
  comparison_json JSON NULL COMMENT '提取信息与系统数据库的比对结果',
  match_result VARCHAR(30) NULL COMMENT 'match/mismatch/partial/uncertain',
  match_summary TEXT NULL COMMENT '比对摘要说明',
  raw_response_json JSON NULL COMMENT 'AI 原始返回（用于调试和审查）',
  error_message TEXT NULL COMMENT '调用失败时的错误信息',
  processing_time_ms INT NULL COMMENT '处理耗时（毫秒）',
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_ai_review_attachment (attachment_id),
  KEY idx_ai_review_application (application_id),
  KEY idx_ai_review_status (review_status),
  CONSTRAINT fk_ai_review_attachment
    FOREIGN KEY (attachment_id) REFERENCES application_attachment(id)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT fk_ai_review_application
    FOREIGN KEY (application_id) REFERENCES application_record(id)
    ON DELETE CASCADE ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci COMMENT='AI 附件审核结果';