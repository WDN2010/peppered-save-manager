# Design System

## Direction

**Mood:** night practice bench: matte charcoal, a precise violet checkpoint signal, and a warm amber safety cue. Quiet enough for repeated use, distinctive enough to feel made for PEPPERED.

The design serves the workflow. Game references appear through checkpoint language, compact route markers, and restrained color, never through decorative HUD furniture.

## Color

Use OKLCH tokens throughout.

```css
:root {
  --bg: oklch(0.105 0 0);
  --surface-1: oklch(0.145 0 0);
  --surface-2: oklch(0.19 0.008 270);
  --surface-3: oklch(0.235 0.012 270);
  --ink: oklch(0.955 0.008 270);
  --muted: oklch(0.72 0.018 270);
  --subtle: oklch(0.56 0.018 270);
  --border: oklch(0.31 0.018 270);
  --primary: oklch(0.70 0.12 270);
  --primary-strong: oklch(0.61 0.15 270);
  --primary-soft: oklch(0.27 0.055 270);
  --accent: oklch(0.80 0.14 78);
  --accent-soft: oklch(0.26 0.045 78);
  --success: oklch(0.74 0.13 150);
  --danger: oklch(0.67 0.18 25);
  --focus: oklch(0.82 0.12 270);
}
```

Primary violet marks selection and the main capture action. Amber marks safety backups, cautions, and restore context. Red is reserved for destructive failure states. Status is always expressed with text or icon plus color.

## Typography

Use the Windows-native `Segoe UI Variable`, falling back to `Segoe UI` and `sans-serif`. One family keeps the utility familiar and readable.

- App title: 20px / 650
- Section title: 16px / 650
- Body: 14px / 400
- Compact metadata: 12px / 500
- Button and control labels: 13px / 600

Support interface scale presets at 100%, 115%, and 130% without clipping.

## Layout

Default window target: 1120 x 720, minimum 860 x 560.

- Top command bar: product identity, active-save health, language, settings.
- Left library pane: 320px, search, sort, snapshot list, empty state.
- Right detail pane: flexible, selected checkpoint description, editable name, capture metadata, and actions.
- The live save appears as a distinct source strip rather than another snapshot card.
- Collapse to a single-pane list/detail flow below 920px.

## Components

### Live save strip
Shows detected, missing, invalid, or game-running state in plain language. The primary action is `Save current` / `Сохранить текущее`.

### Snapshot row
Title first, human checkpoint description second, capture date third. Selected state uses a violet edge and surface shift, not a full saturated fill.

### Detail header
Editable name, checkpoint description, optional technical disclosure, and actions. Restore copy states exactly what will happen and confirms the safety backup.

### Toast and activity status
Short, persistent enough to read, keyboard and screen-reader announced. Long operations show a labelled progress state in the command area.

### Empty and missing states
Teach the next action. Never show only "Nothing here".

## Motion

Use 150 to 200ms state transitions for selection, disclosure, toast appearance, and pane changes. No page-load choreography. Under reduced motion, use instant state changes and opacity-only toast appearance.

## Iconography

Use one coherent outline icon set. Icons supplement labels and never replace text for primary actions.

## Localization

All visible strings live in typed RU and EN dictionaries. Layout must tolerate English strings up to 35% longer than Russian labels and vice versa. Dates follow the selected UI locale.
