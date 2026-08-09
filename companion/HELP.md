# Broadcast Timer

Full control plus live feedback and variables for a self-hosted
[broadcast-timer](https://github.com/kgtpuck/broadcast-timer) server — a
time-of-day clock / count up-down timer for broadcast use.

**You don't need Companion's Generic HTTP module for this timer anymore** —
every action below just POSTs to the same REST endpoints Generic HTTP would,
so this one module covers both control and feedback. If you already have
Generic HTTP buttons set up for this timer, they keep working fine alongside
this module — the server treats every controller the same way and broadcasts
state to all of them, whether that's Generic HTTP, this module, the server's
own `/control/:id` web page, or several Companion instances at once.

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

## Actions

| Action | Options | Notes |
|---|---|---|
| **Start** | — | Starts counting up/down |
| **Stop** | — | Pauses, keeping the current value |
| **Reset** | — | Elapsed time back to zero; keeps configured duration/direction |
| **Set direction** | Direction: Up/Down | Folds current elapsed value and stops the timer if it was running — press Start again after |
| **Set time** | Hours, Minutes, Seconds | Ignored while running — Stop or Reset first |
| **Send digit** | Digit: 0–9 | Keypad-style entry: shifts one digit into a 6-digit HHMMSS buffer from the right (e.g. 1,2,3,0,0 → `00:12:30`). Ignored while running |
| **Clear entry** | — | Resets the digit-entry buffer to zero |
| **Show timer** | — | Display shows the timer (mode = timer) |
| **Hide timer** | — | Display goes back to clock-only |

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
  flashing "expired" feedback. Display-only — no action attached.
- **Status Indicators** — one button each for Running, Expired, Timer
  visible, Direction: Down, and Direction: Up, styled with their matching
  feedback so they light up on their own. Display-only — no action attached.
- **Transport** — Start, Stop, Reset, Show, Hide, Count down, Count up. Start
  lights up green while running; Show lights up blue while the timer is
  visible; Count down/up light up while that's the active direction — these
  double as both the control and its own status indicator on one button.
- **Keypad** — one button per digit (0–9) plus Clear, for a numeric entry pad
  matching the server's own `/control` page.
- **Quick Set** — Set 1:00, Set 5:00, Set 10:00 as starting points for common
  segment lengths. Duplicate and edit a button's Hours/Minutes/Seconds
  options for other durations.
