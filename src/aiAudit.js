import { query, transaction } from "./db.js";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

// AI 自动审核模块
// 与人工审核并行执行，使用阿里云 DashScope OCR 识别材料中的姓名
// 无论 AI 审核结果如何，仍需人工审核确定

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const uploadDir = path.join(rootDir, "uploads", "applications");

// DashScope 兼容 OpenAI 的配置
const AI_API_BASE = process.env.AI_API_BASE_URL || "https://ws-uwiff5b8ww2vs5zv.cn-beijing.maas.aliyuncs.com/compatible-mode/v1";
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_MODEL = process.env.AI_MODEL || "qwen-vl-max";

// 简单中文转拼音映射（覆盖常见姓氏和常用字）
const PINYIN_MAP = {
  // 常见姓
  "李": "li", "王": "wang", "张": "zhang", "刘": "liu", "陈": "chen", "杨": "yang", "赵": "zhao", "黄": "huang",
  "周": "zhou", "吴": "wu", "徐": "xu", "孙": "sun", "胡": "hu", "朱": "zhu", "高": "gao", "林": "lin",
  "何": "he", "郭": "guo", "马": "ma", "罗": "luo", "梁": "liang", "宋": "song", "郑": "zheng", "谢": "xie",
  "韩": "han", "唐": "tang", "冯": "feng", "于": "yu", "董": "dong", "萧": "xiao", "程": "cheng", "曹": "cao",
  "袁": "yuan", "邓": "deng", "许": "xu", "傅": "fu", "沈": "shen", "曾": "zeng", "彭": "peng", "吕": "lv",
  "苏": "su", "卢": "lu", "蒋": "jiang", "蔡": "cai", "贾": "jia", "丁": "ding", "魏": "wei", "薛": "xue",
  "叶": "ye", "阎": "yan", "余": "yu", "潘": "pan", "杜": "du", "戴": "dai", "夏": "xia", "钟": "zhong",
  "汪": "wang", "田": "tian", "任": "ren", "姜": "jiang", "范": "fan", "方": "fang", "石": "shi", "姚": "yao",
  "谭": "tan", "廖": "liao", "邹": "zou", "熊": "xiong", "金": "jin", "陆": "lu", "郝": "hao", "孔": "kong",
  "白": "bai", "崔": "cui", "康": "kang", "毛": "mao", "邱": "qiu", "秦": "qin", "江": "jiang", "史": "shi",
  "顾": "gu", "侯": "hou", "邵": "shao", "孟": "meng", "龙": "long", "万": "wan", "段": "duan", "雷": "lei",
  "钱": "qian", "汤": "tang", "尹": "yin", "黎": "li", "易": "yi", "常": "chang", "武": "wu", "乔": "qiao",
  "贺": "he", "赖": "lai", "龚": "gong", "文": "wen",
  // 常见名字字
  "明": "ming", "华": "hua", "伟": "wei", "强": "qiang", "丽": "li", "芳": "fang", "敏": "min",
  "静": "jing", "磊": "lei", "洋": "yang", "勇": "yong", "涛": "tao", "斌": "bin", "超": "chao",
  "浩": "hao", "杰": "jie", "鹏": "peng", "宇": "yu", "轩": "xuan", "子": "zi", "文": "wen",
  "博": "bo", "思": "si", "睿": "rui", "晨": "chen", "阳": "yang", "雨": "yu", "雪": "xue",
  "飞": "fei", "峰": "feng", "军": "jun", "龙": "long", "志": "zhi", "建": "jian", "国": "guo",
  "平": "ping", "慧": "hui", "晓": "xiao", "一": "yi", "天": "tian", "乐": "le", "欣": "xin",
  "然": "ran", "宁": "ning", "彤": "tong", "涵": "han", "琪": "qi", "琳": "lin", "佳": "jia",
  "俊": "jun", "帅": "shuai", "凯": "kai", "铭": "ming", "扬": "yang", "昊": "hao", "逸": "yi",
  "源": "yuan", "泽": "ze", "瑞": "rui", "睿": "rui", "哲": "zhe", "恒": "heng", "嘉": "jia",
  "悦": "yue", "瑶": "yao", "璇": "xuan", "琬": "wan", "琛": "chen", "皓": "hao",
  "新": "xin", "成": "cheng", "德": "de", "毅": "yi", "宏": "hong", "良": "liang", "辉": "hui",
  "新华": "xinhua", "建国": "jianguo", "志强": "zhiqiang", "晓明": "xiaoming"
};

function nameToPinyin(chineseName) {
  // 将中文姓名转为拼音（每个字用空格分隔）
  if (!chineseName || typeof chineseName !== "string") return "";
  const pinyins = [];
  for (const char of chineseName) {
    const py = PINYIN_MAP[char];
    if (py) {
      // 首字母大写
      pinyins.push(py.charAt(0).toUpperCase() + py.slice(1));
    }
  }
  return {
    spaced: pinyins.join(" "),       // "Zhang San"
    nospace: pinyins.join(""),       // "ZhangSan"
    lowercaseNospace: pinyins.map(s => s.toLowerCase()).join("") // "zhangsan"
  };
}

function extractNamesFromText(text) {
  // 从 OCR 结果中提取可能的人名
  // 策略：匹配2-4个连续汉字 + 常见西文人名格式
  if (!text) return [];

  const names = new Set();

  // 1. 提取中文姓名（2-4个连续汉字，前面可能有逗号、空格、换行等分隔符）
  const chineseNamePattern = /[\s,，、\n\r]?([\u4e00-\u9fff]{2,4})(?=[\s,，、\n\r\)\)\.\。:：!！?？]|$)/g;
  let match;
  while ((match = chineseNamePattern.exec(text)) !== null) {
    const name = match[1].trim();
    if (name.length >= 2 && name.length <= 4) {
      names.add(name);
    }
  }

  // 2. 提取英文/拼音姓名（如 Zhang San, ZHANG San, ZhangSan）
  const englishNamePattern = /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)/g;
  while ((match = englishNamePattern.exec(text)) !== null) {
    names.add(match[1].trim());
  }

  // 3. 提取大写字母连续组合（可能是全大写姓名如 ZHANG SAN）
  const upperNamePattern = /([A-Z]{2,}(?:\s+[A-Z]{2,})+)/g;
  while ((match = upperNamePattern.exec(text)) !== null) {
    names.add(match[1].trim());
  }

  return [...names];
}

function matchStudentName(studentName, studentPinyin, recognizedNames) {
  // 检查学生姓名是否出现在识别到的姓名列表中
  const matches = [];
  const lowerStudentName = studentName.toLowerCase();

  for (const recognizedName of recognizedNames) {
    const lowerRecognized = recognizedName.toLowerCase();

    // 1. 直接中文匹配
    if (lowerRecognized === lowerStudentName) {
      matches.push({ recognized: recognizedName, method: "中文精确匹配" });
      continue;
    }

    // 2. 拼音空格格式匹配 (zhang san)
    if (lowerRecognized === studentPinyin.spaced.toLowerCase()) {
      matches.push({ recognized: recognizedName, method: "拼音空格格式匹配" });
      continue;
    }

    // 3. 拼音无空格匹配 (zhangsan)
    if (lowerRecognized === studentPinyin.lowercaseNospace) {
      matches.push({ recognized: recognizedName, method: "拼音连写匹配" });
      continue;
    }

    // 4. 模糊匹配：姓名中的每个字是否在识别名中出现
    const allCharsPresent = [...lowerStudentName].every(char => lowerRecognized.includes(char));
    if (allCharsPresent && lowerStudentName.length >= 2) {
      matches.push({ recognized: recognizedName, method: "字符包含匹配（部分匹配）" });
      continue;
    }

    // 5. 英文名中是否包含拼音的部分
    const pinyinWord = studentPinyin.lowercaseNospace;
    if (pinyinWord && lowerRecognized.includes(pinyinWord) && pinyinWord.length >= 4) {
      matches.push({ recognized: recognizedName, method: "拼音包含匹配" });
      continue;
    }
  }

  return matches;
}

async function performOcrOnAttachment(filePath, mimeType) {
  // 调用 DashScope 兼容 OpenAI 的多模态接口进行 OCR
  const fileBuffer = await fs.readFile(filePath);
  const base64Image = fileBuffer.toString("base64");
  const dataUrl = `data:${mimeType || "image/jpeg"};base64,${base64Image}`;

  const response = await fetch(`${AI_API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${AI_API_KEY}`
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [
        {
          role: "system",
          content: "你是一个 OCR 助手。请识别图片中所有的文字内容，特别关注其中出现的所有人名。以纯文本形式返回所有文字，不要遗漏任何内容。"
        },
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: dataUrl } },
            { type: "text", text: "请识别这张图片中的所有文字，特别注意提取其中出现的人名。" }
          ]
        }
      ],
      max_tokens: 4096
    })
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(`AI API 调用失败: HTTP ${response.status} - ${errorBody}`);
  }

  const result = await response.json();
  const content = result.choices?.[0]?.message?.content || "";

  return {
    rawText: content,
    model: AI_MODEL
  };
}

async function getApplicationAttachments(applicationId) {
  const attachments = await query(
    `SELECT id, file_url, file_name, mime_type, storage_key, status
     FROM application_attachment
     WHERE application_id = :applicationId AND status = 'active'
     ORDER BY id`,
    { applicationId }
  );
  return attachments;
}

async function getStudentInfo(refId) {
  // application_record.student_id 可能存的是 student_profile.id，也可能是 student_no
  // 先用 id 查找，再用 student_no 查找
  let [student] = await query(
    `SELECT id, student_no, name FROM student_profile WHERE id = :refId`,
    { refId }
  );
  if (!student) {
    [student] = await query(
      `SELECT id, student_no, name FROM student_profile WHERE student_no = :refNo`,
      { refNo: String(refId) }
    );
  }
  if (!student) {
    // 最后尝试 CAST 匹配
    [student] = await query(
      `SELECT id, student_no, name FROM student_profile WHERE CAST(id AS CHAR) = :refStr OR student_no = :refStr2`,
      { refStr: String(refId), refStr2: String(refId) }
    );
  }
  return student || null;
}

async function triggerAiAudit(applicationId) {
  // 为一条申报触发 AI 自动审核
  try {
    if (!AI_API_KEY) {
      throw new Error("未配置 AI_API_KEY，无法执行 AI 自动审核");
    }

    const [application] = await query(
      `SELECT id, student_id, status FROM application_record WHERE id = :applicationId`,
      { applicationId }
    );
    if (!application) throw new Error("申报记录不存在");

    const student = await getStudentInfo(application.student_id);
    if (!student || !student.name) throw new Error("无法获取学生姓名信息");

    const studentName = student.name;
    const studentPinyin = nameToPinyin(studentName);

    // 获取材料附件
    const attachments = await getApplicationAttachments(applicationId);

    if (!attachments.length) {
      await insertAiAuditResult({
        applicationId: application.id,
        attachmentId: null,
        studentName,
        studentNamePinyin: JSON.stringify(studentPinyin),
        recognizedNames: JSON.stringify([]),
        ocrRawText: "无附件材料",
        matchSuccess: false,
        matchDetail: "该申报未上传任何材料附件",
        status: "completed",
        modelUsed: null
      });
      return { applicationId, status: "completed", matchSuccess: false, reason: "无附件" };
    }

    // 对每个附件执行 OCR 并匹配
    const allResults = [];

    for (const attachment of attachments) {
      // 更新状态为 processing
      await query(
        `INSERT INTO ai_audit_record
         (application_id, attachment_id, student_name, student_name_pinyin, recognized_names, ocr_raw_text,
          match_success, match_detail, status, model_used)
         VALUES (:applicationId, :attachmentId, :studentName, :studentNamePinyin, '[]', NULL, 0, NULL, 'processing', :model)`,
        {
          applicationId: application.id,
          attachmentId: attachment.id,
          studentName,
          studentNamePinyin: JSON.stringify(studentPinyin),
          model: AI_MODEL
        }
      );

      try {
        // 找到实际文件路径
        let filePath;
        if (attachment.file_url && attachment.file_url.startsWith("demo://")) {
          throw new Error("演示文件不支持 OCR");
        }

        // 优先用 storage_key 构造路径（存储后的真实文件名）
        const storageKey = attachment.storage_key || "";
        if (storageKey) {
          // storage_key 格式如 "applications/5/1784087288691-07e6b054-名称.jpg"
          filePath = path.join(rootDir, "uploads", storageKey);
        }

        // 如果 storageKey 路径不存在，回退到用 file_url 构造
        let exists = false;
        try { await fs.access(filePath); exists = true; } catch { /* ignore */ }

        if (!exists) {
          // 遍历 application 目录找匹配文件
          const appDir = path.join(uploadDir, String(application.id));
          try {
            const files = await fs.readdir(appDir);
            for (const f of files) {
              if (f.endsWith(attachment.file_name) || f.includes(attachment.file_name.replace(/\.[^.]+$/, ""))) {
                filePath = path.join(appDir, f);
                exists = true;
                break;
              }
            }
            // 如果还没找到，取第一个非隐藏文件
            if (!exists && files.length > 0) {
              filePath = path.join(appDir, files[0]);
              exists = true;
            }
          } catch { /* ignore */ }
        }

        if (!exists) {
          throw new Error(`文件不存在: ${attachment.file_name}`);
        }

        const ocrResult = await performOcrOnAttachment(filePath, attachment.mime_type);
        const recognizedNames = extractNamesFromText(ocrResult.rawText);
        const matches = matchStudentName(studentName, studentPinyin, recognizedNames);

        const matchSuccess = matches.length > 0;
        let matchDetail;

        if (matchSuccess) {
          matchDetail = `成功匹配：${studentName} 在材料 "${attachment.file_name}" 中被识别到。`;
          matchDetail += `匹配方式：${matches.map(m => m.method).join("；")}。`;
          matchDetail += `识别到的匹配名：${matches.map(m => m.recognized).join("、")}`;
        } else {
          matchDetail = `未匹配：在材料 "${attachment.file_name}" 中未找到学生姓名 "${studentName}"。`;
          matchDetail += `${recognizedNames.length ? `识别到的姓名为：${recognizedNames.join("、")}` : "未识别到任何姓名"}`;
        }

        const recordId = await updateAiAuditResult({
          applicationId: application.id,
          attachmentId: attachment.id,
          studentName,
          recognizedNames,
          ocrRawText: ocrResult.rawText,
          matchSuccess,
          matchDetail,
          status: "completed",
          modelUsed: ocrResult.model
        });

        allResults.push({
          attachmentId: attachment.id,
          matchSuccess,
          recognizedNames,
          matchDetail
        });

      } catch (err) {
        await updateAiAuditError({
          applicationId: application.id,
          attachmentId: attachment.id,
          studentName,
          errorMessage: err.message
        });
        allResults.push({
          attachmentId: attachment.id,
          matchSuccess: false,
          recognizedNames: [],
          matchDetail: `OCR 失败：${err.message}`
        });
      }
    }

    // 综合结论
    const overallSuccess = allResults.some(r => r.matchSuccess);
    const overallDetail = overallSuccess
      ? `材料审核通过：至少一个附件中匹配到学生姓名 "${studentName}"`
      : `材料审核不通过：所有附件中均未匹配到学生姓名 "${studentName}"`;

    await insertAiAuditResult({
      applicationId: application.id,
      attachmentId: null,
      studentName,
      studentNamePinyin: JSON.stringify(studentPinyin),
      recognizedNames: JSON.stringify([...new Set(allResults.flatMap(r => r.recognizedNames || []))]),
      ocrRawText: null,
      matchSuccess: overallSuccess,
      matchDetail: overallDetail,
      status: "completed",
      modelUsed: AI_MODEL
    });

    return {
      applicationId,
      status: "completed",
      matchSuccess: overallSuccess,
      perAttachment: allResults
    };

  } catch (err) {
    console.error("AI 审核失败:", err);
    await insertAiAuditResult({
      applicationId,
      attachmentId: null,
      studentName: "未知",
      studentNamePinyin: "{}",
      recognizedNames: JSON.stringify([]),
      ocrRawText: null,
      matchSuccess: false,
      matchDetail: `系统错误：${err.message}`,
      status: "failed",
      errorMessage: err.message,
      modelUsed: null
    });
    return { applicationId, status: "failed", error: err.message };
  }
}

async function insertAiAuditResult(params) {
  return query(
    `INSERT INTO ai_audit_record
     (application_id, attachment_id, student_name, student_name_pinyin, recognized_names, ocr_raw_text,
      match_success, match_detail, status, error_message, model_used)
     VALUES (:applicationId, :attachmentId, :studentName, :studentNamePinyin, :recognizedNames, :ocrRawText,
      :matchSuccess, :matchDetail, :status, :errorMessage, :modelUsed)`,
    {
      applicationId: params.applicationId,
      attachmentId: params.attachmentId || null,
      studentName: params.studentName,
      studentNamePinyin: JSON.stringify(params.studentNamePinyin || {}),
      recognizedNames: params.recognizedNames ? JSON.stringify(params.recognizedNames) : JSON.stringify([]),
      ocrRawText: params.ocrRawText || null,
      matchSuccess: params.matchSuccess ? 1 : 0,
      matchDetail: params.matchDetail || null,
      status: params.status || "pending",
      errorMessage: params.errorMessage || null,
      modelUsed: params.modelUsed || null
    }
  );
}

async function updateAiAuditResult(params) {
  // 更新已有的 processing 记录
  return query(
    `UPDATE ai_audit_record
     SET recognized_names = :recognizedNames, ocr_raw_text = :ocrRawText,
         match_success = :matchSuccess, match_detail = :matchDetail,
         status = :status, model_used = :modelUsed, updated_at = NOW()
     WHERE application_id = :applicationId AND attachment_id <=> :attachmentId AND status = 'processing'
     ORDER BY id DESC LIMIT 1`,
    {
      applicationId: params.applicationId,
      attachmentId: params.attachmentId || null,
      recognizedNames: JSON.stringify(params.recognizedNames || []),
      ocrRawText: params.ocrRawText || null,
      matchSuccess: params.matchSuccess ? 1 : 0,
      matchDetail: params.matchDetail || null,
      status: params.status || "completed",
      modelUsed: params.modelUsed || null
    }
  );
}

async function updateAiAuditError(params) {
  return query(
    `UPDATE ai_audit_record
     SET status = 'failed', error_message = :errorMessage, updated_at = NOW()
     WHERE application_id = :applicationId AND attachment_id <=> :attachmentId AND status = 'processing'
     ORDER BY id DESC LIMIT 1`,
    {
      applicationId: params.applicationId,
      attachmentId: params.attachmentId || null,
      errorMessage: params.errorMessage
    }
  );
}

async function getAiAuditResults(applicationId) {
  // 获取某条申报的所有 AI 审核结果
  const rows = await query(
    `SELECT * FROM ai_audit_record
     WHERE application_id = :applicationId
     ORDER BY attachment_id IS NOT NULL DESC, id`,
    { applicationId }
  );

  // 解析 JSON 字段
  return rows.map(row => {
    try { row.recognized_names = JSON.parse(row.recognized_names || "[]"); } catch { row.recognized_names = []; }
    try { row.student_name_pinyin = JSON.parse(row.student_name_pinyin || "{}"); } catch { row.student_name_pinyin = {}; }
    return row;
  });
}

export { triggerAiAudit, getAiAuditResults };
