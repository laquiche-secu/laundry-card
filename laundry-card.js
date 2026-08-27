/* Laundry Card
 * No helper entities required.
 * Reads power/energy history directly from Home Assistant.
 */
class LaundryCard extends HTMLElement {
  static getStubConfig() {
    return {
      type: "custom:laundry-card",
      price_per_kwh: 0.25,
      detection: { start_power: 10, stop_power: 5, stop_delay: 180, min_cycle_duration: 60 },
      laundry: { name: "Lave-linge", power: "", energy: "", current: "" },
      dryer: { name: "Sèche-linge", power: "", energy: "", current: "" }
    };
  }

  setConfig(config) {
    this._config = {
      price_per_kwh: 0.25,
      detection: { start_power: 10, stop_power: 5, stop_delay: 180, min_cycle_duration: 60 },
      laundry: { name: "Lave-linge", power: "", energy: "", current: "" },
      dryer: { name: "Sèche-linge", power: "", energy: "", current: "" },
      ...config,
    };
    this._config.detection = {
      start_power: 10, stop_power: 5, stop_delay: 180, min_cycle_duration: 60,
      ...(config.detection || {})
    };
    this._config.laundry = {
      name: "Lave-linge", power: "", energy: "", current: "",
      ...(config.laundry || {})
    };
    this._config.dryer = {
      name: "Sèche-linge", power: "", energy: "", current: "",
      ...(config.dryer || {})
    };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._refreshTimer) this._scheduleRefresh();
    this._renderCurrent();
  }

  connectedCallback() {
    this._scheduleRefresh();
  }

  disconnectedCallback() {
    clearTimeout(this._refreshTimer);
  }

  _scheduleRefresh() {
    clearTimeout(this._refreshTimer);
    const interval = Math.max(15000, Number(this._config?.refresh_interval || 60000));
    this._refreshTimer = setTimeout(async () => {
      await this._load();
      this._scheduleRefresh();
    }, interval);
  }

  async _load() {
    if (!this._hass) return;
    const jobs = [];
    if (this._config.laundry.power) jobs.push(["laundry", this._config.laundry]);
    if (this._config.dryer.power) jobs.push(["dryer", this._config.dryer]);
    for (const [key, machine] of jobs) this._data[key] = await this._analyse(machine);
    this._render();
  }

  async _history(entityId, start, end) {
    if (!entityId) return [];
    try {
      const r = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: [entityId],
        minimal_response: false,
        significant_changes_only: false
      });
      return r[entityId] || [];
    } catch (e) {
      console.error("Laundry Card history:", e);
      return [];
    }
  }

  async _analyse(machine) {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const historyStart = new Date(Math.min(
      monthStart.getTime(),
      this._startOfWeek(now).getTime()
    ));

    const [power, energy] = await Promise.all([
      this._history(machine.power, historyStart, now),
      this._history(machine.energy, historyStart, now)
    ]);

    const cycles = this._detect(power);
    const weekStart = this._startOfWeek(now);

    const weekCycles = cycles.filter(c => c.start >= weekStart);
    const monthCycles = cycles.filter(c => c.start >= monthStart);

    const unit = this._energyUnit(machine.energy);
    const weekEnergy = weekCycles.reduce((s, c) => s + this._cycleEnergy(c, energy, unit), 0);
    const monthEnergy = monthCycles.reduce((s, c) => s + this._cycleEnergy(c, energy, unit), 0);

    const currentCycle = cycles.find(c => !c.end) || null;
    const currentEnergy = currentCycle ? this._cycleEnergy(currentCycle, energy, unit) : 0;
    const lastFinished = [...cycles].reverse().find(c => c.end) || null;
    const price = Number(this._config.price_per_kwh || 0);

    return {
      running: !!currentCycle,
      currentCycle,
      lastFinished,
      currentEnergy,
      cyclesWeek: weekCycles.length,
      cyclesMonth: monthCycles.length,
      weekEnergy,
      monthEnergy,
      costWeek: weekEnergy * price,
      costMonth: monthEnergy * price
    };
  }

  _detect(history) {
    const d = this._config.detection;
    const startW = Number(d.start_power);
    const stopW = Number(d.stop_power);
    const stopDelay = Number(d.stop_delay) * 1000;
    const minDuration = Number(d.min_cycle_duration) * 1000;

    const points = history.map(x => ({
      time: new Date(x.last_changed),
      power: Number(x.state)
    })).filter(x => Number.isFinite(x.power))
      .sort((a,b) => a.time - b.time);

    const cycles = [];
    let running = false, start = null, belowSince = null;

    for (const p of points) {
      if (!running) {
        if (p.power >= startW) {
          running = true;
          start = p.time;
          belowSince = null;
        }
        continue;
      }

      if (p.power <= stopW) {
        belowSince ??= p.time;
        if (p.time - belowSince >= stopDelay) {
          const end = belowSince;
          if (end - start >= minDuration) cycles.push({ start, end });
          running = false; start = null; belowSince = null;
        }
      } else {
        belowSince = null;
      }
    }

    if (running && start) cycles.push({ start, end: null });
    return cycles;
  }

  _energyUnit(entityId) {
    const s = this._hass?.states?.[entityId];
    return s?.attributes?.unit_of_measurement === "Wh" ? "Wh" : "kWh";
  }

  _energyAt(history, date) {
    let best = null;
    for (const x of history) {
      const t = new Date(x.last_changed);
      if (t <= date) best = x; else break;
    }
    const n = best ? Number(best.state) : NaN;
    return Number.isFinite(n) ? n : null;
  }

  _cycleEnergy(cycle, history, unit) {
    const a = this._energyAt(history, cycle.start);
    const b = this._energyAt(history, cycle.end || new Date());
    if (a == null || b == null) return 0;
    let v = b - a;
    if (unit === "Wh") v /= 1000;
    return Math.max(0, v);
  }

  _startOfWeek(d) {
    const x = new Date(d);
    const day = x.getDay();
    x.setDate(x.getDate() + (day === 0 ? -6 : 1 - day));
    x.setHours(0,0,0,0);
    return x;
  }

  _duration(start) {
    const sec = Math.max(0, Math.floor((Date.now() - start.getTime()) / 1000));
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h ? `${h} h ${m} min` : `${m} min`;
  }

  _ago(date) {
    const sec = Math.max(0, Math.floor((Date.now() - date.getTime()) / 1000));
    if (sec < 3600) return "moins d'une heure";
    const h = Math.floor(sec / 3600);
    if (h < 24) return `il y a ${h} h`;
    const d = Math.floor(h / 24);
    return `il y a ${d} jour${d > 1 ? "s" : ""}`;
  }

  _fmtKwh(v) { return `${v.toFixed(2).replace(".", ",")} kWh`; }
  _fmtEuro(v) { return `${v.toFixed(2).replace(".", ",")} €`; }

  _machine(machine, data, icon) {
    if (!machine.power) return "";
    if (!data) return `<section class="machine"><header><div class="title">${icon} ${machine.name}</div></header><div class="loading">Chargement…</div></section>`;

    const running = data.running;
    const status = running ? "EN COURS" : "À L'ARRÊT";
    const primary = running
      ? `Depuis ${this._duration(data.currentCycle.start)}`
      : (data.lastFinished ? `Dernier cycle : ${this._ago(data.lastFinished.end)}` : "Aucun cycle enregistré");

    return `
      <section class="machine ${running ? "running" : ""}">
        <header>
          <div class="title"><span class="icon">${icon}</span>${machine.name}</div>
          <div class="status ${running ? "on" : "off"}">● ${status}</div>
        </header>
        <div class="state"><div class="state-icon">${running ? "▶" : "■"}</div><div><b>${running ? "Machine en cours" : "Machine à l'arrêt"}</b><span>${primary}</span></div></div>
        <div class="consumption">
          <span class="label">CONSOMMATION</span>
          <div class="energy">⚡ <b>${this._fmtKwh(running ? data.currentEnergy : 0)}</b></div>
          <small>${running ? "Cycle en cours" : "Aucune consommation en cours"}</small>
        </div>
        <div class="stats">
          <div><span>Cette semaine</span><b>${data.cyclesWeek} cycle${data.cyclesWeek > 1 ? "s" : ""}</b><small>${this._fmtEuro(data.costWeek)}</small></div>
          <i></i>
          <div><span>Ce mois</span><b>${data.cyclesMonth} cycle${data.cyclesMonth > 1 ? "s" : ""}</b><small>${this._fmtEuro(data.costMonth)}</small></div>
        </div>
      </section>`;
  }

  _renderCurrent() {
    // Update dynamic text without forcing a history request.
    if (!this._hass) return;
    const nodes = this.shadowRoot?.querySelectorAll("[data-running-duration]");
    nodes?.forEach(n => {
      const key = n.dataset.runningDuration;
      const d = this._data?.[key];
      if (d?.running) n.textContent = `Depuis ${this._duration(d.currentCycle.start)}`;
    });
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({mode:"open"});
    const c = this._config || {};
    this.shadowRoot.innerHTML = `
      <style>
        :host{display:block}.card{background:var(--ha-card-background,var(--card-background-color,#fff));border-radius:16px;padding:16px}.machines{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px}.machine{border:1px solid var(--divider-color);border-radius:14px;padding:15px}.title{font-size:19px;font-weight:650;display:flex;gap:9px;align-items:center}.icon{font-size:23px}header{display:flex;justify-content:space-between;align-items:center;margin-bottom:14px}.status{font-size:11px;font-weight:750}.on{color:var(--success-color,#43a047)}.off{color:var(--secondary-text-color)}.state{display:flex;align-items:center;gap:12px;padding:13px;border-radius:12px;background:var(--secondary-background-color);margin-bottom:10px}.state-icon{width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:var(--card-background-color)}.state b,.state span{display:block}.state span{margin-top:4px;font-size:12px;color:var(--secondary-text-color)}.consumption{border:1px solid var(--divider-color);border-radius:12px;padding:13px;margin-bottom:10px}.label{font-size:10px;font-weight:750;letter-spacing:.08em}.energy{font-size:27px;margin-top:6px}.consumption small{color:var(--secondary-text-color)}.stats{display:grid;grid-template-columns:1fr auto 1fr;text-align:center;border:1px solid var(--divider-color);border-radius:12px;padding:12px}.stats span,.stats b,.stats small{display:block}.stats span{font-size:11px;color:var(--secondary-text-color)}.stats b{font-size:17px;margin-top:4px}.stats small{font-size:14px;margin-top:3px}.stats i{width:1px;height:48px;background:var(--divider-color);align-self:center}.loading{text-align:center;padding:25px;color:var(--secondary-text-color)}@media(max-width:600px){.machines{grid-template-columns:1fr}}
      </style>
      <ha-card class="card">
        <div class="machines">
          ${this._machine(c.laundry,this._data?.laundry,"🧺")}
          ${this._machine(c.dryer,this._data?.dryer,"🔥")}
        </div>
      </ha-card>`;
  }
}
customElements.define("laundry-card", LaundryCard);

class LaundryCardEditor extends HTMLElement {
  setConfig(config) {
    this._config = JSON.parse(JSON.stringify(config || {}));
    this._config.laundry ||= {};
    this._config.dryer ||= {};
    this._config.detection ||= {};
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _fire(config) {
    this._config = config;
    this.dispatchEvent(new CustomEvent("config-changed", {detail:{config}, bubbles:true, composed:true}));
  }

  _input(label, value, path, type="text", step="") {
    const el = document.createElement("ha-textfield");
    el.label = label;
    el.value = value ?? "";
    el.type = type;
    if (step) el.step = step;
    el.addEventListener("change", e => {
      const c = JSON.parse(JSON.stringify(this._config));
      const parts = path.split(".");
      let o = c;
      for (let i=0;i<parts.length-1;i++) o = o[parts[i]] ||= {};
      const raw = e.target.value;
      o[parts.at(-1)] = type === "number" ? Number(raw) : raw;
      this._fire(c);
    });
    return el;
  }

  _entityPicker(label, value, path, domainFilter) {
    const row = document.createElement("div");
    const sel = document.createElement("ha-entity-picker");
    sel.label = label;
    sel.hass = this._hass;
    sel.value = value || "";
    sel.includeDomains = domainFilter ? [domainFilter] : undefined;
    sel.allowCustomEntity = true;
    sel.addEventListener("value-changed", e => {
      const c = JSON.parse(JSON.stringify(this._config));
      const parts = path.split(".");
      let o = c;
      for (let i=0;i<parts.length-1;i++) o = o[parts[i]] ||= {};
      o[parts.at(-1)] = e.detail.value;
      this._fire(c);
    });
    row.appendChild(sel);
    return row;
  }

  _machine(title, key) {
    const box = document.createElement("div");
    box.className = "section";
    const h = document.createElement("h3");
    h.textContent = title;
    box.appendChild(h);
    const m = this._config[key] || {};
    box.appendChild(this._input("Nom", m.name || (key==="laundry"?"Lave-linge":"Sèche-linge"), `${key}.name`));
    box.appendChild(this._entityPicker("Puissance (W) — utilisée pour détecter les cycles", m.power, `${key}.power`, "sensor"));
    box.appendChild(this._entityPicker("Énergie (kWh ou Wh) — consommation affichée", m.energy, `${key}.energy`, "sensor"));
    box.appendChild(this._entityPicker("Courant (A) — non affiché", m.current, `${key}.current`, "sensor"));
    return box;
  }

  _render() {
    if (!this._hass) return;
    this.innerHTML = "";
    const style = document.createElement("style");
    style.textContent = `
      :host{display:block;padding:12px}.section{padding:8px 0 18px;border-bottom:1px solid var(--divider-color);margin-bottom:15px}
      h2{font-size:18px;margin:5px 0 16px}h3{font-size:15px;margin:0 0 12px}
      ha-textfield,ha-entity-picker{display:block;margin:8px 0;width:100%}
      .hint{color:var(--secondary-text-color);font-size:12px;line-height:1.45;margin:5px 0 12px}
      .grid{display:grid;grid-template-columns:1fr 1fr;gap:10px}
      @media(max-width:600px){.grid{grid-template-columns:1fr}}
    `;
    this.appendChild(style);

    const title = document.createElement("h2");
    title.textContent = "Laundry Card";
    this.appendChild(title);

    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Aucune entité supplémentaire n'est créée. La carte utilise directement l'historique Home Assistant. Le courant et la puissance servent à la logique mais ne sont pas affichés.";
    this.appendChild(hint);

    this.appendChild(this._machine("🧺 Lave-linge","laundry"));
    this.appendChild(this._machine("🔥 Sèche-linge","dryer"));

    const detection = document.createElement("div");
    detection.className = "section";
    const dh = document.createElement("h3"); dh.textContent = "Détection des cycles"; detection.appendChild(dh);
    const grid = document.createElement("div"); grid.className = "grid";
    grid.appendChild(this._input("Seuil de démarrage (W)", this._config.detection.start_power ?? 10, "detection.start_power","number","1"));
    grid.appendChild(this._input("Seuil d'arrêt (W)", this._config.detection.stop_power ?? 5, "detection.stop_power","number","1"));
    grid.appendChild(this._input("Délai avant arrêt confirmé (s)", this._config.detection.stop_delay ?? 180, "detection.stop_delay","number","1"));
    grid.appendChild(this._input("Durée minimale d'un cycle (s)", this._config.detection.min_cycle_duration ?? 60, "detection.min_cycle_duration","number","1"));
    detection.appendChild(grid); this.appendChild(detection);

    const pricing = document.createElement("div");
    pricing.className = "section";
    const ph = document.createElement("h3"); ph.textContent = "Tarification"; pricing.appendChild(ph);
    pricing.appendChild(this._input("Prix du kWh (non affiché)", this._config.price_per_kwh ?? 0.25, "price_per_kwh","number","0.001"));
    const pi = document.createElement("div"); pi.className="hint"; pi.textContent="Ce prix est uniquement utilisé pour calculer les coûts hebdomadaires et mensuels."; pricing.appendChild(pi);
    this.appendChild(pricing);
  }
}
customElements.define("laundry-card-editor", LaundryCardEditor);

const old = customElements.get("laundry-card");
if (old && !old.prototype.getConfigElement) {
  old.prototype.getConfigElement = function() {
    const editor = document.createElement("laundry-card-editor");
    editor.hass = this._hass;
    editor.setConfig(this._config);
    return editor;
  };
  old.prototype.getStubConfig = LaundryCard.getStubConfig;
}
