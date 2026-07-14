import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, pool } from "./db.js";

// AI 附件自动审核模块。
// 设计原则：
//   1. 异步非阻塞 — 上传后立即返回，AI 审核在后台执行
//   2. 独立并行 — AI 结果存入 ai_attachment_review 表，人工审核流程完全不受影响
//   3. 通用识别 — prompt 不写死具体字段名，由 AI 自适应判断图片中有什么信息
//   4. 可替换 — 锁定 OpenAI 兼容接口，换模型只需改环境变量

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

// ---- 配置 ----

const AI_ENABLED = process.env.AI_REVIEW_ENABLED !== "false";
const AI_API_KEY = process.env.AI_API_KEY || "";
const AI_API_BASE_URL = process.env.AI_API_BASE_URL || "https://api.openai.com/v1";
const AI_MODEL = process.env.AI_MODEL || "gpt-4o";
const AI_MAX_TOKENS = Number(process.env.AI_MAX_TOKENS || 4096);
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 30000);

// ---- 文件处理 ----

async function fileToBase64(filePath) {
  const buffer = await readFile(filePath);
  return buffer.toString("base64");
}

function mimeTypeForFile(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  const map = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".bmp": "image/bmp",
    ".pdf": "application/pdf"
  };
  return map[ext] || "image/jpeg";
}

// ---- AI 调用 ----

function buildExtractionPrompt() {
  return `你是一个教育机构的材料审核 AI 助手。请严格提取图片中的全部文字内容，包括所有中文、英文、数字、标点符号。

关键要求：
1. 提取图片中出现的所有文字，一字不漏
2. 保持原文的排版和格式
3. 特别注意识别：人员姓名、学号、证书标题、颁发机构、日期、分数/等级
4. 如果图片是证书/证明类材料，请特别留意"颁发给谁"和"被授予者"对应的姓名

请以 JSON 格式返回：
{
  "full_text": "图片中的全部文字内容（完整原文）",
  "all_names": ["图片中出现的所有人员姓名列表"],
  "all_ids": ["图片中出现的所有数字编号列表（学号、证书编号等）"],
  "document_type": "推测的文档类型（如：荣誉证书/成绩单/论文录用证明/任职证明等）",
  "notes": "需要人工关注的补充说明（如图片模糊、信息不完整等）"
}

只返回上述 JSON，不要包含任何其他解释文字。`;
}

async function callAI(imageBase64, mimeType, retryCount = 0) {
  const maxRetries = 2;

  // qwen3.5-ocr 是专用 OCR 模型，需要 min_pixels/max_pixels 控制图像分辨率。
  // 每 Token 对应 32×32 像素，默认值 3072-8388608。
  const requestBody = {
    model: AI_MODEL,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image_url",
            image_url: {
              url: `data:${mimeType};base64,${imageBase64}`
            },
            // 千问 OCR 特有参数：图像像素范围控制
            min_pixels: 32 * 32 * 3,   // 3072 — 小于此值的图像会被放大
            max_pixels: 32 * 32 * 8192 // 8388608 — 大于此值的图像会被缩小
          },
          { type: "text", text: buildExtractionPrompt() }
        ]
      }
    ],
    max_tokens: AI_MAX_TOKENS,
    temperature: 0.01
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);

  try {
    const response = await fetch(`${AI_API_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`AI API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const content = data?.choices?.[0]?.message?.content;
    const requestId = data?.id || null;

    if (!content) {
      throw new Error("AI returned empty response");
    }

    let parsed;
    try {
      const cleaned = content.replace(/```json\s*|```\s*/gi, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      parsed = { raw_text: content, parse_error: true };
    }

    return { parsed, requestId, model: data.model || AI_MODEL };
  } catch (error) {
    clearTimeout(timeoutId);
    if (retryCount < maxRetries && error.name !== "AbortError") {
      await new Promise((resolve) => setTimeout(resolve, 1000 * (retryCount + 1)));
      return callAI(imageBase64, mimeType, retryCount + 1);
    }
    throw error;
  }
}

// ---- 学生信息比对 ----

async function fetchStudentInfo(applicationId) {
  const rows = await query(
    `SELECT sp.student_no, sp.name, sp.grade, sp.major, sp.class_name, sp.college_id
     FROM application_record ar
     JOIN student_profile sp ON sp.id = ar.student_id
     WHERE ar.id = :applicationId`,
    { applicationId }
  );
  return rows[0] || null;
}

function normalizeName(name) {
  if (!name) return "";
  return name.replace(/[\s\u3000]+/g, "").toLowerCase();
}

function compareStrings(extracted, actual) {
  if (!extracted || !actual) return { match: false, score: 0, detail: "missing_data" };
  const normExtracted = normalizeName(String(extracted));
  const normActual = normalizeName(String(actual));
  if (normExtracted === normActual) return { match: true, score: 100, detail: "exact_match" };
  // 处理省略姓或名的情况（如 "张三" vs "张三丰" 或 "三丰"）
  if (normExtracted.includes(normActual) || normActual.includes(normExtracted)) {
    if (normActual.length >= 2 && normExtracted.length >= 2) {
      return { match: true, score: 85, detail: "partial_inclusion" };
    }
  }
  // 允许单字差异（如 "张山" vs "张三"）
  if (normActual.length >= 2 && normExtracted.length >= 2) {
    const longer = normActual.length >= normExtracted.length ? normActual : normExtracted;
    const shorter = normActual.length >= normExtracted.length ? normExtracted : normActual;
    let diffCount = 0;
    for (let i = 0; i < longer.length; i++) {
      if (!shorter.includes(longer[i])) diffCount++;
    }
    if (diffCount <= 1) return { match: true, score: 70, detail: "single_char_diff" };
  }
  return { match: false, score: 0, detail: "no_match" };
}

function buildComparison(extracted, studentInfo) {
  const comparisons = {};

  // 图片中的所有姓名列表（来自 OCR 提取）
  const allNames = (extracted.all_names || []).map((n) => normalizeName(String(n)));

  // 图片全文
  const fullText = extracted.full_text || "";

  // 学生姓名通过存在于 all_names 列表或者存在于文档全文来判定
  const studentName = studentInfo?.name ? normalizeName(studentInfo.name) : "";
  const studentId = studentInfo?.student_no ? normalizeName(studentInfo.student_no) : "";

  // 姓名是否在图片中出现？策略分两步：
  // a) 精确出现在 OCR 提取的姓名列表中
  // b) 出现在完整 OCR 文本中的任何位置
  const exactNameHit = studentName
    ? allNames.some(
        (name) =>
          name === studentName ||
          name.includes(studentName) ||
          studentName.includes(name)
      )
    : false;

  const fuzzyNameHit =
    studentName && fullText
      ? normalizeName(fullText).includes(studentName)
      : false;

  const nameMatched = exactNameHit || fuzzyNameHit;

  comparisons.name = {
    match: nameMatched,
    score: nameMatched ? 90 : 0,
    detail: exactNameHit ? "found_in_names_list" : fuzzyNameHit ? "found_in_full_text" : "not_found",
    extracted: allNames.join(", ") || "(全文搜索)",
    actual: studentInfo?.name || null
  };

  // 学号比对：在 OCR 提取的所有 ID 里搜索
  const allIds = (extracted.all_ids || []).map((id) => normalizeName(String(id)));
  const idInIds = studentId ? allIds.some((id) => id === studentId || id.includes(studentId) || studentId.includes(id)) : false;
  const idInText = studentId ? normalizeName(fullText).includes(studentId) : false;
  const idMatched = idInIds || idInText;

  comparisons.student_id = {
    match: idMatched ? true : studentId ? false : null,
    score: idMatched ? 100 : 0,
    detail: idInIds ? "found_in_ids_list" : idInText ? "found_in_full_text" : studentId ? "not_found" : "no_student_id_in_system",
    extracted: allIds.join(", ") || "(全文搜索)",
    actual: studentInfo?.student_no || null
  };

  // 综合判定
  let matchResult;
  if (nameMatched) {
    matchResult = "match";
  } else {
    matchResult = "mismatch";
  }

  const scores = [comparisons.name?.score || 0, comparisons.student_id?.score || 0].filter(
    (s) => s !== null && s !== undefined
  );
  const avgConfidence = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;

  let summary;
  if (matchResult === "match") {
    const parts = ["学生姓名在材料中出现"];
    if (idMatched) parts.push("学号匹配");
    summary = parts.join("，");
  } else {
    summary = "学生姓名未在材料中找到，请人工核实";
  }

  return { comparisons, matchResult, avgConfidence, summary };
}

// ---- 主流程 ----

async function runAIReview(attachmentId, applicationId, fileUrl, fileName) {
  if (!AI_ENABLED || !AI_API_KEY) {
    await insertReviewResult({
      attachmentId,
      applicationId,
      reviewStatus: "failed",
      errorMessage: "AI review is disabled or API key not configured"
    });
    return;
  }

  await insertReviewResult({
    attachmentId,
    applicationId,
    reviewStatus: "processing"
  });

  const startTime = Date.now();

  try {
    // 1. 读取图片文件
    const absolutePath = path.join(rootDir, ...fileUrl.replace(/^\//, "").split("/"));
    const imageBase64 = await fileToBase64(absolutePath);
    const mimeType = mimeTypeForFile(fileName);

    // 2. 调用 AI Vision API
    const { parsed, requestId, model } = await callAI(imageBase64, mimeType);
    const processingTimeMs = Date.now() - startTime;

    // 3. 查询学生信息
    const studentInfo = await fetchStudentInfo(applicationId);

    // 4. 比对
    const aiConfidence = typeof parsed.overall_confidence === "number" ? parsed.overall_confidence : null;
    const { comparisons, matchResult, avgConfidence, summary } = buildComparison(parsed, studentInfo);

    const confidenceScore = avgConfidence !== null ? avgConfidence : aiConfidence;

    // 5. 写入结果
    await updateReviewResult(attachmentId, {
      reviewStatus: "completed",
      aiModel: model,
      aiRequestId: requestId,
      confidenceScore,
      extractedInfo: {
        full_text: parsed.full_text || null,
        all_names: parsed.all_names || [],
        all_ids: parsed.all_ids || [],
        document_type: parsed.document_type || null,
        notes: parsed.notes || null
      },
      comparison: comparisons,
      matchResult,
      matchSummary: summary,
      rawResponse: parsed,
      processingTimeMs
    });
  } catch (error) {
    const processingTimeMs = Date.now() - startTime;
    await updateReviewResult(attachmentId, {
      reviewStatus: "failed",
      errorMessage: error.message,
      processingTimeMs
    });
    console.error(`[AI Review] Failed for attachment ${attachmentId}:`, error.message);
  }
}

async function insertReviewResult({ attachmentId, applicationId, reviewStatus, errorMessage = null }) {
  await query(
    `INSERT INTO ai_attachment_review (attachment_id, application_id, review_status, error_message)
     VALUES (:attachmentId, :applicationId, :reviewStatus, :errorMessage)
     ON DUPLICATE KEY UPDATE review_status = VALUES(review_status), error_message = VALUES(error_message)`,
    { attachmentId, applicationId, reviewStatus, errorMessage }
  );
}

async function updateReviewResult(attachmentId, data) {
  await query(
    `UPDATE ai_attachment_review
     SET review_status = :reviewStatus,
         ai_model = :aiModel,
         ai_request_id = :aiRequestId,
         confidence_score = :confidenceScore,
         extracted_info_json = :extractedInfo,
         comparison_json = :comparison,
         match_result = :matchResult,
         match_summary = :matchSummary,
         raw_response_json = :rawResponse,
         error_message = :errorMessage,
         processing_time_ms = :processingTimeMs
     WHERE attachment_id = :attachmentId`,
    {
      attachmentId,
      reviewStatus: data.reviewStatus,
      aiModel: data.aiModel || null,
      aiRequestId: data.aiRequestId || null,
      confidenceScore: data.confidenceScore ?? null,
      extractedInfo: data.extractedInfo ? JSON.stringify(data.extractedInfo) : null,
      comparison: data.comparison ? JSON.stringify(data.comparison) : null,
      matchResult: data.matchResult || null,
      matchSummary: data.matchSummary || null,
      rawResponse: data.rawResponse ? JSON.stringify(data.rawResponse) : null,
      errorMessage: data.errorMessage || null,
      processingTimeMs: data.processingTimeMs ?? null
    }
  );
}

// ---- 对外接口 ----

// 触发异步 AI 审核（上传材料后调用，不阻塞主流程）
function triggerAIReview(attachmentId, applicationId, fileUrl, fileName) {
  if (!AI_ENABLED) return;
  // 使用 setImmediate 确保不阻塞当前请求
  setImmediate(() => {
    runAIReview(attachmentId, applicationId, fileUrl, fileName).catch((error) => {
      console.error(`[AI Review] Unhandled error for attachment ${attachmentId}:`, error);
    });
  });
}

// ---- API 路由处理 ----

async function handleAIReviewApi(req, res, context) {
  const { parts, method, ok } = context;

  // 查询某条申报的所有附件 AI 审核结果
  if (
    method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "ai-review" &&
    parts[2] === "applications" &&
    parts.length === 4
  ) {
    const applicationId = Number(parts[3]);
    const rows = await query(
      `SELECT ar.*, att.file_name, att.file_url, att.review_result AS human_review_result
       FROM ai_attachment_review ar
       JOIN application_attachment att ON att.id = ar.attachment_id
       WHERE ar.application_id = :applicationId
       ORDER BY ar.created_at DESC`,
      { applicationId }
    );
    return ok(res, rows);
  }

  // 查询单个附件的 AI 审核结果
  if (
    method === "GET" &&
    parts[0] === "api" &&
    parts[1] === "ai-review" &&
    parts[2] === "attachments" &&
    parts.length === 4
  ) {
    const attachmentId = Number(parts[3]);
    const rows = await query(
      `SELECT ar.*, att.file_name, att.file_url, att.review_result AS human_review_result
       FROM ai_attachment_review ar
       JOIN application_attachment att ON att.id = ar.attachment_id
       WHERE ar.attachment_id = :attachmentId
       ORDER BY ar.created_at DESC
       LIMIT 1`,
      { attachmentId }
    );
    if (!rows.length) {
      return ok(res, { review_status: "not_started" });
    }
    return ok(res, rows[0]);
  }

  // 手动重新触发 AI 审核
  if (
    method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "ai-review" &&
    parts[2] === "attachments" &&
    parts[4] === "retry"
  ) {
    const attachmentId = Number(parts[3]);
    const rows = await query(
      `SELECT att.id, att.application_id, att.file_url, att.file_name
       FROM application_attachment att
       WHERE att.id = :attachmentId`,
      { attachmentId }
    );
    if (!rows.length) {
      const error = new Error("附件不存在");
      error.status = 404;
      throw error;
    }
    const att = rows[0];
    triggerAIReview(att.id, att.application_id, att.file_url, att.file_name);
    return ok(res, { attachment_id: attachmentId, review_status: "processing" }, "AI 审核已重新触发");
  }

  // 批量触发 AI 审核（对某条申报的所有附件）
  if (
    method === "POST" &&
    parts[0] === "api" &&
    parts[1] === "ai-review" &&
    parts[2] === "applications" &&
    parts[4] === "run"
  ) {
    const applicationId = Number(parts[3]);
    const attachments = await query(
      `SELECT id, application_id, file_url, file_name
       FROM application_attachment
       WHERE application_id = :applicationId AND status = 'active'`,
      { applicationId }
    );
    for (const att of attachments) {
      triggerAIReview(att.id, att.application_id, att.file_url, att.file_name);
    }
    return ok(res, { application_id: applicationId, triggered_count: attachments.length }, "AI 审核已触发");
  }

  return false;
}

export { handleAIReviewApi, triggerAIReview };