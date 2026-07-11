USE bnuai_zongce;

CREATE TABLE IF NOT EXISTS student_profile (
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

CREATE TABLE IF NOT EXISTS system_user (
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

CREATE TABLE IF NOT EXISTS system_operation_log (
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
