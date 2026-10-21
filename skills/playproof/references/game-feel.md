# Reviewing game feel from a contact sheet

A contact sheet turns motion into something you can inspect tile by tile. These are the checks that separate motion that feels good from motion that feels cheap, and how each one shows up on `frames.png`. Film at 60 fps and show every frame (`--fps 60`) for anything faster than ~300 ms.

## Response time

Players feel input lag above ~100 ms; good action games react on the next frame.

- On the sheet: find the tile right after the input step. Something should change in the first 1–3 frames (≤ 50 ms). A dashed box near the player character is the reaction.
- If the first change appears 6+ frames later, look for input handled in a fixed-step update that runs too rarely, a tween with a start delay, or input queued until an animation finishes.

## Anticipation → action → follow-through

- **Anticipation**: a short wind-up opposite to the action (crouch before a jump, pull back before a throw). 2–6 frames is enough; more feels sluggish.
- **Action**: fast. A jump should leave the ground in very few frames.
- **Follow-through / settle**: squash on landing, overshoot then settle on UI pop-ins, trailing parts (hair, cape, antennae) lagging behind the body.
- On the sheet: the tiles before the motion should show the wind-up, and the last tiles should show a settle, not a hard stop.

## Easing

- Linear motion (constant speed, instant start and stop) reads as robotic for characters and UI.
- On the bar graph: eased motion ramps up and down. A flat plateau of identical bars that starts and ends abruptly is linear.
- Exceptions: projectiles, conveyor belts and scrolling backgrounds are usually linear on purpose.

## Squash and stretch

- Fast vertical motion stretches along the direction of travel; impacts squash. Volume should look roughly constant (wider when shorter).
- On the sheet: compare the character's silhouette across tiles around take-off and landing.

## Impact and emphasis

- **Hit-stop**: freezing both parties for 2–6 frames on a strong hit sells weight. On the sheet that is a deliberate short *hold* right after contact.
- **Screen shake**: a few frames of small offsets, decaying. Shake that never decays, or is larger than a few percent of the screen, hurts readability.
- **Flash**: a one-frame white flash on hit is a classic. playproof flags it as *flicker*; that is fine when it is intended and on the right object.
- **Particles**: dust on landing, sparks on hit. They should spawn on the contact frame, not before or after.

## Continuity

- *Sudden jump* findings on characters or UI are usually bugs: a position reset without a tween, a state switch that snaps, an object respawning in view.
- *Flicker* that is not a deliberate flash is usually a draw-order bug or a frame where state is half-updated.
- A *hold* in the middle of an action can be a hitch (asset loading, garbage collection, a synchronous save). Compare with `perf`.

## Readability

- The thing the player must watch should be the thing that moves most. The dashed boxes show where change happens; if the biggest box is a background effect, the player's eye goes there too.
- Important feedback should stay on screen long enough to read: text at least ~0.5 s, score pop-ups ~0.6–1 s.

## UI transitions

- Panels: 150–300 ms, ease-out on enter, ease-in on exit, with a small overshoot on playful games.
- Buttons: a visible pressed state on the frame the finger lands, release animation on lift.
- Nothing should pop in on a single frame unless it is a deliberate cut.
