import { getSetting, setSetting, deleteSetting, getDeviceId, getRecent } from '../database/db';

const TIMEOUT_MS = 15000;

// Erreur d'authentification (non connecté, session expirée) : la synchronisation automatique l'ignore
export const authError = (message: string) => Object.assign(new Error(message), { name: 'AuthError' });
export const isAuthError = (e: any) => e?.name === 'AuthError';

const request = async (url: string, options: RequestInit) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
};

const getServerUrl = async () => {
  const url = await getSetting('server_url');
  if (!url) throw authError('Serveur non configuré');
  return url;
};

export const isLoggedIn = async () => (await getSetting('refresh_token')) !== null;

export const login = async (serverUrl: string, username: string, password: string) => {
  const base = serverUrl.trim().replace(/\/+$/, '');
  const res = await request(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);

  await setSetting('server_url', base);
  await setSetting('username', username);
  await setSetting('access_token', body.access_token);
  await setSetting('refresh_token', body.refresh_token);
};

// Association par code : le code (6 chiffres) est généré par l'administrateur sur le dashboard web
export const pairDevice = async (serverUrl: string, code: string) => {
  const base = serverUrl.trim().replace(/\/+$/, '');
  const [deviceInfo] = await getRecent<object>('device_info', 1);
  const res = await request(`${base}/api/pairing/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: code.trim(), device_id: await getDeviceId(), device_info: deviceInfo ?? {} }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Erreur ${res.status}`);

  await setSetting('server_url', base);
  await setSetting('username', body.device_name);
  await setSetting('access_token', body.access_token);
  await setSetting('refresh_token', body.refresh_token);
};

export const logout = async () => {
  await deleteSetting('access_token');
  await deleteSetting('refresh_token');
};

const refreshAccessToken = async (base: string) => {
  const refreshToken = await getSetting('refresh_token');
  if (!refreshToken) throw authError('Non connecté');

  const res = await request(`${base}/api/auth/refresh`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${refreshToken}` },
  });
  if (!res.ok) {
    await logout();
    throw authError('Session expirée, reconnecte-toi');
  }
  const body = await res.json();
  await setSetting('access_token', body.access_token);
  return body.access_token as string;
};

// POST authentifié : renouvelle le token d'accès automatiquement s'il a expiré
export const apiPost = async (path: string, payload: object) => {
  const base = await getServerUrl();
  let token = await getSetting('access_token');
  if (!token) throw authError('Non connecté');

  const send = (t: string) =>
    request(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
      body: JSON.stringify(payload),
    });

  let res = await send(token);
  if (res.status === 401) {
    token = await refreshAccessToken(base);
    res = await send(token);
  }

  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? body.msg ?? `Erreur ${res.status}`);
  return body;
};