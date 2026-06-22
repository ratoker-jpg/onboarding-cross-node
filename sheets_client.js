const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value, mode = 0o600) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
  try { fs.chmodSync(filePath, mode); } catch (_) {}
}

function getOAuthConfig(clientPath) {
  const raw = readJson(clientPath);
  const creds = raw.installed || raw.web;
  if (!creds || !creds.client_id || !creds.client_secret) {
    throw new Error('OAuth client JSON не содержит client_id/client_secret');
  }
  return creds;
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  if (text.trim()) {
    try { data = JSON.parse(text); } catch (_) { data = text; }
  }
  if (!res.ok) {
    const msg = data && data.error ? (data.error.message || JSON.stringify(data.error)) : text;
    const err = new Error(`HTTP ${res.status}: ${msg}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

class SheetsClient {
  constructor(config) {
    this.spreadsheetId = config.spreadsheetId;
    this.clientPath = config.clientPath;
    this.tokenPath = config.tokenPath;
    this.base = `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(this.spreadsheetId)}`;
  }

  async getAccessToken() {
    const creds = getOAuthConfig(this.clientPath);
    const token = readJson(this.tokenPath);
    if (token.access_token && token.expiry_date && Number(token.expiry_date) > Date.now() + 60_000) {
      return token.access_token;
    }
    if (!token.refresh_token) throw new Error('В OAuth token нет refresh_token. Нужно заново пройти oauth_get_token.js');

    const form = new URLSearchParams({
      client_id: creds.client_id,
      client_secret: creds.client_secret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    });

    const res = await fetchJson('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    const next = {
      ...token,
      access_token: res.access_token,
      token_type: res.token_type || token.token_type || 'Bearer',
      scope: res.scope || token.scope,
      expiry_date: Date.now() + Number(res.expires_in || 3600) * 1000,
    };
    writeJson(this.tokenPath, next);
    return next.access_token;
  }

  async request(apiPath, options = {}) {
    const token = await this.getAccessToken();
    const headers = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json; charset=utf-8',
      ...(options.headers || {}),
    };
    const body = options.body === undefined ? undefined : JSON.stringify(options.body);
    return fetchJson(`${this.base}${apiPath}`, { ...options, headers, body });
  }

  quoteSheet(name) {
    return `'${String(name).replace(/'/g, "''")}'`;
  }

  enc(s) { return encodeURIComponent(s); }

  async batchGet(sheetNames) {
    const params = new URLSearchParams();
    for (const name of sheetNames) params.append('ranges', this.quoteSheet(name));
    params.set('valueRenderOption', 'FORMATTED_VALUE');
    const res = await this.request(`/values:batchGet?${params.toString()}`, { method: 'GET' });
    const out = {};
    for (const vr of res.valueRanges || []) {
      const range = String(vr.range || '');
      const name = range.startsWith("'") ? range.slice(1, range.indexOf("'!")) : range.split('!')[0];
      out[name.replace(/''/g, "'")] = vr.values || [];
    }
    for (const name of sheetNames) if (!out[name]) out[name] = [];
    return out;
  }

  async appendRows(sheetName, rows) {
    if (!rows || !rows.length) return null;
    const range = this.enc(this.quoteSheet(sheetName));
    return this.request(`/values/${range}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`, {
      method: 'POST',
      body: { majorDimension: 'ROWS', values: rows },
    });
  }

  async updateValues(sheetName, a1, values) {
    const range = this.enc(`${this.quoteSheet(sheetName)}!${a1}`);
    return this.request(`/values/${range}?valueInputOption=USER_ENTERED`, {
      method: 'PUT',
      body: { majorDimension: 'ROWS', values },
    });
  }
}

module.exports = { SheetsClient };
