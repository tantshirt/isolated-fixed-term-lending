# Lendspan Design Council

Adapted from the RUDDR Design Council at the user's request. The shared roster is `_bmad/custom/bmad-party-mode.toml`. Summon with `bmad-party-mode --party design-council`.

Sally leads nine specialists: Nils (motion), Wren (references), Sol (story), Ravi (composition), Plumb (mechanics), Indigo (visual consistency), Fovea (comprehension/accessibility), Kestrel (identity), and Hollis (implementation).

The user's approved Lendspan brief wins over every inherited style rule. The council evaluates real source and screenshots; it does not manufacture research or impose repeated approval gates on already authorized work.

## Reproduce the source library

Run `python3 .design-council/restore.py`. It fetches the seven public repositories at the immutable revisions in `sources.lock.json`, into ignored `vendor/` directories. It refuses to modify an existing checkout at a different revision; preserve it and choose a separate destination instead. No RUDDR symlinks, private environment files, or generated assets are imported.

Source repos retain their upstream licenses. `sources.lock.json` records provenance, not endorsements. See `rulings.md` for the decisions applied to this project.
