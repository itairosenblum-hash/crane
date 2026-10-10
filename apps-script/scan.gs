// ================================================
// סריקת תסקירים בשרת (Gemini) — קובץ נפרד באותו פרויקט Apps Script
// ------------------------------------------------
// התקנה (פעם אחת):
// 1. בעורך Apps Script: ➕ ליד "קבצים" ← סקריפט ← שם: scan ← הדבק את כל הקובץ הזה
// 2. בתוך doPost, מיד אחרי השורה  const { action, data } = body;  הוסף שורה אחת:
//      if (action === 'scanDocument') return scanDocument_(data);
// 3. ⚙️ הגדרות הפרויקט ← מאפייני סקריפט ← הוסף:
//      GEMINI_API_KEY = המפתח מ-https://aistudio.google.com/apikey
//      (אופציונלי) GEMINI_MODEL = gemini-3.8-flash
// 4. פריסה ← ניהול פריסות ← ✏️ ← גרסה חדשה ← פריסה (כך ה-URL נשאר זהה)
// ================================================

// מפתח ה-Web של Firebase (ציבורי, אותו אחד שב-index.html) — משמש רק לאימות שהמבקש מחובר
const SCAN_FIREBASE_WEB_KEY = 'AIzaSyDDDPT3cjlyTzhU0iFe-A7y2YlZW-iTdIk';
const SCAN_DEFAULT_MODEL = 'gemini-3.8-flash';
const SCAN_MAX_BYTES = 15 * 1024 * 1024;
const SCAN_ALLOWED_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const SCAN_INSTRUCTIONS = `You extract structured data from an Israeli safety inspection certificate for lifting equipment
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

function scanSchema_() {
  const S = { type: 'STRING', nullable: true };
  const N = { type: 'NUMBER', nullable: true };
  const fields = ['inspectionNumber', 'serialNumber', 'chassisNumber', 'manufacturer', 'type', 'manufacturingYear',
    'lastCheck', 'nextCheck', 'safeWorkLoad', 'maxLoad', 'testLoad', 'height', 'inspectionType', 'inspectorName', 'notes'];
  const numeric = { safeWorkLoad: 1, maxLoad: 1, testLoad: 1, height: 1 };
  const props = {};
  fields.forEach(f => { props[f] = numeric[f] ? N : S; });
  const conf = {};
  fields.forEach(f => { conf[f] = { type: 'NUMBER' }; });
  props.confidence = { type: 'OBJECT', properties: conf };
  return { type: 'OBJECT', properties: props, required: fields.concat(['confidence']), propertyOrdering: fields.concat(['confidence']) };
}

function scanJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// מאמת שה-idToken שייך למשתמש מחובר באפליקציה (Firebase Auth)
function scanVerifyUser_(idToken) {
  if (!idToken) return false;
  const res = UrlFetchApp.fetch('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + SCAN_FIREBASE_WEB_KEY, {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) return false;
  const users = JSON.parse(res.getContentText()).users || [];
  return users.length > 0 && !users[0].disabled;
}

function scanCleanDate_(v) {
  if (!v) return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})$/);
  if (m) {
    let y = m[3]; if (y.length === 2) y = '20' + y;
    const d = +m[1], mo = +m[2];
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return null;
    return ('0' + d).slice(-2) + '/' + ('0' + mo).slice(-2) + '/' + y;
  }
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[3] + '/' + m[2] + '/' + m[1];
  return null;
}

function scanCleanNum_(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.').replace(/[^\d.]/g, ''));
  return isFinite(n) && n >= 0 && n < 100000 ? n : null;
}

function scanCleanStr_(v, max) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s && s !== 'null' ? s.slice(0, max || 120) : null;
}

function scanDocument_(data) {
  try {
    data = data || {};
    if (!scanVerifyUser_(data.idToken)) return scanJson_({ ok: false, msg: 'נדרשת התחברות מחדש לאפליקציה' });

    const mimeType = String(data.mimeType || '');
    if (SCAN_ALLOWED_TYPES.indexOf(mimeType) < 0) return scanJson_({ ok: false, msg: 'סוג קובץ לא נתמך: ' + mimeType });
    const fileData = String(data.fileData || '').replace(/^data:[^,]*,/, '');
    if (fileData.length < 100) return scanJson_({ ok: false, msg: 'הקובץ ריק' });
    if (fileData.length * 0.75 > SCAN_MAX_BYTES) return scanJson_({ ok: false, msg: 'הקובץ גדול מדי (עד 15MB)' });

    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty('GEMINI_API_KEY');
    if (!apiKey) return scanJson_({ ok: false, msg: 'חסר GEMINI_API_KEY במאפייני הסקריפט' });
    const model = props.getProperty('GEMINI_MODEL') || SCAN_DEFAULT_MODEL;

    const body = {
      systemInstruction: { parts: [{ text: SCAN_INSTRUCTIONS }] },
      contents: [{ role: 'user', parts: [
        { inlineData: { mimeType: mimeType, data: fileData } },
        { text: 'Extract the certificate fields.' }
      ] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: scanSchema_(),
        // קריאת מסמך לא דורשת חשיבה ארוכה
        thinkingConfig: { thinkingLevel: 'LOW' }
      }
    };
    const res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent', {
      method: 'post', contentType: 'application/json', headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(body), muteHttpExceptions: true
    });
    const code = res.getResponseCode();
    const out = JSON.parse(res.getContentText() || '{}');
    if (code !== 200) {
      Logger.log('Gemini error ' + code + ': ' + res.getContentText().slice(0, 500));
      return scanJson_({ ok: false, msg: 'הסריקה נכשלה (' + code + '). אפשר למלא ידנית.' });
    }
    const parts = (((out.candidates || [])[0] || {}).content || {}).parts || [];
    const text = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
    const r = JSON.parse(text || '{}');

    const year = scanCleanStr_(r.manufacturingYear, 4);
    return scanJson_({
      ok: true,
      model: model,
      fields: {
        inspectionNumber: scanCleanStr_(r.inspectionNumber, 40),
        serialNumber: scanCleanStr_(r.serialNumber, 40),
        chassisNumber: scanCleanStr_(r.chassisNumber, 60),
        manufacturer: scanCleanStr_(r.manufacturer, 80),
        type: scanCleanStr_(r.type, 60),
        manufacturingYear: year && /^(19|20)\d{2}$/.test(year) ? year : null,
        lastCheck: scanCleanDate_(r.lastCheck),
        nextCheck: scanCleanDate_(r.nextCheck),
        safeWorkLoad: scanCleanNum_(r.safeWorkLoad),
        maxLoad: scanCleanNum_(r.maxLoad),
        testLoad: scanCleanNum_(r.testLoad),
        height: scanCleanNum_(r.height),
        inspectionType: scanCleanStr_(r.inspectionType, 60),
        inspectorName: scanCleanStr_(r.inspectorName, 60),
        notes: scanCleanStr_(r.notes, 500)
      },
      confidence: r.confidence || {}
    });
  } catch (e) {
    Logger.log('scanDocument error: ' + e + ' | ' + e.stack);
    return scanJson_({ ok: false, msg: 'שגיאה בסריקה: ' + e });
  }
}
