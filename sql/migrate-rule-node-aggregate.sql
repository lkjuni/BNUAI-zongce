-- 将旧的固定层级类型合并为通用汇总节点。
-- 本迁移只改变节点分类，不改变节点 ID、父子关系、配置或业务数据。

UPDATE rule_node
SET node_type = 'aggregate'
WHERE node_type IN ('total', 'module', 'category', 'subcategory');

ALTER TABLE rule_node
  MODIFY COLUMN node_type VARCHAR(30) NOT NULL COMMENT 'aggregate/item；汇总层级由parent_id决定',
  ADD CONSTRAINT chk_rule_node_type CHECK (node_type IN ('aggregate', 'item')),
  ADD CONSTRAINT chk_rule_node_apply_entry CHECK (node_type = 'item' OR is_apply_entry = 0);
