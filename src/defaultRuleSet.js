import { transaction } from "./db.js";

// 根据学院综测细则附件初始化默认规则集。下方辅助函数用于保持大量规则数据
// 的声明式表达，整个导入过程由同一事务保证完整成功或完整回滚。

const defaultRuleSetName = "人工智能学院本科生综合测评默认规则集";

async function seedDefaultRuleSet() {
  return transaction(async (conn) => {
    const suffix = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const [setResult] = await conn.execute(
      `INSERT INTO rule_set (college_id, name, description, status, created_by)
       VALUES (1, ?, ?, 'enabled', 1)`,
      [
        `${defaultRuleSetName}-${suffix}`,
        "根据附件二、附件三、附件四整理的默认规则集，覆盖学术创新成果、学科认证、岗位任职、学生活动等默认配置。"
      ]
    );
    const ruleSetId = setResult.insertId;

    const [versionResult] = await conn.execute(
      `INSERT INTO rule_set_version
       (rule_set_id, version_no, version_name, status, change_note, published_by, published_at)
       VALUES (?, 'default-2026', '默认规则集 2026 版', 'published', '由附件二、附件三、附件四初始化', 1, NOW())`,
      [ruleSetId]
    );
    const versionId = versionResult.insertId;

    async function node(parentId, nodeType, code, name, maxScore, aggregationType, isApplyEntry, sortOrder, description = null) {
      const [result] = await conn.execute(
        `INSERT INTO rule_node
         (rule_set_version_id, parent_id, node_type, code, name, max_score, aggregation_type, is_apply_entry, sort_order, status, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'enabled', ?)`,
        [versionId, parentId, nodeType, code, name, maxScore, aggregationType, isApplyEntry ? 1 : 0, sortOrder, description]
      );
      return result.insertId;
    }

    async function config(nodeId, configType, configJson, formulaCode = null) {
      await conn.execute(
        `INSERT INTO rule_calculation_config (node_id, config_type, formula_code, config_json, rounding_rule)
         VALUES (?, ?, ?, ?, 'round')`,
        [nodeId, configType, formulaCode, JSON.stringify(configJson)]
      );
    }

    async function selectField(nodeId, key, label, options, sortOrder = 1, required = true) {
      await conn.execute(
        `INSERT INTO rule_form_field (node_id, field_key, field_label, field_type, required, options_json, sort_order)
         VALUES (?, ?, ?, 'select', ?, ?, ?)`,
        [nodeId, key, label, required ? 1 : 0, JSON.stringify(options), sortOrder]
      );
    }

    async function textField(nodeId, key, label, sortOrder = 1, required = true) {
      await conn.execute(
        `INSERT INTO rule_form_field (node_id, field_key, field_label, field_type, required, sort_order)
         VALUES (?, ?, ?, 'text', ?, ?)`,
        [nodeId, key, label, required ? 1 : 0, sortOrder]
      );
    }

    async function numberField(nodeId, key, label, validation, sortOrder = 1, required = true) {
      await conn.execute(
        `INSERT INTO rule_form_field (node_id, field_key, field_label, field_type, required, validation_json, sort_order)
         VALUES (?, ?, ?, 'number', ?, ?, ?)`,
        [nodeId, key, label, required ? 1 : 0, JSON.stringify(validation || {}), sortOrder]
      );
    }

    async function material(nodeId, name, description, maxFileCount = 3) {
      await conn.execute(
        `INSERT INTO material_requirement (node_id, material_name, required, description, file_type_limit, max_file_count)
         VALUES (?, ?, 1, ?, 'pdf,jpg,jpeg,png', ?)`,
        [nodeId, name, description, maxFileCount]
      );
    }

    async function audit(nodeId, role, instruction, second = false) {
      await conn.execute(
        `INSERT INTO audit_requirement (node_id, audit_role, audit_instruction, need_second_audit)
         VALUES (?, ?, ?, ?)`,
        [nodeId, role, instruction, second ? 1 : 0]
      );
    }

    const total = await node(null, "aggregate", "total", "综合测评总分", 105, "sum", 0, 1, "默认规则集根节点");
    await node(total, "aggregate", "moral", "思想品德", 5, "manual", 0, 10, "思想品德模块，当前作为预留模块。");
    await node(total, "aggregate", "academic", "学业成绩", 86, "manual", 0, 20, "学业成绩模块，当前作为外部成绩导入预留模块。");

    const innovation = await node(total, "aggregate", "innovation", "学术创新成果", 7, "cap", 0, 30, "附件二。模块最高 7 分，内部按规则树汇总后封顶。");
    const research = await node(innovation, "aggregate", "innovation.research", "科研成果", null, "sum", 0, 10, "包含项目成果、论文成果、其他成果。");
    const project = await node(research, "aggregate", "innovation.research.project", "项目成果", null, "max", 0, 10, "本科生科研训练与创新创业项目，按项目类型、角色、阶段/结论计分。");
    const projectItem = await node(project, "item", "innovation.research.project.result", "项目成果认定", null, "level", 1, 10, "未成功结题或中期退出为扣分项。");
    await config(projectItem, "level", {
      levels: [
        { name: "国家级科研训练-主持-结题", score: 1.0 },
        { name: "国家级科研训练-主持-优秀", score: 2.0 },
        { name: "国家级科研训练-参与-结题", score: 0.6 },
        { name: "国家级科研训练-参与-优秀", score: 1.5 },
        { name: "北京市级科研训练/启研计划-主持-结题", score: 0.8 },
        { name: "北京市级科研训练/启研计划-主持-优秀", score: 1.5 },
        { name: "北京市级科研训练/启研计划-参与-结题", score: 0.5 },
        { name: "北京市级科研训练/启研计划-参与-优秀", score: 1.0 },
        { name: "校级科研训练-主持-结题", score: 0.6 },
        { name: "校级科研训练-主持-优秀", score: 1.0 },
        { name: "校级科研训练-参与-结题", score: 0.3 },
        { name: "校级科研训练-参与-优秀", score: 0.5 },
        { name: "国家级创业训练项目-主持-结题", score: 1.0 },
        { name: "国家级创业训练项目-主持-优秀", score: 2.0 },
        { name: "国家级创业训练项目-参与前50%-结题", score: 0.6 },
        { name: "国家级创业训练项目-参与后50%-结题", score: 0.3 },
        { name: "国家级创业训练项目-参与前50%-优秀", score: 2.0 },
        { name: "国家级创业训练项目-参与后50%-优秀", score: 1.0 },
        { name: "国家级创业实践项目-主持-中期", score: 0.5 },
        { name: "国家级创业实践项目-主持-结题", score: 1.0 },
        { name: "国家级创业实践项目-主持-优秀", score: 2.0 },
        { name: "国家级创业实践项目-参与前50%-中期", score: 0.3 },
        { name: "国家级创业实践项目-参与后50%-中期", score: 0.15 },
        { name: "国家级创业实践项目-参与前50%-结题", score: 0.6 },
        { name: "国家级创业实践项目-参与后50%-结题", score: 0.3 },
        { name: "国家级创业实践项目-参与前50%-优秀", score: 2.0 },
        { name: "国家级创业实践项目-参与后50%-优秀", score: 1.0 },
        { name: "未成功结题或中期退出-主持", score: -2.0 },
        { name: "未成功结题或中期退出-参与", score: -1.0 }
      ]
    });
    await selectField(projectItem, "project_score_level", "项目计分档位", [
      "国家级科研训练-主持-结题",
      "国家级科研训练-主持-优秀",
      "国家级科研训练-参与-结题",
      "国家级科研训练-参与-优秀",
      "北京市级科研训练/启研计划-主持-结题",
      "北京市级科研训练/启研计划-主持-优秀",
      "北京市级科研训练/启研计划-参与-结题",
      "北京市级科研训练/启研计划-参与-优秀",
      "校级科研训练-主持-结题",
      "校级科研训练-主持-优秀",
      "校级科研训练-参与-结题",
      "校级科研训练-参与-优秀",
      "国家级创业训练项目-主持-结题",
      "国家级创业训练项目-主持-优秀",
      "国家级创业训练项目-参与前50%-结题",
      "国家级创业训练项目-参与后50%-结题",
      "国家级创业训练项目-参与前50%-优秀",
      "国家级创业训练项目-参与后50%-优秀",
      "国家级创业实践项目-主持-中期",
      "国家级创业实践项目-主持-结题",
      "国家级创业实践项目-主持-优秀",
      "国家级创业实践项目-参与前50%-中期",
      "国家级创业实践项目-参与后50%-中期",
      "国家级创业实践项目-参与前50%-结题",
      "国家级创业实践项目-参与后50%-结题",
      "国家级创业实践项目-参与前50%-优秀",
      "国家级创业实践项目-参与后50%-优秀",
      "未成功结题或中期退出-主持",
      "未成功结题或中期退出-参与"
    ]);
    await textField(projectItem, "project_name", "项目名称", 2);
    await material(projectItem, "项目结题/中期/优秀证明", "以教务数据或项目证明为准。");
    await audit(projectItem, "class_committee", "核对项目级别、角色、成员排名、结题/中期/优秀状态。", true);

    const paper = await node(research, "aggregate", "innovation.research.paper", "论文成果", null, "max", 0, 20, "共同第一作者按 1/N；最佳论文奖或 Spotlight 升一档。");
    const paperItem = await node(paper, "item", "innovation.research.paper.publication", "论文成果认定", null, "level", 1, 10);
    await config(paperItem, "level", {
      levels: [
        { name: "A+类论文", score: 7 },
        { name: "A类论文", score: 5 },
        { name: "A-类论文", score: 4 },
        { name: "B+类论文", score: 3 },
        { name: "B类论文", score: 2 },
        { name: "B-类论文", score: 1 },
        { name: "C类论文", score: 0.8 },
        { name: "C-类论文", score: 0.5 }
      ]
    });
    await selectField(paperItem, "paper_level", "论文类别", ["A+类论文", "A类论文", "A-类论文", "B+类论文", "B类论文", "B-类论文", "C类论文", "C-类论文"]);
    await textField(paperItem, "paper_title", "论文题目", 2);
    await numberField(paperItem, "co_first_author_count", "共同第一作者人数 N", { min: 1, step: 1 }, 3, false);
    await material(paperItem, "论文发表/录用证明", "正式发表或录用证明、导师说明、目录分类证明。");
    await audit(paperItem, "college_admin", "核对论文目录、作者顺序、共同一作人数、奖励升级情况。", true);

    const other = await node(research, "aggregate", "innovation.research.other", "其他成果", null, "max", 0, 30);
    const patentItem = await node(other, "item", "innovation.research.other.patent", "国家发明专利授权", null, "fixed", 1, 10, "仅认定已授权发明专利，第一发明人或教师第一本人第二。");
    await config(patentItem, "fixed", { score: 1 });
    await textField(patentItem, "patent_name", "专利名称");
    await material(patentItem, "专利授权书", "需提供专利授权书。");
    await audit(patentItem, "college_admin", "核对专利类型、授权状态和发明人顺序。", true);
    const highLevelItem = await node(other, "item", "innovation.research.other.high_level", "其他高水平成果", null, "manual", 1, 20, "需要专家推荐、工作小组评议加分。");
    await textField(highLevelItem, "achievement_name", "成果名称");
    await material(highLevelItem, "专家推荐或评议材料", "专家推荐、工作小组评议意见。");
    await audit(highLevelItem, "college_admin", "由工作小组评议后人工确认分值。", true);

    const competition = await node(innovation, "aggregate", "innovation.competition", "竞赛获奖", null, "sum", 0, 20);
    const professional = await node(competition, "aggregate", "innovation.competition.professional", "专业竞赛类", null, "max", 0, 10);
    const professionalItem = await node(professional, "item", "innovation.competition.professional.award", "专业竞赛获奖认定", null, "level", 1, 10);
    await config(professionalItem, "level", {
      levels: [
        { name: "ICPC世界总决赛-入围", score: 7 },
        { name: "ICPC亚洲东大陆决赛-金奖", score: 5 },
        { name: "ICPC亚洲东大陆决赛-银奖", score: 4 },
        { name: "ICPC亚洲东大陆决赛-铜奖", score: 3 },
        { name: "ICPC亚洲东大陆区域赛-金奖", score: 3 },
        { name: "ICPC亚洲东大陆区域赛-银奖", score: 2 },
        { name: "ICPC亚洲东大陆区域赛-铜奖", score: 1 },
        { name: "CCPC全国总决赛-金奖", score: 5 },
        { name: "CCPC全国总决赛-银奖", score: 4 },
        { name: "CCPC全国总决赛-铜奖", score: 3 },
        { name: "CCPC国赛区域赛/女生专场-金奖", score: 3 },
        { name: "CCPC国赛区域赛/女生专场-银奖", score: 2 },
        { name: "CCPC国赛区域赛/女生专场-铜奖", score: 1 },
        { name: "XCPC校内选拔赛-一等奖", score: 0.5 },
        { name: "XCPC校内选拔赛-二等奖", score: 0.3 },
        { name: "北京市大学生程序设计竞赛-金奖", score: 2 },
        { name: "北京市大学生程序设计竞赛-银奖", score: 1 },
        { name: "北京市大学生程序设计竞赛-铜奖", score: 0.5 },
        { name: "天梯赛全国个人奖-一等奖", score: 1 },
        { name: "天梯赛全国个人奖-二等奖", score: 0.8 },
        { name: "天梯赛全国个人奖-三等奖", score: 0.4 },
        { name: "全国大学生计算机系统能力大赛-特等奖", score: 5 },
        { name: "全国大学生计算机系统能力大赛-一等奖", score: 4 },
        { name: "全国大学生计算机系统能力大赛-二等奖", score: 3 },
        { name: "全国大学生计算机系统能力大赛-三等奖", score: 2.5 },
        { name: "ASC世界总决赛-冠军", score: 5 },
        { name: "ASC世界总决赛-亚军", score: 4 },
        { name: "ASC世界总决赛-晋级决赛", score: 2 },
        { name: "华为ICT世界总决赛-特等奖", score: 5 },
        { name: "华为ICT世界总决赛-一等奖", score: 4 },
        { name: "华为ICT世界总决赛-二等奖", score: 3 },
        { name: "华为ICT世界总决赛-三等奖", score: 2 },
        { name: "华为ICT全国总决赛-特等奖", score: 3 },
        { name: "华为ICT全国总决赛-一等奖", score: 2 },
        { name: "华为ICT全国总决赛-二等奖", score: 1.5 },
        { name: "华为ICT全国总决赛-三等奖", score: 1 },
        { name: "美国大学生数学建模竞赛-O奖", score: 1 },
        { name: "美国大学生数学建模竞赛-F奖", score: 0.8 },
        { name: "美国大学生数学建模竞赛-M奖", score: 0.5 },
        { name: "全国大学生数学建模竞赛-一等奖", score: 1 },
        { name: "全国大学生数学建模竞赛-二等奖", score: 0.8 }
      ]
    });
    await selectField(professionalItem, "professional_award_level", "专业竞赛奖项", [
      "ICPC世界总决赛-入围",
      "ICPC亚洲东大陆决赛-金奖",
      "ICPC亚洲东大陆决赛-银奖",
      "ICPC亚洲东大陆决赛-铜奖",
      "ICPC亚洲东大陆区域赛-金奖",
      "ICPC亚洲东大陆区域赛-银奖",
      "ICPC亚洲东大陆区域赛-铜奖",
      "CCPC全国总决赛-金奖",
      "CCPC全国总决赛-银奖",
      "CCPC全国总决赛-铜奖",
      "CCPC国赛区域赛/女生专场-金奖",
      "CCPC国赛区域赛/女生专场-银奖",
      "CCPC国赛区域赛/女生专场-铜奖",
      "XCPC校内选拔赛-一等奖",
      "XCPC校内选拔赛-二等奖",
      "北京市大学生程序设计竞赛-金奖",
      "北京市大学生程序设计竞赛-银奖",
      "北京市大学生程序设计竞赛-铜奖",
      "天梯赛全国个人奖-一等奖",
      "天梯赛全国个人奖-二等奖",
      "天梯赛全国个人奖-三等奖",
      "全国大学生计算机系统能力大赛-特等奖",
      "全国大学生计算机系统能力大赛-一等奖",
      "全国大学生计算机系统能力大赛-二等奖",
      "全国大学生计算机系统能力大赛-三等奖",
      "ASC世界总决赛-冠军",
      "ASC世界总决赛-亚军",
      "ASC世界总决赛-晋级决赛",
      "华为ICT世界总决赛-特等奖",
      "华为ICT世界总决赛-一等奖",
      "华为ICT世界总决赛-二等奖",
      "华为ICT世界总决赛-三等奖",
      "华为ICT全国总决赛-特等奖",
      "华为ICT全国总决赛-一等奖",
      "华为ICT全国总决赛-二等奖",
      "华为ICT全国总决赛-三等奖",
      "美国大学生数学建模竞赛-O奖",
      "美国大学生数学建模竞赛-F奖",
      "美国大学生数学建模竞赛-M奖",
      "全国大学生数学建模竞赛-一等奖",
      "全国大学生数学建模竞赛-二等奖"
    ]);
    await textField(professionalItem, "competition_name", "竞赛名称", 2);
    await material(professionalItem, "获奖证书或官方证明", "需体现竞赛名称、奖项等级、本人身份。");
    await audit(professionalItem, "class_committee", "核对专业竞赛名称、级别、奖项和证明材料。", true);

    const creative = await node(competition, "aggregate", "innovation.competition.creative", "创意策划类", null, "max", 0, 20, "负责人取括号外分数，成员按前50%/后50%取括号内分数；非主赛道系数0.8。");
    const creativeItem = await node(creative, "item", "innovation.competition.creative.award", "创意策划类竞赛获奖认定", null, "level", 1, 10);
    await config(creativeItem, "level", {
      levels: [
        { name: "大挑国家级特等奖-负责人", score: 7 },
        { name: "大挑国家级特等奖-成员前50%", score: 5 },
        { name: "大挑国家级特等奖-成员后50%", score: 4 },
        { name: "大挑国家级一等奖-负责人", score: 5 },
        { name: "大挑国家级一等奖-成员前50%", score: 4 },
        { name: "大挑国家级一等奖-成员后50%", score: 3 },
        { name: "大挑国家级二等奖-负责人", score: 4 },
        { name: "大挑国家级二等奖-成员前50%", score: 3 },
        { name: "大挑国家级二等奖-成员后50%", score: 2 },
        { name: "大挑国家级三等奖-负责人", score: 3 },
        { name: "大挑国家级三等奖-成员前50%", score: 2 },
        { name: "大挑国家级三等奖-成员后50%", score: 1.5 },
        { name: "大挑省市级特等奖-负责人", score: 2.5 },
        { name: "大挑省市级特等奖-成员前50%", score: 1.6 },
        { name: "大挑省市级特等奖-成员后50%", score: 0.9 },
        { name: "大挑省市级一等奖-负责人", score: 2 },
        { name: "大挑省市级一等奖-成员前50%", score: 1.3 },
        { name: "大挑省市级一等奖-成员后50%", score: 0.7 },
        { name: "小挑/互联网+/创青春国家级金奖/一等奖-负责人", score: 5 },
        { name: "小挑/互联网+/创青春国家级金奖/一等奖-成员前50%", score: 3 },
        { name: "小挑/互联网+/创青春国家级金奖/一等奖-成员后50%", score: 2 },
        { name: "小挑/互联网+/创青春国家级银奖/二等奖-负责人", score: 3.5 },
        { name: "小挑/互联网+/创青春国家级银奖/二等奖-成员前50%", score: 2.3 },
        { name: "小挑/互联网+/创青春国家级银奖/二等奖-成员后50%", score: 1.2 },
        { name: "小挑/互联网+/创青春国家级铜奖/三等奖-负责人", score: 2.5 },
        { name: "小挑/互联网+/创青春国家级铜奖/三等奖-成员前50%", score: 1.6 },
        { name: "小挑/互联网+/创青春国家级铜奖/三等奖-成员后50%", score: 0.9 },
        { name: "人工智能创意赛全国一等奖", score: 2 },
        { name: "人工智能创意赛全国二等奖", score: 1.5 },
        { name: "人工智能创意赛全国三等奖", score: 1 },
        { name: "京彩大创一等奖-负责人", score: 1.5 },
        { name: "京彩大创一等奖-成员前50%", score: 0.9 },
        { name: "京彩大创一等奖-成员后50%", score: 0.5 },
        { name: "京彩大创二等奖-负责人", score: 1 },
        { name: "京彩大创二等奖-成员前50%", score: 0.6 },
        { name: "京彩大创二等奖-成员后50%", score: 0.3 },
        { name: "京彩大创三等奖-负责人", score: 0.5 },
        { name: "京彩大创三等奖-成员前50%", score: 0.3 },
        { name: "京彩大创三等奖-成员后50%", score: 0.15 },
        { name: "京师杯一等奖", score: 0.5 },
        { name: "京师杯二等奖", score: 0.3 }
      ]
    });
    await selectField(creativeItem, "creative_award_level", "创意策划竞赛奖项", [
      "大挑国家级特等奖-负责人",
      "大挑国家级特等奖-成员前50%",
      "大挑国家级特等奖-成员后50%",
      "大挑国家级一等奖-负责人",
      "大挑国家级一等奖-成员前50%",
      "大挑国家级一等奖-成员后50%",
      "大挑国家级二等奖-负责人",
      "大挑国家级二等奖-成员前50%",
      "大挑国家级二等奖-成员后50%",
      "大挑国家级三等奖-负责人",
      "大挑国家级三等奖-成员前50%",
      "大挑国家级三等奖-成员后50%",
      "大挑省市级特等奖-负责人",
      "大挑省市级特等奖-成员前50%",
      "大挑省市级特等奖-成员后50%",
      "大挑省市级一等奖-负责人",
      "大挑省市级一等奖-成员前50%",
      "大挑省市级一等奖-成员后50%",
      "小挑/互联网+/创青春国家级金奖/一等奖-负责人",
      "小挑/互联网+/创青春国家级金奖/一等奖-成员前50%",
      "小挑/互联网+/创青春国家级金奖/一等奖-成员后50%",
      "小挑/互联网+/创青春国家级银奖/二等奖-负责人",
      "小挑/互联网+/创青春国家级银奖/二等奖-成员前50%",
      "小挑/互联网+/创青春国家级银奖/二等奖-成员后50%",
      "小挑/互联网+/创青春国家级铜奖/三等奖-负责人",
      "小挑/互联网+/创青春国家级铜奖/三等奖-成员前50%",
      "小挑/互联网+/创青春国家级铜奖/三等奖-成员后50%",
      "人工智能创意赛全国一等奖",
      "人工智能创意赛全国二等奖",
      "人工智能创意赛全国三等奖",
      "京彩大创一等奖-负责人",
      "京彩大创一等奖-成员前50%",
      "京彩大创一等奖-成员后50%",
      "京彩大创二等奖-负责人",
      "京彩大创二等奖-成员前50%",
      "京彩大创二等奖-成员后50%",
      "京彩大创三等奖-负责人",
      "京彩大创三等奖-成员前50%",
      "京彩大创三等奖-成员后50%",
      "京师杯一等奖",
      "京师杯二等奖"
    ]);
    await selectField(creativeItem, "main_track_factor", "赛道系数", ["主赛道", "非主赛道-0.8"], 2, false);
    await material(creativeItem, "获奖证书及成员排名证明", "成员排名以获奖证书为准。");
    await audit(creativeItem, "class_committee", "核对赛道、奖项、负责人/成员排名。", true);

    const teacher = await node(competition, "aggregate", "innovation.competition.teacher", "教师素养类", null, "max", 0, 30);
    const teacherItem = await node(teacher, "item", "innovation.competition.teacher.award", "教师素养类成果认定", null, "level", 1, 10);
    await config(teacherItem, "level", {
      levels: [
        { name: "全国高等师范院校未来教师素质大赛-一等奖", score: 2 },
        { name: "全国高等师范院校未来教师素质大赛-二等奖", score: 1.5 },
        { name: "全国高等师范院校未来教师素质大赛-三等奖", score: 1.2 },
        { name: "未来教师素质大赛校级-一等奖", score: 1 },
        { name: "未来教师素质大赛校级-二等奖", score: 0.8 },
        { name: "未来教师素质大赛校级-三等奖", score: 0.4 },
        { name: "NOI教练证书-初级教练", score: 1.5 },
        { name: "RoboCup中国赛-一等奖", score: 2 },
        { name: "RoboCup中国赛-二等奖", score: 1 },
        { name: "RoboCup中国赛-三等奖", score: 0.5 }
      ]
    });
    await selectField(teacherItem, "teacher_award_level", "教师素养成果", [
      "全国高等师范院校未来教师素质大赛-一等奖",
      "全国高等师范院校未来教师素质大赛-二等奖",
      "全国高等师范院校未来教师素质大赛-三等奖",
      "未来教师素质大赛校级-一等奖",
      "未来教师素质大赛校级-二等奖",
      "未来教师素质大赛校级-三等奖",
      "NOI教练证书-初级教练",
      "RoboCup中国赛-一等奖",
      "RoboCup中国赛-二等奖",
      "RoboCup中国赛-三等奖"
    ]);
    await material(teacherItem, "证书或获奖证明", "师范生限制等由审核人核对。");
    await audit(teacherItem, "class_committee", "核对成果类别、证书、师范生适用限制。");

    const certification = await node(innovation, "aggregate", "innovation.certification", "学科认证", null, "max", 0, 30);
    const cspItem = await node(certification, "item", "innovation.certification.csp", "计算机软件能力认证 CSP", null, "level", 1, 10, "成绩当年认定，仅计算一次。");
    await config(cspItem, "level", {
      levels: [
        { name: "CSP 400分及以上", score: 3 },
        { name: "CSP 350分及以上", score: 2 },
        { name: "CSP 300分及以上", score: 1.5 },
        { name: "CSP 250分及以上", score: 1 }
      ]
    });
    await selectField(cspItem, "csp_score_band", "CSP成绩档位", ["CSP 400分及以上", "CSP 350分及以上", "CSP 300分及以上", "CSP 250分及以上"]);
    await material(cspItem, "CSP成绩证明", "需提供成绩证明。");
    await audit(cspItem, "class_committee", "核对成绩年份、分数和是否重复认定。");

    const studentWork = await node(total, "aggregate", "student_work", "学生工作", 7, "cap", 0, 40, "附件四。岗位任职上限3分，学生活动上限4分。");
    const position = await node(studentWork, "aggregate", "student_work.position", "岗位任职", 3, "max", 0, 10, "各岗位类别加分不累计，取最高。");
    const positionItem = await node(position, "item", "student_work.position.role", "岗位任职认定", null, "formula", 1, 10);
    await config(positionItem, "formula", {
      formula: "base_score * evaluation_weight",
      base_scores: [
        { name: "校级职务一档", score: 3 },
        { name: "校级职务二档", score: 2 },
        { name: "校级职务三档", score: 1 },
        { name: "校级职务四档", score: 0.5 },
        { name: "校级职务五档", score: 0.25 },
        { name: "党支部书记", score: 2 },
        { name: "党支部委员", score: 1 },
        { name: "班长/团支书/学习委员", score: 2 },
        { name: "雪绒花使者/体育委员/文艺委员/其他班委", score: 1 },
        { name: "院团委副书记/院学生会主席", score: 3 },
        { name: "院团委/院学生会部门负责人/雪绒花使者负责人", score: 2 },
        { name: "人工智能社团社长", score: 0.5 },
        { name: "青年团校/青春宣讲团A级", score: 1 },
        { name: "青年团校/青春宣讲团B级", score: 0.5 },
        { name: "青年团校/青春宣讲团C级", score: 0.2 }
      ]
    }, "POSITION_SCORE_BY_WEIGHT");
    await selectField(positionItem, "position_name", "岗位类别", [
      "校级职务一档",
      "校级职务二档",
      "校级职务三档",
      "校级职务四档",
      "校级职务五档",
      "党支部书记",
      "党支部委员",
      "班长/团支书/学习委员",
      "雪绒花使者/体育委员/文艺委员/其他班委",
      "院团委副书记/院学生会主席",
      "院团委/院学生会部门负责人/雪绒花使者负责人",
      "人工智能社团社长",
      "青年团校/青春宣讲团A级",
      "青年团校/青春宣讲团B级",
      "青年团校/青春宣讲团C级"
    ]);
    await numberField(positionItem, "evaluation_weight", "岗位评价权重", { min: 0, max: 1, step: 0.01 }, 2);
    await material(positionItem, "任职证明或评议结果", "需包含任职周期和评价权重。");
    await audit(positionItem, "class_committee", "核对是否满一年、权重来源、岗位类别是否取最高。");

    const activity = await node(studentWork, "aggregate", "student_work.activity", "学生活动", 4, "cap", 0, 20);
    const sports = await node(activity, "aggregate", "student_work.activity.sports", "文体比赛类", 2, "cap", 0, 10);
    const sportsItem = await node(sports, "item", "student_work.activity.sports.award", "文体比赛获奖认定", null, "weight", 1, 10);
    await config(sportsItem, "weight", {
      levels: [
        { name: "校级一档", score: 2 },
        { name: "校级二档", score: 1 },
        { name: "校级三档", score: 0.5 },
        { name: "校级四档", score: 0.3 },
        { name: "校级五档", score: 0.1 },
        { name: "弃赛/未完成/消极应赛", score: -1 }
      ],
      weights: [
        { name: "A 级项目", weight: 1 },
        { name: "B 级项目", weight: 0.8 },
        { name: "C 级项目", weight: 0.6 }
      ]
    }, "BASE_SCORE_TIMES_WEIGHT");
    await selectField(sportsItem, "award_level", "比赛分档", ["校级一档", "校级二档", "校级三档", "校级四档", "校级五档", "弃赛/未完成/消极应赛"]);
    await selectField(sportsItem, "event_weight", "项目难度", ["A 级项目", "B 级项目", "C 级项目"], 2, false);
    await material(sportsItem, "文体比赛证明材料", "需提供报名名单、比赛名次或活动证明。");
    await audit(sportsItem, "class_committee", "核对名单、名次、项目难度分级和是否弃赛。");

    const collegeActivity = await node(activity, "aggregate", "student_work.activity.college_event", "参与学院大型活动", 0.5, "cap", 0, 20);
    const collegeActivityItem = await node(collegeActivity, "item", "student_work.activity.college_event.participation", "学院大型活动参与认定", null, "level", 1, 10);
    await config(collegeActivityItem, "level", {
      levels: [
        { name: "院级一档-主持团队负责人/节目负责人", score: 0.5 },
        { name: "院级二档-主持团队参与人/节目参与人", score: 0.3 }
      ]
    });
    await selectField(collegeActivityItem, "college_event_level", "学院大型活动分档", ["院级一档-主持团队负责人/节目负责人", "院级二档-主持团队参与人/节目参与人"]);
    await material(collegeActivityItem, "学院大型活动证明", "需提供活动组织方证明。");
    await audit(collegeActivityItem, "class_committee", "核对活动级别、角色和证明材料。");

    const practice = await node(activity, "aggregate", "student_work.activity.practice", "实践活动", 1.5, "cap", 0, 30);
    const practiceItem = await node(practice, "item", "student_work.activity.practice.result", "实践活动认定", null, "level", 1, 10);
    await config(practiceItem, "level", {
      levels: [
        { name: "暑期社会实践/寒假返乡调研-特等-主持", score: 1 },
        { name: "暑期社会实践/寒假返乡调研-特等-参与", score: 0.5 },
        { name: "暑期社会实践/寒假返乡调研-一等-主持", score: 0.9 },
        { name: "暑期社会实践/寒假返乡调研-一等-参与", score: 0.4 },
        { name: "暑期社会实践/寒假返乡调研-二等-主持", score: 0.4 },
        { name: "暑期社会实践/寒假返乡调研-二等-参与", score: 0.15 },
        { name: "暑期社会实践/寒假返乡调研-三等-主持", score: 0.2 },
        { name: "暑期社会实践/寒假返乡调研-三等-参与", score: 0.1 },
        { name: "人工智能学院立项追加", score: 0.1 },
        { name: "北京市级奖励追加", score: 0.2 },
        { name: "国家级奖励追加", score: 0.5 },
        { name: "国家级重大专项活动完成", score: 1.5 }
      ]
    });
    await selectField(practiceItem, "practice_level", "实践活动档位", [
      "暑期社会实践/寒假返乡调研-特等-主持",
      "暑期社会实践/寒假返乡调研-特等-参与",
      "暑期社会实践/寒假返乡调研-一等-主持",
      "暑期社会实践/寒假返乡调研-一等-参与",
      "暑期社会实践/寒假返乡调研-二等-主持",
      "暑期社会实践/寒假返乡调研-二等-参与",
      "暑期社会实践/寒假返乡调研-三等-主持",
      "暑期社会实践/寒假返乡调研-三等-参与",
      "人工智能学院立项追加",
      "北京市级奖励追加",
      "国家级奖励追加",
      "国家级重大专项活动完成"
    ]);
    await material(practiceItem, "实践活动结项/奖励证明", "需体现评级、本人角色、学院立项或奖励情况。");
    await audit(practiceItem, "class_committee", "核对评级、角色、追加加分条件。");

    const partyClass = await node(activity, "aggregate", "student_work.activity.party_class", "党团班活动", 2, "cap", 0, 40);
    const partyClassItem = await node(partyClass, "item", "student_work.activity.party_class.record", "党团班活动认定", null, "level", 1, 10);
    await config(partyClassItem, "level", {
      levels: [
        { name: "文明宿舍一等奖", score: 1 },
        { name: "文明宿舍二等奖", score: 0.7 },
        { name: "文明宿舍三等奖", score: 0.5 },
        { name: "学院学术实践活动参与1次", score: 0.1 },
        { name: "班级活动参与超过2/3", score: 0.5 },
        { name: "党员/预备党员党支部活动不足1/2", score: -0.5 },
        { name: "团员团支部活动不足1/2", score: -0.5 }
      ]
    });
    await selectField(partyClassItem, "party_class_level", "党团班活动档位", [
      "文明宿舍一等奖",
      "文明宿舍二等奖",
      "文明宿舍三等奖",
      "学院学术实践活动参与1次",
      "班级活动参与超过2/3",
      "党员/预备党员党支部活动不足1/2",
      "团员团支部活动不足1/2"
    ]);
    await material(partyClassItem, "党团班活动证明", "认证表、班委/党支部/团支部签字确认材料。");
    await audit(partyClassItem, "class_committee", "核对参与次数、身份、证明签字。");

    const [yearResult] = await conn.execute(
      `INSERT INTO academic_year
       (name, evaluation_start_date, evaluation_end_date, apply_start_time, apply_end_time, audit_start_time, audit_end_time, status)
       VALUES (?, '2025-09-01', '2026-08-31', '2026-09-01 00:00:00', '2026-09-20 23:59:59',
       '2026-09-21 00:00:00', '2026-10-10 23:59:59', 'configuring')`,
      [`2025-2026学年默认规则验证-${suffix}`]
    );

    return { ruleSetId, versionId, academicYearId: yearResult.insertId };
  });
}

export { seedDefaultRuleSet };
