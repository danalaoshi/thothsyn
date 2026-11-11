// 封装对 FastAPI（/api）的调用，统一带上 Bearer Token。

async function request(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<any> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const init: RequestInit = { method, headers };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(body);
  }
  const r = await fetch(`/api${path}`, init);
  if (!r.ok) {
    let detail = r.statusText;
    try {
      const j = await r.json();
      detail = j.detail || detail;
    } catch {
      /* ignore */
    }
    throw new Error(`${r.status}: ${detail}`);
  }
  if (r.status === 204) return null;
  return r.json();
}

export const api = {
  get: (path: string, token: string) => request("GET", path, token),
  post: (path: string, token: string, body?: unknown) =>
    request("POST", path, token, body),
  del: (path: string, token: string) => request("DELETE", path, token),
};
