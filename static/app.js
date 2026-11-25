"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const units = { years: { label: "années", seconds: 31556952 }, months: { label: "mois", seconds: 2629746 }, days: { label: "jours", seconds: 86400 }, hours: { label: "heures", seconds: 3600 } };
  const whole = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 0 });
  const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" });
  let authenticated = false;
  let protectedSpace = false;
  let sessionEpoch = 0;
  let refreshPending = null;
  let timers = [];
  let deleteId = null;
  const cards = new Map();
  const pendingUnits = new Set();

  class ApiError extends Error {
    constructor(message, status) { super(message); this.status = status; }
  }

  function setError(id, message = "") {
    $(id).textContent = message;
    if (id === "list-error") $(id).hidden = !message;
  }

  function announce(message) { $("announcement").textContent = message; }

  function showLogin() {
    authenticated = false;
    sessionEpoch += 1;
    timers = [];
    cards.clear();
    $("timers").replaceChildren();
    $("workspace").hidden = true;
    $("boot").hidden = true;
    $("logout").hidden = true;
    $("login-panel").hidden = false;
    if ($("delete-dialog").open) $("delete-dialog").close();
    $("password").focus();
  }

  async function api(path, options = {}) {
    let response;
    try {
      response = await fetch(path, { credentials: "same-origin", cache: "no-store", ...options, headers: { "Content-Type": "application/json", "X-Requested-With": "Minuteur", ...options.headers } });
    } catch (_) { throw new ApiError("Connexion impossible. Vérifiez votre réseau puis réessayez.", 0); }
    let data = null;
    if (response.status !== 204) {
      try { data = await response.json(); } catch (_) { /* A proxy may return a non-JSON error page. */ }
    }
    if (!response.ok) {
      if (response.status === 401 && path !== "/api/login") {
        showLogin();
        setError("login-error", "Votre session a expiré. Reconnectez-vous ; votre formulaire est conservé.");
      }
      throw new ApiError(data?.error || "Une erreur est survenue. Veuillez réessayer.", response.status);
    }
    return data;
  }

  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined) element.textContent = text;
    return element;
  }

  function renderCards() {
    const activeIds = new Set(timers.map((timer) => timer.id));
    for (const [id, card] of cards) {
      if (!activeIds.has(id)) { card.element.remove(); cards.delete(id); }
    }
    for (const timer of timers) {
      let card = cards.get(timer.id);
      if (!card) {
        const element = node("article", "timer-card");
        const top = node("div", "card-top");
        const heading = node("div");
        const title = node("h3", "timer-title");
        const target = node("p", "target-date");
        heading.append(title, target);
        const remove = node("button", "delete-button");
        const trash = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        trash.setAttribute("viewBox", "0 0 24 24");
        trash.setAttribute("aria-hidden", "true");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7");
        trash.append(path);
        remove.append(trash);
        remove.type = "button";
        remove.addEventListener("click", () => openDelete(timer.id));
        top.append(heading, remove);
        const main = node("div", "card-main");
        const count = node("div", "countdown-row");
        const value = node("span", "countdown-value");
        const unit = node("span", "countdown-unit");
        const primary = node("span", "countdown-part");
        primary.append(value, unit);
        count.append(primary);
        const control = node("div", "unit-control");
        const label = node("label", "", "Afficher en");
        const select = node("select");
        select.id = `unit-${timer.id}`;
        label.htmlFor = select.id;
        for (const [key, config] of Object.entries(units)) {
          const option = node("option", "", config.label[0].toUpperCase() + config.label.slice(1));
          option.value = key;
          select.append(option);
        }
        select.addEventListener("change", () => changeUnit(timer.id, select));
        control.append(label, select);
        main.append(count, control);
        const breakdown = node("span", "breakdown");
        count.append(breakdown);
        const bottom = node("div", "card-bottom");
        const status = node("span", "card-status");
        const note = node("span");
        bottom.append(status, note);
        element.append(top, main, bottom);
        card = { element, title, target, remove, value, unit, select, breakdown, status, note, finished: null };
        cards.set(timer.id, card);
        $("timers").append(element);
      }
      card.title.textContent = timer.title;
      card.target.textContent = `Le ${dateFormat.format(new Date(timer.ends_at))} · heure locale`;
      card.remove.setAttribute("aria-label", `Supprimer ${timer.title}`);
      card.select.setAttribute("aria-label", `Unité du temps restant pour ${timer.title}`);
      if (!pendingUnits.has(timer.id)) card.select.value = timer.display_unit;
    }
    $("timer-count").textContent = whole.format(timers.length);
    $("empty").hidden = timers.length !== 0;
    tick();
  }

  function tick() {
    if (!authenticated) return;
    const now = Date.now();
    for (const timer of timers) {
      const card = cards.get(timer.id);
      if (!card) continue;
      const seconds = Math.max(0, Math.ceil((Date.parse(timer.ends_at) - now) / 1000));
      const finished = seconds === 0;
      const config = units[timer.display_unit] || units.years;
      const approximate = timer.display_unit === "years" || timer.display_unit === "months";
      card.value.textContent = finished ? "Le moment est là !" : whole.format(Math.floor(seconds / config.seconds));
      card.unit.textContent = config.label;
      let remainder = seconds % config.seconds;
      const subunits = timer.display_unit === "years"
        ? [["mois", units.months.seconds], ["jours", units.days.seconds]]
        : timer.display_unit === "months"
          ? [["jours", units.days.seconds]]
          : timer.display_unit === "days"
            ? [["heures", units.hours.seconds], ["minutes", 60]]
            : [["minutes", 60]];
      if (finished) {
        card.breakdown.textContent = "L’attente est terminée. Profitez de l’instant.";
        delete card.breakdown.dataset.unit;
      } else {
        if (card.breakdown.dataset.unit !== timer.display_unit) {
          card.breakdown.replaceChildren(...subunits.map(([label]) => {
            const part = node("span", "countdown-part");
            part.append(node("span", "countdown-value"), node("span", "countdown-unit", label));
            return part;
          }));
          card.breakdown.dataset.unit = timer.display_unit;
        }
        subunits.forEach(([, size], index) => {
          const value = Math.floor(remainder / size);
          remainder %= size;
          card.breakdown.children[index].firstChild.textContent = whole.format(value);
        });
      }
      card.note.textContent = approximate ? "Estimation · année de 365,2425 jours" : "Chaque seconde vous rapproche";
      if (card.finished !== finished) {
        card.element.classList.toggle("finished", finished);
        const dot = node("span", "status-dot");
        dot.setAttribute("aria-hidden", "true");
        card.status.replaceChildren(dot, document.createTextNode(finished ? "Moment arrivé" : "En attendant ce moment"));
        if (card.finished === false && finished) announce(`${timer.title} : le moment est arrivé !`);
        card.finished = finished;
      }
    }
  }

  async function refreshTimers() {
    if (!authenticated) return;
    if (refreshPending) return refreshPending;
    const epoch = sessionEpoch;
    $("list-loading").hidden = false;
    refreshPending = (async () => {
      try {
        const data = await api("/api/timers");
        if (!authenticated || epoch !== sessionEpoch) return;
        timers = data.timers;
        renderCards();
        setError("list-error");
      } catch (error) {
        if (error.status !== 401 && epoch === sessionEpoch) setError("list-error", `${error.message} Vos moments seront actualisés au retour sur cet onglet.`);
      } finally {
        $("list-loading").hidden = true;
        refreshPending = null;
      }
    })();
    return refreshPending;
  }

  async function start() {
    $("retry").hidden = true;
    try {
      const session = await api("/api/session");
      protectedSpace = session.password_required;
      if (protectedSpace && !session.authenticated) { showLogin(); return; }
      authenticated = true;
      sessionEpoch += 1;
      $("boot").hidden = true;
      $("login-panel").hidden = true;
      $("workspace").hidden = false;
      $("logout").hidden = !protectedSpace;
      await refreshTimers();
    } catch (error) {
      $("boot").querySelector("p").textContent = error.message;
      $("boot").querySelector(".spinner").hidden = true;
      $("retry").hidden = false;
    }
  }

  $("login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector("button");
    if (button.disabled) return;
    button.disabled = true;
    setError("login-error");
    try {
      await api("/api/login", { method: "POST", body: JSON.stringify({ password: $("password").value }) });
      $("password").value = "";
      await start();
      if (authenticated) $("title").focus();
    } catch (error) { setError("login-error", error.message); }
    finally { button.disabled = false; }
  });

  $("logout").addEventListener("click", async () => {
    $("logout").disabled = true;
    try { await api("/api/logout", { method: "POST", body: "{}" }); showLogin(); setError("login-error"); }
    catch (error) { if (error.status !== 401) setError("list-error", error.message); }
    finally { $("logout").disabled = false; }
  });

  $("create-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector("button[type=submit]");
    if (button.disabled) return;
    setError("create-error");
    const data = Object.fromEntries(new FormData(form));
    data.title = data.title.trim();
    let total = 0;
    for (const key of ["years", "months", "days", "hours", "minutes"]) { data[key] = Number(data[key]); total += data[key]; }
    if (!data.title) { setError("create-error", "Donnez un nom à ce moment."); $("title").focus(); return; }
    if (!total) { setError("create-error", "Choisissez une durée supérieure à zéro."); $("minutes").focus(); return; }
    button.disabled = true;
    const epoch = sessionEpoch;
    try {
      const result = await api("/api/timers", { method: "POST", body: JSON.stringify(data) });
      if (!authenticated || epoch !== sessionEpoch) return;
      if (refreshPending) await refreshPending;
      if (!authenticated || epoch !== sessionEpoch) return;
      timers = [result.timer, ...timers.filter((timer) => timer.id !== result.timer.id)];
      form.reset();
      renderCards();
      $("timers").prepend(cards.get(result.timer.id).element);
      announce(`${result.timer.title} a été créé.`);
    } catch (error) { setError("create-error", error.message); }
    finally { button.disabled = false; }
  });

  async function changeUnit(id, select) {
    if (pendingUnits.has(id)) return;
    const previous = timers.find((timer) => timer.id === id)?.display_unit;
    pendingUnits.add(id);
    select.disabled = true;
    const epoch = sessionEpoch;
    try {
      const result = await api(`/api/timers/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ display_unit: select.value }) });
      if (refreshPending) await refreshPending;
      if (!authenticated || epoch !== sessionEpoch) return;
      timers = timers.map((timer) => timer.id === id ? result.timer : timer);
      setError("list-error");
      tick();
      announce("Unité d’affichage enregistrée.");
    } catch (error) {
      select.value = previous;
      if (error.status !== 401) setError("list-error", error.message);
    } finally { pendingUnits.delete(id); select.disabled = false; }
  }

  function openDelete(id) {
    const timer = timers.find((item) => item.id === id);
    if (!timer) return;
    deleteId = id;
    $("delete-description").textContent = `« ${timer.title} » sera retiré de votre espace.`;
    setError("delete-error");
    $("delete-dialog").showModal();
    $("delete-cancel").focus();
  }

  $("delete-confirm").addEventListener("click", async () => {
    const id = deleteId;
    if (!id || $("delete-confirm").disabled) return;
    $("delete-confirm").disabled = true;
    $("delete-cancel").disabled = true;
    const epoch = sessionEpoch;
    try {
      await api(`/api/timers/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
      if (refreshPending) await refreshPending;
      if (!authenticated || epoch !== sessionEpoch) return;
      timers = timers.filter((timer) => timer.id !== id);
      renderCards();
      $("delete-dialog").close();
      $("title").focus();
      announce("Le moment a été supprimé.");
    } catch (error) { setError("delete-error", error.message); }
    finally { $("delete-confirm").disabled = false; $("delete-cancel").disabled = false; }
  });
  $("delete-dialog").addEventListener("cancel", (event) => { if ($("delete-confirm").disabled) event.preventDefault(); });
  $("retry").addEventListener("click", start);
  $("start-first").addEventListener("click", () => { $("title").focus(); $("create-form").scrollIntoView({ block: "center" }); });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && authenticated) { tick(); refreshTimers(); } });
  window.addEventListener("online", () => { if (authenticated) refreshTimers(); });
  setInterval(tick, 1000);
  start();
})();
