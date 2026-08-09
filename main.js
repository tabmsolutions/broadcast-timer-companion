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

// Feedback/variables only, by design: this module never sends commands to
// the server. Actions (start/stop/reset/set/direction/digit/show/hide) stay
// on Companion's built-in Generic HTTP module, unchanged. Any number of
// controllers can drive a timer at once — Generic HTTP buttons, this
// module's own Companion instance, the server's own /control web page, or
// several of any of those simultaneously — because the server holds one
// authoritative state per timer and broadcasts every change over
// WebSocket to all subscribers, this module included. See
// https://github.com/kgtpuck/broadcast-timer for the server and its REST API.
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
      }
    ]

    this.setPresetDefinitions(structure, presets)
  }
}

export default BroadcastTimerInstance
