import { createMD5, createSHA256 } from "hash-wasm";

interface Release { id: string; filename: string; bytes: number; version: string; published: string; downloadUrl: string }
interface Pending { id: string; filename: string; bytes: number; version: string }
interface Stats { days: number; generatedAt: string; totals: { today: number; last7Days: number; last30Days: number; selected: number }; daily: { date: string; downloads: number }[]; versions: { id: string; version: string; downloads: number }[] }
const statsPage = document.body.dataset.page === "stats";
const tokensPage = document.body.dataset.page === "tokens";
const adminPath = statsPage ? "/admin/stats" : tokensPage ? "/admin/tokens" : "/admin";
const element = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const button = (id: string) => element<HTMLButtonElement>(id);
const pendingKey = "mirror-pending-upload";
let currentId: string | null = null;
let cursor: string | null = null;
let busy = false;
let cancelled = false;
let controller: AbortController | null = null;
let setupToken = new URLSearchParams(location.hash.slice(1)).get("token") || "";
if (location.hash) history.replaceState(null, "", location.pathname);
class ApiError extends Error { constructor(message: string, public status: number, public data: any) { super(message); } }
function message(id: string, text: string, kind = "") { const target = element(id); target.textContent = text; target.className = `message ${kind}`; }
async function api(path: string, method = "GET", data?: unknown, signal?: AbortSignal): Promise<any> {
  const result = await fetch(path, { method, credentials: "same-origin", headers: data === undefined ? {} : { "Content-Type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data), signal });
  const value = await result.json().catch(() => ({}));
  if (!result.ok) throw new ApiError(value.error || `Request failed (${result.status}).`, result.status, value);
  return value;
}
function readPending(): Pending | null { try { return JSON.parse(localStorage.getItem(pendingKey) || "null"); } catch { return null; } }
function savePending(value: Pending | null) { if (value) localStorage.setItem(pendingKey, JSON.stringify(value)); else localStorage.removeItem(pendingKey); }
function show(mode: string) { for (const view of ["login", "setup", "dashboard"]) element(`${view}-view`).hidden = view !== mode; }
function uploadState() {
  const pending = readPending();
  button("upload-button").textContent = pending ? "Resume upload & publish" : "Upload & publish";
  button("cancel-upload").hidden = !pending;
  button("cancel-upload").textContent = busy ? "Cancel upload" : "Discard unfinished upload";
  input("version").disabled = busy || !!pending;
  if (pending) input("version").value = pending.version;
  if (pending && !busy) message("upload-message", `Unfinished upload: ${pending.filename}. Choose the same file to resume, or discard it to start another.`);
}
async function historyList(append = false) {
  const result = await api(`/api/admin/releases${append && cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`);
  currentId = result.current;
  cursor = result.cursor;
  const container = element("releases");
  if (!append) container.replaceChildren();
  for (const release of result.releases as Release[]) {
    const row = document.createElement("article"); row.className = "release";
    const info = document.createElement("div"); info.className = "release-info";
    const name = document.createElement("strong"); name.textContent = release.version;
    const meta = document.createElement("small"); meta.textContent = `${release.filename} · ${(release.bytes / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB · ${new Date(release.published).toLocaleString()}`;
    const link = document.createElement("a"); link.textContent = "Download this version"; link.href = release.downloadUrl; link.setAttribute("download", "");
    const linkRow = document.createElement("small"); linkRow.append(link); info.append(name, meta, linkRow); row.append(info);
    if (release.id === currentId) { const badge = document.createElement("span"); badge.className = "current"; badge.textContent = "Current"; row.append(badge); }
    else {
      const activate = document.createElement("button"); activate.type = "button"; activate.className = "secondary"; activate.textContent = "Make current";
      activate.addEventListener("click", async () => {
        activate.disabled = true;
        try { await api(`/api/admin/releases/${release.id}/activate`, "POST", { expectedCurrentId: currentId }); await historyList(); message("history-message", "The public mirror now serves the selected version.", "success"); }
        catch (error) { message("history-message", errorText(error), "error"); await historyList().catch(() => {}); }
        finally { activate.disabled = false; }
      });
      row.append(activate);
    }
    container.append(row);
  }
  if (!container.childElementCount) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No releases yet. Upload the first archive above."; container.append(empty); }
  button("more").hidden = !cursor;
  button("upload-button").disabled = busy;
}
function errorText(error: unknown) { return error instanceof Error ? error.message : "The request failed. Please try again."; }
let statsGeneration = 0;
async function loadStats() {
  const generation = ++statsGeneration;
  button("stats-refresh").disabled = true;
  message("stats-message", "Loading download statistics…");
  try {
    const stats: Stats = await api(`/api/admin/stats?days=${element<HTMLSelectElement>("stats-days").value}`);
    if (generation !== statsGeneration) return;
    const count = (value: number) => Math.round(value).toLocaleString();
    for (const [id, value] of [["today", stats.totals.today], ["seven", stats.totals.last7Days], ["thirty", stats.totals.last30Days]] as const) element(`stats-${id}`).textContent = count(value);
    element("stats-period").textContent = `· last ${stats.days} days`;
    const chart = element("stats-chart"); chart.replaceChildren(); chart.style.setProperty("--days", String(stats.days));
    chart.setAttribute("aria-label", `${count(stats.totals.selected)} download starts over ${stats.days} UTC days. Daily numbers are listed below.`);
    const maximum = Math.max(1, ...stats.daily.map(value => value.downloads));
    const table = element("stats-daily-rows"); table.replaceChildren();
    for (const value of stats.daily) {
      const bar = document.createElement("div"); bar.className = "daily-bar"; bar.style.height = `${value.downloads / maximum * 100}%`; bar.title = `${value.date} (UTC): ${count(value.downloads)} starts`; chart.append(bar);
      const row = document.createElement("tr"); const date = document.createElement("td"); const amount = document.createElement("td"); date.textContent = value.date; amount.textContent = count(value.downloads); row.append(date, amount); table.append(row);
    }
    element("stats-first-date").textContent = stats.daily[0]?.date || "";
    element("stats-last-date").textContent = `${stats.daily.at(-1)?.date || ""} (UTC)`;
    const versions = element("stats-versions"); versions.replaceChildren();
    for (const release of stats.versions) {
      const row = document.createElement("div"); row.className = "stats-version";
      const info = document.createElement("div"); const name = document.createElement("strong"); name.textContent = release.version;
      const id = document.createElement("small"); id.textContent = release.id; info.append(name, id);
      const amount = document.createElement("span"); amount.textContent = count(release.downloads); row.append(info, amount); versions.append(row);
    }
    element("stats-empty").hidden = stats.totals.selected !== 0;
    element("stats-updated").textContent = `Queried ${new Date(stats.generatedAt).toLocaleString()}. Refresh to check for new data.`;
    element("stats-content").hidden = false;
    message("stats-message", "");
  } catch (error) {
    if (generation !== statsGeneration) return;
    element("stats-content").hidden = true;
    message("stats-message", errorText(error), "error");
    if (error instanceof ApiError && error.status === 401) show("login");
  } finally { if (generation === statsGeneration) button("stats-refresh").disabled = false; }
}
for (const mode of ["login", "setup"]) element<HTMLFormElement>(`${mode}-form`).addEventListener("submit", async event => {
  event.preventDefault();
  const submit = (event.currentTarget as HTMLFormElement).querySelector("button")!; submit.disabled = true;
  try {
    const password = input(mode === "login" ? "login-password" : "new-password").value;
    if (mode === "setup" && password !== input("confirm-password").value) throw new Error("The passwords do not match.");
    if (mode === "setup" && !setupToken) throw new Error("Open the private one-time setup link to set the password.");
    await api(`/api/admin/${mode}`, "POST", { password, ...(mode === "setup" ? { token: setupToken } : {}) });
    input(mode === "login" ? "login-password" : "new-password").value = "";
    setupToken = "";
    location.replace(adminPath);
  } catch (error) { message(`${mode}-message`, errorText(error), "error"); }
  finally { submit.disabled = false; }
});
button("logout").addEventListener("click", async () => { await api("/api/admin/logout", "POST"); location.replace(adminPath); });
if (statsPage) {
  button("stats-refresh").addEventListener("click", () => { void loadStats(); });
  element("stats-days").addEventListener("change", () => { void loadStats(); });
} else if (!tokensPage) {
button("refresh").addEventListener("click", () => historyList().catch(error => message("history-message", errorText(error), "error")));
button("more").addEventListener("click", () => historyList(true).catch(error => message("history-message", errorText(error), "error")));
input("archive").addEventListener("change", () => {
  const file = input("archive").files?.[0];
  element("file-description").textContent = file ? `${file.name} · ${(file.size / 1048576).toLocaleString(undefined, { maximumFractionDigits: 1 })} MiB` : "RAR, ZIP, or 7z · up to 10 GiB";
});
button("cancel-upload").addEventListener("click", async () => {
  const pending = readPending(); if (!pending) return;
  cancelled = true; controller?.abort();
  try { await api(`/api/admin/uploads/${pending.id}/abort`, "POST"); savePending(null); uploadState(); message("upload-message", "Upload discarded. The current release is unchanged."); }
  catch (error) { message("upload-message", errorText(error), "error"); }
});
element<HTMLFormElement>("upload-form").addEventListener("submit", async event => {
  event.preventDefault(); if (busy) return;
  const file = input("archive").files?.[0]; if (!file) return;
  if (!/\.(rar|zip|7z)$/i.test(file.name) || !file.size || file.size > 10 * 1024 ** 3) { message("upload-message", "Choose a non-empty RAR, ZIP, or 7z archive up to 10 GiB.", "error"); return; }
  busy = true; cancelled = false; controller = new AbortController();
  const progress = element<HTMLProgressElement>("progress"); progress.hidden = false; progress.value = 0;
  button("upload-button").disabled = true; input("archive").disabled = true; uploadState();
  try {
    let pending = readPending();
    if (pending && (pending.filename !== file.name || pending.bytes !== file.size)) throw new Error("Select the same file to resume, or discard the unfinished upload first.");
    if (!pending) {
      const started = await api("/api/admin/uploads", "POST", { filename: file.name, bytes: file.size, version: input("version").value.trim(), expectedCurrentId: currentId }, controller.signal);
      pending = { id: started.id, filename: file.name, bytes: file.size, version: input("version").value.trim() };
      savePending(pending);
    }
    uploadState();
    const upload = await api(`/api/admin/uploads/${pending.id}`);
    if (upload.expired) throw new Error("This upload expired. Discard it and start a new upload.");
    if (upload.status === "aborted") throw new Error("This upload was discarded. Discard the saved entry and start a new upload.");
    const known = new Map<number, string>(upload.parts.map((part: any) => [part.partNumber, part.etag]));
    const [sha256, md5, partMd5] = await Promise.all([createSHA256(), createMD5(), createMD5()]);
    sha256.init(); md5.init();
    for (let offset = 0, number = 1; offset < file.size; offset += upload.partSize, number++) {
      if (cancelled) throw new DOMException("Cancelled", "AbortError");
      const buffer = await file.slice(offset, offset + upload.partSize).arrayBuffer();
      const bytes = new Uint8Array(buffer);
      sha256.update(bytes); md5.update(bytes);
      const partHash = partMd5.init().update(bytes).digest();
      if (known.has(number)) {
        if (known.get(number) !== partHash) throw new Error("The selected file differs from the unfinished upload. Discard it and start a new upload.");
      } else {
        message("upload-message", `Uploading part ${number} of ${Math.ceil(file.size / upload.partSize)}…`);
        let receipt: any;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const result = await fetch(`/api/admin/uploads/${pending.id}/parts/${number}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-Part-MD5": partHash }, body: buffer, credentials: "same-origin", signal: controller.signal });
            receipt = await result.json();
            if (!result.ok) throw new ApiError(receipt.error || "Upload failed.", result.status, receipt);
            break;
          } catch (error) { if (cancelled || attempt === 2 || error instanceof ApiError && error.status < 500 && error.status !== 422) throw error; await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1))); }
        }
        if (receipt.etag !== partHash) throw new Error("The uploaded bytes did not pass verification. Resume to retry.");
      }
      progress.value = Math.min(100, (offset + bytes.length) / file.size * 100);
    }
    if (cancelled) throw new DOMException("Cancelled", "AbortError");
    button("cancel-upload").disabled = true;
    message("upload-message", "All parts verified. Publishing release…");
    await api(`/api/admin/uploads/${pending.id}/complete`, "POST", { sha256: sha256.digest(), md5: md5.digest() });
    savePending(null); input("archive").value = ""; input("version").value = "";
    element("file-description").textContent = "RAR, ZIP, or 7z · up to 10 GiB";
    await historyList();
    message("upload-message", "Published. The public mirror now shows the new archive and its checksums.", "success");
  } catch (error) {
    if (error instanceof ApiError && error.data.release) { savePending(null); await historyList().catch(() => {}); }
    if (!cancelled) message("upload-message", `${errorText(error)}${readPending() ? " Choose the same file and resume to continue." : ""}`, "error");
  } finally {
    busy = false; controller = null; button("upload-button").disabled = false; button("cancel-upload").disabled = false; input("archive").disabled = false;
    button("cancel-upload").hidden = !readPending(); button("cancel-upload").textContent = "Discard unfinished upload"; input("version").disabled = !!readPending();
    button("upload-button").textContent = readPending() ? "Resume upload & publish" : "Upload & publish";
  }
});
}
interface UploadToken { id: string; name: string; createdAt: string; expiresAt: string }
async function loadTokens() {
  const result = await api("/api/admin/tokens");
  const list = element("token-list"); list.replaceChildren();
  for (const token of result.tokens as UploadToken[]) {
    const row = document.createElement("article"); row.className = "release"; row.dataset.tokenId = token.id;
    const info = document.createElement("div"); info.className = "release-info";
    const name = document.createElement("strong"); name.textContent = token.name;
    const dates = document.createElement("small"); dates.textContent = `Created ${new Date(token.createdAt).toLocaleDateString()} · Expires ${new Date(token.expiresAt).toLocaleDateString()} · ID ${token.id.slice(0, 8)}`;
    if (Date.parse(token.expiresAt) <= Date.now()) { const expired = document.createElement("small"); expired.className = "token-expired"; expired.textContent = "Expired"; info.append(expired); }
    info.prepend(name, dates); row.append(info);
    const revoke = document.createElement("button"); revoke.type = "button"; revoke.className = "secondary"; revoke.textContent = "Revoke";
    revoke.addEventListener("click", async () => {
      revoke.disabled = true;
      try {
        await api(`/api/admin/tokens/${token.id}`, "DELETE");
        if (input("created-token").value.startsWith(`as_mirror_${token.id}_`)) clearToken();
        await loadTokens(); message("tokens-message", `Revoked ${token.name}.`, "success");
      } catch (error) { message("tokens-message", errorText(error), "error"); revoke.disabled = false; }
    });
    row.append(revoke); list.append(row);
  }
  if (!list.childElementCount) { const empty = document.createElement("p"); empty.className = "empty"; empty.textContent = "No API tokens. Create one above to automate uploads."; list.append(empty); }
}
function clearToken() { input("created-token").value = ""; element("token-secret").hidden = true; button("create-token").disabled = false; }
if (tokensPage) {
  window.addEventListener("pagehide", clearToken);
  element<HTMLFormElement>("token-form").addEventListener("submit", async event => {
    event.preventDefault(); if (!element("token-secret").hidden) return;
    button("create-token").disabled = true; message("token-message", "");
    try {
      const created = await api("/api/admin/tokens", "POST", { name: input("token-name").value, expiresInDays: Number(element<HTMLSelectElement>("token-expiry").value) });
      input("created-token").value = created.token; element("token-secret").hidden = false; input("token-name").value = "";
      message("token-message", "Token created. Copy it now; it cannot be shown again.", "success");
      await loadTokens().catch(error => message("tokens-message", errorText(error), "error"));
    } catch (error) { message("token-message", errorText(error), "error"); button("create-token").disabled = false; }
  });
  button("dismiss-token").addEventListener("click", () => { clearToken(); message("token-message", ""); });
  button("copy-token").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(input("created-token").value); message("token-message", "Token copied. Save it in your secret manager.", "success"); }
    catch { input("created-token").focus(); input("created-token").select(); message("token-message", "Select and copy the token from the field above."); }
  });
  button("tokens-refresh").addEventListener("click", () => { void loadTokens().catch(error => message("tokens-message", errorText(error), "error")); });
}
const mode = document.body.dataset.mode || "login";
show(mode);
if (mode === "dashboard") {
  if (statsPage) void loadStats();
  else if (tokensPage) void loadTokens().catch(error => { if (error instanceof ApiError && error.status === 401) show("login"); else message("tokens-message", errorText(error), "error"); });
  else { uploadState(); historyList().catch(error => { if (error instanceof ApiError && error.status === 401) show("login"); else message("history-message", errorText(error), "error"); }); }
}
