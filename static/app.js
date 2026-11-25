"use strict";

(() => {
  const $ = (id) => document.getElementById(id);
  const units = { years: { label: "années", seconds: 31556952 }, months: { label: "mois", seconds: 2629746 }, weeks: { label: "semaines", seconds: 604800 }, days: { label: "jours", seconds: 86400 }, hours: { label: "heures", seconds: 3600 } };
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
    $("timers").replaceChildren($("add-timer"));
    $("workspace").hidden = true;
    $("boot").hidden = true;
    $("logout").hidden = true;
    $("new-timer").hidden = true;
    $("login-panel").hidden = false;
    if ($("delete-dialog").open) $("delete-dialog").close();
    if ($("create-dialog").open) $("create-dialog").close();
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

  const svgNamespace = "http://www.w3.org/2000/svg";
  const segmentShapes = [
    "8,2 32,2 37,7 32,12 8,12 3,7",
    "33,13 38,8 38,35 33,40 28,35 28,18",
    "33,42 38,47 38,74 33,69 28,64 28,47",
    "8,70 32,70 37,75 32,80 8,80 3,75",
    "2,47 7,42 12,47 12,64 7,69 2,74",
    "2,8 7,13 12,18 12,35 7,40 2,35",
    "8,36 32,36 37,41 32,46 8,46 3,41",
  ];
  const digitSegments = ["1111110", "0110000", "1101101", "1111001", "0110011", "1011011", "1011111", "1110000", "1111111", "1111011"];

  function createClockPart(label) {
    const element = node("span", "countdown-part");
    const value = document.createElementNS(svgNamespace, "svg");
    value.classList.add("countdown-value");
    value.setAttribute("aria-hidden", "true");
    value.setAttribute("focusable", "false");
    element.append(node("span", "countdown-unit", label), value);
    return { element, value, digits: [], text: "" };
  }

  function updateClockPart(part, amount) {
    const text = String(amount).padStart(2, "0");
    if (part.text === text) return;
    if (part.digits.length !== text.length) {
      part.digits = Array.from(text, (_, index) => {
        const digit = document.createElementNS(svgNamespace, "g");
        digit.setAttribute("transform", `translate(${index * 46} 0)`);
        for (const points of segmentShapes) {
          const segment = document.createElementNS(svgNamespace, "polygon");
          segment.setAttribute("points", points);
          digit.append(segment);
        }
        return digit;
      });
      part.value.replaceChildren(...part.digits);
      part.value.setAttribute("viewBox", `0 0 ${text.length * 46 - 6} 82`);
      part.value.style.width = `${text.length * 28}px`;
    }
    for (let index = 0; index < text.length; index++) {
      if (part.text.length === text.length && part.text[index] === text[index]) continue;
      const segments = digitSegments[Number(text[index])];
      Array.from(part.digits[index].children).forEach((segment, position) => {
        segment.setAttribute("class", segments[position] === "1" ? "segment lit" : "segment");
      });
    }
    part.text = text;
  }

  function updateClock(card, seconds, displayUnit) {
    const key = Object.hasOwn(units, displayUnit) ? displayUnit : "years";
    const config = units[key];
    const amounts = [[config.label, Math.floor(seconds / config.seconds)]];
    let remainder = seconds % config.seconds;
    const subunits = key === "years"
      ? [["mois", units.months.seconds], ["semaines", units.weeks.seconds], ["jours", units.days.seconds]]
      : key === "months"
        ? [["semaines", units.weeks.seconds], ["jours", units.days.seconds]]
        : key === "weeks"
          ? [["jours", units.days.seconds]]
          : key === "days"
            ? [["heures", units.hours.seconds], ["minutes", 60]]
            : [["minutes", 60]];
    for (const [label, size] of subunits) {
      const amount = Math.floor(remainder / size);
      remainder %= size;
      if (label !== "semaines" || amount > 0) amounts.push([label, amount]);
    }
    const shape = amounts.map(([label]) => label).join(",");
    if (card.shape !== shape) {
      card.parts = amounts.map(([label]) => createClockPart(label));
      card.face.replaceChildren(...card.parts.map((part) => part.element));
      card.shape = shape;
    }
    amounts.forEach(([, amount], index) => updateClockPart(card.parts[index], amount));
    const description = amounts.map(([label, amount]) => `${whole.format(amount)} ${label}`).join(", ");
    if (card.readable.textContent !== description) card.readable.textContent = description;
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
        const readable = node("span", "sr-only");
        const face = node("div", "clock-face");
        face.setAttribute("aria-hidden", "true");
        const complete = node("div", "clock-complete");
        complete.hidden = true;
        complete.append(node("strong", "", "Le moment est là !"), node("span", "", "L’attente est terminée. Profitez de l’instant."));
        count.append(readable, face, complete);
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
        element.append(top, main);
        card = { element, title, target, remove, select, face, readable, complete, parts: [], shape: "", finished: null };
        cards.set(timer.id, card);
        $("timers").insertBefore(element, $("add-timer"));
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
      if (!finished) updateClock(card, seconds, timer.display_unit);
      if (card.finished !== finished) {
        card.face.hidden = finished;
        card.readable.hidden = finished;
        card.complete.hidden = !finished;
        card.element.classList.toggle("finished", finished);
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
      $("new-timer").hidden = false;
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
      if (authenticated) $("new-timer").focus();
    } catch (error) { setError("login-error", error.message); }
    finally { button.disabled = false; }
  });

  $("logout").addEventListener("click", async () => {
    $("logout").disabled = true;
    try { await api("/api/logout", { method: "POST", body: "{}" }); showLogin(); setError("login-error"); }
    catch (error) { if (error.status !== 401) setError("list-error", error.message); }
    finally { $("logout").disabled = false; }
  });

  function openCreate() {
    if (!authenticated) return;
    $("create-dialog").showModal();
    $("title").focus();
  }

  $("new-timer").addEventListener("click", openCreate);
  $("add-timer").addEventListener("click", openCreate);
  $("create-close").addEventListener("click", () => {
    if (!$("create-form").querySelector("button[type=submit]").disabled) $("create-dialog").close();
  });
  $("create-dialog").addEventListener("cancel", (event) => {
    if ($("create-form").querySelector("button[type=submit]").disabled) event.preventDefault();
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
    $("create-close").disabled = true;
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
      $("create-dialog").close();
      announce(`${result.timer.title} a été créé.`);
    } catch (error) { setError("create-error", error.message); }
    finally { button.disabled = false; $("create-close").disabled = false; }
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
      $("new-timer").focus();
      announce("Le moment a été supprimé.");
    } catch (error) { setError("delete-error", error.message); }
    finally { $("delete-confirm").disabled = false; $("delete-cancel").disabled = false; }
  });
  $("delete-dialog").addEventListener("cancel", (event) => { if ($("delete-confirm").disabled) event.preventDefault(); });
  $("retry").addEventListener("click", start);
  $("start-first").addEventListener("click", openCreate);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && authenticated) { tick(); refreshTimers(); } });
  window.addEventListener("online", () => { if (authenticated) refreshTimers(); });
  setInterval(tick, 1000);
  start();
})();
