(() => {
  // client/auth-entry.js
  var $ = (id) => document.getElementById(id);
  async function request(path, init = {}) {
    const response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: { "content-type": "application/json", ...init.headers ?? {} },
      cache: "no-store"
    });
    const body = response.status === 204 ? null : await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body?.error || `\u8BF7\u6C42\u5931\u8D25\uFF08${response.status}\uFF09`);
    return body;
  }
  function showError(error) {
    const box = $("error");
    if (!box) return;
    box.textContent = error?.message || String(error);
    box.hidden = false;
  }
  function clearError() {
    const box = $("error");
    if (box) box.hidden = true;
  }
  function setBusy(button, busy, text) {
    if (!button) return;
    if (!button.dataset.idleText) button.dataset.idleText = button.textContent;
    button.disabled = busy;
    button.textContent = busy ? text : button.dataset.idleText;
  }
  async function login(event) {
    event.preventDefault();
    const button = $("login-button");
    const password = String($("login-password")?.value ?? "");
    if (password.length < 6) return showError(new Error("\u8BF7\u8F93\u5165\u81F3\u5C11 6 \u4E2A\u5B57\u7B26\u7684\u8BBE\u5907\u5BC6\u7801"));
    try {
      clearError();
      setBusy(button, true, "\u6B63\u5728\u9A8C\u8BC1\u2026");
      const result = await request("/pocket-auth/login", { method: "POST", body: JSON.stringify({ password }) });
      location.replace(result.redirect || "/");
    } catch (error) {
      showError(error);
      setBusy(button, false, "");
      const input = $("login-password");
      if (input) {
        input.value = "";
        input.focus();
      }
    }
  }
  async function pair(event) {
    event.preventDefault();
    const button = $("pair-button");
    const name = String($("device-name")?.value ?? "").trim();
    const password = String($("device-password")?.value ?? "");
    const confirmation = String($("device-password-confirm")?.value ?? "");
    const token = new URLSearchParams(location.hash.slice(1)).get("pair");
    if (!token) return showError(new Error("\u914D\u5BF9\u94FE\u63A5\u65E0\u6548\u6216\u5DF2\u7ECF\u5931\u6548"));
    if (!name) return showError(new Error("\u8BF7\u586B\u5199\u8BBE\u5907\u540D\u79F0"));
    if (password.length < 6) return showError(new Error("\u8BBE\u5907\u5BC6\u7801\u81F3\u5C11\u9700\u8981 6 \u4E2A\u5B57\u7B26"));
    if (password !== confirmation) return showError(new Error("\u4E24\u6B21\u8F93\u5165\u7684\u8BBE\u5907\u5BC6\u7801\u4E0D\u4E00\u81F4"));
    try {
      clearError();
      setBusy(button, true, "\u6B63\u5728\u63D0\u4EA4\u2026");
      await request("/pocket-pair/submit", { method: "POST", body: JSON.stringify({ token, name, password }) });
      $("pair-form").hidden = true;
      $("pair-complete").hidden = false;
      history.replaceState(null, "", `${location.pathname}${location.search}`);
    } catch (error) {
      showError(error);
      setBusy(button, false, "");
    }
  }
  function boot() {
    $("login-form")?.addEventListener("submit", login);
    $("pair-form")?.addEventListener("submit", pair);
  }
  document.addEventListener("DOMContentLoaded", boot, { once: true });
})();
