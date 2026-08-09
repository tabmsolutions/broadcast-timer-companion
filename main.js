import { InstanceBase, InstanceStatus, Regex, combineRgb } from '@companion-module/base'
import WebSocket from 'ws'

const DEFAULT_STATE = {
  name: '',
  mode: 'clock',
  running: false,
  expired: false,
  direction: 'down',
  valueSeconds: 0
}

function pad2(n) {
  return String(n).padStart(2, '0')
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(totalSeconds))
  const hh = Math.floor(s / 3600)
  const mm = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return `${pad2(hh)}:${pad2(mm)}:${pad2(ss)}`
}

// Actions here are a thin wrapper around the same REST endpoints Companion's
// built-in Generic HTTP module can already call directly — this module adds
// feedback/variables (which Generic HTTP can't do) plus friendlier presets,
// but doesn't require Generic HTTP or replace it: use either, or both on the
// same timer at once. Any number of controllers can drive a timer
// simultaneously — Generic HTTP buttons, this module, the server's own
// /control web page — because the server holds one authoritative state per
// timer and broadcasts every change over WebSocket to all subscribers, this
// module included. See https://github.com/kgtpuck/broadcast-timer for the
// server and its REST API.
class BroadcastTimerInstance extends InstanceBase {
  constructor(internal) {
    super(internal)
    this.ws = null
    this.reconnectTimer = null
    this.reconnectDelay = 1000
    this.blinkTimer = null
    this.blinkPhase = false
    this.tickTimer = null
    this.destroyed = false
    this.state = { ...DEFAULT_STATE }
    // Anchor for local interpolation between WebSocket pushes: the server
    // only pushes on discrete state changes (start/stop/set/...), not on
    // every tick of a running countdown, so without this the displayed
    // value would sit frozen at whatever it was when the timer started.
    this.anchorValueSeconds = 0
    this.anchorAtMs = Date.now()
  }

  async init(config) {
    this.config = config
    this.updateVariableDefinitions()
    this.updateFeedbackDefinitions()
    this.updateActionDefinitions()
    this.updatePresetDefinitions()
    this.updateVariableValues()
    this.updateStatus(InstanceStatus.Connecting)
    this.startBlinkTimer()
    this.startTickTimer()
    this.connect()
  }

  async destroy() {
    this.destroyed = true
    this.stopBlinkTimer()
    this.stopTickTimer()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.close()
      this.ws = null
    }
  }

  async configUpdated(config) {
    this.config = config
    this.reconnectDelay = 1000
    if (this.ws) {
      this.ws.removeAllListeners()
      this.ws.close()
      this.ws = null
    }
    this.connect()
  }

  getConfigFields() {
    return [
      {
        type: 'textinput',
        id: 'host',
        label: 'Server host / IP',
        width: 6,
        default: '127.0.0.1',
        regex: Regex.HOSTNAME
      },
      {
        type: 'textinput',
        id: 'port',
        label: 'Server port',
        width: 3,
        default: '3000',
        regex: Regex.PORT
      },
      {
        type: 'textinput',
        id: 'timerId',
        label: 'Timer id',
        width: 3,
        default: 'timer1',
        tooltip: 'The id shown on the timer\'s card in /admin, e.g. "timer1". One module instance watches one timer.'
      }
    ]
  }

  wsUrl() {
    const host = (this.config && this.config.host) || '127.0.0.1'
    const port = (this.config && this.config.port) || '3000'
    const timerId = (this.config && this.config.timerId) || 'timer1'
    return `ws://${host}:${port}/ws?timer=${encodeURIComponent(timerId)}`
  }

  restBaseUrl() {
    const host = (this.config && this.config.host) || '127.0.0.1'
    const port = (this.config && this.config.port) || '3000'
    const timerId = (this.config && this.config.timerId) || 'timer1'
    return `http://${host}:${port}/api/timers/${encodeURIComponent(timerId)}`
  }

  // Fire-and-log a POST to one of the server's action endpoints (the same
  // ones Generic HTTP would call). The resulting state change arrives back
  // over the already-open WebSocket, so there's no need to update local
  // state here — just report failures, since a button press with no
  // feedback of failure is a bad experience for an operator mid-show.
  async postCommand(path, body) {
    const url = `${this.restBaseUrl()}${path}`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        this.log('warn', `${path} failed: HTTP ${res.status} ${text}`)
      }
    } catch (e) {
      this.log('warn', `${path} failed: ${e.message}`)
    }
  }

  connect() {
    if (this.destroyed) return
    let ws
    try {
      ws = new WebSocket(this.wsUrl())
    } catch (e) {
      this.updateStatus(InstanceStatus.ConnectionFailure, e.message)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.on('open', () => {
      this.reconnectDelay = 1000
      this.updateStatus(InstanceStatus.Ok)
    })

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'state' && msg.timer) this.applyState(msg.timer)
      } catch (e) {
        this.log('warn', `Failed to parse server message: ${e.message}`)
      }
    })

    ws.on('close', (code, reasonBuf) => {
      if (this.ws !== ws) return // superseded by a newer connection already
      const reason = reasonBuf ? reasonBuf.toString() : ''
      if (code === 1008) {
        // Server rejected the timer id outright (see server/ws.js) rather
        // than the connection just dropping — surface that distinctly
        // instead of a generic "disconnected", since it means the config
        // needs fixing, not just a network hiccup.
        this.updateStatus(InstanceStatus.BadConfig, reason || 'Unknown timer id')
      } else {
        this.updateStatus(InstanceStatus.Disconnected)
      }
      this.scheduleReconnect()
    })

    ws.on('error', (err) => {
      this.updateStatus(InstanceStatus.ConnectionFailure, err.message)
    })
  }

  scheduleReconnect() {
    if (this.destroyed || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, this.reconnectDelay)
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, 15000)
  }

  applyState(t) {
    this.state = {
      name: t.name || '',
      mode: t.mode || 'clock',
      running: !!t.running,
      expired: !!t.expired,
      direction: t.direction || 'down',
      valueSeconds: typeof t.valueSeconds === 'number' ? t.valueSeconds : 0
    }
    this.anchorValueSeconds = this.state.valueSeconds
    this.anchorAtMs = Date.now()
    this.updateVariableValues()
    this.checkFeedbacks('running', 'expired', 'visible', 'direction')
  }

  // Live value extrapolated from the last server push, matching the same
  // math the server/display pages use, so it keeps advancing between pushes
  // instead of sitting frozen at the value from when the timer last started.
  currentValueSeconds() {
    if (!this.state.running) return this.anchorValueSeconds
    const elapsedSec = (Date.now() - this.anchorAtMs) / 1000
    const v = this.state.direction === 'up'
      ? this.anchorValueSeconds + elapsedSec
      : this.anchorValueSeconds - elapsedSec
    return Math.max(0, v)
  }

  updateVariableDefinitions() {
    this.setVariableDefinitions({
      name: { name: 'Timer name' },
      value: { name: 'Full value, HH:MM:SS' },
      value_mmss: { name: 'Value, MM:SS (total minutes, uncapped at 59 -- e.g. 125:07)' },
      value_ss: { name: 'Value, total whole seconds (e.g. 45, or 7505)' },
      digit_h1: { name: 'Hours - tens digit' },
      digit_h2: { name: 'Hours - ones digit' },
      digit_m1: { name: 'Minutes - tens digit' },
      digit_m2: { name: 'Minutes - ones digit' },
      digit_s1: { name: 'Seconds - tens digit' },
      digit_s2: { name: 'Seconds - ones digit' },
      mode: { name: 'Mode (clock or timer)' },
      running: { name: 'Running (yes/no)' },
      direction: { name: 'Direction (up/down)' },
      expired: { name: 'Expired (yes/no)' }
    })
  }

  updateVariableValues() {
    const liveSeconds = this.currentValueSeconds()
    const text = formatDuration(liveSeconds)
    const digits = text.replace(/:/g, '').split('')

    const totalWhole = Math.max(0, Math.round(liveSeconds))
    const mm = Math.floor(totalWhole / 60) // uncapped -- e.g. 125, not wrapped to hours
    const ss = totalWhole % 60
    const mmss = `${pad2(mm)}:${pad2(ss)}`
    const ssOnly = pad2(totalWhole) // grows past 2 digits naturally for totals >= 100s

    this.setVariableValues({
      name: this.state.name,
      value: text,
      value_mmss: mmss,
      value_ss: ssOnly,
      digit_h1: digits[0],
      digit_h2: digits[1],
      digit_m1: digits[2],
      digit_m2: digits[3],
      digit_s1: digits[4],
      digit_s2: digits[5],
      mode: this.state.mode,
      running: this.state.running ? 'yes' : 'no',
      direction: this.state.direction,
      expired: this.state.expired ? 'yes' : 'no'
    })
  }

  // Companion has no native "blink" primitive; a feedback just re-evaluates
  // when told to. Toggling blinkPhase and re-checking the 'expired'
  // feedback on an interval is what makes the button flash.
  startBlinkTimer() {
    this.blinkTimer = setInterval(() => {
      this.blinkPhase = !this.blinkPhase
      if (this.state.expired && !this.state.running) this.checkFeedbacks('expired')
    }, 500)
  }

  stopBlinkTimer() {
    if (this.blinkTimer) clearInterval(this.blinkTimer)
    this.blinkTimer = null
  }

  // Keeps value/value_mmss/value_ss/digit_* advancing once a second while
  // the timer is running, independent of the server's discrete pushes.
  startTickTimer() {
    this.tickTimer = setInterval(() => {
      if (this.state.running) this.updateVariableValues()
    }, 1000)
  }

  stopTickTimer() {
    if (this.tickTimer) clearInterval(this.tickTimer)
    this.tickTimer = null
  }

  updateFeedbackDefinitions() {
    this.setFeedbackDefinitions({
      running: {
        type: 'boolean',
        name: 'Timer running',
        description: 'True while the timer is actively counting up or down',
        defaultStyle: { bgcolor: combineRgb(34, 70, 44), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => this.state.running
      },
      expired: {
        type: 'boolean',
        name: 'Timer expired (flashes)',
        description: 'True on alternating ~500ms ticks while a countdown has hit zero and stopped, for a flashing button',
        defaultStyle: { bgcolor: combineRgb(70, 34, 44), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => this.state.expired && !this.state.running && this.blinkPhase
      },
      visible: {
        type: 'boolean',
        name: 'Timer visible on display (mode = timer)',
        description: 'True when the display is showing the timer, as opposed to clock-only',
        defaultStyle: { bgcolor: combineRgb(45, 74, 99), color: combineRgb(255, 255, 255) },
        options: [],
        callback: () => this.state.mode === 'timer'
      },
      direction: {
        type: 'boolean',
        name: 'Direction is...',
        description: "True when the timer's current count direction matches the selected option",
        defaultStyle: { bgcolor: combineRgb(90, 74, 20), color: combineRgb(255, 255, 255) },
        options: [
          {
            type: 'dropdown',
            id: 'direction',
            label: 'Direction',
            default: 'down',
            choices: [
              { id: 'down', label: 'Down' },
              { id: 'up', label: 'Up' }
            ]
          }
        ],
        callback: (feedback) => this.state.direction === feedback.options.direction
      }
    })
  }

  // Mirrors server/routes/api.js exactly. These call the same endpoints
  // Generic HTTP would; this module doesn't need Generic HTTP installed to
  // control the timer, but doesn't mind if it's there too.
  updateActionDefinitions() {
    const digitChoices = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => ({ id: d, label: d }))

    this.setActionDefinitions({
      start: {
        name: 'Start',
        description: 'Start the timer counting up/down',
        options: [],
        callback: async () => this.postCommand('/start')
      },
      stop: {
        name: 'Stop',
        description: 'Pause the timer, keeping its current value',
        options: [],
        callback: async () => this.postCommand('/stop')
      },
      reset: {
        name: 'Reset',
        description: 'Reset elapsed time to zero (keeps the configured duration and direction)',
        options: [],
        callback: async () => this.postCommand('/reset')
      },
      direction: {
        name: 'Set direction',
        description: "Switch between counting up and down. Folds the timer's current elapsed value and stops it if it was running — press Start again afterward.",
        options: [
          {
            type: 'dropdown',
            id: 'direction',
            label: 'Direction',
            default: 'down',
            choices: [
              { id: 'down', label: 'Down' },
              { id: 'up', label: 'Up' }
            ]
          }
        ],
        callback: async (action) => this.postCommand('/direction', { direction: action.options.direction })
      },
      set: {
        name: 'Set time',
        description: 'Set the timer to a specific HH:MM:SS. Ignored while the timer is running — stop or reset it first.',
        options: [
          { type: 'number', id: 'hh', label: 'Hours', default: 0, min: 0, max: 99 },
          { type: 'number', id: 'mm', label: 'Minutes', default: 5, min: 0, max: 59 },
          { type: 'number', id: 'ss', label: 'Seconds', default: 0, min: 0, max: 59 }
        ],
        callback: async (action) =>
          this.postCommand('/set', { hh: action.options.hh, mm: action.options.mm, ss: action.options.ss })
      },
      digit: {
        name: 'Send digit',
        description: "Keypad-style entry: shifts one digit into a 6-digit HHMMSS buffer from the right, e.g. pressing 1,2,3,0,0 sets 00:12:30. Ignored while the timer is running.",
        options: [{ type: 'dropdown', id: 'digit', label: 'Digit', default: '0', choices: digitChoices }],
        callback: async (action) => this.postCommand('/digit', { digit: action.options.digit })
      },
      clear: {
        name: 'Clear entry',
        description: 'Reset the digit-entry buffer to zero',
        options: [],
        callback: async () => this.postCommand('/clear')
      },
      show: {
        name: 'Show timer',
        description: 'Switch the display to show the timer (mode = timer), alongside the clock',
        options: [],
        callback: async () => this.postCommand('/show')
      },
      hide: {
        name: 'Hide timer',
        description: 'Switch the display back to clock-only (mode = clock)',
        options: [],
        callback: async () => this.postCommand('/hide')
      }
    })
  }

  // Ready-to-drag buttons for every feedback and the variables, so a user
  // doesn't have to hand-build styling/feedback wiring themselves.
  updatePresetDefinitions() {
    const colors = {
      running: { bgcolor: combineRgb(34, 70, 44), color: combineRgb(255, 255, 255) },
      expired: { bgcolor: combineRgb(70, 34, 44), color: combineRgb(255, 255, 255) },
      visible: { bgcolor: combineRgb(45, 74, 99), color: combineRgb(255, 255, 255) },
      direction: { bgcolor: combineRgb(90, 74, 20), color: combineRgb(255, 255, 255) },
      idle: { bgcolor: combineRgb(20, 20, 20), color: combineRgb(180, 180, 180) },
      digit: { bgcolor: combineRgb(0, 0, 0), color: combineRgb(255, 215, 0) }
    }
    const noOptionFeedback = (feedbackId, style) => ({ feedbackId, options: {}, style })

    const presets = {}

    presets.value = {
      type: 'simple',
      name: 'Full timer value (HH:MM:SS)',
      style: { text: '$(broadcast-timer:value)', size: '18', color: colors.digit.color, bgcolor: colors.digit.bgcolor },
      steps: [{ down: [], up: [] }],
      feedbacks: [noOptionFeedback('expired', colors.expired)]
    }

    presets.value_mmss = {
      type: 'simple',
      name: 'Full timer value (MM:SS)',
      style: { text: '$(broadcast-timer:value_mmss)', size: '24', color: colors.digit.color, bgcolor: colors.digit.bgcolor },
      steps: [{ down: [], up: [] }],
      feedbacks: [noOptionFeedback('expired', colors.expired)]
    }

    presets.value_ss = {
      type: 'simple',
      name: 'Full timer value (SS only)',
      style: { text: '$(broadcast-timer:value_ss)', size: '30', color: colors.digit.color, bgcolor: colors.digit.bgcolor },
      steps: [{ down: [], up: [] }],
      feedbacks: [noOptionFeedback('expired', colors.expired)]
    }

    presets.name = {
      type: 'simple',
      name: 'Timer name',
      style: { text: '$(broadcast-timer:name)', size: '14', color: combineRgb(255, 255, 255), bgcolor: combineRgb(20, 20, 20) },
      steps: [{ down: [], up: [] }],
      feedbacks: []
    }

    const digitLabels = {
      digit_h1: 'Digit: Hours - tens',
      digit_h2: 'Digit: Hours - ones',
      digit_m1: 'Digit: Minutes - tens',
      digit_m2: 'Digit: Minutes - ones',
      digit_s1: 'Digit: Seconds - tens',
      digit_s2: 'Digit: Seconds - ones'
    }
    for (const [varId, label] of Object.entries(digitLabels)) {
      presets[varId] = {
        type: 'simple',
        name: label,
        style: { text: `$(broadcast-timer:${varId})`, size: '44', color: colors.digit.color, bgcolor: colors.digit.bgcolor },
        steps: [{ down: [], up: [] }],
        feedbacks: [noOptionFeedback('expired', colors.expired)]
      }
    }

    presets.running = {
      type: 'simple',
      name: 'Running indicator',
      style: { text: 'RUNNING', size: '14', color: colors.idle.color, bgcolor: colors.idle.bgcolor },
      steps: [{ down: [], up: [] }],
      feedbacks: [noOptionFeedback('running', colors.running)]
    }

    presets.expired = {
      type: 'simple',
      name: 'Expired indicator (flashes)',
      style: { text: 'EXPIRED', size: '14', color: colors.idle.color, bgcolor: colors.idle.bgcolor },
      steps: [{ down: [], up: [] }],
      feedbacks: [noOptionFeedback('expired', colors.expired)]
    }

    presets.visible = {
      type: 'simple',
      name: 'Timer visible indicator',
      style: { text: 'ON DISPLAY', size: '14', color: colors.idle.color, bgcolor: colors.idle.bgcolor },
      steps: [{ down: [], up: [] }],
      feedbacks: [noOptionFeedback('visible', colors.visible)]
    }

    presets.direction_down = {
      type: 'simple',
      name: 'Direction: Down indicator',
      style: { text: '▼ DOWN', size: '14', color: colors.idle.color, bgcolor: colors.idle.bgcolor },
      steps: [{ down: [], up: [] }],
      feedbacks: [{ feedbackId: 'direction', options: { direction: 'down' }, style: colors.direction }]
    }

    presets.direction_up = {
      type: 'simple',
      name: 'Direction: Up indicator',
      style: { text: '▲ UP', size: '14', color: colors.idle.color, bgcolor: colors.idle.bgcolor },
      steps: [{ down: [], up: [] }],
      feedbacks: [{ feedbackId: 'direction', options: { direction: 'up' }, style: colors.direction }]
    }

    // --- Transport: action + the feedback that makes sense to pair with it,
    // so e.g. Start visibly lights up green once the timer is actually
    // running, rather than being a plain unstateful button like Generic
    // HTTP would give you.
    const actionOnly = (actionId, options = {}) => ({
      type: 'simple',
      steps: [{ down: [{ actionId, options }], up: [] }]
    })

    presets.act_start = {
      ...actionOnly('start'),
      name: 'Start',
      style: { text: 'START', size: '18', color: combineRgb(255, 255, 255), bgcolor: combineRgb(20, 20, 20) },
      feedbacks: [noOptionFeedback('running', colors.running)]
    }

    presets.act_stop = {
      ...actionOnly('stop'),
      name: 'Stop',
      style: { text: 'STOP', size: '18', color: combineRgb(255, 255, 255), bgcolor: combineRgb(20, 20, 20) },
      feedbacks: []
    }

    presets.act_reset = {
      ...actionOnly('reset'),
      name: 'Reset',
      style: { text: 'RESET', size: '18', color: combineRgb(255, 255, 255), bgcolor: combineRgb(20, 20, 20) },
      feedbacks: []
    }

    presets.act_show = {
      ...actionOnly('show'),
      name: 'Show timer',
      style: { text: 'SHOW', size: 16, color: combineRgb(255, 255, 255), bgcolor: combineRgb(20, 20, 20) },
      feedbacks: [noOptionFeedback('visible', colors.visible)]
    }

    presets.act_hide = {
      ...actionOnly('hide'),
      name: 'Hide timer (clock only)',
      style: { text: 'HIDE', size: 16, color: combineRgb(255, 255, 255), bgcolor: combineRgb(20, 20, 20) },
      feedbacks: []
    }

    presets.act_direction_down = {
      ...actionOnly('direction', { direction: 'down' }),
      name: 'Count down',
      style: { text: '▼ DOWN', size: 16, color: combineRgb(255, 255, 255), bgcolor: combineRgb(20, 20, 20) },
      feedbacks: [{ feedbackId: 'direction', options: { direction: 'down' }, style: colors.direction }]
    }

    presets.act_direction_up = {
      ...actionOnly('direction', { direction: 'up' }),
      name: 'Count up',
      style: { text: '▲ UP', size: 16, color: combineRgb(255, 255, 255), bgcolor: combineRgb(20, 20, 20) },
      feedbacks: [{ feedbackId: 'direction', options: { direction: 'up' }, style: colors.direction }]
    }

    // --- Keypad: one button per digit plus Clear, for building a numeric
    // entry pad that mirrors the server's own /control page.
    for (const d of ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9']) {
      presets[`act_digit_${d}`] = {
        ...actionOnly('digit', { digit: d }),
        name: `Send digit ${d}`,
        style: { text: d, size: '30', color: colors.digit.color, bgcolor: colors.digit.bgcolor },
        feedbacks: []
      }
    }

    presets.act_clear = {
      ...actionOnly('clear'),
      name: 'Clear entry',
      style: { text: 'CLEAR', size: 16, color: combineRgb(255, 157, 157), bgcolor: combineRgb(58, 30, 34) },
      feedbacks: []
    }

    // --- Quick set: a few common broadcast segment lengths as starting
    // points -- duplicate and edit the HH/MM/SS action options for others.
    const quickSets = [
      { id: 'act_set_1m', label: 'Set 1:00', mm: 1 },
      { id: 'act_set_5m', label: 'Set 5:00', mm: 5 },
      { id: 'act_set_10m', label: 'Set 10:00', mm: 10 }
    ]
    for (const q of quickSets) {
      presets[q.id] = {
        ...actionOnly('set', { hh: 0, mm: q.mm, ss: 0 }),
        name: q.label,
        style: { text: q.label, size: 16, color: combineRgb(255, 255, 255), bgcolor: combineRgb(20, 20, 20) },
        feedbacks: []
      }
    }

    const structure = [
      {
        id: 'value-and-digits',
        name: 'Value & Digits',
        definitions: ['value', 'value_mmss', 'value_ss', 'name', 'digit_h1', 'digit_h2', 'digit_m1', 'digit_m2', 'digit_s1', 'digit_s2']
      },
      {
        id: 'status',
        name: 'Status Indicators',
        definitions: ['running', 'expired', 'visible', 'direction_down', 'direction_up']
      },
      {
        id: 'transport',
        name: 'Transport',
        definitions: ['act_start', 'act_stop', 'act_reset', 'act_show', 'act_hide', 'act_direction_down', 'act_direction_up']
      },
      {
        id: 'keypad',
        name: 'Keypad',
        definitions: [
          'act_digit_0', 'act_digit_1', 'act_digit_2', 'act_digit_3', 'act_digit_4',
          'act_digit_5', 'act_digit_6', 'act_digit_7', 'act_digit_8', 'act_digit_9',
          'act_clear'
        ]
      },
      {
        id: 'quick-set',
        name: 'Quick Set',
        definitions: quickSets.map((q) => q.id)
      }
    ]

    this.setPresetDefinitions(structure, presets)
  }
}

export default BroadcastTimerInstance
