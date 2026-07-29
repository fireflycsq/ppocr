const TOKEN_KEY = 'ppocr-auth-token'

export interface AuthUser {
  id: number
  username: string
}

export interface AuthSession {
  token: string
  user: AuthUser
}

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY)
}

export function saveAuthSession(session: AuthSession): void {
  localStorage.setItem(TOKEN_KEY, session.token)
}

export function clearAuthSession(): void {
  localStorage.removeItem(TOKEN_KEY)
}

async function parseError(res: Response): Promise<string> {
  if (res.status === 502) {
    return '标注服务不可用（502），请确认 label-api 容器已启动'
  }
  if (res.status === 404) {
    return '登录接口不可用（404），请确认 OCR 服务已加载标注登录模块'
  }
  try {
    const body = await res.json()
    if (typeof body.detail === 'string') return body.detail
    if (Array.isArray(body.detail)) {
      return body.detail.map((item: { msg?: string }) => item.msg ?? '请求失败').join('；')
    }
  } catch {
    // ignore
  }
  return `请求失败 (${res.status})`
}

export async function authFetch(
  path: string,
  init: RequestInit = {},
  token?: string | null,
): Promise<Response> {
  const authToken = token ?? getStoredToken()
  const headers = new Headers(init.headers)
  if (authToken) {
    headers.set('Authorization', `Bearer ${authToken}`)
  }
  if (
    init.body &&
    !(init.body instanceof FormData) &&
    !headers.has('Content-Type')
  ) {
    headers.set('Content-Type', 'application/json')
  }
  return fetch(path, { ...init, headers })
}

export async function login(username: string, password: string): Promise<AuthSession> {
  const res = await authFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

export async function register(username: string, password: string): Promise<AuthSession> {
  const res = await authFetch('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}

export async function fetchCurrentUser(token?: string | null): Promise<AuthUser> {
  const res = await authFetch('/api/auth/me', {}, token)
  if (!res.ok) throw new Error(await parseError(res))
  return res.json()
}
