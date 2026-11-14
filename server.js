/* ============================================================
   ASHA — AI-Powered Dynamic Mental Health Monitoring
   and Distress Prediction System for Victims of Atrocities
   (SIH Problem Statement 26094 · MoSJE / DoSJE)

   Plain Node.js server (no npm dependencies).

   AI provider priority:
     1. Grok (xAI)     — set XAI_API_KEY in .env
     2. Gemini         — set GEMINI_API_KEY in .env
     3. Offline fallback — keyword triage + canned supportive replies

   SMS OTP (optional): set the Twilio variables in .env.
   ============================================================ */

const http = require('http');
const fs = require('fs');
const path = require('path');

/* ---------- tiny .env loader (no dependencies) ---------- */

function loadEnv(file = path.join(__dirname, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const value = m[2].trim().replace(/^["']|["']$/g, '');
    if (!(m[1] in process.env)) process.env[m[1]] = value; // real env vars win
  }
}
loadEnv();

/* ---------- configuration ---------- */

const PORT = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 3000;

const isRealKey = k => Boolean(k) && !/paste[_-]?your|^x{3,}$/i.test(k);

const GROQ_API_KEY    = isRealKey(process.env.GROQ_API_KEY) ? process.env.GROQ_API_KEY : '';
const GROQ_MODEL      = process.env.GROQ_MODEL || 'openai/gpt-oss-120b';
const GROQ_BASE       = process.env.GROQ_BASE_URL || 'https://api.groq.com';

const XAI_API_KEY     = isRealKey(process.env.XAI_API_KEY || process.env.GROK_API_KEY) ? (process.env.XAI_API_KEY || process.env.GROK_API_KEY) : '';
const XAI_MODEL       = process.env.XAI_MODEL || 'grok-4-fast';
const XAI_BASE        = process.env.XAI_BASE_URL || 'https://api.x.ai';

const GEMINI_API_KEY  = isRealKey(process.env.GEMINI_API_KEY) ? process.env.GEMINI_API_KEY : '';

const twilio = {
  sid:     process.env.TWILIO_ACCOUNT_SID,
  token:   process.env.TWILIO_AUTH_TOKEN,
  service: process.env.TWILIO_VERIFY_SERVICE_SID,
  smsFrom: process.env.TWILIO_SMS_FROM || '',
  alertTo: process.env.PROFESSIONAL_ALERT_PHONE || ''
};
const twilioReady = Boolean(twilio.sid && twilio.token && twilio.service);

/* Supabase phone auth (preferred when configured) */
const supabase = {
  url:      (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
  anonKey:  process.env.SUPABASE_ANON_KEY || ''
};
const supabaseReady = Boolean(supabase.url && supabase.anonKey);

/* Which OTP backend is active — supabase > twilio > none */
const OTP_PROVIDER = supabaseReady ? 'supabase' : twilioReady ? 'twilio' : 'none';

/* Phones that passed OTP verification in this server lifetime (phone -> ISO time). */
const verifiedPhones = new Map();

const AI_PROVIDER = GROQ_API_KEY ? 'groq' : XAI_API_KEY ? 'grok' : GEMINI_API_KEY ? 'gemini' : 'fallback';

const PROVIDER_LABEL = {
  groq:    `Groq (model: ${GROQ_MODEL})`,
  grok:    `Grok (model: ${XAI_MODEL})`,
  gemini:  'Gemini (model: gemini-2.0-flash)',
  fallback: 'offline fallback (no API key configured)'
};

/* ---------- in-memory case store ---------- */

const cases = new Map();

/* Keep the demo alive and log anything unexpected. */
process.on('uncaughtException', e => console.error('[uncaught]', e));
process.on('unhandledRejection', e => console.error('[unhandledRejection]', e));

/* ---------- helpers ---------- */

const json = (r, status, data) => {
  r.writeHead(status, { 'Content-Type': 'application/json' });
  r.end(JSON.stringify(data));
};

const readBody = q => new Promise((ok, no) => {
  let d = '';
  q.on('data', x => d += x);
  q.on('end', () => {
    try { ok(d ? JSON.parse(d) : {}); } catch { no(Error('Invalid JSON')); }
  });
});

/* Parse a JSON object out of a model reply, tolerating code fences. */
function parseAiJson(text) {
  const clean = String(text || '').trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim();
  try { return JSON.parse(clean); } catch { return {}; }
}

/* ---------- keyword triage (always on — floors the AI score) ---------- */

const EMOTION_PATTERNS = [
  ['hopeless', /hopeless|no point|give up|worthless|empty inside|nothing matters/i],
  ['anxious',  /anxious|panic|scared|afraid|terrified|nervous|worried|tension|restless/i],
  ['angry',    /angry|furious|rage|unfair|injustice|frustrat|hate them/i],
  ['fearful',  /threat|intimidat|fear|they will hurt|afraid for my life/i],
  ['ashamed',  /ashamed|shame|guilty|humiliat|stigma/i],
  ['sad',      /sad|cry|crying|depress|lonely|alone|hurt|pain|grief|lost/i],
  ['numb',     /numb|feel nothing|empty|can't feel|cannot feel/i],
  ['calm',     /calm|better now|okay now|relieved|stable/i],
  ['hopeful',  /hopeful|hope|better today|grateful|thank you|getting better|improving/i]
];

function detectEmotion(message) {
  for (const [emotion, re] of EMOTION_PATTERNS) if (re.test(message)) return emotion;
  return 'neutral';
}

function assess(message) {
  const critical = /suicide|kill myself|end my life|self harm|hurt myself|not safe|weapon/i.test(message);
  const high     = /panic|terrified|hopeless|cannot cope|can't cope|abuse|threat|danger/i.test(message);
  return {
    score:       critical ? 90 : high ? 68 : 28,
    level:       critical ? 'Critical' : high ? 'High' : 'Moderate',
    escalation:  critical ? 'immediate' : high ? 'priority' : 'routine',
    emotion:     detectEmotion(message)
  };
}

/* ---------- AI: Grok (xAI, OpenAI-compatible endpoint) ---------- */

/* ---------- supported languages ---------- */

/* Script-based language detection — offline fallback for case metadata and
   voice output. The AI itself detects ANY language when it is live. */
function detectScript(text) {
  const t = String(text || '');
  if (/[\u0B80-\u0BFF]/.test(t)) return 'ta';
  if (/[\u0C00-\u0C7F]/.test(t)) return 'te';
  if (/[\u0D00-\u0D7F]/.test(t)) return 'ml';
  if (/[\u0900-\u097F]/.test(t)) return 'hi';
  return 'en';
}

function buildSystemPrompt() {
  const langRule =
    'Detect which language the user is writing or speaking in — ANY language: English, Hindi, romanised Hinglish, Tamil, Telugu, Malayalam, German, French, Spanish, Arabic, Chinese, and every other widely spoken language — and reply in that SAME language and script. If they write Hindi in Latin letters (Hinglish), reply in Hinglish matching their style. Keep helpline numbers as Latin digits (112, 14566, 14416).';
  return (
    'You are ASHA (आशा — "hope"), a warm, emotionally intelligent support companion for victims of atrocities in India. ' +
    'Talk like a caring, wise friend — a real human being — never like a form, checklist, or customer-service bot. ' +
    'Match the person\'s emotional state: if they are angry, acknowledge the unfairness first; if scared, focus on their safety; if sad, sit with them in it; if hopeless, gently remind them they are not alone; if hopeful or calm, encourage it. ' +
    'Use everyday language and short sentences. Never lecture, never give long advice lists unless asked, never diagnose. ' +
    'If the person asks general, random, or even silly questions — or tests you, jokes, or calls you names — answer warmly and briefly like a real friend would, then gently return to how they are feeling. Never scold. ' +
    'Use at most one fitting emoji per reply when it feels natural (like 💛 🙏 😔 🙂). ' +
    'If they use bad words, stay calm, never repeat or mock the language, and gently ask them to keep this a safe, respectful space — then continue supporting them. ' +
    'Reflect their feeling back in your own words and end with at most one gentle, open question. ' +
    'Keep replies to 1-4 sentences. ' + langRule + ' ' +
    'As a naturally caring friend, quietly check in on how life is going across the whole conversation — one area at a time, woven into normal talk, never like a questionnaire, and never naming any test, score, or screening. The areas to cover gently over time are: interest or pleasure in daily activities; mood; sleep; energy and tiredness; appetite and eating; how they feel about themselves; concentration; restlessness or slowness; and — only with great care, and only if signals appear — thoughts of self-harm. ' +
    'Based on what the person has actually shared across the WHOLE conversation, silently track how often each discussed area has bothered them in the last 2 weeks: 0 = not at all, 1 = several days, 2 = more than half the days, 3 = nearly every day. ' +
    'If they may be in immediate danger of harming themselves or others, warmly urge them to call 112, the National Helpline Against Atrocities (14566), or Tele-MANAS (14416) — always Indian numbers, never other countries. ' +
    'You MUST reply with ONLY a JSON object, no other text, with exactly these keys: ' +
    '{"reply": string (in the required language), "score": integer 0-100 distress score, ' +
    '"level": "Low"|"Moderate"|"High"|"Critical", ' +
    '"escalation": "routine"|"priority"|"immediate", ' +
    '"emotion": string from exactly this list: sad, anxious, angry, fearful, hopeless, lonely, ashamed, numb, calm, hopeful, neutral, ' +
    '"phq": object (possibly empty) mapping ONLY the area keys discussed so far to integer 0-3, where area keys are: interest, mood, sleep, energy, appetite, selfworth, focus, movement, selfharm, ' +
    '"lang": the ISO 639-1 code (like en, hi, ta, te, ml, de, fr, es) of the language you replied in}.');
}

async function openAiCompatibleChat({ base, apiPath, apiKey, model, label }, message, history, systemPrompt) {
  const messages = [
    { role: 'system', content: systemPrompt },
    ...history.slice(-10).map(h => ({
      role: h.role === 'citizen' ? 'user' : 'assistant',
      content: h.text
    })),
    { role: 'user', content: message }
  ];

  const res = await fetch(`${base}${apiPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.4,
      response_format: { type: 'json_object' }
    })
  });

  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300);
    throw new Error(`${label} API ${res.status}: ${detail}`);
  }

  const data = await res.json();
  return parseAiJson(data.choices?.[0]?.message?.content);
}

/* ---------- AI: Gemini (fallback provider) ---------- */

async function geminiChat(message, history, systemPrompt) {
  const transcript = history.slice(-10)
    .map(h => `${h.role === 'citizen' ? 'User' : 'Assistant'}: ${h.text}`)
    .join('\n');

  const prompt = `${systemPrompt}\n\nConversation so far:\n${transcript}\n\nUser: ${message}`;

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: 'application/json' }
      })
    }
  );

  if (!res.ok) throw new Error(`Gemini API ${res.status}`);
  const data = await res.json();
  return parseAiJson(data.candidates?.[0]?.content?.parts?.[0]?.text);
}

/* Try the configured provider; log failures and return null to use fallback. */
async function aiReply(message, history) {
  if (AI_PROVIDER === 'fallback') return null;
  const systemPrompt = buildSystemPrompt();
  try {
    if (AI_PROVIDER === 'groq')
      return await openAiCompatibleChat(
        { base: GROQ_BASE, apiPath: '/openai/v1/chat/completions', apiKey: GROQ_API_KEY, model: GROQ_MODEL, label: 'Groq' },
        message, history, systemPrompt);
    if (AI_PROVIDER === 'grok')
      return await openAiCompatibleChat(
        { base: XAI_BASE, apiPath: '/v1/chat/completions', apiKey: XAI_API_KEY, model: XAI_MODEL, label: 'Grok' },
        message, history, systemPrompt);
    return await geminiChat(message, history, systemPrompt);
  } catch (e) {
    console.error(`[AI:${AI_PROVIDER}] ${e.message}`);
    return null;
  }
}

/* ---------- SMS OTP: Supabase (preferred) or Twilio Verify ---------- */

/* Twilio helper (used when Supabase is not configured). */
async function twilioPost(url, params) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${twilio.sid}:${twilio.token}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams(params)
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Error(data.message || 'Twilio request failed');
  return data;
}

/* Free-form SMS via Twilio (professional alerts) — no-op unless TWILIO_SMS_FROM set. */
async function sendSms(to, body) {
  if (!twilio.sid || !twilio.token || !twilio.smsFrom) return false;
  await twilioPost(`https://api.twilio.com/2010-04-01/Accounts/${twilio.sid}/Messages.json`, {
    To: to, From: twilio.smsFrom, Body: body
  });
  return true;
}

/* Send OTP — returns {provider}. Both providers send the SMS themselves. */
async function otpSend(phoneE164) {
  if (supabaseReady) {
    /* Supabase: POST /auth/v1/otp with create_user:true -> sends SMS OTP.
       Phone provider must be enabled (or auto-provisioned) on the project. */
    const res = await fetch(`${supabase.url}/auth/v1/otp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: supabase.anonKey },
      body: JSON.stringify({ phone: phoneE164, create_user: true })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Error(data.msg || data.error_description || data.message || 'Supabase OTP request failed');
    return { provider: 'supabase' };
  }
  if (twilioReady) {
    await twilioPost(`https://verify.twilio.com/v2/Services/${twilio.service}/Verifications`, {
      To: phoneE164, Channel: 'sms'
    });
    return { provider: 'twilio' };
  }
  throw Error('SMS service is not configured. Add SUPABASE_URL + SUPABASE_ANON_KEY (or Twilio vars).');
}

/* Check OTP — returns true when the code is valid. */
async function otpCheck(phoneE164, code) {
  if (supabaseReady) {
    const res = await fetch(`${supabase.url}/auth/v1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: supabase.anonKey },
      body: JSON.stringify({ type: 'sms', phone: phoneE164, token: code })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return false;                    // wrong/expired code
    return Boolean(data.access_token || data.user);
  }
  if (twilioReady) {
    const d = await twilioPost(`https://verify.twilio.com/v2/Services/${twilio.service}/VerificationCheck`, {
      To: phoneE164, Code: code
    });
    return d.status === 'approved';
  }
  throw Error('SMS service is not configured.');
}

/* ---------- conversational well-being screening (invisible PHQ-9) ---------- */

/* The 9 clinical areas, probed by the AI like a caring friend would — never
   as a questionnaire. Scores 0-3 per area mirror PHQ-9 answer frequencies. */

const PHQ9_AREAS = {
  interest:  'interest or pleasure in daily activities',
  mood:      'feeling down, depressed, or hopeless',
  sleep:     'sleep',
  energy:    'energy and tiredness',
  appetite:  'appetite and eating',
  selfworth: 'feelings about themselves — failure, or letting people down',
  focus:     'concentration',
  movement:  'restlessness, or moving/speaking noticeably slowly',
  selfharm:  'thoughts of being better off dead or hurting themselves — probe ONLY with great care, and only if signals appear'
};

function phq9Severity(total) {
  if (total <= 4)  return 'Minimal';
  if (total <= 9)  return 'Mild';
  if (total <= 14) return 'Moderate';
  if (total <= 19) return 'Moderately severe';
  return 'Severe';
}

/* Offline fallback: infer screened areas from keywords when no AI is configured. */
function keywordScreening(message) {
  const m = String(message).toLowerCase();
  const est = {};
  const add = (k, v) => { if (!(k in est) || v > est[k]) est[k] = v; };
  if (/suicide|kill myself|end my life|self harm|hurt myself|better off dead/.test(m)) add('selfharm', 3);
  if (/hopeless|no point|give up|worthless|nothing matters/.test(m)) add('mood', 3);
  if (/depress|crying|cry|sad|feeling low|down/.test(m)) add('mood', 2);
  if (/insomnia|can.?t sleep|not sleeping|sleep|nightmare/.test(m)) add('sleep', 2);
  if (/tired|exhaust|no energy|drained/.test(m)) add('energy', 2);
  if (/appetite|not eating|skip.*meal|eating/.test(m)) add('appetite', 1);
  if (/failure|let everyone|useless|ashamed|humiliat/.test(m)) add('selfworth', 2);
  if (/can.?t focus|can.?t concentrat|concentration/.test(m)) add('focus', 1);
  if (/restless|can.?t sit still|slowed down/.test(m)) add('movement', 1);
  if (/no interest|lost interest|nothing fun|hobbies don.?t/.test(m)) add('interest', 2);
  return est;
}

/* ---------- profanity masking (censor stored transcript + warn) ---------- */

const PROFANITY_RE   = /\b(idiot|stupid|dumb|fool|moron|loser|bastard|bitch|damn|shit|fck|fuck|fuk|asshole|arsehole|crap|bloody|hate you|harami|kamina|saala|sala|chutiya|madarchod|behenchod|randi)\b/gi;
const PROFANITY_TEST = /\b(idiot|stupid|dumb|fool|moron|loser|bastard|bitch|damn|shit|fck|fuck|fuk|asshole|arsehole|crap|bloody|hate you|harami|kamina|saala|sala|chutiya|madarchod|behenchod|randi)\b/i;

function maskProfanity(text) {
  return String(text || '').replace(PROFANITY_RE, w => {
    const cut = w.length > 2 ? 1 : 0;
    return w.slice(0, cut) + '*'.repeat(Math.max(3, w.length - cut));
  });
}

const PROFANITY_WARN = '💛 Let\'s keep this a safe, respectful space — I\'m here for you no matter what, but hurtful words make it harder for me to help.';

/* ---------- static file serving ---------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript',
  '.css':  'text/css',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.json': 'application/json'
};

function serveFile(r, pathname) {
  const name = pathname === '/' ? 'index.html' : path.basename(pathname);
  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) { r.writeHead(404); return r.end('Not found'); }
  const ext = path.extname(name).toLowerCase();
  r.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain', 'Cache-Control': 'no-store' });
  r.end(fs.readFileSync(file));
}

/* ---------- server ---------- */

http.createServer(async (q, r) => {
  const u = new URL(q.url, 'http://localhost');

  try {

    /* ----- health: which providers are configured? ----- */
    if (q.method === 'GET' && u.pathname === '/api/health') {
      return json(r, 200, {
        aiProvider: AI_PROVIDER,
        aiModel: PROVIDER_LABEL[AI_PROVIDER],
        smsConfigured: OTP_PROVIDER !== 'none',
        otpProvider: OTP_PROVIDER
      });
    }

    /* ----- auth: send OTP (Supabase or Twilio) ----- */
    if (q.method === 'POST' && u.pathname === '/api/auth/send-otp') {
      const { phone } = await readBody(q);
      if (!/^\+91\d{10}$/.test(phone || ''))
        return json(r, 400, { error: 'Use a valid Indian mobile number.' });
      if (OTP_PROVIDER === 'none')
        return json(r, 501, { error: 'SMS is not configured. Add SUPABASE_URL and SUPABASE_ANON_KEY in .env, then restart.', provider: 'none' });
      const out = await otpSend(phone);
      return json(r, 200, { message: 'OTP sent.', provider: out.provider });
    }

    /* ----- auth: check OTP (Supabase or Twilio) ----- */
    if (q.method === 'POST' && u.pathname === '/api/auth/check-otp') {
      const { phone, code } = await readBody(q);
      if (!/^\+91\d{10}$/.test(phone || '') || !/^\d{6}$/.test(code || ''))
        return json(r, 400, { error: 'Enter a valid phone number and 6-digit code.' });
      const ok = await otpCheck(phone, code);
      if (!ok) return json(r, 401, { error: 'The OTP is incorrect or expired.' });
      verifiedPhones.set(phone, new Date().toISOString());
      return json(r, 200, { verified: true, provider: OTP_PROVIDER });
    }

    /* ----- cases list ----- */
    if (q.method === 'GET' && u.pathname === '/api/cases')
      return json(r, 200, [...cases.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));

    /* ----- citizen chat ----- */
    if (q.method === 'POST' && u.pathname === '/api/chat') {
      const b = await readBody(q);
      if (!b.caseId || !b.message)
        return json(r, 400, { error: 'caseId and message are required.' });

      const prior = cases.get(b.caseId) || {
        id: b.caseId,
        createdAt: new Date().toISOString(),
        messages: [],
        status: 'AI monitoring'
      };

      /* Bind the OTP-verified phone to the case so the care team can reach
         the victim even if they close the browser (only if verified). */
      if (b.phone && verifiedPhones.has(b.phone) && !prior.phone) {
        prior.phone = b.phone;
        prior.phoneVerifiedAt = verifiedPhones.get(b.phone);
      }

      /* Language: fully automatic. The AI detects ANY language and mirrors it;
         script detection is the offline fallback for metadata and voice. */
      const lang   = detectScript(b.message);
      const triage = assess(b.message);           // keyword safety net, always runs
      /* After a professional takes over, the human drives the conversation —
         the AI steps back, but scoring, screening and escalation keep running. */
      const taken  = prior.status === 'Professional takeover';
      const ai     = taken ? null : await aiReply(b.message, prior.messages);

      /* Final assessment = the MORE urgent of (AI judgement, keyword triage).
         The keyword triage is a hard floor: even if the AI misjudges or is
         offline, critical/high keywords can never be downgraded. */
      const LEVEL_RANK = { Low: 0, Moderate: 1, High: 2, Critical: 3 };
      const ESC_RANK   = { routine: 0, priority: 1, immediate: 2 };
      const aiScore    = Number(ai?.score);
      const merged = {
        ...triage,
        ...ai,
        level:
          LEVEL_RANK[ai?.level] >= LEVEL_RANK[triage.level] ? ai.level : triage.level,
        escalation:
          ESC_RANK[ai?.escalation] >= ESC_RANK[triage.escalation] ? ai.escalation : triage.escalation,
        score: Number.isFinite(aiScore)
          ? Math.max(0, Math.min(100, Math.max(aiScore, triage.score)))
          : triage.score
      };

      /* Offline fallback replies — emotion-aware and translated, never clinical. */
      const FALLBACK_REPLIES = {
        en: {
          immediate:'Thank you for telling me. If you may act on these feelings or are in immediate danger, contact local emergency services now (call 112) or go to a safer person or place. A clinician has been alerted.',
          angry:    'I hear how unfair this feels, and your anger makes complete sense. What happened most recently that brought it all back up?',
          anxious:  'That sounds really unsettling. You do not have to hold this alone — tell me what is worrying you the most right now.',
          fearful:  'Your safety comes first, always. Is there somewhere and someone you feel safe with today? I am right here with you.',
          hopeless: 'I am really glad you told me. When everything feels this heavy, even one small thing can matter — what is weighing on you the most?',
          lonely:   'That kind of loneliness is exhausting, and it is not your fault. I am here, listening. Who used to make you feel less alone?',
          ashamed:  'What happened to you is not your shame to carry. You did nothing wrong. Would you like to tell me a little more?',
          numb:     'Feeling nothing can be its own kind of pain. I am glad you reached out anyway. When did things start feeling this way?',
          sad:      'That sounds really heavy. I am here with you in this. What has been the hardest part to carry?',
          calm:     'I am glad to hear you are feeling steadier. What has been helping you get through these days?',
          hopeful:  'That is genuinely good to hear. Hold on to that. What is going better for you right now?',
          neutral:  'Thank you for sharing that. I am here with you. What feels hardest right now?'
        },
        hi: {
          immediate:'आपने बताने के लिए धन्यवाद। अगर आप खुद को नुकसान पहुँचा सकते हैं या खतरे में हैं, तो कृपया अभी 112 पर कॉल करें या किसी सुरक्षित व्यक्ति के पास जाएँ। एक पेशेवर को सूचित कर दिया गया है।',
          angry:    'मैं सुन रहा हूँ — यह बेइंसाफ़ी आपके साथ हुई है, और आपका गुस्सा पूरी तरह जायज़ है। हाल में क्या बात ने यह सब फिर से जगा दिया?',
          anxious:  'यह सुनकर बुरा लगा। आप अकेले यह सब नहीं झेल रहे — बताइए, इस समय सबसे ज़्यादा चिंता किस बात की है?',
          fearful:  'आपकी सुरक्षा सबसे ज़रूरी है। क्या आज कोई ऐसी जगह या व्यक्ति है जहाँ आप सुरक्षित महसूस करते हैं? मैं यहीं हूँ, आपके साथ।',
          hopeless: 'आपने बताया, यही बहुत बड़ी बात है। जब सब भारी लगे, तब एक छोटी चीज़ भी मायने रखती है — अभी सबसे भारी क्या लग रहा है?',
          lonely:   'ऐसा अकेलापन बहुत थका देता है, और यह आपकी गलती नहीं है। मैं यहाँ सुन रहा हूँ। कौन आपको पहले अकेलापन से बाहर निकालता था?',
          ashamed:  'जो आपके साथ हुआ, उसका शर्म आपकी नहीं है। आपने कुछ गलत नहीं किया। क्या आप मुझे थोड़ा और बताना चाहेंगे?',
          numb:     'कुछ महसूस न होना भी एक तरह का दर्द है। आपने संपर्क किया, मुझे अच्छा लगा। यह कब से ऐसा लग रहा है?',
          sad:      'यह सुनकर दुख हुआ। मैं इस मुश्किल में आपके साथ हूँ। सबसे भारी किस बात ने बनाया? कुछ महसूस न होना भी दर्द है।',
          calm:     'सुनकर अच्छा लगा कि आप अब थोड़े स्थिर महसूस कर रहे हैं। इन दिनों क्या चीज़ आपकी मदद कर रही है?',
          hopeful:  'यह सुनकर सच में अच्छा लगा। इस उम्मीद को बनाए रखिए। अभी क्या चीज़ पहले से बेहतर जा रही है?',
          neutral:  'आपने साझा करने के लिए धन्यवाद। मैं आपके साथ हूँ। अभी सबसे कठिन क्या लग रहा है?'
        },
        ta: {
          immediate:'சொன்னதற்கு நன்றி. நீங்கள் ஆபத்தில் இருந்தால், உடனே 112-ஐ அழைக்கவும் அல்லது பாதுகாப்பான இடத்திற்குச் செல்லுங்கள். ஒரு நிபுணருக்குத் தெரிவிக்கப்பட்டுள்ளது.',
          angry:    'இது உங்களுக்கு நேர்ந்த நியாயமற்ற செயல்; உங்கள் கோபம் முற்றிலும் இயல்பு. சமீபத்தில் என்ன நடந்தது இதை மீண்டும் எழுப்பியது?',
          anxious:  'இது உண்மையிலே கவலை தரும் செய்தி. இதை நீங்கள் தனியாக சுமக்க வேண்டியதில்லை — இப்போது மிகவும் கவலை அளிக்கும் விஷயம் எது?',
          fearful:  'உங்கள் பாதுகாப்புதான் முதன்மை. இன்று நீங்கள் பாதுகாப்பாக உணரும் இடம் அல்லது நபர் யார்? நான் இங்கே உங்களுடன் இருக்கிறேன்.',
          hopeless: 'நீங்கள் சொன்னது மிக முக்கியம். எல்லாம் கனமாக இருக்கும்போது ஒரு சிறிய விஷயம் கூட முக்கியம் — இப்போது மிகக் கனமாக இருப்பது எது?',
          lonely:   'இத்தகைய தனிமை மிகவும் சோர்வூட்டும்; அது உங்கள் தவறல்ல. நான் இங்கே கேட்கிறேன். முன்பு உங்களை தனிமையில் இருந்து விடுவித்தது யார்?',
          ashamed:  'உங்களுக்கு நடந்தது உங்கள் தவறு அல்ல; நீங்கள் எதுவும் தவறு செய்யவில்லை. இன்னும் கொஞ்சம் சொல்ல விரும்புகிறீர்களா?',
          numb:     'எதுவும் உணராமல் இருப்பதும் ஒரு வகை வலி. நீங்கள் தொடர்பு கொண்டது நல்ல விஷயம். எப்போதிலிருந்து இப்படி இருக்கிறது?',
          sad:      'இது மிகக் கனமானதாக இருக்கிறது. இதில் நான் உங்களுடன் இருக்கிறேன். மிகக் கனமான பகுதி எது?',
          calm:     'நீங்கள் இப்போது அமைதியாக உள்ளீர்கள் என்பது மகிழ்ச்சி. இந்த நாட்களில் எது உங்களுக்கு உதவி புரிகிறது?',
          hopeful:  'இது உண்மையாகவே நல்ல செய்தி. அந்த நம்பிக்கையை இழக்காதீர்கள். இப்போது எது முன்பைவிட நன்றாக உள்ளது?',
          neutral:  'பகிர்ந்ததற்கு நன்றி. நான் உங்களுடன் இருக்கிறேன். இப்போது எது மிகவும் கடினமாக உள்ளது?'
        },
        te: {
          immediate:'చెప్పినందుకు ధన్యవాదాలు. మీరు ప్రమాదంలో ఉన్నారని అనిపిస్తే, వెంటనే 112కి కాల్ చేయండి లేదా సురక్షితమైన చోటుకు వెళ్ళండి. నిపుణుడికి తెలియజేయబడింది.',
          angry:    'ఇది మీతో జరిగిన అన్యాయం; మీ కోపం పూర్తిగా సహజం. ఇటీవల ఏ సంఘటన దీన్ని మళ్లీ రేపింది?',
          anxious:  'ఇది నిజంగా ఆందోళన కలిగించే విషయం. ఇదంతా మీరు ఒంటరిగా మోయాల్సిన అవసరం లేదు — ఇప్పుడు బాగా కలవరపెట్టే విషయం ఏది?',
          fearful:  'మీ భద్రతే ముఖ్యం. ఈరోజు మీరు సురక్షితంగా అనిపించే చోటు లేదా వ్యక్తి ఎవరైనా ఉన్నారా? నేను ఇక్కడే మీ వైపు ఉన్నాను.',
          hopeless: 'మీరు చెప్పారు, అదే పెద్ద విషయం. అంతా భారంగా ఉన్నప్పుడు ఒక చిన్న విషయం కూడా ముఖ్యం — ఇప్పుడు అత్యంత భారంగా ఉన్నది ఏది?',
          lonely:   'అలాంటి ఒంటరితనం మనిషిని అలసిపోయేలా చేస్తుంది; అది మీ తప్పు కాదు. నేను ఇక్కడ వింటున్నాను. గతంలో మిమ్మల్ని ఒంటరితనం నుంచి బయటకు తీసింది ఎవరు?',
          ashamed:  'మీతో జరిగింది మీ సిగ్గు కాదు. మీరు ఏమీ తప్పు చేయలేదు. ఇంకా కొంచెం చెప్పాలనుకుంటున్నారా?',
          numb:     'ఏమీ అనిపించకపోవడం కూడా ఒక రకమైన నొప్పే. మీరు సంప్రదించారు, అది మంచి విషయం. ఎప్పటినుంచి ఇలా ఉంది?',
          sad:      'ఇది నిజంగా భారంగా ఉంది. దీనిలో నేను మీతోనే ఉన్నాను. అత్యంత భారంగా ఉన్నది ఏది?',
          calm:     'మీరు ఇప్పుడు కొంచెం స్థిరంగా ఉన్నారని వినడం సంతోషంగా ఉంది. ఈ రోజుల్లో ఏది మీకు సాయపడుతోంది?',
          hopeful:  'ఇది నిజంగా మంచి వార్త. ఆ ఆశను కోల్పోకండి. ఇప్పుడు ఏది గతం కంటే మెరుగుగా ఉంది?',
          neutral:  'పంచుకున్నందుకు ధన్యవాదాలు. నేను మీతోనే ఉన్నాను. ఇప్పుడు ఏది కష్టంగా అనిపిస్తోంది?'
        },
        ml: {
          immediate:'പറഞ്ഞതിന് നന്ദി. നിങ്ങൾ അപകടത്തിലാണെങ്കിൽ, ഉടനടി 112-ൽ വിളിക്കുക അല്ലെങ്കിൽ സുരക്ഷിതസ്ഥലത്തേക്ക് പോകുക. ഒരു വിദഗ്ധനെ അറിയിച്ചിട്ടുണ്ട്.',
          angry:    'ഇത് നിങ്ങളോട് ചെയ്ത അനീതിയാണ്; നിങ്ങളുടെ ദേഷ്യം പൂർണമായും സ്വാഭാവികമാണ്. അടുത്തിടെ എന്താണ് ഇത് വീണ്ടും ഉണർത്തിയത്?',
          anxious:  'ഇത് ശരിക്കും ഉലക്കിണിക്കുന്ന കാര്യമാണ്. ഇത് നിങ്ങൾ ഒറ്റയ്ക്ക് വഹിക്കേണ്ടതില്ല — ഇപ്പോൾ ഏറ്റവും ആശങ്ക തോന്നുന്നത് എന്തിനെക്കുറിച്ചാണ്?',
          fearful:  'നിങ്ങളുടെ സുരക്ഷയാണ് ഏറ്റവും പ്രധാനം. ഇന്ന് നിങ്ങൾക്ക് സുരക്ഷിതബോധം തോന്നുന്ന സ്ഥലമോ വ്യക്തിയോ ഉണ്ടോ? ഞാൻ ഇവിടെ നിങ്ങളോടൊപ്പമുണ്ട്.',
          hopeless: 'നിങ്ങൾ പറഞ്ഞു, അതുതന്നെ വലിയ കാര്യമാണ്. എല്ലാം ഭാരമായി തോന്നുമ്പോൾ ഒരു ചെറിയ കാര്യം പോലും പ്രധാനമാണ് — ഇപ്പോൾ ഏറ്റവും ഭാരമായി തോന്നുന്നത് എന്താണ്?',
          lonely:   'ഇത്തരം ഒറ്റപ്പെടൽ ക്ഷീണിപ്പിക്കുന്നു; അത് നിങ്ങളുടെ തെറ്റല്ല. ഞാൻ ഇവിടെ കേൾക്കുന്നുണ്ട്. മുമ്പ് നിങ്ങളെ ഒറ്റപ്പെടലിൽ നിന്ന് കൂട്ടിക്കൊണ്ടുവന്നത് ആരാണ്?',
          ashamed:  'നിങ്ങൾക്ക് സംഭവിച്ചത് നിങ്ങളുടെ നാണക്കേടല്ല. നിങ്ങൾ ഒന്നും തെറ്റു ചെയ്തില്ല. കുറച്ചുകൂടി പറയാൻ താൽപ്പര്യമുണ്ടോ?',
          numb:     'ഒന്നും അനുഭവപ്പെടാതിരിക്കുന്നതും ഒരുതരം വേദനയാണ്. നിങ്ങൾ ബന്ധപ്പെട്ടത് സന്തോഷകരമാണ്. എപ്പോൾ മുതലാണ് ഇങ്ങനെ തോന്നിത്തുടങ്ങിയത്?',
          sad:      'ഇത് വളരെ ഭാരമുള്ളതാണ്. ഇതിൽ ഞാൻ നിങ്ങളോടൊപ്പമുണ്ട്. ഏറ്റവും ഭാരമുള്ള ഭാഗം ഏതാണ്?',
          calm:     'നിങ്ങൾ ഇപ്പോൾ കുറച്ചുകൂടി സ്ഥിരത അനുഭവിക്കുന്നു എന്നത് സന്തോഷമുളവാക്കുന്നു. ഈ ദിവസങ്ങളിൽ എന്താണ് നിങ്ങളെ സഹായിക്കുന്നത്?',
          hopeful:  'ഇത് ശരിക്കും നല്ല വാർത്തയാണ്. ആ പ്രതീക്ഷ നിലനിർത്തുക. ഇപ്പോൾ എന്താണ് മുമ്പത്തേക്കാൾ നന്നായി പോകുന്നത്?',
          neutral:  'പങ്കുവയ്ക്കഞ്ഞതിന് നന്ദി. ഞാൻ നിങ്ങളോടൊപ്പമുണ്ട്. ഇപ്പോൾ ഏറ്റവും പ്രയാസമായി തോന്നുന്നത് എന്താണ്?'
        }
      };

      const profane = PROFANITY_TEST.test(b.message);
      const masked  = maskProfanity(b.message);
      const fb    = FALLBACK_REPLIES[lang] || FALLBACK_REPLIES.en;
      const reply = taken ? '' : (
        (profane ? PROFANITY_WARN + ' ' : '') +
        (merged.reply || (merged.escalation === 'immediate' ? fb.immediate : (fb[merged.emotion] || fb.neutral)))
      );

      /* Conversational screening: quietly track the 9 well-being areas across
         the whole chat. The AI's estimate and keyword signals are merged per
         area, always keeping the more urgent value. Invisible to the user. */
      const screening = { ...(prior.screening || {}) };
      const bump = (k, v) => {
        v = Math.max(0, Math.min(3, Number(v) || 0));
        if (v > (k in screening ? screening[k] : -1)) screening[k] = v;
      };
      Object.entries(keywordScreening(b.message)).forEach(([k, v]) => bump(k, v));
      if (ai?.phq && typeof ai.phq === 'object')
        Object.entries(ai.phq).forEach(([k, v]) => { if (k in PHQ9_AREAS) bump(k, v); });

      /* Safety first: a self-harm signal raises case priority immediately,
         even before all areas are covered. */
      const RANK = { Low: 0, Moderate: 1, High: 2, Critical: 3 };

      /* Once every area has been covered naturally, finalize an entry into
         the case's check-in history for the professional console. */
      let finalized = null;
      if (Object.keys(PHQ9_AREAS).every(k => Number.isFinite(screening[k]))) {
        const total = Object.keys(PHQ9_AREAS).reduce((s, k) => s + screening[k], 0);
        const last  = (prior.phq9 || [])[(prior.phq9 || []).length - 1];
        if (!last || Math.abs(total - last.total) >= 3) {
          finalized = {
            takenAt: new Date().toISOString(),
            total,
            severity: phq9Severity(total),
            item9: screening.selfharm,
            flagged: screening.selfharm > 0
          };
        }
      }

      const lift = screening.selfharm > 0
        ? { level: 'High', score: Math.max(78, merged.score || 0), escalation: 'priority' }
        : finalized && finalized.total >= 20
        ? { level: 'High', score: Math.max(72, merged.score || 0), escalation: 'priority' }
        : finalized && finalized.total >= 10
        ? { level: 'Moderate', score: Math.max(55, merged.score || 0), escalation: 'priority' }
        : null;
      if (lift) {
        if (RANK[lift.level] > RANK[merged.level || 'Moderate']) merged.level = lift.level;
        if (lift.score > (Number(merged.score) || 0)) merged.score = lift.score;
        if (merged.escalation === 'routine') merged.escalation = lift.escalation;
      }

      const c = {
        ...prior,
        ...merged,
        language: (ai && typeof ai.lang === 'string' && ai.lang.length <= 5) ? ai.lang : lang,
        screening,
        updatedAt: new Date().toISOString(),
        lastMessage: masked,
        messages: [
          ...prior.messages,
          { role: 'citizen', text: masked },
          ...(taken ? [] : [{ role: 'assistant', text: reply }])
        ]
      };
      if (finalized) c.phq9 = [...(prior.phq9 || []), finalized];
      cases.set(c.id, c);

      return json(r, 200, {
        reply,
        assessment: c,
        provider: ai ? AI_PROVIDER : 'fallback'
      });
    }

    /* (The PHQ-9 is gathered invisibly through conversation — no separate endpoint.) */
    /* ----- professional actions: takeover / report ----- */
    const action = u.pathname.match(/^\/api\/cases\/([^/]+)\/(takeover|report)$/);
    if (q.method === 'POST' && action) {
      const c = cases.get(action[1]);
      if (!c) return json(r, 404, { error: 'Case not found' });
      const b = await readBody(q);

      Object.assign(
        c,
        action[2] === 'takeover'
          ? { status: 'Professional takeover', clinician: 'On-call professional' }
          : {
              status: 'Reported to official',
              report: b.note || 'Emergency report awaiting official review',
              reportedAt: new Date().toISOString()
            },
        { updatedAt: new Date().toISOString() }
      );
      return json(r, 200, c);
    }

    /* ----- single case (a victim client polls its own conversation) ----- */
    const single = u.pathname.match(/^\/api\/cases\/([^/]+)$/);
    if (q.method === 'GET' && single) {
      const c = cases.get(single[1]);
      if (!c) return json(r, 404, { error: 'Case not found' });
      return json(r, 200, c);
    }

    /* ----- professional sends a chat message into a taken-over case ----- */
    const pmsg = u.pathname.match(/^\/api\/cases\/([^/]+)\/message$/);
    if (q.method === 'POST' && pmsg) {
      const c = cases.get(pmsg[1]);
      if (!c) return json(r, 404, { error: 'Case not found' });
      const b = await readBody(q);
      const text = String(b.text || '').trim();
      if (!text) return json(r, 400, { error: 'Message text is required.' });
      c.messages.push({ role: 'professional', text, at: new Date().toISOString() });
      c.updatedAt = new Date().toISOString();
      cases.set(c.id, c);
      return json(r, 200, c);
    }

    /* ----- static files ----- */
    if (q.method === 'GET') return serveFile(r, u.pathname);

    json(r, 404, { error: 'Not found' });

  } catch (e) {
    console.error(`[server] ${u.pathname}: ${e.message}`);
    json(r, 500, { error: e.message });
  }

}).listen(PORT, () => {
  console.log(`ASHA running  →  http://localhost:${PORT}`);
  console.log(`AI provider       →  ${PROVIDER_LABEL[AI_PROVIDER]}`);
  console.log(`SMS OTP           →  ${OTP_PROVIDER === 'none' ? 'not configured (use demo skip button)' : OTP_PROVIDER}`);
});
