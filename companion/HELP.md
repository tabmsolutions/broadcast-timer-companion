# Broadcast Timer

Live feedback and variables for a self-hosted
[broadcast-timer](https://github.com/kgtpuck/broadcast-timer) server — a
time-of-day clock / count up-down timer, normally controlled from Companion
via the built-in **Generic HTTP** module.

**This module does not send any commands.** It only reads live state over a
WebSocket and exposes it as variables and feedbacks. Keep using Generic HTTP
(or the server's own `/control/:id` web page) for start/stop/reset/set/
direction/digit/show/hide — this module is a read-only companion to that,
not a replacement. Any number of controllers (Generic HTTP buttons, this
module, the web control page, several Companion instances) can drive or
watch the same timer at once; the server broadcasts state to everyone.

## Setup

One module instance watches one timer. If you have multiple timers, add one
instance per timer. For each instance, set:

- **Server host / IP** — the machine running the broadcast-timer server
- **Server port** — default `3000`
- **Timer id** — matches the id shown on that timer's card in the server's
  `/admin` page (e.g. `timer1`)

## Variables

| Variable | Example | Notes |
|---|---|---|
| `value` | `00:12:30` | Full HH:MM:SS on one variable, for a single button |
| `value_mmss` | `12:30` | Same value as MM:SS. Minutes are *not* capped at 59 — a 2-hour value reads `120:00`, not wrapped back into hours |
| `value_ss` | `750` | Same value as total whole seconds, no colons. Pads to 2 digits minimum (`05`), grows past that naturally for longer totals |
| `digit_h1`, `digit_h2` | `0`, `0` | Hours, tens/ones digit |
| `digit_m1`, `digit_m2` | `1`, `2` | Minutes, tens/ones digit |
| `digit_s1`, `digit_s2` | `3`, `0` | Seconds, tens/ones digit |
| `name` | `Timer 1` | The timer's configured display name |
| `mode` | `timer` | `clock` or `timer` — whether the timer is showing on the display |
| `running` | `yes` | `yes` or `no` |
| `direction` | `down` | `up` or `down` |
| `expired` | `no` | `yes` once a countdown hits zero, until reset |

For a segmented scoreboard-style display across several buttons, the
per-digit variables already compose to whatever width you need — use
`digit_m1`/`digit_m2`/`digit_s1`/`digit_s2` alone for an MM:SS panel, or just
`digit_s1`/`digit_s2` for an SS-only panel; skipping `digit_h1`/`digit_h2`
is enough, no separate digit set is needed. `value`/`value_mmss`/`value_ss`
exist for the single-button case, where you want one of those widths as one
compact string instead of separate digit buttons.

All value/digit variables update live once a second while the timer is
running, independent of the server's discrete start/stop/set events — they
won't sit frozen between those events.

## Feedbacks

- **Timer running** — true while counting up/down
- **Timer expired (flashes)** — true on alternating ticks while a countdown
  has hit zero and stopped, so a button styled with this feedback flashes
- **Timer visible on display (mode = timer)** — true when the display is
  showing the timer rather than clock-only
- **Direction is...** — true when the timer's direction matches the
  selected option (Up/Down)

## Presets

Drag these in from Companion's presets panel instead of building buttons by
hand:

- **Value & Digits** — full-value buttons for `HH:MM:SS`, `MM:SS`, and
  `SS`-only, a name button, and six individual digit buttons (for a
  scoreboard-style layout across separate buttons), all pre-wired with the
  flashing "expired" feedback
- **Status Indicators** — one button each for Running, Expired, Timer
  visible, Direction: Down, and Direction: Up, styled with their matching
  feedback so they light up on their own

All presets have empty button actions (this module doesn't add actions —
attach a Generic HTTP action separately if you want the same button to also
control the timer).
