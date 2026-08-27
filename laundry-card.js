/* Laundry Card
 * Displays power/energy history for a single laundry or dryer machine.
 * No helper entities required.
 * Styled with Mushroom Card design
 */
class LaundryCard extends HTMLElement {
  static getStubConfig() {
    return {
      type: "custom:laundry-card",
      machine_type: "laundry",
      name: "Lave-linge",
      price_per_kwh: 0.25,
      detection: { 
        start_power: 10, 
        stop_power: 5, 
        stop_delay: 180, 
        min_cycle_duration: 60 
      },
      power: "",
      energy: "",
      current: "",
      icon: "mdi:washing-machine",
      tap_action: { action: "more-info" }
    };
  }

  constructor() {
    super();
    this._data = null;
    this._refreshTimer = null;
  }

  setConfig(config) {
    const machineType = config.machine_type || "laundry";
    const defaultName = machineType === "dryer" ? "Sèche-linge" : "Lave-linge";
    const defaultIcon = machineType === "dryer" ? "mdi:tumble-dryer" : "mdi:washing-machine";

    this._config = {
      machine_type: machineType,
      name: defaultName,
      price_per_kwh: 0.25,
      detection: { 
        start_power: 10, 
        stop_power: 5, 
        stop_delay: 180, 
        min_cycle_duration: 60 
      },
      power: "",
      energy: "",
      current: "",
      refresh_interval: 60000,
      icon: defaultIcon,
      tap_action: { action: "more-info" },
      ...config,
    };

    this._config.detection = {
      start_power: 10, 
      stop_power: 5, 
      stop_delay: 180, 
      min_cycle_duration: 60,
      ...(config.detection || {})
    };

    this._icon = this._config.icon || defaultIcon;
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
    if (!this._hass || !this._config.power) {
      this._data = null;
      return;
    }
    this._data = await this._analyse();
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

  async _analyse() {
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const historyStart = new Date(Math.min(
      monthStart.getTime(),
      this._startOfWeek(now).getTime()
    ));

    const [power, energy] = await Promise.all([
      this._history(this._config.power, historyStart, now),
      this._history(this._config.energy, historyStart, now)
    ]);

    const cycles = this._detect(power);
    const weekStart = this._startOfWeek(now);

    const weekCycles = cycles.filter(c => c.start >= weekStart);
    const monthCycles = cycles.filter(c => c.start >= monthStart);

    const unit = this._energyUnit();
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
      .sort((a, b) => a.time - b.time);

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
          running = false;
          start = null;
          belowSince = null;
        }
      } else {
        belowSince = null;
      }
    }

    if (running && start) cycles.push({ start, end: null });
    return cycles;
  }

  _energyUnit() {
    const s = this._hass?.states?.[this._config.energy];
    return s?.attributes?.unit_of_measurement === "Wh" ? "Wh" : "kWh";
  }

  _energyAt(history, date) {
    let best = null;
    for (const x of history) {
      const t = new Date(x.last_changed);
      if (t <= date) best = x;
      else break;
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
    x.setHours(0, 0, 0, 0);
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

  _fmtKwh(v) {
    return `${v.toFixed(2).replace(".", ",")} kWh`;
  }

  _fmtEuro(v) {
    return `${v.toFixed(2).replace(".", ",")} €`;
  }

  _renderCurrent() {
    if (!this._hass || !this._data?.running) return;
    const elem = this.shadowRoot?.querySelector("[data-running-duration]");
    if (elem) {
      elem.textContent = `Depuis ${this._duration(this._data.currentCycle.start)}`;
    }
  }

  _handleAction(action) {
    if (!action || action.action === 'none') return;
    const act = action.action;
    try {
      if (act === 'more-info') {
        const entity = action.entity || this._config.power || this._config.energy || null;
        if (entity) this.dispatchEvent(new CustomEvent('hass-more-info', { detail: { entityId: entity }, bubbles: true, composed: true }));
      } else if (act === 'navigate') {
        const nav = action.navigation_path || action.navigation || action.path || null;
        if (nav) window.history.pushState({}, '', nav);
      } else if (act === 'url') {
        const url = action.url;
        if (url) window.open(url, '_blank');
      } else if (act === 'toggle') {
        const entity = action.entity || this._config.power || null;
        if (entity) this._hass.callService('homeassistant', 'toggle', { entity_id: entity });
      } else if (act === 'call-service') {
        const domain = action.service?.split('.')?.[0] || action.service_domain || null;
        const service = action.service?.split('.')?.[1] || action.service || null;
        let serviceData = action.service_data || action.data || {};
        if (typeof serviceData === 'string') {
          try { serviceData = JSON.parse(serviceData); } catch (e) { serviceData = {}; }
        }
        if (domain && service) this._hass.callService(domain, service, serviceData);
      }
    } catch (e) {
      console.error('Laundry Card action error', e);
    }
  }

  _render() {
    if (!this.shadowRoot) this.attachShadow({ mode: "open" });

    const c = this._config;
    if (!c.power) {
      this.shadowRoot.innerHTML = `
        <style>
          :host { display: block; }
          .error { 
            background: var(--card-background-color, #fff);
            border-radius: 12px;
            padding: 16px;
            color: var(--error-color, #f44336);
            text-align: center;
            font-weight: 500;
          }
        </style>
        <div class="error">⚠️ Entité "power" non configurée</div>`;
      return;
    }

    const data = this._data;
    const running = data?.running || false;
    const status = running ? "EN COURS" : "À L'ARRÊT";
    const primary = running
      ? `Depuis ${this._duration(data.currentCycle.start)}`
      : (data?.lastFinished ? `Dernier cycle : ${this._ago(data.lastFinished.end)}` : "Aucun cycle enregistré");

    const consumptionValue = running ? this._fmtKwh(data.currentEnergy) : this._fmtKwh(0);
    const consumptionLabel = running ? "Cycle en cours" : "Aucune consommation en cours";

    // Affichage conditionnel de la consommation - s'affiche SEULEMENT si la machine est en fonctionnement
    const consumptionDisplay = running ? `
      <div class="consumption">
        <span class="label">Consommation du cycle</span>
        <div class="energy">⚡ <b>${consumptionValue}</b></div>
        <small>${consumptionLabel}</small>
      </div>
    ` : '';

    // Icon handling: support mdi: icons using ha-icon
    const iconValue = this._config.icon || this._icon || "";
    const iconMarkup = String(iconValue).startsWith("mdi:")
      ? `<ha-icon icon="${iconValue}"></ha-icon>`
      : `${iconValue}`;

    // Cursor pointer if an action is configured
    const actionable = c.tap_action && c.tap_action.action && c.tap_action.action !== 'none';

    this.shadowRoot.innerHTML = `
      <style>
        :host {
          display: block;
          --mush-rgb: 76, 175, 80;
          --mush-color: rgb(var(--mush-rgb));
          --mush-rgb-off: 158, 158, 158;
          --mush-color-off: rgb(var(--mush-rgb-off));
        }
        
        .card {
          background: var(--card-background-color, #fff);
          border-radius: 12px;
          padding: 0;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.08);
          overflow: hidden;
          border: 1px solid var(--divider-color, rgba(0, 0, 0, 0.08));
          ${actionable ? 'cursor: pointer;' : ''}
        }
        
        .machine {
          display: flex;
          flex-direction: column;
          padding: 16px;
        }
        
        header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
          gap: 12px;
        }
        
        .title-section {
          display: flex;
          align-items: center;
          gap: 12px;
          flex: 1;
        }
        
        .icon {
          font-size: 32px;
          width: 48px;
          height: 48px;
          display: flex;
          align-items: center;
          justify-content: center;
          border-radius: 50%;
          background: rgba(var(--mush-rgb), 0.15);
        }

        .icon ha-icon {
          --mdc-icon-size: 28px;
          width: 28px;
          height: 28px;
          display: inline-block;
        }
        
        .title {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        
        .title-text {
          font-size: 16px;
          font-weight: 600;
          color: var(--primary-text-color);
        }
        
        .status {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 12px;
          border-radius: 8px;
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          white-space: nowrap;
        }
        
        .status.on {
          background: rgba(76, 175, 80, 0.15);
          color: var(--success-color, #4caf50);
        }
        
        .status.off {
          background: rgba(158, 158, 158, 0.15);
          color: var(--secondary-text-color);
        }
        
        .status-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          display: inline-block;
          background: currentColor;
        }
        
        .status.on .status-dot {
          animation: pulse 2s ease-in-out infinite;
        }
        
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.6; }
        }
        
        .state {
          display: flex;
          gap: 12px;
          padding: 12px;
          background: var(--secondary-background-color, rgba(0, 0, 0, 0.02));
          border-radius: 8px;
          margin-bottom: 12px;
        }
        
        .state-icon {
          font-size: 24px;
          width: 32px;
          display: flex;
          align-items: center;
          justify-content: center;
          flex-shrink: 0;
        }
        
        .machine.running .state-icon {
          animation: bounce 1s ease-in-out infinite;
        }
        
        @keyframes bounce {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.1); }
        }
        
        .state-text {
          display: flex;
          flex-direction: column;
          justify-content: center;
          gap: 4px;
        }
        
        .state-text b {
          color: var(--primary-text-color);
          font-size: 15px;
          font-weight: 600;
        }
        
        .state-text span {
          color: var(--secondary-text-color);
          font-size: 13px;
        }
        
        .consumption {
          padding: 12px;
          background: var(--secondary-background-color, rgba(0, 0, 0, 0.02));
          border-radius: 8px;
          margin-bottom: 12px;
        }
        
        .label {
          display: block;
          color: var(--secondary-text-color);
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
        }
        
        .energy {
          font-size: 20px;
          font-weight: 600;
          color: var(--primary-text-color);
          margin-bottom: 4px;
        }
        
        .energy b {
          color: var(--success-color, #4caf50);
        }
        
        .consumption small {
          color: var(--secondary-text-color);
          font-size: 12px;
        }
        
        .stats {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 12px;
        }
        
        .stat-item {
          padding: 12px;
          background: var(--secondary-background-color, rgba(0, 0, 0, 0.02));
          border-radius: 8px;
          text-align: center;
        }
        
        .stat-item span {
          display: block;
          color: var(--secondary-text-color);
          font-size: 11px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.5px;
          margin-bottom: 6px;
        }
        
        .stat-item b {
          display: block;
          font-size: 16px;
          color: var(--primary-text-color);
          margin-bottom: 4px;
        }
        
        .stat-item small {
          display: block;
          color: var(--secondary-text-color);
          font-size: 12px;
        }
      </style>
      <div class="card">
        <div class="machine ${running ? "running" : ""}">
          <header>
            <div class="title-section">
              <div class="icon">${iconMarkup}</div>
              <div class="title">
                <div class="title-text">${c.name}</div>
              </div>
            </div>
            <div class="status ${running ? "on" : "off"}">
              <span class="status-dot"></span>
              ${status}
            </div>
          </header>
          
          <div class="state">
            <div class="state-icon">${running ? "▶" : "■"}</div>
            <div class="state-text">
              <b>${running ? "Machine en cours" : "Machine à l'arrêt"}</b>
              <span data-running-duration>${primary}</span>
            </div>
          </div>
          
          ${consumptionDisplay}
          
          <div class="stats">
            <div class="stat-item">
              <span>Cette semaine</span>
              <b>${data?.cyclesWeek || 0} cycle${(data?.cyclesWeek || 0) > 1 ? "s" : ""}</b>
              <small>${this._fmtEuro(data?.costWeek || 0)}</small>
            </div>
            <div class="stat-item">
              <span>Ce mois</span>
              <b>${data?.cyclesMonth || 0} cycle${(data?.cyclesMonth || 0) > 1 ? "s" : ""}</b>
              <small>${this._fmtEuro(data?.costMonth || 0)}</small>
            </div>
          </div>
        </div>
      </div>`;

    const cardEl = this.shadowRoot.querySelector('.card');
    if (cardEl) {
      // attach click handler for tap_action
      cardEl.onclick = () => this._handleAction(this._config.tap_action || {});
    }
  }
}

customElements.define("laundry-card", LaundryCard);

/* Configuration Editor */
class LaundryCardEditor extends HTMLElement {
  constructor() {
    super();
    this._config = {};
    this._hass = null;
  }

  setConfig(config) {
    this._config = JSON.parse(JSON.stringify(config || {}));
    this._config.machine_type ??= "laundry";
    this._config.name ??= this._config.machine_type === "dryer" ? "Sèche-linge" : "Lave-linge";
    this._config.price_per_kwh ??= 0.25;
    this._config.detection ??= {};
    this._config.detection.start_power ??= 10;
    this._config.detection.stop_power ??= 5;
    this._config.detection.stop_delay ??= 180;
    this._config.detection.min_cycle_duration ??= 60;
    this._config.power ??= "";
    this._config.energy ??= "";
    this._config.current ??= "";
    this._config.refresh_interval ??= 60000;
    this._config.icon ??= "mdi:washing-machine";
    this._config.tap_action ??= { action: 'more-info' };
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    this._render();
  }

  _fire(config) {
    this._config = config;
    this.dispatchEvent(
      new CustomEvent("config-changed", {
        detail: { config },
        bubbles: true,
        composed: true
      })
    );
  }

  _createInput(label, value, path, type = "text", step = "") {
    const el = document.createElement("ha-textfield");
    el.label = label;
    el.value = value ?? "";
    el.type = type;
    if (step) el.step = step;
    el.addEventListener("change", (e) => {
      const c = JSON.parse(JSON.stringify(this._config));
      const parts = path.split(".");
      let o = c;
      for (let i = 0; i < parts.length - 1; i++) {
        o = o[parts[i]] ||= {};
      }
      const raw = e.target.value;
      o[parts.at(-1)] = type === "number" ? Number(raw) : raw;
      this._fire(c);
    });
    return el;
  }

  _createEntityPicker(label, value, path, domainFilter) {
    const sel = document.createElement("ha-entity-picker");
    sel.label = label;
    sel.hass = this._hass;
    sel.value = value || "";
    sel.includeDomains = domainFilter ? [domainFilter] : undefined;
    sel.allowCustomEntity = true;
    sel.addEventListener("value-changed", (e) => {
      const c = JSON.parse(JSON.stringify(this._config));
      const parts = path.split(".");
      let o = c;
      for (let i = 0; i < parts.length - 1; i++) {
        o = o[parts[i]] ||= {};
      }
      o[parts.at(-1)] = e.detail.value;
      this._fire(c);
    });
    return sel;
  }

  _createSection(title, content) {
    const section = document.createElement("div");
    section.className = "section";
    const h = document.createElement("h3");
    h.textContent = title;
    section.appendChild(h);
    if (Array.isArray(content)) {
      content.forEach((el) => section.appendChild(el));
    } else {
      section.appendChild(content);
    }
    return section;
  }

  _render() {
    if (!this._hass) return;

    this.innerHTML = "";

    const style = document.createElement("style");
    style.textContent = `
      :host {
        display: block;
        padding: 0;
        background: var(--lovelace-background, var(--primary-background-color));
      }

      .editor-container {
        max-width: 600px;
        margin: 0;
        background: var(--card-background-color, #fff);
        border-radius: 8px;
        overflow: hidden;
      }

      .editor-header {
        padding: 16px;
        border-bottom: 1px solid var(--divider-color);
        background: linear-gradient(135deg, var(--primary-color, #1976d2) 0%, var(--accent-color, #00bcd4) 100%);
        color: #fff;
      }

      .editor-header h2 {
        margin: 0;
        font-size: 18px;
        font-weight: 600;
      }

      .editor-content {
        padding: 16px;
      }

      .section {
        margin-bottom: 24px;
        padding-bottom: 16px;
        border-bottom: 1px solid var(--divider-color);
      }

      .section:last-child {
        border-bottom: none;
        margin-bottom: 0;
        padding-bottom: 0;
      }

      h3 {
        margin: 0 0 12px;
        font-size: 14px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.5px;
        color: var(--primary-text-color);
      }

      .hint {
        color: var(--secondary-text-color);
        font-size: 12px;
        line-height: 1.5;
        margin: 8px 0 0;
      }

      ha-textfield,
      ha-entity-picker,
      ha-select {
        display: block;
        margin: 12px 0 0;
        width: 100%;
      }

      ha-textfield:first-child,
      ha-entity-picker:first-child,
      ha-select:first-child {
        margin-top: 0;
      }

      .grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 12px;
      }

      .grid > * {
        margin: 0 !important;
      }

      .grid.full > * {
        grid-column: 1 / -1;
      }

      @media (max-width: 600px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }

      .info-box {
        background: var(--secondary-background-color, #f5f5f5);
        border-left: 4px solid var(--primary-color, #1976d2);
        padding: 12px;
        border-radius: 4px;
        margin: 12px 0;
      }

      .info-box p {
        margin: 0;
        font-size: 12px;
        line-height: 1.5;
        color: var(--secondary-text-color);
      }
    `;
    this.appendChild(style);

    const container = document.createElement("div");
    container.className = "editor-container";

    const header = document.createElement("div");
    header.className = "editor-header";
    const headerTitle = document.createElement("h2");
    headerTitle.textContent = "⚙️ Configuration Laundry Card";
    header.appendChild(headerTitle);
    container.appendChild(header);

    const content = document.createElement("div");
    content.className = "editor-content";

    // Machine Type Section
    const machineSelect = document.createElement("ha-select");
    machineSelect.label = "Type de machine";
    machineSelect.value = this._config.machine_type || "laundry";
    machineSelect.innerHTML = `
      <mwc-list-item value="laundry">🧺 Lave-linge</mwc-list-item>
      <mwc-list-item value="dryer">🔥 Sèche-linge</mwc-list-item>
    `;
    machineSelect.addEventListener("change", (e) => {
      const c = JSON.parse(JSON.stringify(this._config));
      c.machine_type = e.target.value;
      c.name =
        e.target.value === "dryer" ? "Sèche-linge" : "Lave-linge";
      this._fire(c);
    });

    const nameInput = this._createInput(
      "Nom de la machine",
      this._config.name,
      "name"
    );

    content.appendChild(
      this._createSection("Type de machine", [machineSelect, nameInput])
    );

    // Entity Selection Section
    content.appendChild(
      this._createSection("Capteurs (Entités)", [
        this._createEntityPicker(
          "⚡ Puissance (W) — détection des cycles",
          this._config.power,
          "power",
          "sensor"
        ),
        this._createEntityPicker(
          "📊 Énergie (kWh ou Wh) — consommation",
          this._config.energy,
          "energy",
          "sensor"
        ),
        this._createEntityPicker(
          "🔌 Courant (A) — optionnel",
          this._config.current,
          "current",
          "sensor"
        ),
      ])
    );

    // Detection Parameters Section
    const detectionGrid = document.createElement("div");
    detectionGrid.className = "grid";
    detectionGrid.appendChild(
      this._createInput(
        "Seuil de démarrage (W)",
        this._config.detection.start_power,
        "detection.start_power",
        "number",
        "1"
      )
    );
    detectionGrid.appendChild(
      this._createInput(
        "Seuil d'arrêt (W)",
        this._config.detection.stop_power,
        "detection.stop_power",
        "number",
        "1"
      )
    );
    detectionGrid.appendChild(
      this._createInput(
        "Délai avant arrêt (s)",
        this._config.detection.stop_delay,
        "detection.stop_delay",
        "number",
        "1"
      )
    );
    detectionGrid.appendChild(
      this._createInput(
        "Durée min. cycle (s)",
        this._config.detection.min_cycle_duration,
        "detection.min_cycle_duration",
        "number",
        "1"
      )
    );

    const detectionHint = document.createElement("div");
    detectionHint.className = "hint";
    detectionHint.innerHTML = `
      <strong>Paramètres de détection :</strong><br>
      • <strong>Seuil démarrage</strong> : puissance pour détecter le début (ex: 10 W)<br>
      • <strong>Seuil arrêt</strong> : puissance pour confirmer la fin (ex: 5 W)<br>
      • <strong>Délai arrêt</strong> : temps de confirmation avant arrêt (ex: 180 s)<br>
      • <strong>Durée min</strong> : durée minimale d'un cycle valide (ex: 60 s)
    `;

    const detectionSection = document.createElement("div");
    detectionSection.className = "section";
    const detectionTitle = document.createElement("h3");
    detectionTitle.textContent = "Détection des cycles";
    detectionSection.appendChild(detectionTitle);
    detectionSection.appendChild(detectionGrid);
    detectionSection.appendChild(detectionHint);
    content.appendChild(detectionSection);

    // Pricing Section
    const pricingInput = this._createInput(
      "Prix du kWh (€)",
      this._config.price_per_kwh,
      "price_per_kwh",
      "number",
      "0.001"
    );
    const pricingHint = document.createElement("div");
    pricingHint.className = "hint";
    pricingHint.textContent =
      "Utilisé pour calculer les coûts hebdomadaires et mensuels";
    content.appendChild(
      this._createSection("Tarification", [pricingInput, pricingHint])
    );

    // Refresh Interval Section
    const refreshInput = this._createInput(
      "Intervalle de rafraîchissement (ms)",
      this._config.refresh_interval || 60000,
      "refresh_interval",
      "number",
      "5000"
    );
    const refreshHint = document.createElement("div");
    refreshHint.className = "hint";
    refreshHint.textContent =
      "Intervalle de mise à jour des données (minimum 15000 ms)";
    content.appendChild(
      this._createSection("Rafraîchissement", [refreshInput, refreshHint])
    );

    // Icon and Tap Action Section
    // Use ha-icon-picker when available, fallback to text input
    let iconInput;
    if (customElements.get('ha-icon-picker')) {
      iconInput = document.createElement('ha-icon-picker');
      iconInput.hass = this._hass;
      iconInput.value = this._config.icon || '';
      iconInput.addEventListener('value-changed', (e) => {
        const c = JSON.parse(JSON.stringify(this._config));
        c.icon = e.detail.value;
        this._fire(c);
      });
    } else {
      iconInput = this._createInput(
        "Icône / logo (mdi:nom_de_l_icone ou emoji)",
        this._config.icon,
        "icon"
      );
    }

    const actionSelect = document.createElement("ha-select");
    actionSelect.label = "Action au clic";
    actionSelect.value = (this._config.tap_action && this._config.tap_action.action) || 'none';
    actionSelect.innerHTML = `
      <mwc-list-item value="none">Aucune</mwc-list-item>
      <mwc-list-item value="more-info">Plus d'info (more-info)</mwc-list-item>
      <mwc-list-item value="navigate">Navigation (navigate)</mwc-list-item>
      <mwc-list-item value="url">Ouvrir URL (url)</mwc-list-item>
      <mwc-list-item value="toggle">Basculer entité (toggle)</mwc-list-item>
      <mwc-list-item value="call-service">Appeler service (call-service)</mwc-list-item>
    `;
    actionSelect.addEventListener('change', (e) => {
      const c = JSON.parse(JSON.stringify(this._config));
      c.tap_action = c.tap_action || {};
      c.tap_action.action = e.target.value;
      this._fire(c);
    });

    const actionEntityPicker = this._createEntityPicker(
      "Entité cible (pour more-info / toggle)",
      this._config.tap_action?.entity || '',
      'tap_action.entity',
      ''
    );

    const actionUrl = this._createInput(
      "URL (pour action url)",
      this._config.tap_action?.url || '',
      'tap_action.url'
    );

    const actionNav = this._createInput(
      "Chemin de navigation (pour navigate)",
      this._config.tap_action?.navigation_path || this._config.tap_action?.navigation || '',
      'tap_action.navigation_path'
    );

    const actionServiceDomain = this._createInput(
      "Service (format domain.service, ex: light.turn_on)",
      this._config.tap_action?.service || '',
      'tap_action.service'
    );

    const actionServiceData = this._createInput(
      "Données du service (JSON)",
      typeof this._config.tap_action?.service_data === 'string' ? this._config.tap_action.service_data : JSON.stringify(this._config.tap_action?.service_data || {}),
      'tap_action.service_data'
    );

    const actionSection = document.createElement('div');
    actionSection.className = 'section';
    const actionTitle = document.createElement('h3');
    actionTitle.textContent = 'Action au clic';
    actionSection.appendChild(actionTitle);
    actionSection.appendChild(iconInput);
    actionSection.appendChild(actionSelect);
    actionSection.appendChild(actionEntityPicker);
    actionSection.appendChild(actionUrl);
    actionSection.appendChild(actionNav);
    actionSection.appendChild(actionServiceDomain);
    actionSection.appendChild(actionServiceData);

    const actionHint = document.createElement('div');
    actionHint.className = 'hint';
    actionHint.innerHTML = `
      Choisissez l'action exécutée lors du clic sur la carte. Pour appeler un service, entrez le service sous la forme <code>domain.service</code> et les données en JSON.
    `;
    actionSection.appendChild(actionHint);

    content.appendChild(actionSection);

    container.appendChild(content);
    this.appendChild(container);
  }
}

customElements.define("laundry-card-editor", LaundryCardEditor);

// Compatibility layer for existing configurations
const old = customElements.get("laundry-card");
if (old && !old.prototype.getConfigElement) {
  old.prototype.getConfigElement = function () {
    const editor = document.createElement("laundry-card-editor");
    editor.hass = this._hass;
    editor.setConfig(this._config);
    return editor;
  };
  old.prototype.getStubConfig = LaundryCard.getStubConfig;
}
