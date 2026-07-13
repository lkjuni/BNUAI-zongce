import { transaction } from "./db.js";

// 默认规则严格使用两种节点语义：aggregate 只负责汇总，item 只负责一次申报和基础计分。
// 一个学生在一个学年内对同一 item 最多只有一条 application_record。
const defaultRuleSetName = "人工智能学院本科生综合测评默认规则集";

async function seedDefaultRuleSet() {
  return transaction(async (conn) => {
    const suffix = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
    const [setResult] = await conn.execute(
      `INSERT INTO rule_set (college_id, name, description, status, created_by)
       VALUES (1, ?, ?, 'enabled', 1)`,
      [
        `${defaultRuleSetName}-${suffix}`,
        "按统一节点语义重构：汇总节点只汇总，规则项只接受每名学生每学年一条申报。"
      ]
    );
    const ruleSetId = setResult.insertId;

    const [versionResult] = await conn.execute(
      `INSERT INTO rule_set_version
       (rule_set_id, version_no, version_name, status, change_note, published_by, published_at)
       VALUES (?, 'default-2026-v2', '默认规则集 2026 规范版', 'published', ?, 1, NOW())`,
      [ruleSetId, "消除单子节点伪汇总；独立成果拆分为平级规则项；规则项固定不可重复申报"]
    );
    const versionId = versionResult.insertId;

    async function node(parentId, nodeType, code, name, maxScore, aggregationType, isApplyEntry, sortOrder, description = null) {
      if (nodeType === "item" && (maxScore !== null || aggregationType !== null)) {
        throw new Error(`规则项 ${code} 不能配置汇总上限或汇总方式`);
      }
      const [result] = await conn.execute(
        `INSERT INTO rule_node
         (rule_set_version_id, parent_id, node_type, code, name, max_score, aggregation_type,
          is_apply_entry, allow_repeat, sort_order, status, description)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'enabled', ?)`,
        [versionId, parentId, nodeType, code, name, maxScore, aggregationType, isApplyEntry ? 1 : 0, sortOrder, description]
      );
      return result.insertId;
    }

    const aggregate = (parentId, code, name, maxScore, aggregationType, sortOrder, description = null) =>
      node(parentId, "aggregate", code, name, maxScore, aggregationType, false, sortOrder, description);
    const item = (parentId, code, name, sortOrder, description = null) =>
      node(parentId, "item", code, name, null, null, true, sortOrder, description);

    async function config(nodeId, configType, configJson, formulaCode = null) {
      await conn.execute(
        `INSERT INTO rule_calculation_config (node_id, config_type, formula_code, config_json, rounding_rule)
         VALUES (?, ?, ?, ?, 'round')`,
        [nodeId, configType, formulaCode, JSON.stringify(configJson)]
      );
    }

    async function field(nodeId, key, label, type, options = null, sortOrder = 1, required = true, validation = null) {
      await conn.execute(
        `INSERT INTO rule_form_field
         (node_id, field_key, field_label, field_type, required, options_json, validation_json, sort_order)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [nodeId, key, label, type, required ? 1 : 0, options ? JSON.stringify(options) : null, validation ? JSON.stringify(validation) : null, sortOrder]
      );
    }

    async function proof(nodeId, name, description, maxFileCount = 5) {
      await conn.execute(
        `INSERT INTO material_requirement
         (node_id, material_name, required, description, file_type_limit, max_file_count)
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

    async function levelItem(parentId, definition) {
      const nodeId = await item(parentId, definition.code, definition.name, definition.sortOrder, definition.description);
      await config(nodeId, definition.configType || "level", {
        levels: definition.levels,
        ...(definition.weights ? { weights: definition.weights } : {})
      }, definition.formulaCode || null);
      await field(nodeId, definition.fieldKey || "score_level", definition.fieldLabel || "计分档位", "select", definition.levels.map((row) => row.name));
      for (const extra of definition.extraFields || []) {
        await field(nodeId, extra.key, extra.label, extra.type, extra.options, extra.sortOrder, extra.required, extra.validation);
      }
      await proof(nodeId, definition.materialName || "证明材料", definition.materialDescription || "需提供可核验的正式证明。", definition.maxFileCount || 5);
      await audit(nodeId, definition.auditRole || "class_committee", definition.auditInstruction || "核对申报内容、计分档位和证明材料。", Boolean(definition.secondAudit));
      return nodeId;
    }

    const total = await aggregate(null, "total", "综合测评总分", 105, "sum", 1, "规则集根节点");
    await aggregate(total, "moral", "思想品德", 5, "manual", 10, "外部评价结果导入，不作为学生申报项。");
    await aggregate(total, "academic", "学业成绩", 86, "manual", 20, "教务成绩导入，不作为学生申报项。");

    const innovation = await aggregate(total, "innovation", "学术创新成果", 7, "cap", 30, "附件二；全部独立成果汇总后最高 7 分。");
    const research = await aggregate(innovation, "innovation.research", "科研成果", null, "sum", 10);

    await levelItem(research, {
      code: "innovation.research.project",
      name: "科研项目",
      sortOrder: 10,
      description: "项目级别、本人角色和结项状态是同一科研项目的互斥属性，一学年只申报一次。",
      fieldKey: "project_score_level",
      fieldLabel: "项目计分档位",
      levels: [
        ["国家级科研训练-主持-结题", 1], ["国家级科研训练-主持-优秀", 2],
        ["国家级科研训练-参与-结题", 0.6], ["国家级科研训练-参与-优秀", 1.5],
        ["北京市级科研训练/启研计划-主持-结题", 0.8], ["北京市级科研训练/启研计划-主持-优秀", 1.5],
        ["北京市级科研训练/启研计划-参与-结题", 0.5], ["北京市级科研训练/启研计划-参与-优秀", 1],
        ["校级科研训练-主持-结题", 0.6], ["校级科研训练-主持-优秀", 1],
        ["校级科研训练-参与-结题", 0.3], ["校级科研训练-参与-优秀", 0.5],
        ["国家级创业训练-主持-结题", 1], ["国家级创业训练-主持-优秀", 2],
        ["国家级创业训练-成员前50%-结题", 0.6], ["国家级创业训练-成员后50%-结题", 0.3],
        ["国家级创业实践-主持-中期", 0.5], ["国家级创业实践-主持-结题", 1], ["国家级创业实践-主持-优秀", 2],
        ["未成功结题或中期退出-主持", -2], ["未成功结题或中期退出-参与", -1]
      ].map(([name, score]) => ({ name, score })),
      extraFields: [{ key: "project_name", label: "项目名称", type: "text", sortOrder: 2, required: true }],
      materialName: "项目结题/中期/优秀证明",
      auditInstruction: "核对项目级别、角色、成员排名和结项状态。",
      secondAudit: false
    });

    const paperItem = await item(research, "innovation.research.paper", "年度最高论文成果", 20, "同一学年只申报计分最高的一篇论文，避免用规则项承担多条成果汇总。");
    const paperLevels = [["A+类论文", 7], ["A类论文", 5], ["A-类论文", 4], ["B+类论文", 3], ["B类论文", 2], ["B-类论文", 1], ["C类论文", 0.8], ["C-类论文", 0.5]].map(([name, score]) => ({ name, score }));
    await config(paperItem, "formula", { levels: paperLevels }, "PAPER_SCORE_BY_AUTHORS");
    await field(paperItem, "paper_level", "论文类别", "select", paperLevels.map((row) => row.name));
    await field(paperItem, "paper_title", "论文题目", "text", null, 2);
    await field(paperItem, "co_first_author_count", "共同第一作者人数 N", "number", null, 3, false, { min: 1, step: 1 });
    await proof(paperItem, "论文发表/录用证明", "正式发表或录用证明、作者顺序和目录分类证明。", 8);
    await audit(paperItem, "college_admin", "核对论文目录、作者顺序、共同一作人数和奖励升级。", false);

    const otherResearch = await aggregate(research, "innovation.research.other", "其他成果", null, "max", 30, "多个其他成果只取最高分。");
    const patentItem = await item(otherResearch, "innovation.research.other.patent", "国家发明专利授权", 10);
    await config(patentItem, "fixed", { score: 1 });
    await field(patentItem, "patent_name", "专利名称", "text");
    await proof(patentItem, "专利授权书", "仅认定已授权发明专利及规定发明人顺序。");
    await audit(patentItem, "college_admin", "核对专利类型、授权状态和发明人顺序。", false);
    const highLevelItem = await item(otherResearch, "innovation.research.other.high_level", "其他高水平成果", 20);
    await config(highLevelItem, "formula", { field_key: "manual_score" }, "DIRECT_FIELD_SCORE");
    await field(highLevelItem, "achievement_name", "成果名称", "text");
    await field(highLevelItem, "manual_score", "工作小组认定分数", "number", null, 2, true, { min: 0, max: 7, step: 0.001 });
    await proof(highLevelItem, "专家推荐或评议材料", "专家推荐和工作小组评议意见。", 8);
    await audit(highLevelItem, "college_admin", "由工作小组评议并确认分值。", false);

    const competition = await aggregate(innovation, "innovation.competition", "竞赛获奖", null, "sum", 20);
    const professional = await aggregate(competition, "innovation.competition.professional", "专业竞赛类", null, "sum", 10, "不同竞赛可以同时发生，拆为独立规则项后求和。");
    const professionalItems = [
      ["icpc", "国际大学生程序设计竞赛", [["世界总决赛入围",7],["东大陆决赛金奖",5],["东大陆决赛银奖",4],["东大陆决赛铜奖",3],["区域赛金奖",3],["区域赛银奖",2],["区域赛铜奖",1]]],
      ["ccpc", "中国大学生程序设计竞赛", [["全国总决赛金奖",5],["全国总决赛银奖",4],["全国总决赛铜奖",3],["区域赛/女生专场金奖",3],["区域赛/女生专场银奖",2],["区域赛/女生专场铜奖",1],["校内选拔一等奖",0.5],["校内选拔二等奖",0.3]]],
      ["bj_programming", "北京市大学生程序设计竞赛", [["金奖",2],["银奖",1],["铜奖",0.5]]],
      ["ladder", "团体程序设计天梯赛全国个人奖", [["一等奖",1],["二等奖",0.8],["三等奖",0.4]]],
      ["system_ability", "全国大学生计算机系统能力大赛", [["特等奖",5],["一等奖",4],["二等奖",3],["三等奖",2.5]]],
      ["asc", "ASC世界大学生超级计算机竞赛", [["冠军",5],["亚军",4],["晋级决赛",2]]],
      ["huawei_ict", "华为ICT大赛创新赛", [["世界特等奖",5],["世界一等奖",4],["世界二等奖",3],["世界三等奖",2],["全国特等奖",3],["全国一等奖",2],["全国二等奖",1.5],["全国三等奖",1]]],
      ["mcm", "美国大学生数学建模竞赛", [["O奖",1],["F奖",0.8],["M奖",0.5]]],
      ["cn_mcm", "全国大学生数学建模竞赛", [["一等奖",1],["二等奖",0.8]]]
    ];
    for (let index = 0; index < professionalItems.length; index++) {
      const [code, name, levels] = professionalItems[index];
      await levelItem(professional, {
        code: `innovation.competition.professional.${code}`,
        name,
        sortOrder: (index + 1) * 10,
        levels: levels.map(([levelName, score]) => ({ name: levelName, score })),
        fieldKey: "award_level",
        fieldLabel: "奖项",
        materialName: "获奖证书或官方证明",
        auditInstruction: `核对${name}奖项、本人身份和证明材料。`,
        secondAudit: false
      });
    }

    const creative = await aggregate(competition, "innovation.competition.creative", "创意策划类", null, "sum", 20, "不同竞赛拆分；同一竞赛内部奖项和成员角色互斥。");
    const creativeItems = [
      ["challenge_cup", "挑战杯课外学术科技作品竞赛", [["国家特等奖-负责人",7],["国家特等奖-成员前50%",5],["国家特等奖-成员后50%",4],["国家一等奖-负责人",5],["国家一等奖-成员前50%",4],["国家一等奖-成员后50%",3],["国家二等奖-负责人",4],["国家二等奖-成员前50%",3],["国家二等奖-成员后50%",2],["省市特等奖-负责人",2.5],["省市一等奖-负责人",2]], true],
      ["entrepreneurship", "小挑/互联网+/创青春", [["国家金奖/一等奖-负责人",5],["国家金奖/一等奖-成员前50%",3],["国家金奖/一等奖-成员后50%",2],["国家银奖/二等奖-负责人",3.5],["国家铜奖/三等奖-负责人",2.5],["省市金奖/一等奖-负责人",2],["省市银奖/二等奖-负责人",1.6],["省市铜奖/三等奖-负责人",1.2]], true],
      ["ai_creativity", "中国高校计算机大赛人工智能创意赛", [["全国一等奖",2],["全国二等奖",1.5],["全国三等奖",1]], false],
      ["jingcai", "京彩大创北京大学生创新创业大赛", [["一等奖-负责人",1.5],["一等奖-成员前50%",0.9],["一等奖-成员后50%",0.5],["二等奖-负责人",1],["二等奖-成员前50%",0.6],["二等奖-成员后50%",0.3],["三等奖-负责人",0.5],["三等奖-成员前50%",0.3],["三等奖-成员后50%",0.15]], false],
      ["jingshi", "京师杯课外学术科技作品竞赛", [["一等奖",0.5],["二等奖",0.3]], true]
    ];
    for (let index = 0; index < creativeItems.length; index++) {
      const [code, name, levels, trackFactor] = creativeItems[index];
      await levelItem(creative, {
        code: `innovation.competition.creative.${code}`,
        name,
        sortOrder: (index + 1) * 10,
        levels: levels.map(([levelName, score]) => ({ name: levelName, score })),
        fieldKey: "award_level",
        fieldLabel: "奖项及团队角色",
        weights: trackFactor ? [{ name: "主赛道", weight: 1 }, { name: "非主赛道", weight: 0.8 }] : null,
        extraFields: trackFactor ? [{ key: "track_type", label: "赛道", type: "select", options: ["主赛道", "非主赛道"], sortOrder: 2, required: true }] : [],
        materialName: "获奖证书及成员排名证明",
        auditInstruction: `核对${name}奖项、赛道和团队角色。`,
        secondAudit: false
      });
    }

    const teacher = await aggregate(competition, "innovation.competition.teacher", "教师素养类", null, "sum", 30);
    const teacherItems = [
      ["national_future_teacher", "全国高等师范院校未来教师素质大赛", [["一等奖",2],["二等奖",1.5],["三等奖",1.2]]],
      ["school_future_teacher", "未来教师素质大赛校级", [["一等奖",1],["二等奖",0.8],["三等奖",0.4]]],
      ["noi_coach", "NOI初级教练证书", [["取得初级教练证书",1.5]]],
      ["robocup", "RoboCup机器人世界杯中国赛", [["一等奖",2],["二等奖",1],["三等奖",0.5]]]
    ];
    for (let index = 0; index < teacherItems.length; index++) {
      const [code, name, levels] = teacherItems[index];
      await levelItem(teacher, {
        code: `innovation.competition.teacher.${code}`,
        name,
        sortOrder: (index + 1) * 10,
        levels: levels.map(([levelName, score]) => ({ name: levelName, score })),
        fieldKey: "achievement_level",
        fieldLabel: "成果档位",
        materialName: "证书或获奖证明",
        auditInstruction: `核对${name}证书、奖项及适用对象。`
      });
    }

    await levelItem(innovation, {
      code: "innovation.certification.csp",
      name: "计算机软件能力认证 CSP",
      sortOrder: 30,
      description: "取得成绩当年认定，一学年只申报一次。",
      levels: [["400分及以上",3],["350分及以上",2],["300分及以上",1.5],["250分及以上",1]].map(([name, score]) => ({ name, score })),
      fieldKey: "csp_score_band",
      fieldLabel: "CSP成绩档位",
      materialName: "CSP成绩证明",
      auditInstruction: "核对成绩年份、分数和是否已在其他学年认定。"
    });

    const studentWork = await aggregate(total, "student_work", "学生工作", 7, "cap", 40, "附件四；岗位任职最高3分，学生活动最高4分。");
    const positionItem = await item(studentWork, "student_work.position", "岗位任职", 10, "多个岗位不累计，学生只申报计分最高的一个岗位。");
    const positionScores = [["校级职务一档",3],["校级职务二档",2],["校级职务三档",1],["校级职务四档",0.5],["校级职务五档",0.25],["党支部书记",2],["党支部委员",1],["班长/团支书/学习委员",2],["其他班委",1],["院团委副书记/院学生会主席",3],["院级部门负责人",2],["人工智能社团社长",0.5],["青年团校/宣讲团A级",1],["青年团校/宣讲团B级",0.5],["青年团校/宣讲团C级",0.2]];
    await config(positionItem, "formula", { base_scores: positionScores.map(([name, score]) => ({ name, score })) }, "POSITION_SCORE_BY_WEIGHT");
    await field(positionItem, "position_name", "岗位类别", "select", positionScores.map(([name]) => name));
    await field(positionItem, "evaluation_weight", "岗位评价权重", "number", null, 2, true, { min: 0, max: 1, step: 0.01 });
    await proof(positionItem, "任职证明或评议结果", "需包含任职周期和评价权重。", 8);
    await audit(positionItem, "class_committee", "核对任职时长、岗位类别、评价权重并确认只取最高岗位。");

    const activity = await aggregate(studentWork, "student_work.activity", "学生活动", 4, "cap", 20);
    const sports = await aggregate(activity, "student_work.activity.sports", "文体比赛类", 2, "cap", 10, "不同比赛项目独立申报，汇总后最高2分。");
    await levelItem(sports, {
      code: "student_work.activity.sports.campus_competition",
      name: "校级文体比赛",
      sortOrder: 10,
      levels: [["校级一档",2],["校级二档",1],["校级三档",0.5],["校级四档",0.3],["校级五档",0.1],["弃赛/未完成/消极应赛",-1]].map(([name, score]) => ({ name, score })),
      fieldKey: "award_level",
      fieldLabel: "比赛分档",
      extraFields: [{ key: "competition_name", label: "比赛名称", type: "text", sortOrder: 2, required: true }],
      materialName: "报名名单和比赛结果证明",
      auditInstruction: "核对比赛名称、名单、名次和是否正常完赛。"
    });
    await levelItem(sports, {
      code: "student_work.activity.sports.meeting_event",
      name: "运动会项目",
      sortOrder: 20,
      levels: [["第一至二名",1],["第三至四名",0.5],["第五至六名",0.3],["第七至八名",0.1]].map(([name, score]) => ({ name, score })),
      weights: [{ name: "A级项目", weight: 1 }, { name: "B级项目", weight: 0.8 }, { name: "C级项目", weight: 0.6 }],
      fieldKey: "rank_level",
      fieldLabel: "名次档位",
      extraFields: [{ key: "event_weight", label: "项目难度", type: "select", options: ["A级项目", "B级项目", "C级项目"], sortOrder: 2, required: true }],
      materialName: "运动会报名及成绩证明",
      auditInstruction: "核对参赛名单、项目难度和最终名次。"
    });

    await levelItem(activity, {
      code: "student_work.activity.college_event",
      name: "参与学院大型活动",
      sortOrder: 20,
      description: "一学年只申报本人参与层级最高的一次学院大型活动。",
      levels: [["主持团队负责人/节目负责人",0.5],["主持团队参与人/节目参与人",0.3]].map(([name, score]) => ({ name, score })),
      fieldKey: "college_event_level",
      fieldLabel: "参与角色",
      materialName: "学院大型活动证明",
      auditInstruction: "核对活动和本人承担的角色。"
    });

    const practice = await aggregate(activity, "student_work.activity.practice", "实践活动", 1.5, "cap", 30);
    const socialPractice = await item(practice, "student_work.activity.practice.social", "寒暑期社会实践", 10);
    const practiceLevels = [["特等-主持",1],["特等-参与",0.5],["一等-主持",0.9],["一等-参与",0.4],["二等-主持",0.4],["二等-参与",0.15],["三等-主持",0.2],["三等-参与",0.1]].map(([name, score]) => ({ name, score }));
    await config(socialPractice, "formula", { levels: practiceLevels }, "PRACTICE_SCORE_WITH_BONUS");
    await field(socialPractice, "practice_level", "结项评级及角色", "select", practiceLevels.map((row) => row.name));
    await field(socialPractice, "college_project", "是否在人工智能学院立项", "select", ["否", "是"], 2);
    await field(socialPractice, "extra_award", "追加奖励", "select", ["无", "北京市级奖励", "国家级奖励"], 3);
    await proof(socialPractice, "实践活动结项及奖励证明", "需体现评级、角色、立项单位和奖励。", 8);
    await audit(socialPractice, "class_committee", "核对评级、角色、学院立项及奖励。");
    const nationalActivity = await item(practice, "student_work.activity.practice.national_special", "国家级重大专项活动", 20);
    await config(nationalActivity, "fixed", { score: 1.5 });
    await field(nationalActivity, "activity_name", "活动名称", "text");
    await proof(nationalActivity, "学校选拔及完成证明", "需证明经学校选拔并完成活动。");
    await audit(nationalActivity, "class_committee", "核对学校选拔和活动完成情况。");

    const partyClass = await aggregate(activity, "student_work.activity.party_class", "党团班活动", 2, "cap", 40);
    await levelItem(partyClass, {
      code: "student_work.activity.party_class.dormitory",
      name: "文明宿舍",
      sortOrder: 10,
      levels: [["一等奖",1],["二等奖",0.7],["三等奖",0.5]].map(([name, score]) => ({ name, score })),
      fieldKey: "dormitory_award",
      fieldLabel: "荣誉等级",
      materialName: "文明宿舍荣誉证明"
    });
    const lectureItem = await item(partyClass, "student_work.activity.party_class.academic_lecture", "学院学术实践活动", 20);
    await config(lectureItem, "formula", { field_key: "activity_count", step_score: 0.1, max_score: 1 }, "QUANTITY_STEP_CAP");
    await field(lectureItem, "activity_count", "认证活动参与次数", "number", null, 1, true, { min: 1, step: 1 });
    await proof(lectureItem, "学术实践活动认证表", "以盖章认证表为准。", 10);
    await audit(lectureItem, "class_committee", "核对认证活动次数，上限1分。");

    const fixedPartyItems = [
      ["class_participation", "班级活动参与超过2/3", 0.5, "班委会、班主任签字确认材料"],
      ["party_absence", "党支部活动参与不足1/2", -0.5, "党支部委员和书记确认材料"],
      ["league_absence", "团支部活动参与不足1/2", -0.5, "团支委和班主任确认材料"]
    ];
    for (let index = 0; index < fixedPartyItems.length; index++) {
      const [code, name, score, materialDescription] = fixedPartyItems[index];
      const nodeId = await item(partyClass, `student_work.activity.party_class.${code}`, name, 30 + index * 10);
      await config(nodeId, "fixed", { score });
      await field(nodeId, "confirmation", "确认说明", "textarea");
      await proof(nodeId, "签字确认材料", materialDescription);
      await audit(nodeId, "class_committee", `核对${name}的参与比例和签字材料。`);
    }

    const [yearResult] = await conn.execute(
      `INSERT INTO academic_year
       (name, evaluation_start_date, evaluation_end_date, apply_start_time, apply_end_time,
        audit_start_time, audit_end_time, status)
       VALUES (?, '2025-09-01', '2026-08-31', '2026-09-01 00:00:00', '2026-09-20 23:59:59',
       '2026-09-21 00:00:00', '2026-10-10 23:59:59', 'configuring')`,
      [`2025-2026学年默认规则验证-${suffix}`]
    );

    return { ruleSetId, versionId, academicYearId: yearResult.insertId };
  });
}

export { seedDefaultRuleSet };
