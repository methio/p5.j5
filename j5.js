/*!
 * p5.j5 v2.0.0
 * ---------------------------------------------------------------------------
 * Réécriture de p5.j5 : API façon Johnny-Five, protocole Firmata (StandardFirmataPlus)
 * parlé directement via l'API Web Serial du navigateur (navigator.serial).
 *
 *  - 100 % côté client : aucun serveur local, aucune dépendance (hors p5.js v2, optionnel)
 *  - Fichier unique, à inclure avec <script src="p5.j5.js"></script> APRÈS p5.js
 *  - Expose `five` (et `p5j5`) en global ; module.exports si CommonJS
 *
 * Navigateurs : Chrome / Edge / Opera (desktop), en HTTPS ou sur http://localhost.
 * Carte : sketch StandardFirmataPlus, 57600 bauds (valeur par défaut du sketch).
 *
 * Règle d'or WebSerial : `board.connect()` doit être appelé depuis un geste utilisateur
 * (clic). Les composants peuvent être créés AVANT la connexion : ils s'initialisent
 * tout seuls dès que la carte est prête.
 * ---------------------------------------------------------------------------
 */
(function (global) {
  "use strict";

  /* =========================================================================
   * 1. Constantes du protocole Firmata
   * ====================================================================== */
  const MODES = Object.freeze({ INPUT: 0, OUTPUT: 1, ANALOG: 2, PWM: 3, SERVO: 4, I2C: 6, PULLUP: 11 });

  const MSG = {
    DIGITAL: 0x90, // 0x90 | port
    ANALOG: 0xe0, // 0xE0 | canal
    REPORT_ANALOG: 0xc0, // 0xC0 | canal
    REPORT_DIGITAL: 0xd0, // 0xD0 | port
    SET_PIN_MODE: 0xf4,
    START_SYSEX: 0xf0,
    END_SYSEX: 0xf7,
    REPORT_VERSION: 0xf9,
  };

  const SYSEX = {
    ANALOG_MAPPING_QUERY: 0x69,
    ANALOG_MAPPING_RESPONSE: 0x6a,
    CAPABILITY_QUERY: 0x6b,
    CAPABILITY_RESPONSE: 0x6c,
    EXTENDED_ANALOG: 0x6f,
    SERVO_CONFIG: 0x70,
    STRING_DATA: 0x71,
    I2C_REQUEST: 0x76,
    I2C_REPLY: 0x77,
    I2C_CONFIG: 0x78,
    REPORT_FIRMWARE: 0x79,
    SAMPLING_INTERVAL: 0x7a,
  };

  /* =========================================================================
   * 2. Utilitaires
   * ====================================================================== */
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const clamp255 = (v) => Math.round(clamp(Number(v) || 0, 0, 255));

  /** Décode une chaîne Firmata : un caractère = 2 octets de 7 bits (LSB, MSB). */
  function decodeString(bytes) {
    let s = "";
    for (let i = 0; i + 1 < bytes.length; i += 2) s += String.fromCharCode(bytes[i] | (bytes[i + 1] << 7));
    return s;
  }

  /** Mini EventEmitter (on / once / off / emit), compatible avec le style Johnny-Five. */
  class Emitter {
    constructor() {
      this._handlers = new Map();
    }
    on(event, fn) {
      if (!this._handlers.has(event)) this._handlers.set(event, []);
      this._handlers.get(event).push(fn);
      return this;
    }
    once(event, fn) {
      const wrapper = (...args) => {
        this.off(event, wrapper);
        fn.apply(this, args);
      };
      wrapper._original = fn;
      return this.on(event, wrapper);
    }
    off(event, fn) {
      const list = this._handlers.get(event);
      if (!list) return this;
      this._handlers.set(event, list.filter((h) => h !== fn && h._original !== fn));
      return this;
    }
    emit(event, ...args) {
      const list = this._handlers.get(event);
      if (!list || list.length === 0) {
        if (event === "error") console.error("[p5.j5]", ...args);
        return this;
      }
      for (const fn of [...list]) {
        try {
          fn.apply(this, args);
        } catch (err) {
          console.error("[p5.j5] erreur dans un gestionnaire d'événement « " + event + " » :", err);
        }
      }
      return this;
    }
  }

  /* =========================================================================
   * 3. Board : connexion Web Serial + analyseur de protocole Firmata
   * ====================================================================== */
  class Board extends Emitter {
    /**
     * @param {object} [options]
     * @param {number} [options.baudRate=57600]  Débit (StandardFirmataPlus : 57600)
     * @param {number} [options.timeout=10000]   Délai max. d'attente de Firmata (ms)
     * @param {Array}  [options.filters]         Filtres requestPort, ex. [{ usbVendorId: 0x2341 }]
     * @param {SerialPort} [options.port]        Port déjà autorisé (ex. via navigator.serial.getPorts())
     */
    constructor(options = {}) {
      super();
      this.options = { baudRate: 57600, timeout: 10000, ...options };
      this.port = null;
      this.isReady = false;
      this.firmware = null; // { name, major, minor }
      this.pins = []; // [{ modes: {mode: resolution}, mode, analogChannel, value }]

      this._reader = null;
      this._writer = null;
      this._readDone = null;
      this._writeChain = Promise.resolve();
      this._closing = false;
      this._sysex = null;
      this._msg = null;
      this._portState = new Array(16).fill(0); // état logique des ports de sortie
      this._reportedPorts = new Set();
      this._readyQueue = [];
      this._i2cConfigured = false;
      this._capsReady = false;
      this._mapReady = false;
      this._onSerialDisconnect = (ev) => {
        if (ev.target === this.port && !this._closing) this.disconnect();
      };

      Board.current = this; // les composants s'attachent par défaut à la dernière carte créée
    }

    static get isSupported() {
      return typeof navigator !== "undefined" && "serial" in navigator;
    }

    get MODES() {
      return MODES;
    }

    /* -------------------- Connexion -------------------- */

    /**
     * Ouvre le port série et attend que Firmata réponde.
     * ⚠ À appeler depuis un gestionnaire de clic (geste utilisateur requis par WebSerial).
     * @param {SerialPort} [port] Port déjà autorisé (sinon une boîte de dialogue s'ouvre)
     * @returns {Promise<Board>} résolue quand la carte est prête
     */
    async connect(port) {
      if (this.isReady) return this;
      const given = port || this.options.port;
      if (!given && !Board.isSupported) {
        throw new Error("Web Serial indisponible : utilisez Chrome, Edge ou Opera (HTTPS ou localhost).");
      }
      this._closing = false;

      // IMPORTANT : requestPort() est le premier `await`, pour conserver l'activation utilisateur.
      this.port =
        given || (await navigator.serial.requestPort(this.options.filters ? { filters: this.options.filters } : {}));

      await this.port.open({ baudRate: this.options.baudRate });
      this._writer = this.port.writable.getWriter();
      this._readDone = this._readLoop();
      if (typeof navigator !== "undefined" && navigator.serial) {
        navigator.serial.addEventListener("disconnect", this._onSerialDisconnect);
      }
      this.emit("connect");

      try {
        await this._handshake();
      } catch (err) {
        await this.disconnect();
        throw err;
      }

      this.isReady = true;
      for (const fn of this._readyQueue.splice(0)) {
        try {
          fn();
        } catch (err) {
          this.emit("error", err);
        }
      }
      this.emit("ready");
      return this;
    }

    /** Reconnexion silencieuse (sans clic) à un port déjà autorisé lors d'une visite précédente. */
    async autoConnect() {
      if (!Board.isSupported) return null;
      const ports = await navigator.serial.getPorts();
      if (ports.length === 0) return null;
      return this.connect(ports[0]);
    }

    /** Ferme proprement le port. */
    async disconnect() {
      if (!this.port) return;
      this._closing = true;
      this.isReady = false;
      if (typeof navigator !== "undefined" && navigator.serial) {
        navigator.serial.removeEventListener("disconnect", this._onSerialDisconnect);
      }
      try {
        await this._reader?.cancel();
      } catch (_) {}
      try {
        await this._readDone;
      } catch (_) {}
      try {
        this._writer?.releaseLock();
      } catch (_) {}
      try {
        await this.port.close();
      } catch (_) {}

      this.port = null;
      this._reader = null;
      this._writer = null;
      this._readDone = null;
      this.firmware = null;
      this.pins = [];
      this._sysex = null;
      this._msg = null;
      this._capsReady = this._mapReady = this._i2cConfigured = false;
      this._reportedPorts.clear();
      this._portState.fill(0);
      this.emit("close");
    }

    /** Exécute `fn` dès que la carte est prête (immédiatement si elle l'est déjà). */
    _whenReady(fn) {
      if (this.isReady) {
        try {
          fn();
        } catch (err) {
          this.emit("error", err);
        }
      } else {
        this._readyQueue.push(fn);
      }
    }

    /** Interroge la carte jusqu'à obtenir firmware + capacités + correspondance analogique. */
    async _handshake() {
      const start = Date.now();
      const timeoutMsg =
        "Aucune réponse Firmata. Vérifiez que StandardFirmataPlus est téléversé sur la carte, " +
        "que le débit est de " + this.options.baudRate + " bauds et que le port n'est pas utilisé ailleurs " +
        "(Moniteur série Arduino, autre onglet…).";

      // L'ouverture du port redémarre la plupart des cartes (≈ 2 s de bootloader) : on réessaie.
      while (!this.firmware) {
        if (Date.now() - start > this.options.timeout) throw new Error(timeoutMsg);
        this._write([MSG.START_SYSEX, SYSEX.REPORT_FIRMWARE, MSG.END_SYSEX]);
        await sleep(400);
      }

      let lastAsk = 0;
      const startCaps = Date.now();
      while (!(this._capsReady && this._mapReady)) {
        if (Date.now() - startCaps > 5000) throw new Error(timeoutMsg);
        if (Date.now() - lastAsk > 1000) {
          this._write([MSG.START_SYSEX, SYSEX.CAPABILITY_QUERY, MSG.END_SYSEX]);
          this._write([MSG.START_SYSEX, SYSEX.ANALOG_MAPPING_QUERY, MSG.END_SYSEX]);
          lastAsk = Date.now();
        }
        await sleep(30);
      }
    }

    /* -------------------- Lecture / écriture brute -------------------- */

    async _readLoop() {
      const reader = this.port.readable.getReader();
      this._reader = reader;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          if (value) for (const byte of value) this._onByte(byte);
        }
      } catch (err) {
        if (!this._closing) this.emit("error", err);
      } finally {
        try {
          reader.releaseLock();
        } catch (_) {}
        if (!this._closing) queueMicrotask(() => this.disconnect()); // débranchement inopiné
      }
    }

    /** Envoie des octets, en série (une file garantit l'ordre des écritures). */
    _write(bytes) {
      const data = Uint8Array.from(bytes);
      this._writeChain = this._writeChain
        .then(() => (this._writer ? this._writer.write(data) : undefined))
        .catch((err) => {
          if (!this._closing) this.emit("error", err);
        });
      return this._writeChain;
    }

    /* -------------------- Analyseur de protocole -------------------- */

    _onByte(b) {
      if (this._sysex) {
        if (b === MSG.END_SYSEX) {
          const data = this._sysex;
          this._sysex = null;
          this._onSysex(data);
        } else if (b < 0x80) {
          this._sysex.push(b);
        } else {
          this._sysex = null; // trame corrompue : on abandonne et on retraite l'octet
          this._onByte(b);
        }
        return;
      }

      if (b >= 0x80) {
        if (b === MSG.START_SYSEX) {
          this._sysex = [];
          this._msg = null;
        } else if (b === MSG.REPORT_VERSION) {
          this._msg = { cmd: b, channel: 0, data: [] };
        } else if ((b >= 0xe0 && b <= 0xef) || (b >= 0x90 && b <= 0x9f)) {
          this._msg = { cmd: b & 0xf0, channel: b & 0x0f, data: [] };
        } else {
          this._msg = null; // commande non gérée
        }
        return;
      }

      if (this._msg) {
        this._msg.data.push(b);
        if (this._msg.data.length === 2) {
          const { cmd, channel, data } = this._msg;
          this._msg = null;
          this._onMessage(cmd, channel, data[0] | (data[1] << 7));
        }
      }
    }

    _onMessage(cmd, channel, value) {
      if (cmd === MSG.ANALOG) {
        this.emit("analog-read-" + channel, value);
      } else if (cmd === MSG.DIGITAL) {
        for (let bit = 0; bit < 8; bit++) {
          const pin = channel * 8 + bit;
          const p = this.pins[pin];
          if (!p || (p.mode !== MODES.INPUT && p.mode !== MODES.PULLUP)) continue;
          const v = (value >> bit) & 1;
          p.value = v;
          this.emit("digital-read-" + pin, v);
        }
      } else if (cmd === MSG.REPORT_VERSION) {
        this.version = { major: value & 0x7f, minor: value >> 7 };
      }
    }

    _onSysex(d) {
      switch (d[0]) {
        case SYSEX.REPORT_FIRMWARE:
          this.firmware = { major: d[1], minor: d[2], name: decodeString(d.slice(3)) };
          break;

        case SYSEX.CAPABILITY_RESPONSE: {
          const pins = [];
          let cur = { modes: {} };
          for (let i = 1; i < d.length; ) {
            if (d[i] === 0x7f) {
              pins.push({ modes: cur.modes, mode: undefined, analogChannel: 127, value: 0 });
              cur = { modes: {} };
              i += 1;
            } else {
              cur.modes[d[i]] = d[i + 1]; // mode -> résolution (bits)
              i += 2;
            }
          }
          this.pins = pins;
          this._capsReady = true;
          break;
        }

        case SYSEX.ANALOG_MAPPING_RESPONSE:
          // Peut arriver avant les capacités sur certains firmwares : on garde la table brute.
          this._analogMap = d.slice(1);
          this._mapReady = true;
          break;

        case SYSEX.STRING_DATA:
          this.emit("string", decodeString(d.slice(1)));
          break;

        case SYSEX.I2C_REPLY:
          this.emit("i2c-reply", {
            address: d[1] | (d[2] << 7),
            register: d[3] | (d[4] << 7),
            bytes: Array.from({ length: Math.floor((d.length - 5) / 2) }, (_, i) => d[5 + 2 * i] | (d[6 + 2 * i] << 7)),
          });
          break;

        default:
          break;
      }

      // Fusion capacités + correspondance analogique (dans n'importe quel ordre).
      if (this._capsReady && this._analogMap) {
        this._analogMap.forEach((ch, pin) => {
          if (this.pins[pin]) this.pins[pin].analogChannel = ch;
        });
      }
    }

    /* -------------------- Résolution des broches -------------------- */

    /** Numéro de broche numérique : accepte 13, "13" ou "A0". */
    resolvePin(pin) {
      if (typeof pin === "string" && /^a\d+$/i.test(pin)) {
        const idx = this.pins.findIndex((p) => p.analogChannel === parseInt(pin.slice(1), 10));
        if (idx === -1) throw new Error("Broche analogique inconnue sur cette carte : " + pin);
        return idx;
      }
      const n = Number(pin);
      if (!Number.isInteger(n) || n < 0 || n >= this.pins.length) throw new Error("Broche invalide : " + pin);
      return n;
    }

    /** Canal analogique : accepte 0 ou "A0". */
    resolveChannel(pin) {
      const ch = typeof pin === "string" && /^a\d+$/i.test(pin) ? parseInt(pin.slice(1), 10) : Number(pin);
      if (!Number.isInteger(ch) || ch < 0) throw new Error("Canal analogique invalide : " + pin);
      return ch;
    }

    /** Numéro de broche numérique associé à un canal analogique. */
    analogPin(channel) {
      const idx = this.pins.findIndex((p) => p.analogChannel === channel);
      if (idx === -1) throw new Error("Cette carte n'a pas de canal analogique A" + channel);
      return idx;
    }

    supports(pin, mode) {
      return !!this.pins[pin] && this.pins[pin].modes[mode] !== undefined;
    }

    /* -------------------- Commandes Firmata -------------------- */

    pinMode(pin, mode) {
      this._write([MSG.SET_PIN_MODE, pin, mode]);
      if (this.pins[pin]) this.pins[pin].mode = mode;
      if (mode === MODES.INPUT || mode === MODES.PULLUP) {
        const port = pin >> 3;
        if (!this._reportedPorts.has(port)) {
          this._reportedPorts.add(port);
          this._write([MSG.REPORT_DIGITAL | port, 1]);
        }
      } else if (mode === MODES.ANALOG) {
        const ch = this.pins[pin] && this.pins[pin].analogChannel;
        if (ch !== undefined && ch !== 127) this._write([MSG.REPORT_ANALOG | ch, 1]);
      }
    }

    digitalWrite(pin, value) {
      const port = pin >> 3;
      const bit = pin & 7;
      if (value) this._portState[port] |= 1 << bit;
      else this._portState[port] &= ~(1 << bit);
      const mask = this._portState[port];
      this._write([MSG.DIGITAL | port, mask & 0x7f, (mask >> 7) & 0x01]);
      if (this.pins[pin]) this.pins[pin].value = value ? 1 : 0;
    }

    /** Écriture PWM (0-255) ou angle de servo. */
    analogWrite(pin, value) {
      const v = Math.max(0, Math.round(value));
      if (pin <= 15) {
        this._write([MSG.ANALOG | pin, v & 0x7f, (v >> 7) & 0x7f]);
      } else {
        this._write([MSG.START_SYSEX, SYSEX.EXTENDED_ANALOG, pin, v & 0x7f, (v >> 7) & 0x7f, (v >> 14) & 0x7f, MSG.END_SYSEX]);
      }
      if (this.pins[pin]) this.pins[pin].value = v;
    }

    servoWrite(pin, angle) {
      this.analogWrite(pin, angle);
    }

    servoConfig(pin, minPulse = 544, maxPulse = 2400) {
      this._write([
        MSG.START_SYSEX, SYSEX.SERVO_CONFIG, pin,
        minPulse & 0x7f, (minPulse >> 7) & 0x7f,
        maxPulse & 0x7f, (maxPulse >> 7) & 0x7f,
        MSG.END_SYSEX,
      ]);
    }

    /** Intervalle d'échantillonnage des entrées analogiques (ms, défaut Firmata : 19). */
    samplingInterval(ms) {
      this._write([MSG.START_SYSEX, SYSEX.SAMPLING_INTERVAL, ms & 0x7f, (ms >> 7) & 0x7f, MSG.END_SYSEX]);
    }

    i2cConfig(delayMicros = 0) {
      this._write([MSG.START_SYSEX, SYSEX.I2C_CONFIG, delayMicros & 0x7f, (delayMicros >> 7) & 0x7f, MSG.END_SYSEX]);
      this._i2cConfigured = true;
    }

    i2cWrite(address, bytes) {
      if (!this._i2cConfigured) this.i2cConfig();
      const out = [MSG.START_SYSEX, SYSEX.I2C_REQUEST, address & 0x7f, 0x00]; // mode écriture, adresse 7 bits
      for (const b of bytes) out.push(b & 0x7f, (b >> 7) & 0x7f);
      out.push(MSG.END_SYSEX);
      this._write(out);
    }
  }
  Board.current = null;

  /* =========================================================================
   * 4. Composant de base
   * ====================================================================== */

  /** Normalise `new X(13)` et `new X({ pin: 13, ... })` en objet d'options. */
  function singlePin(opts) {
    return opts !== null && typeof opts === "object" && !Array.isArray(opts) ? opts : { pin: opts };
  }

  class Component extends Emitter {
    constructor(options = {}) {
      super();
      this.board = (options && options.board) || Board.current;
      if (!this.board) throw new Error("Créez d'abord une carte : `const board = new five.Board()`.");
    }
    _whenReady(fn) {
      this.board._whenReady(fn);
    }
    /**
     * Émet l'événement puis appelle, s'il existe, le callback global idiomatique p5.js
     * défini par la classe (ex. `buttonPressed(btn)`), comme `mousePressed()` ou `keyPressed()`.
     */
    emit(event, ...args) {
      super.emit(event, ...args);
      const hookName = this.constructor.hooks && this.constructor.hooks[event];
      if (hookName && typeof global[hookName] === "function") {
        try {
          global[hookName](this, ...args);
        } catch (err) {
          console.error("[p5.j5] erreur dans " + hookName + "() :", err);
        }
      }
      return this;
    }
  }

  /* =========================================================================
   * 5. Button
   * ====================================================================== */
  class Button extends Component {
    static hooks = { press: "buttonPressed", release: "buttonReleased", hold: "buttonHeld" };

    /**
     * @param {number|string|object} opts  broche, ou { pin, isPullup, invert, holdtime }
     * Événements : "press"/"down", "release"/"up", "hold" ; propriété `isDown`.
     */
    constructor(opts) {
      const o = singlePin(opts);
      super(o);
      this._rawPin = o.pin;
      this.isPullup = !!o.isPullup; // true = INPUT_PULLUP (bouton entre la broche et GND)
      this.invert = !!o.invert;
      this.holdtime = o.holdtime ?? 500;
      this.isDown = false;
      this.value = 0;
      this._seen = false;
      this._holdTimer = null;
      this._whenReady(() => this._init());
    }
    _init() {
      const b = this.board;
      this.pin = b.resolvePin(this._rawPin);
      b.pinMode(this.pin, this.isPullup && b.supports(this.pin, MODES.PULLUP) ? MODES.PULLUP : MODES.INPUT);
      b.on("digital-read-" + this.pin, (v) => this._onValue(v));
    }
    _onValue(raw) {
      let down = this.isPullup ? raw === 0 : raw === 1;
      if (this.invert) down = !down;
      this.value = down ? 1 : 0;

      const first = !this._seen;
      this._seen = true;
      if (!first && down === this.isDown) return;
      this.isDown = down;
      if (first && !down) return; // premier échantillon « relâché » : rien à signaler

      clearInterval(this._holdTimer);
      if (down) {
        this.emit("down");
        this.emit("press");
        const t0 = performance.now();
        this._holdTimer = setInterval(() => this.emit("hold", Math.round(performance.now() - t0)), this.holdtime);
      } else {
        this.emit("up");
        this.emit("release");
      }
    }
  }

  /* =========================================================================
   * 6. Sensor / Light
   * ====================================================================== */
  class Sensor extends Component {
    static hooks = { change: "sensorChanged" };

    /**
     * @param {number|string|object} opts  "A0", ou { pin, type: "analog"|"digital", threshold, scale }
     * Propriétés : `raw` (0-1023), `value` (éventuellement mise à l'échelle).
     * Événements : "data" (à chaque mesure), "change" (variation ≥ threshold).
     */
    constructor(opts) {
      const o = singlePin(opts);
      super(o);
      this._rawPin = o.pin;
      this.type = o.type === "digital" ? "digital" : "analog";
      this.threshold = o.threshold ?? 1;
      this._scale = Array.isArray(o.scale) ? o.scale : null; // [min, max] de sortie
      this.raw = null;
      this.value = null;
      this._last = null;
      this._whenReady(() => this._init());
    }
    _init() {
      const b = this.board;
      if (this.type === "digital") {
        this.pin = b.resolvePin(this._rawPin);
        b.pinMode(this.pin, MODES.INPUT);
        b.on("digital-read-" + this.pin, (v) => this._onRaw(v));
      } else {
        this.channel = b.resolveChannel(this._rawPin);
        this.pin = b.analogPin(this.channel);
        b.pinMode(this.pin, MODES.ANALOG);
        b.on("analog-read-" + this.channel, (v) => this._onRaw(v));
      }
    }
    /** Convertit la plage brute 0-1023 vers [lo, hi]. */
    scaleTo(range) {
      this._scale = range;
      return this;
    }
    _onRaw(raw) {
      this.raw = raw;
      this.value = this._scale ? this._scale[0] + (raw / 1023) * (this._scale[1] - this._scale[0]) : raw;
      this.emit("data", this.value);
      if (this._last === null || Math.abs(this.value - this._last) >= this.threshold) {
        this._last = this.value;
        this.emit("change", this.value);
      }
    }
  }

  class Light extends Sensor {
    /** Capteur de lumière (photorésistance) : `level` de 0 à 100 %. */
    get level() {
      return this.raw === null ? 0 : Math.round((this.raw / 1023) * 100);
    }
  }

  /* =========================================================================
   * 7. Joystick
   * ====================================================================== */
  class Joystick extends Component {
    static hooks = { change: "joystickMoved" };

    /**
     * @param {object} opts { pins: [X, Y], invertX, invertY, deadband, autoCalibrate }
     * Propriétés `x` et `y` dans [-1, 1] ; événements "data" et "change".
     */
    constructor(opts = {}) {
      super(opts);
      if (!Array.isArray(opts.pins) || opts.pins.length < 2) throw new Error("Joystick : `pins: [X, Y]` requis.");
      this._rawPins = opts.pins;
      this.invertX = !!(opts.invertX ?? opts.invert);
      this.invertY = !!(opts.invertY ?? opts.invert);
      this.deadband = opts.deadband ?? 0.03;
      this.autoCalibrate = opts.autoCalibrate ?? true; // centre = 1re lecture (sinon 512)
      this.x = 0;
      this.y = 0;
      this.raw = [null, null];
      this.center = [512, 512];
      this._calibrated = false;
      this._whenReady(() => this._init());
    }
    _init() {
      const b = this.board;
      this._rawPins.slice(0, 2).forEach((p, i) => {
        const ch = b.resolveChannel(p);
        b.pinMode(b.analogPin(ch), MODES.ANALOG);
        b.on("analog-read-" + ch, (v) => this._onRaw(i, v));
      });
    }
    /** Recalibre le centre sur la position actuelle du manche (à lâcher au repos). */
    calibrate() {
      if (this.raw[0] !== null && this.raw[1] !== null) this.center = [this.raw[0], this.raw[1]];
    }
    _norm(v, c, invert) {
      let n = v >= c ? (v - c) / Math.max(1, 1023 - c) : (v - c) / Math.max(1, c);
      if (Math.abs(n) < this.deadband) n = 0;
      if (invert) n = -n;
      return Math.round(clamp(n, -1, 1) * 100) / 100;
    }
    _onRaw(i, v) {
      this.raw[i] = v;
      if (this.raw[0] === null || this.raw[1] === null) return;
      if (!this._calibrated) {
        this._calibrated = true;
        if (this.autoCalibrate) this.calibrate();
      }
      const x = this._norm(this.raw[0], this.center[0], this.invertX);
      const y = this._norm(this.raw[1], this.center[1], this.invertY);
      const changed = x !== this.x || y !== this.y;
      this.x = x;
      this.y = y;
      this.emit("data", { x, y });
      if (changed) this.emit("change", { x, y });
    }
  }

  /* =========================================================================
   * 8. Led / Led.RGB
   * ====================================================================== */
  class Led extends Component {
    /** @param {number|string|object} opts broche, ou { pin, isAnode } */
    constructor(opts) {
      const o = singlePin(opts);
      super(o);
      this._rawPin = o.pin;
      this.isAnode = !!o.isAnode;
      this._level = 0; // 0-255
      this._timer = null;
      this._ready = false;
      this._whenReady(() => this._init());
    }
    get isOn() {
      return this._level > 0;
    }
    _init() {
      const b = this.board;
      this.pin = b.resolvePin(this._rawPin);
      this._pwm = b.supports(this.pin, MODES.PWM);
      b.pinMode(this.pin, this._pwm ? MODES.PWM : MODES.OUTPUT);
      this._ready = true;
      this._apply();
    }
    _apply() {
      if (!this._ready) return; // l'état est mémorisé et appliqué à l'initialisation
      let v = this._level;
      if (this.isAnode) v = 255 - v;
      if (this._pwm) this.board.analogWrite(this.pin, v);
      else this.board.digitalWrite(this.pin, v > 127 ? 1 : 0);
    }
    _stopAnim() {
      clearInterval(this._timer);
      this._timer = null;
    }
    on() {
      this._stopAnim();
      this._level = 255;
      this._apply();
      return this;
    }
    off() {
      this._stopAnim();
      this._level = 0;
      this._apply();
      return this;
    }
    toggle() {
      return this.isOn ? this.off() : this.on();
    }
    /** Luminosité 0-255 (nécessite une broche PWM, sinon tout-ou-rien). */
    brightness(value) {
      this._stopAnim();
      this._level = clamp(Math.round(value), 0, 255);
      this._apply();
      return this;
    }
    /** Clignote : alterne allumé/éteint toutes les `ms` millisecondes. */
    blink(ms = 100) {
      this._stopAnim();
      this._level = 255;
      this._apply();
      this._timer = setInterval(() => {
        this._level = this._level > 0 ? 0 : 255;
        this._apply();
      }, ms);
      return this;
    }
    /** Respiration (fondu montant/descendant) sur une période de `ms` ; nécessite une broche PWM. */
    pulse(ms = 1000) {
      this._stopAnim();
      const t0 = performance.now();
      this._timer = setInterval(() => {
        const phase = ((performance.now() - t0) % ms) / ms;
        this._level = Math.round(255 * (1 - Math.abs(2 * phase - 1)));
        this._apply();
      }, 25);
      return this;
    }
    /** Arrête blink / pulse en conservant l'état courant. */
    stop() {
      this._stopAnim();
      return this;
    }
  }

  /** Convertit une couleur ("#ff8800", "f80", "tomato", [r,g,b], {red,green,blue}) en [r,g,b]. */
  function parseColor(c) {
    if (Array.isArray(c) && c.length >= 3) return c.slice(0, 3).map(clamp255);
    if (c && typeof c === "object") {
      const r = c.red ?? c.r;
      const g = c.green ?? c.g;
      const bl = c.blue ?? c.b;
      if (r !== undefined && g !== undefined && bl !== undefined) return [r, g, bl].map(clamp255);
    }
    if (typeof c === "string") {
      let s = c.trim().replace(/^#/, "");
      if (/^[0-9a-f]{3}$/i.test(s)) s = s.split("").map((x) => x + x).join("");
      if (/^[0-9a-f]{6}$/i.test(s)) return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
      if (typeof document !== "undefined") {
        // Noms CSS : on laisse le navigateur les convertir en #rrggbb.
        const ctx = document.createElement("canvas").getContext("2d");
        ctx.fillStyle = "#000000";
        ctx.fillStyle = c;
        const hex = ctx.fillStyle;
        if (/^#[0-9a-f]{6}$/i.test(hex)) return parseColor(hex);
      }
    }
    throw new Error("Couleur invalide : " + JSON.stringify(c));
  }

  class LedRGB extends Component {
    /** @param {Array|object} opts [R, G, B], ou { pins: [R,G,B] | {red,green,blue}, isAnode } */
    constructor(opts) {
      const o = Array.isArray(opts) ? { pins: opts } : opts || {};
      super(o);
      let p = o.pins;
      if (Array.isArray(p)) p = { red: p[0], green: p[1], blue: p[2] };
      if (!p || p.red == null || p.green == null || p.blue == null) throw new Error("Led.RGB : 3 broches [R, G, B] requises.");
      this._rawPins = [p.red, p.green, p.blue];
      this.isAnode = !!o.isAnode;
      this._color = [255, 255, 255];
      this._isOn = false;
      this._intensity = 100;
      this._timer = null;
      this._ready = false;
      this._whenReady(() => this._init());
    }
    get isOn() {
      return this._isOn;
    }
    _init() {
      const b = this.board;
      this.pins = this._rawPins.map((p) => b.resolvePin(p));
      this._pwm = this.pins.map((pin) => b.supports(pin, MODES.PWM));
      this.pins.forEach((pin, i) => b.pinMode(pin, this._pwm[i] ? MODES.PWM : MODES.OUTPUT));
      this._ready = true;
      this._apply();
    }
    _apply() {
      if (!this._ready) return;
      const k = this._isOn ? this._intensity / 100 : 0;
      this.pins.forEach((pin, i) => {
        let v = Math.round(this._color[i] * k);
        if (this.isAnode) v = 255 - v;
        if (this._pwm[i]) this.board.analogWrite(pin, v);
        else this.board.digitalWrite(pin, v > 127 ? 1 : 0);
      });
    }
    _stopAnim() {
      clearInterval(this._timer);
      this._timer = null;
    }
    /** Définit et affiche une couleur. */
    color(value) {
      this._color = parseColor(value);
      if (!this._timer) this._isOn = true;
      this._apply();
      return this;
    }
    on() {
      this._stopAnim();
      this._isOn = true;
      this._apply();
      return this;
    }
    off() {
      this._stopAnim();
      this._isOn = false;
      this._apply();
      return this;
    }
    /** Intensité globale 0-100 %. */
    intensity(percent) {
      this._intensity = clamp(percent, 0, 100);
      this._apply();
      return this;
    }
    /** Stroboscope : alterne la couleur courante et le noir toutes les `ms` ms. */
    strobe(ms = 100) {
      this._stopAnim();
      this._isOn = true;
      this._apply();
      this._timer = setInterval(() => {
        this._isOn = !this._isOn;
        this._apply();
      }, ms);
      return this;
    }
    stop() {
      this._stopAnim();
      return this;
    }
  }
  Led.RGB = LedRGB; // permet `new five.Led.RGB([r, g, b])`

  /* =========================================================================
   * 9. LCD (HD44780 derrière un « backpack » I2C PCF8574)
   * ====================================================================== */
  const LCD_PRESETS = {
    PCF8574: { address: 0x27, pins: { rs: 0, rw: 1, e: 2, backlight: 3, data: [4, 5, 6, 7] } },
    PCF8574A: { address: 0x3f, pins: { rs: 0, rw: 1, e: 2, backlight: 3, data: [4, 5, 6, 7] } },
  };
  const LCD_ROW_OFFSETS = [0x00, 0x40, 0x14, 0x54];

  class LCD extends Component {
    /**
     * @param {object|string} opts { controller: "PCF8574"|"PCF8574A", address, rows, cols, pins }
     * Méthodes : print(), clear(), cursor(row, col), home(), on(), off(), backlight(), noBacklight().
     * Les appels sont mis en file : on peut les enchaîner sans attendre, même avant la connexion.
     */
    constructor(opts = {}) {
      const o = typeof opts === "string" ? { controller: opts } : opts;
      super(o);
      const name = String(o.controller || "PCF8574").toUpperCase();
      const preset = LCD_PRESETS[name];
      if (!preset) throw new Error("LCD : contrôleur inconnu « " + name + " » (PCF8574 ou PCF8574A).");
      this.address = o.address ?? preset.address;
      this.pins = { ...preset.pins, ...(o.pins || {}) };
      this.rows = o.rows ?? 2;
      this.cols = o.cols ?? 16;
      this._backlight = true;
      this._displayControl = 0x04; // affichage ON, curseur OFF, clignotement OFF

      // La file reste bloquée tant que la carte n'est pas prête et l'écran initialisé.
      this._queue = new Promise((resolve) => {
        this._release = resolve;
      });
      this._whenReady(() => {
        this._init()
          .catch((err) => this.emit("error", err))
          .then(() => this._release());
      });
    }

    /* Un octet du PCF8574 = bits de données + RS + E + rétroéclairage. */
    _pack(nibble, rs) {
      let b = 0;
      for (let i = 0; i < 4; i++) if ((nibble >> i) & 1) b |= 1 << this.pins.data[i];
      if (rs) b |= 1 << this.pins.rs;
      if (this._backlight) b |= 1 << this.pins.backlight;
      return b;
    }
    /** Un octet HD44780 → 4 octets I2C (poids fort + impulsion E, poids faible + impulsion E). */
    _encode(value, rs) {
      const e = 1 << this.pins.e;
      const hi = this._pack(value >> 4, rs);
      const lo = this._pack(value & 0x0f, rs);
      return [hi | e, hi, lo | e, lo];
    }
    _i2c(bytes) {
      for (let i = 0; i < bytes.length; i += 16) this.board.i2cWrite(this.address, bytes.slice(i, i + 16));
    }
    async _command(value) {
      this._i2c(this._encode(value, false));
      await sleep(value <= 0x03 ? 4 : 1); // clear/home sont lents (~2 ms)
    }
    async _init() {
      this.board.i2cConfig();
      const e = 1 << this.pins.e;
      const nibble = (n) => {
        const v = this._pack(n, false);
        this._i2c([v | e, v]);
      };
      await sleep(50);
      nibble(0x03); await sleep(5);
      nibble(0x03); await sleep(5);
      nibble(0x03); await sleep(1);
      nibble(0x02); await sleep(1); // passage en mode 4 bits
      await this._command(0x20 | (this.rows > 1 ? 0x08 : 0x00)); // function set
      await this._command(0x08 | this._displayControl); // affichage ON
      await this._command(0x01); // effacement
      await this._command(0x06); // entrée : curseur vers la droite
    }
    _enqueue(task) {
      this._queue = this._queue.then(task).catch((err) => this.emit("error", err));
      return this;
    }

    /** Écrit du texte à la position du curseur. */
    print(text) {
      const bytes = [];
      for (const ch of String(text)) {
        const code = ch.charCodeAt(0);
        bytes.push(...this._encode(code < 256 ? code : 0x3f, true)); // hors Latin-1 → « ? »
      }
      return this._enqueue(async () => this._i2c(bytes));
    }
    clear() {
      return this._enqueue(() => this._command(0x01));
    }
    home() {
      return this._enqueue(() => this._command(0x02));
    }
    /** Place le curseur (lignes et colonnes numérotées à partir de 0, comme Johnny-Five). */
    cursor(row, col) {
      const r = clamp(row, 0, this.rows - 1);
      const addr = LCD_ROW_OFFSETS[r] + clamp(col, 0, this.cols - 1);
      return this._enqueue(() => this._command(0x80 | addr));
    }
    on() {
      this._displayControl |= 0x04;
      return this._enqueue(() => this._command(0x08 | this._displayControl));
    }
    off() {
      this._displayControl &= ~0x04;
      return this._enqueue(() => this._command(0x08 | this._displayControl));
    }
    backlight() {
      this._backlight = true;
      return this._enqueue(async () => this._i2c([this._pack(0, false)]));
    }
    noBacklight() {
      this._backlight = false;
      return this._enqueue(async () => this._i2c([this._pack(0, false)]));
    }
  }

  /* =========================================================================
   * 10. Motor (pont en H : PWM + direction)
   * ====================================================================== */
  class Motor extends Component {
    /**
     * @param {Array|object} opts [pwm, dir], ou { pins: { pwm, dir } | [pwm, dir], invertDirection }
     * Méthodes : forward(v), reverse(v), stop(), start(v), speed(v) ; vitesse 0-255 (défaut 128).
     */
    constructor(opts) {
      const o = Array.isArray(opts) ? { pins: opts } : opts || {};
      super(o);
      let p = o.pins;
      if (Array.isArray(p)) p = { pwm: p[0], dir: p[1] };
      if (!p || p.pwm == null || p.dir == null) throw new Error("Motor : `[pwm, dir]` requis.");
      this._rawPins = p;
      this.invertDirection = !!o.invertDirection;
      this.isOn = false;
      this._speed = 0;
      this._dir = 1; // 1 = avant
      this._ready = false;
      this._whenReady(() => this._init());
    }
    _init() {
      const b = this.board;
      this.pwmPin = b.resolvePin(this._rawPins.pwm);
      this.dirPin = b.resolvePin(this._rawPins.dir);
      b.pinMode(this.pwmPin, MODES.PWM);
      b.pinMode(this.dirPin, MODES.OUTPUT);
      this._ready = true;
      this._apply();
    }
    _apply() {
      if (!this._ready) return;
      this.board.digitalWrite(this.dirPin, this._dir ^ (this.invertDirection ? 1 : 0)); // direction d'abord
      this.board.analogWrite(this.pwmPin, this.isOn ? this._speed : 0);
    }
    _run(dir, speed) {
      this._dir = dir;
      this._speed = clamp(Math.round(speed ?? (this._speed || 128)), 0, 255);
      this.isOn = this._speed > 0;
      this._apply();
      return this;
    }
    forward(speed) {
      return this._run(1, speed);
    }
    reverse(speed) {
      return this._run(0, speed);
    }
    start(speed) {
      return this._run(this._dir, speed);
    }
    speed(value) {
      return this._run(this._dir, value);
    }
    stop() {
      this.isOn = false;
      this._apply();
      return this;
    }
  }

  /* =========================================================================
   * 11. Piezo
   * -------------------------------------------------------------------------
   * StandardFirmataPlus ne sait PAS générer de fréquence (pas de tone()). La note est donc
   * produite en logiciel : le navigateur bascule la broche à la fréquence voulue. C'est
   * suffisant pour de simples bips / mélodies (≈ 100-900 Hz à 57600 bauds), mais ni précis
   * ni silencieux côté CPU pendant la note. Pour un son propre, utilisez un firmware
   * disposant d'une commande « tone ».
   * ====================================================================== */
  const NOTE_INDEX = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

  /** "A4" → 440 ; "C#5", "Bb3" acceptés ; un nombre est renvoyé tel quel (Hz). */
  function noteToFreq(note) {
    if (typeof note === "number") return note;
    const m = /^([A-G])([#b]?)(-?\d)$/i.exec(String(note).trim());
    if (!m) throw new Error("Note invalide : " + note);
    const midi = 12 * (parseInt(m[3], 10) + 1) + NOTE_INDEX[m[1].toUpperCase()] + (m[2] === "#" ? 1 : m[2] === "b" ? -1 : 0);
    return 440 * Math.pow(2, (midi - 69) / 12);
  }

  class Piezo extends Component {
    /** @param {number|string|object} opts broche, ou { pin } */
    constructor(opts) {
      const o = singlePin(opts);
      super(o);
      this._rawPin = o.pin;
      this._toneId = 0;
      this._playId = 0;
      this._channel = null;
      this._ready = false;
      this._warned = false;
      this._whenReady(() => this._init());
    }
    _init() {
      this.pin = this.board.resolvePin(this._rawPin);
      this.board.pinMode(this.pin, MODES.OUTPUT);
      this.board.digitalWrite(this.pin, 0);
      this._ready = true;
    }
    _stopTone() {
      this._toneId++;
      if (this._channel) {
        this._channel.port1.close();
        this._channel.port2.close();
        this._channel = null;
      }
      if (this._ready) this.board.digitalWrite(this.pin, 0);
    }
    /**
     * Joue une fréquence (Hz) ou un nom de note ("A4") pendant `duration` ms (indéfiniment si omis).
     * Non bloquant : revient immédiatement.
     */
    tone(frequency, duration) {
      this._stopTone();
      if (!this._ready) return this;
      let freq = noteToFreq(frequency);
      if (!(freq > 0)) return this;

      const maxFreq = Math.floor(this.board.options.baudRate / 60); // 3 octets × 10 bits par bascule
      if (freq > maxFreq) {
        if (!this._warned) console.warn("[p5.j5] Piezo : " + Math.round(freq) + " Hz dépasse la limite logicielle (" + maxFreq + " Hz).");
        this._warned = true;
        freq = maxFreq;
      }

      const half = 500 / freq; // demi-période (ms)
      const id = this._toneId;
      const t0 = performance.now();
      const end = duration > 0 ? t0 + duration : Infinity;
      let next = t0;
      let level = 0;

      // MessageChannel plutôt que setTimeout : pas de plancher de 4 ms entre deux itérations.
      const channel = new MessageChannel();
      this._channel = channel;
      channel.port1.onmessage = () => {
        if (id !== this._toneId) return;
        const now = performance.now();
        if (now >= end) {
          this._stopTone();
          return;
        }
        if (now >= next) {
          level ^= 1;
          this.board.digitalWrite(this.pin, level);
          next = now - next > half * 4 ? now + half : next + half; // rattrapage si le navigateur a pris du retard
        }
        channel.port2.postMessage(0);
      };
      channel.port2.postMessage(0);
      return this;
    }
    frequency(frequency, duration) {
      return this.tone(frequency, duration);
    }
    /** Coupe le son (et interrompt une mélodie en cours). */
    noTone() {
      this._playId++;
      this._stopTone();
      return this;
    }
    /**
     * Joue une mélodie : { song: [["C4", 1/4], ["E4", 1/4], [null, 1/4]], tempo: 100, beats: 1/4 }.
     * `null` = silence. Renvoie une Promise résolue à la fin (ou à l'interruption par noTone()).
     */
    async play({ song = [], tempo = 100, beats = 1 / 4 } = {}) {
      const id = ++this._playId;
      for (const [note, beat = beats] of song) {
        if (id !== this._playId) return;
        const ms = (60000 / tempo) * (beat * 4); // 1/4 = une noire = 60000/tempo ms
        if (note) this.tone(note, ms * 0.9);
        else this._stopTone();
        await sleep(ms);
      }
      if (id === this._playId) this._stopTone();
    }
  }

  /* =========================================================================
   * 12. Servo
   * ====================================================================== */
  class Servo extends Component {
    /**
     * @param {number|string|object} opts broche, ou { pin, range: [0,180], pwmRange: [544,2400], startAt, invert }
     * Méthodes : to(angle[, ms]), min(), max(), center(), home(), stop().
     */
    constructor(opts) {
      const o = singlePin(opts);
      super(o);
      this._rawPin = o.pin;
      this.range = o.range || [0, 180];
      this.pwmRange = o.pwmRange || [544, 2400];
      this.invert = !!o.invert;
      this.startAt = o.startAt;
      this.value = null; // dernier angle demandé
      this._tween = null;
      this._ready = false;
      this._whenReady(() => this._init());
    }
    _init() {
      const b = this.board;
      this.pin = b.resolvePin(this._rawPin);
      b.servoConfig(this.pin, this.pwmRange[0], this.pwmRange[1]); // avant pinMode(SERVO)
      b.pinMode(this.pin, MODES.SERVO);
      this._ready = true;
      const initial = this.value ?? this.startAt;
      if (initial != null) this._write(initial);
    }
    _write(angle) {
      if (!this._ready) return;
      const a = this.invert ? this.range[0] + this.range[1] - angle : angle;
      this.board.servoWrite(this.pin, Math.round(a));
    }
    /** Déplace le servo à `angle` ; avec `ms`, le mouvement est interpolé sur cette durée. */
    to(angle, ms) {
      clearInterval(this._tween);
      this._tween = null;
      const target = clamp(angle, this.range[0], this.range[1]);
      if (!ms || ms <= 0 || this.value === null) {
        this.value = target;
        this._write(target);
        return this;
      }
      const from = this.value;
      const t0 = performance.now();
      this._tween = setInterval(() => {
        const t = clamp((performance.now() - t0) / ms, 0, 1);
        this.value = from + (target - from) * t;
        this._write(this.value);
        if (t >= 1) {
          clearInterval(this._tween);
          this._tween = null;
        }
      }, 20);
      return this;
    }
    min(ms) {
      return this.to(this.range[0], ms);
    }
    max(ms) {
      return this.to(this.range[1], ms);
    }
    center(ms) {
      return this.to((this.range[0] + this.range[1]) / 2, ms);
    }
    home(ms) {
      return this.to(this.startAt ?? (this.range[0] + this.range[1]) / 2, ms);
    }
    stop() {
      clearInterval(this._tween);
      this._tween = null;
      return this;
    }
  }

  /* =========================================================================
   * 13. Export global + intégration p5.js v2
   * ====================================================================== */
  const five = { version: "2.0.0", MODES, Board, Button, Joystick, LCD, Led, Light, Motor, Piezo, Sensor, Servo };

  global.five = five;
  global.p5j5 = five;
  if (typeof module !== "undefined" && module.exports) module.exports = five;

  /**
   * Addon p5.js v2 (`p5.registerAddon`) : ajoute au sketch
   *   - createBoard(options)                 → five.Board suivi par p5 (fermé à la suppression du sketch)
   *   - createConnectButton(board, label)    → bouton HTML qui appelle board.connect() au clic
   * Les callbacks globaux (buttonPressed, buttonReleased, buttonHeld, sensorChanged, joystickMoved)
   * sont gérés directement par les composants.
   */
  const trackedBoards = new Set();

  function p5Addon(p5, fn, lifecycles) {
    fn.createBoard = function (options) {
      const board = new Board(options);
      trackedBoards.add(board);
      return board;
    };

    fn.createConnectButton = function (board, label = "Connecter l'Arduino") {
      const button = this.createButton(label);
      const el = button.elt;
      el.addEventListener("click", async () => {
        el.disabled = true;
        try {
          await board.connect(); // requestPort() est appelé de façon synchrone dans le clic
          el.textContent = "Arduino connecté ✓";
        } catch (err) {
          el.disabled = false;
          el.textContent = label;
          if (err && err.name === "NotFoundError") return; // boîte de dialogue annulée
          board.emit("error", err);
        }
      });
      board.on("close", () => {
        el.disabled = false;
        el.textContent = label;
      });
      return button;
    };

    lifecycles.remove = function () {
      for (const board of trackedBoards) board.disconnect();
      trackedBoards.clear();
    };
  }

  if (global.p5 && typeof global.p5.registerAddon === "function") {
    global.p5.registerAddon(p5Addon);
  } else if (global.p5 && global.p5.prototype) {
    // Repli (p5.js v1) : méthodes sur le prototype, sans nettoyage automatique.
    p5Addon(global.p5, global.p5.prototype, {});
  }
})(typeof globalThis !== "undefined" ? globalThis : window);