class LaundryEnergyCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._config = {};
    this._hass = null;
    this._data = {};
  }

  setConfig(config) {
    if (!config.laundry && !config.dryer) {
      throw new Error("Configure au moins une machine.");
    }

    this._config = {
      refresh_interval: 60000,

      detection: {
        start_power: 10,
        stop_power: 5,
        stop_delay: 180,
        min_cycle_duration: 60,
      },

      price_per_kwh: 0.25,

      laundry: {
        name: "Lave-linge",
        power: "",
        energy: "",
        current: "",
      },

      dryer: {
        name: "Sèche-linge",
        power: "",
        energy: "",
        current: "",
      },

      ...config,

      detection: {
        start_power: 10,
        stop_power: 5,
        stop_delay: 180,
        min_cycle_duration: 60,
        ...(config.detection || {}),
      },

      laundry: {
        name: "Lave-linge",
        power: "",
        energy: "",
        current: "",
        ...(config.laundry || {}),
      },

      dryer: {
        name: "Sèche-linge",
        power: "",
        energy: "",
        current: "",
        ...(config.dryer || {}),
      },
    };

    this._render();
  }

  set hass(hass) {
    this._hass = hass;

    if (!this._initialized) {
      this._initialized = true;
      this._update();
      return;
    }

    this._updateCurrentValues();
  }

  connectedCallback() {
    if (this._config.refresh_interval) {
      this._timer = setInterval(
        () => this._update(),
        this._config.refresh_interval
      );
    }
  }

  disconnectedCallback() {
    if (this._timer) {
      clearInterval(this._timer);
    }
  }

  async _update() {
    if (!this._hass) return;

    const machines = [];

    if (this._config.laundry.power) {
      machines.push(["laundry", this._config.laundry]);
    }

    if (this._config.dryer.power) {
      machines.push(["dryer", this._config.dryer]);
    }

    for (const [key, machine] of machines) {
      this._data[key] = await this._analyseMachine(machine);
    }

    this._render();
  }

  async _getHistory(entityId, start, end) {
    if (!entityId || !this._hass) return [];

    try {
      const result = await this._hass.callWS({
        type: "history/history_during_period",
        start_time: start.toISOString(),
        end_time: end.toISOString(),
        entity_ids: [entityId],
        minimal_response: false,
        significant_changes_only: false,
      });

      return result[entityId] || [];
    } catch (err) {
      console.error("Laundry Energy Card:", err);
      return [];
    }
  }

  async _analyseMachine(machine) {
    const now = new Date();

    // On récupère suffisamment d'historique pour :
    // - connaître le cycle actuel
    // - calculer semaine
    // - calculer mois
    // - déterminer les cycles terminés
    const start = new Date(now);
    start.setDate(1);
    start.setHours(0, 0, 0, 0);

    const powerHistory = await this._getHistory(
      machine.power,
      start,
      now
    );

    const energyHistory = await this._getHistory(
      machine.energy,
      start,
      now
    );

    const cycles = this._detectCycles(powerHistory);

    const currentCycle = cycles.find(c => !c.end);

    const energyUnit = this._getEnergyUnit(machine.energy);

    const currentEnergy = this._getCurrentCycleEnergy(
      currentCycle,
      energyHistory,
      energyUnit
    );

    const weekStart = this._startOfWeek(now);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const weekCycles = cycles.filter(c =>
      c.start >= weekStart
    );

    const monthCycles = cycles.filter(c =>
      c.start >= monthStart
    );

    const weekEnergy = weekCycles.reduce(
      (sum, cycle) => sum + this._cycleEnergy(
        cycle,
        energyHistory,
        energyUnit
      ),
      0
    );

    const monthEnergy = monthCycles.reduce(
      (sum, cycle) => sum + this._cycleEnergy(
        cycle,
        energyHistory,
        energyUnit
      ),
      0
    );

    const powerState =
      this._hass.states[machine.power];

    const currentPower = powerState
      ? Number(powerState.state)
      : 0;

    return {
      running: !!currentCycle,
      currentPower,
      currentEnergy,
      cyclesWeek: weekCycles.length,
      cyclesMonth: monthCycles.length,
      energyWeek: weekEnergy,
      energyMonth: monthEnergy,
      costWeek:
        weekEnergy * Number(this._config.price_per_kwh || 0),
      costMonth:
        monthEnergy * Number(this._config.price_per_kwh || 0),
      currentCycle,
      lastCycle: cycles.length
        ? cycles[cycles.length - 1]
        : null,
    };
  }

  _detectCycles(history) {
    if (!history || history.length === 0) {
      return [];
    }

    const startThreshold =
      Number(this._config.detection.start_power);

    const stopThreshold =
      Number(this._config.detection.stop_power);

    const stopDelay =
      Number(this._config.detection.stop_delay) * 1000;

    const minDuration =
      Number(this._config.detection.min_cycle_duration) * 1000;

    const points = history
      .map(item => ({
        time: new Date(item.last_changed),
        power: Number(item.state),
      }))
      .filter(item =>
        Number.isFinite(item.power)
      )
      .sort((a, b) =>
        a.time - b.time
      );

    const cycles = [];

    let running = false;
    let start = null;
    let stopCandidate = null;

    for (const point of points) {
      if (!running) {
        if (point.power >= startThreshold) {
          running = true;
          start = point.time;
          stopCandidate = null;
        }

        continue;
      }

      if (point.power <= stopThreshold) {
        if (!stopCandidate) {
          stopCandidate = point.time;
        }

        if (
          point.time - stopCandidate >= stopDelay
        ) {
          const end = stopCandidate;

          if (end - start >= minDuration) {
            cycles.push({
              start,
              end,
            });
          }

          running = false;
          start = null;
          stopCandidate = null;
        }
      } else {
        stopCandidate = null;
      }
    }

    // Cycle toujours en cours
    if (running && start) {
      cycles.push({
        start,
        end: null,
      });
    }

    return cycles;
  }

  _getCurrentCycleEnergy(
    cycle,
    history,
    unit
  ) {
    if (!cycle || !history.length) {
      return 0;
    }

    const startValue =
      this._energyAt(history, cycle.start);

    const nowValue =
      this._energyAt(history, new Date());

    if (
      startValue === null ||
      nowValue === null
    ) {
      return 0;
    }

    let value = nowValue - startValue;

    if (unit === "Wh") {
      value /= 1000;
    }

    return Math.max(0, value);
  }

  _cycleEnergy(
    cycle,
    history,
    unit
  ) {
    if (!cycle || !history.length) {
      return 0;
    }

    const startValue =
      this._energyAt(history, cycle.start);

    const endValue =
      this._energyAt(
        history,
        cycle.end || new Date()
      );

    if (
      startValue === null ||
      endValue === null
    ) {
      return 0;
    }

    let value = endValue - startValue;

    if (unit === "Wh") {
      value /= 1000;
    }

    return Math.max(0, value);
  }

  _energyAt(history, date) {
    let closest = null;

    for (const item of history) {
      const time = new Date(item.last_changed);

      if (time <= date) {
        closest = item;
      } else {
        break;
      }
    }

    if (!closest) return null;

    const value = Number(closest.state);

    return Number.isFinite(value)
      ? value
      : null;
  }

  _getEnergyUnit(entityId) {
    const entity = this._hass.states[entityId];

    if (!entity) return "kWh";

    const unit =
      entity.attributes.unit_of_measurement;

    return unit === "Wh" ? "Wh" : "kWh";
  }

  _startOfWeek(date) {
    const result = new Date(date);
    const day = result.getDay();

    const diff = day === 0 ? -6 : 1 - day;

    result.setDate(result.getDate() + diff);
    result.setHours(0, 0, 0, 0);

    return result;
  }

  _formatDuration(start) {
    const seconds =
      Math.floor(
        (Date.now() - start.getTime()) / 1000
      );

    const hours =
      Math.floor(seconds / 3600);

    const minutes =
      Math.floor((seconds % 3600) / 60);

    if (hours > 0) {
      return `${hours} h ${minutes} min`;
    }

    return `${minutes} min`;
  }

  _formatEnergy(value) {
    return `${value.toFixed(2)} kWh`;
  }

  _formatCost(value) {
    return `${value.toFixed(2)} €`;
  }

  _formatLastCycle(cycle) {
    if (!cycle) {
      return "Aucun cycle enregistré";
    }

    const date =
      cycle.end || cycle.start;

    const diff =
      Date.now() - date.getTime();

    const hours =
      Math.floor(diff / 3600000);

    if (hours < 1) {
      return "Il y a moins d'une heure";
    }

    if (hours < 24) {
      return `Il y a ${hours} h`;
    }

    const days =
      Math.floor(hours / 24);

    return `Il y a ${days} jour${days > 1 ? "s" : ""}`;
  }

  _machineCard(machine, data, icon) {
    if (!data) return "";

    const running = data.running;

    return `
      <section class="machine ${running ? "running" : ""}">

        <header>
          <div class="title">
            <span class="icon">${icon}</span>
            <span>${machine.name}</span>
          </div>

          <div class="status ${running ? "on" : "off"}">
            ${running ? "● EN COURS" : "● À L'ARRÊT"}
          </div>
        </header>

        <div class="main-status">

          <div class="status-icon">
            ${running ? "▶" : "■"}
          </div>

          <div>
            ${
              running
                ? `
                  <strong>Machine en cours</strong>
                  <span>
                    Depuis ${this._formatDuration(
                      data.currentCycle.start
                    )}
                  </span>
                `
                : `
                  <strong>Machine à l'arrêt</strong>
                  <span>
                    ${
                      data.lastCycle
                        ? `Dernier cycle : ${this._formatLastCycle(data.lastCycle)}`
                        : "Aucun cycle enregistré"
                    }
                  </span>
                `
            }
          </div>

        </div>

        <div class="consumption">

          <div>
            <span class="label">CONSOMMATION</span>

            <div class="energy">
              ⚡
              <strong>
                ${
                  running
                    ? this._formatEnergy(data.currentEnergy)
                    : "0,00 kWh"
                }
              </strong>
            </div>

            ${
              running
                ? `<small>Cycle en cours</small>`
                : `<small>Énergie du dernier cycle non affichée</small>`
            }
          </div>

        </div>

        <div class="statistics">

          <div class="stat">
            <span>Cette semaine</span>
            <strong>
              ${data.cyclesWeek}
              cycle${data.cyclesWeek > 1 ? "s" : ""}
            </strong>
            <small>
              ${this._formatCost(data.costWeek)}
            </small>
          </div>

          <div class="separator"></div>

          <div class="stat">
            <span>Ce mois</span>
            <strong>
              ${data.cyclesMonth}
              cycle${data.cyclesMonth > 1 ? "s" : ""}
            </strong>
            <small>
              ${this._formatCost(data.costMonth)}
            </small>
          </div>

        </div>

      </section>
    `;
  }

  _updateCurrentValues() {
    if (!this._hass) return;

    this._render();
  }

  _render() {
    const laundry =
      this._data.laundry;

    const dryer =
      this._data.dryer;

    this.shadowRoot.innerHTML = `
      <style>

        :host {
          display: block;
        }

        .card {
          background:
            var(--ha-card-background,
            var(--card-background-color, white));

          border-radius: 16px;
          padding: 18px;
          box-sizing: border-box;
        }

        .machines {
          display: grid;
          grid-template-columns:
            repeat(auto-fit, minmax(320px, 1fr));
          gap: 16px;
        }

        .machine {
          border: 1px solid
            var(--divider-color);
          border-radius: 14px;
          padding: 16px;
        }

        header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        .title {
          display: flex;
          align-items: center;
          gap: 10px;

          font-size: 20px;
          font-weight: 600;
        }

        .icon {
          font-size: 25px;
        }

        .status {
          font-size: 11px;
          font-weight: 700;
        }

        .status.on {
          color:
            var(--success-color, #43a047);
        }

        .status.off {
          color:
            var(--secondary-text-color);
        }

        .main-status {
          display: flex;
          align-items: center;
          gap: 14px;

          background:
            var(--secondary-background-color);

          border-radius: 12px;
          padding: 14px;
          margin-bottom: 12px;
        }

        .status-icon {
          width: 46px;
          height: 46px;

          border-radius: 50%;

          display: flex;
          align-items: center;
          justify-content: center;

          font-size: 18px;

          background:
            var(--card-background-color);
        }

        .main-status strong,
        .main-status span {
          display: block;
        }

        .main-status span {
          color:
            var(--secondary-text-color);
          margin-top: 4px;
          font-size: 13px;
        }

        .consumption {
          border: 1px solid
            var(--divider-color);

          border-radius: 12px;
          padding: 14px;
          margin-bottom: 12px;
        }

        .label {
          display: block;
          font-size: 11px;
          font-weight: 700;
          letter-spacing: .08em;
          margin-bottom: 8px;
        }

        .energy {
          display: flex;
          align-items: center;
          gap: 10px;

          font-size: 28px;
        }

        .energy strong {
          font-size: 27px;
        }

        .consumption small {
          color:
            var(--secondary-text-color);
          display: block;
          margin-top: 4px;
        }

        .statistics {
          display: grid;
          grid-template-columns: 1fr auto 1fr;
          align-items: center;

          border: 1px solid
            var(--divider-color);

          border-radius: 12px;
          padding: 14px;
        }

        .stat {
          text-align: center;
        }

        .stat span {
          display: block;
          font-size: 12px;
          color:
            var(--secondary-text-color);
        }

        .stat strong {
          display: block;
          font-size: 18px;
          margin-top: 5px;
        }

        .stat small {
          display: block;
          margin-top: 3px;
          font-size: 15px;
        }

        .separator {
          width: 1px;
          height: 50px;
          background:
            var(--divider-color);
        }

        @media (max-width: 600px) {

          .machines {
            grid-template-columns: 1fr;
          }

        }

      </style>

      <ha-card class="card">

        <div class="machines">

          ${
            laundry
              ? this._machineCard(
                  this._config.laundry,
                  laundry,
                  "🧺"
                )
              : ""
          }

          ${
            dryer
              ? this._machineCard(
                  this._config.dryer,
                  dryer,
                  "🔥"
                )
              : ""
          }

        </div>

      </ha-card>
    `;
  }
}

customElements.define(
  "laundry-energy-card",
  LaundryEnergyCard
);
