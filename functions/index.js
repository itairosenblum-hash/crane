// Cloud Functions של מערכת תסקירי הבטיחות
// scanCertificate: קריאת תסקיר (PDF או תמונה) עם Gemini והחזרת השדות לטופס האמצעי.
// הפונקציה רק קוראת את הקובץ ומחזירה טקסט — היא לא כותבת ל-Firestore ולא שומרת קבצים.
import { initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { onCall, HttpsError } from "firebase-functions/v2/https";
import { setGlobalOptions, logger } from "firebase-functions/v2";
import { defineSecret, defineString } from "firebase-functions/params";
import { GoogleGenAI, Type, ThinkingLevel } from "@google/genai";

initializeApp();
const db = getFirestore();
setGlobalOptions({ region: "europe-west1", maxInstances: 5 });

const GEMINI_API_KEY = defineSecret("GEMINI_API_KEY");
const GEMINI_MODEL = defineString("GEMINI_MODEL", { default: "gemini-3.8-flash" });

const MAX_BYTES = 15 * 1024 * 1024;
const ALLOWED_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"]);

const INSTRUCTIONS = `You extract structured data from an Israeli safety inspection certificate for lifting equipment
("תסקיר בדיקה וניסוי מכונות-הרמה" / "תסקיר בדיקה של מכונת הרמה"), written in Hebrew. Read every page you are given.
Rules:
- inspectionNumber: the certificate number (מספר תסקיר), usually in a box at the top of the first page.
- Section 2 ("תיאור המתקן") contains TWO id-like values that look similar and must never be swapped:
  - serialNumber: ONLY the value explicitly labeled "מספר רישוי" (license/registration number, often with a צ' prefix such as צ'10242).
    If nothing is explicitly labeled מספר רישוי, return null. Never put the chassis number here.
  - chassisNumber: ONLY the value explicitly labeled "מס' שילדה" (for example 8FBCU25-88599). If nothing is labeled מס' שילדה, return null.
    Do not confuse it with a model code from the "יצרן, דגם, מספר סידורי" row.
- manufacturer: the manufacturer name from the "יצרן, דגם, מספר סידורי" row.
- type: the equipment type in Hebrew as printed (for example מלגזה, עגורן, במת הרמה).
- manufacturingYear: four digits, or null.
- lastCheck: the date of this inspection (תאריך הבדיקה / תאריך בדיקה מוכחת). nextCheck: the next inspection date (תאריך בדיקה הבאה / הבדיקה הבאה עד).
  Israeli documents print dates day first (DD/MM/YY or DD/MM/YYYY). Return dates as DD/MM/YYYY with a four-digit year.
- safeWorkLoad (עומס עבודה בטוח), maxLoad (עומס מקסימלי), testLoad (עומס מבחן / עומס ניסוי): numbers only, in tons. If printed in kg, convert to tons.
- height: radius or lifting height (רדיוס / גובה) in meters, number only.
- inspectionType: the type of inspection as printed (for example בדיקה תקופתית, בדיקה ראשונה).
- inspectorName: the name of the certified inspector (שם הבודק / בודק מוסמך) as printed, without license numbers.
- notes: section 4 (הערות / ליקויים / הגבלות) as printed, condensed into one or two lines. null if empty.
- Use null for anything not on the document. Never guess or invent values.
- confidence: 0 to 1 per field, honest. Use below 0.7 when the text is blurry, handwritten, cut off or ambiguous.`;

const FIELDS = ["inspectionNumber", "serialNumber", "chassisNumber", "manufacturer", "type", "manufacturingYear",
  "lastCheck", "nextCheck", "safeWorkLoad", "maxLoad", "testLoad", "height", "inspectionType", "inspectorName", "notes"];
const NUMERIC = new Set(["safeWorkLoad", "maxLoad", "testLoad", "height"]);

const SCHEMA = {
  type: Type.OBJECT,
  properties: {
    ...Object.fromEntries(FIELDS.map((f) => [f, { type: NUMERIC.has(f) ? Type.NUMBER : Type.STRING, nullable: true }])),
    confidence: { type: Type.OBJECT, properties: Object.fromEntries(FIELDS.map((f) => [f, { type: Type.NUMBER }])) }
  },
  required: [...FIELDS, "confidence"],
  propertyOrdering: [...FIELDS, "confidence"]
};

function cleanDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})$/);
  if (m) {
    const y = m[3].length === 2 ? "20" + m[3] : m[3];
    const d = +m[1], mo = +m[2];
    if (d < 1 || d > 31 || mo < 1 || mo > 12 || y.length !== 4) return null;
    return `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}`;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : null;
}
function cleanNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", ".").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n >= 0 && n < 100000 ? n : null;
}
function cleanStr(v, max = 120) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s !== "null" ? s.slice(0, max) : null;
}

export const scanCertificate = onCall({ secrets: [GEMINI_API_KEY], timeoutSeconds: 300, memory: "512MiB" }, async (request) => {
  // רק משתמש מחובר שיש לו פרופיל במערכת
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError("unauthenticated", "נדרשת התחברות מחדש");
  const profile = await db.doc(`users/${uid}`).get();
  if (!profile.exists) throw new HttpsError("permission-denied", "אין הרשאה לסריקה");

  const mimeType = String(request.data?.mimeType || "");
  if (!ALLOWED_TYPES.has(mimeType)) throw new HttpsError("invalid-argument", `סוג קובץ לא נתמך: ${mimeType}`);
  const buffer = Buffer.from(String(request.data?.fileData || "").replace(/^data:[^,]*,/, ""), "base64");
  if (buffer.length < 100) throw new HttpsError("invalid-argument", "הקובץ ריק");
  if (buffer.length > MAX_BYTES) throw new HttpsError("invalid-argument", "הקובץ גדול מדי (עד 15MB)");

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY.value(), httpOptions: { timeout: 150000 } });
  let r;
  try {
    const res = await ai.models.generateContent({
      model: GEMINI_MODEL.value(),
      contents: [{ role: "user", parts: [
        { inlineData: { mimeType, data: buffer.toString("base64") } },
        { text: "Extract the certificate fields." }
      ] }],
      config: {
        systemInstruction: INSTRUCTIONS,
        responseMimeType: "application/json",
        responseSchema: SCHEMA,
        temperature: 0,
        thinkingConfig: { thinkingLevel: ThinkingLevel.LOW }
      }
    });
    r = JSON.parse(res.text);
  } catch (e) {
    logger.error("gemini certificate scan failed", e?.message || e);
    const timedOut = /timeout|aborted/i.test(String(e?.message || e?.cause?.message || ""));
    throw new HttpsError("internal", timedOut ? "הסריקה לקחה יותר מדי זמן. נסו שוב או מלאו ידנית." : "הסריקה נכשלה. אפשר למלא את הפרטים ידנית.");
  }

  const year = cleanStr(r.manufacturingYear, 4);
  return {
    model: GEMINI_MODEL.value(),
    fields: {
      inspectionNumber: cleanStr(r.inspectionNumber, 40),
      serialNumber: cleanStr(r.serialNumber, 40),
      chassisNumber: cleanStr(r.chassisNumber, 60),
      manufacturer: cleanStr(r.manufacturer, 80),
      type: cleanStr(r.type, 60),
      manufacturingYear: year && /^(19|20)\d{2}$/.test(year) ? year : null,
      lastCheck: cleanDate(r.lastCheck),
      nextCheck: cleanDate(r.nextCheck),
      safeWorkLoad: cleanNum(r.safeWorkLoad),
      maxLoad: cleanNum(r.maxLoad),
      testLoad: cleanNum(r.testLoad),
      height: cleanNum(r.height),
      inspectionType: cleanStr(r.inspectionType, 60),
      inspectorName: cleanStr(r.inspectorName, 60),
      notes: cleanStr(r.notes, 500)
    },
    confidence: r.confidence || {}
  };
});
