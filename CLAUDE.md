# Waddle (hangout-planner): rules from Alexi

Read this before changing anything that shows calendar events or sharing. These are product decisions Alexi made; keep them unless she changes them.

## Views: what each one shows

| View | Who sees it | Shows |
|---|---|---|
| **My availability** (week grid, "My availability" tab) | Only you | Plain busy/free blocks by default. The **"Show event details"** switch turns on your actual schedule: event name, place and time. The switch is remembered per device (`gatherly-mine-details`). |
| **Group view** (week grid, "Group" tab) | Everyone in the group | Who's free, plus named event blocks: **event name · person · place**, but only for events that person has chosen to share and only when the group allows event details. Your own events always show to you. |
| **Group calendar** (per-person week agenda) | Everyone in the group | One row per person. Same rule as the group view: other people's event names and places only when the group allows event details and they shared that event; otherwise "Busy". Your own row shows your events to you. |
| **Your calendar** (agenda under the grid) | Only you | Every event name. Tap an event to pick it for sharing, or lock it as private. |
| **A friend's calendar** (Friends → Calendar) | That friend | Exactly what your "Who sees what" level for them allows. |
| **Booking link** (public page) | Anyone with the link | Only open times, never event names or places. Private events still block bookings. |

Busy/free is the baseline everywhere; names and places are always something the owner switches on, never the default.

## Privacy levels ("Who sees what")

- Levels, from least to most: **Nothing** → **Busy / free only** (default) → **Only events I pick** (picked events show their name; the rest read "Busy") → **Everything**.
- Set a default for friends, override it per friend, and set a separate level for groups. A group also has its own setting (busy only vs. event details); the stricter of the two wins.
- **Share more for a while**: a temporary higher level for one friend (today, this weekend, 24 hours, 7 days) that falls back on its own, even if your phone is off.
- **Private events** are hidden from everyone, not even shown as busy. Only a salted hash of the title is stored, never the name. Booking links still keep those times closed.
- A **place travels only with its event name**. If the name isn't shared, the place isn't either. Event notes/descriptions are never shared.
- Sharing choices sync across your devices when signed in.
- **Free now** is a manual status friends see at a glance.

## Working rules

- Never send email, change a real calendar or reply to invitations while building or testing; use the fakes in `.claude/skills/run-hangout-planner/`.
- How to run and test the app: `.claude/skills/run-hangout-planner/SKILL.md`.
- What Waddle must include, what proves each feature works, and what's left: [BLUEPRINT.md](BLUEPRINT.md). Update its status table when you add or change a feature.
