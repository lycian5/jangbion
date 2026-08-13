const attemptsByIp = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 12;
const MAX_IMAGE_CHARS = 2_700_000;
const METER_INSTRUCTION = '계기판 화면만 분석하세요. 누적 시간계(Hr/HR/h)와 누적 거리계(km)를 읽고, 화면 날짜가 있으면 YYYY-MM-DD로 읽으세요. 추측하지 말고 확실하지 않으면 null과 낮은 신뢰도를 반환하세요. 사진 날짜는 참고용이며 기록 날짜를 정하지 않습니다.';

function send(res, status, payload) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(payload);
}

function allowRequest(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recent = (attemptsByIp.get(ip) || []).filter(time => now - time < WINDOW_MS);
  if (recent.length >= MAX_ATTEMPTS) return false;
  recent.push(now);
  attemptsByIp.set(ip, recent);
  return true;
}

const responseSchema = {
  type: 'object', additionalProperties: false,
  required: ['hourMeter', 'odometer', 'displayDate', 'rawText', 'fieldConfidence', 'needsReview'],
  properties: {
    hourMeter: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
    odometer: { anyOf: [{ type: 'number', minimum: 0 }, { type: 'null' }] },
    displayDate: { anyOf: [{ type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, { type: 'null' }] },
    rawText: { type: 'string', maxLength: 500 },
    fieldConfidence: {
      type: 'object', additionalProperties: false, required: ['hourMeter', 'odometer', 'displayDate'],
      properties: {
        hourMeter: { type: 'integer', minimum: 0, maximum: 100 },
        odometer: { type: 'integer', minimum: 0, maximum: 100 },
        displayDate: { type: 'integer', minimum: 0, maximum: 100 }
      }
    },
    needsReview: { type: 'boolean' }
  }
};

function providerConfig() {
  const provider = String(process.env.AI_PROVIDER || 'openai').toLowerCase();
  if (provider === 'openai') return { provider, kind: 'responses', key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_VISION_MODEL || 'gpt-5-mini', endpoint: 'https://api.openai.com/v1/responses' };
  if (provider === 'nvidia') return { provider, kind: 'chat', key: process.env.NVIDIA_API_KEY, model: process.env.NVIDIA_VISION_MODEL, endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions' };
  if (provider === 'openai-compatible') {
    const baseUrl = String(process.env.AI_BASE_URL || '').replace(/\/$/, '');
    return { provider, kind: 'chat', key: process.env.AI_API_KEY, model: process.env.AI_VISION_MODEL, endpoint: baseUrl ? `${baseUrl}/chat/completions` : '' };
  }
  return null;
}

function parseJson(text) {
  const normalized = String(text || '').replace(/^```json\s*/i, '').replace(/\s*```$/, '').trim();
  return JSON.parse(normalized);
}

function upstreamFailure(response, data) {
  const error = new Error(String(data?.error?.message || data?.message || `HTTP ${response.status}`).slice(0, 500));
  error.upstreamStatus = response.status;
  return error;
}

function normalizeResult(parsed) {
  const numberOrNull = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : null;
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(parsed?.displayDate || '')) ? parsed.displayDate : null;
  const confidence = parsed?.fieldConfidence || {};
  const score = value => Math.max(0, Math.min(100, Number.parseInt(value, 10) || 0));
  const hourMeter = numberOrNull(parsed?.hourMeter);
  const odometer = numberOrNull(parsed?.odometer);
  return {
    type: 'meter',
    fields: { hourMeter, odometer, displayDate: date },
    fieldSources: { hourMeter: hourMeter == null ? 'unknown' : 'confirmed', odometer: odometer == null ? 'unknown' : 'confirmed', displayDate: date == null ? 'unknown' : 'confirmed' },
    fieldConfidence: { hourMeter: score(confidence.hourMeter), odometer: score(confidence.odometer), displayDate: score(confidence.displayDate) },
    needsReview: Boolean(parsed?.needsReview), rawText: String(parsed?.rawText || '').slice(0, 500)
  };
}

async function analyzeWithResponses(config, image, signal) {
  const response = await fetch(config.endpoint, {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model, store: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: METER_INSTRUCTION }, { type: 'input_image', image_url: image, detail: 'high' }] }],
      text: { format: { type: 'json_schema', name: 'meter_reading', strict: true, schema: responseSchema } }
    })
  });
  const data = await response.json();
  if (!response.ok) throw upstreamFailure(response, data);
  return parseJson(data.output_text);
}

async function analyzeWithChat(config, image, signal) {
  const jsonInstruction = `${METER_INSTRUCTION} 응답은 다른 설명 없이 다음 JSON만 반환하세요: {"hourMeter":number|null,"odometer":number|null,"displayDate":"YYYY-MM-DD"|null,"rawText":string,"fieldConfidence":{"hourMeter":0-100,"odometer":0-100,"displayDate":0-100},"needsReview":boolean}.`;
  const response = await fetch(config.endpoint, {
    method: 'POST', signal,
    headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.model, temperature: 0, max_tokens: 500,
      messages: [{ role: 'user', content: [{ type: 'text', text: jsonInstruction }, { type: 'image_url', image_url: { url: image } }] }]
    })
  });
  const data = await response.json();
  if (!response.ok) throw upstreamFailure(response, data);
  return parseJson(data?.choices?.[0]?.message?.content);
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return send(res, 405, { message: 'POST 요청만 허용됩니다.' });
  if (!allowRequest(req)) return send(res, 429, { message: '잠시 후 다시 시도해주세요.' });
  const config = providerConfig();
  if (!config || !config.key || !config.model || !config.endpoint) return send(res, 503, { message: '선택한 사진 분석 공급자가 아직 설정되지 않았습니다.' });

  let body;
  try { body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {}); }
  catch (error) { return send(res, 400, { message: '요청 형식이 올바르지 않습니다.' }); }
  const image = String(body.image || '');
  if (body.context !== 'usage' || !/^data:image\/(webp|jpeg|png);base64,/i.test(image) || image.length > MAX_IMAGE_CHARS) return send(res, 400, { message: '유효한 계기판 사진을 선택해주세요.' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 14_000);
  try {
    const parsed = config.kind === 'responses' ? await analyzeWithResponses(config, image, controller.signal) : await analyzeWithChat(config, image, controller.signal);
    return send(res, 200, normalizeResult(parsed));
  } catch (error) {
    console.error('AI image analysis failed', {
      provider: config.provider,
      model: config.model,
      upstreamStatus: error.upstreamStatus || null,
      errorName: error.name,
      errorMessage: String(error.message || '').slice(0, 500)
    });
    const message = error.name === 'AbortError' ? '사진 분석 시간이 초과되었습니다.' : '사진 분석에 실패했습니다.';
    return send(res, 502, { message });
  } finally {
    clearTimeout(timer);
  }
};
