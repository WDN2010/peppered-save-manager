# Product

## Register

product

## Users

PEPPERED speedrunners, route researchers, and players who repeatedly return to specific practice states on Windows. The primary user is technically comfortable but should not need to inspect save JSON or remember scene codes.

## Product Purpose

PEPPERED Save Manager turns the game's single `Save.es3` file into a safe named checkpoint library. It lets the user capture the current persisted save, give it a meaningful name, understand where it belongs in the game, restore it with an automatic safety backup, and move the whole catalog between computers through import and export.

Success means a player can move from "I want to practise that section" to the correct save in a few clear actions, without touching AppData or risking the active save.

## Brand Personality

Focused, trustworthy, quietly game-aware. The application should feel like a purpose-built speedrun tool, with restrained references to PEPPERED rather than decorative gamer styling.

## Anti-references

- No corporate admin-dashboard look.
- No raw JSON, coordinates, hashes, or scene codes as the primary reading surface.
- No neon cyberpunk overload, fake telemetry, decorative side rails, or animated gamer clutter.
- No ambiguous destructive actions or restore flows that hide what will be replaced.
- No machine-translated or partially localized interface.

## Design Principles

1. Name the place, not the data. Show a short checkpoint description first and technical identifiers only as secondary detail.
2. Protect the active save. Every restore creates a recovery snapshot and uses an atomic replacement path.
3. Keep practice flow short. Capture, select, restore, and launch are the central actions.
4. Make state visible. Clearly distinguish the live game save, named snapshots, missing paths, import results, and errors.
5. Treat Russian and English as equal product surfaces, not a translated afterthought.

## Accessibility & Inclusion

Target WCAG 2.2 AA contrast. Support full keyboard navigation, visible focus states, scalable interface text, reduced-motion behavior, screen-reader-friendly labels, and status updates that do not rely on color alone.
