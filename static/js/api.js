// api.js —— 本地 SQLite 后端存取
async function jget(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}
async function jsend(url, method, body) {
  const r = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.status);
  return r.json();
}

export const api = {
  listProjects: () => jget("/api/projects"),
  createProject: (name, data) => jsend("/api/projects", "POST", { name, data }),
  getProject: (id) => jget(`/api/projects/${id}`),
  updateProject: (id, name, data) => jsend(`/api/projects/${id}`, "PUT", { name, data }),
  deleteProject: (id) => jsend(`/api/projects/${id}`, "DELETE", {}),

  listVersions: (pid) => jget(`/api/projects/${pid}/versions`),
  saveVersion: (pid, label) => jsend(`/api/projects/${pid}/versions`, "POST", { label }),
  saveVersionData: (pid, label, data) => jsend(`/api/projects/${pid}/versions`, "POST", { label, data }),
  getVersion: (vid) => jget(`/api/versions/${vid}`),
  deleteVersion: (vid) => jsend(`/api/versions/${vid}`, "DELETE", {}),
};
