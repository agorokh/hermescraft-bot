# Creative studio: tall builds by hand (agorokh/hermescraft#592)

The walking builder ([physical-build-502.md](physical-build-502.md)) refuses any cell it cannot
walk to, so nothing tall can be built by hand. In a creative-mode world a character may fly to
reach a cell. Everything after the approach is the #502 hand placer, unchanged.

## When it is on

All three must hold, otherwise `build_schematic` behaves exactly as before:

- `HERMESCRAFT_PHYSICAL_BUILDS=1` (the household launcher always sets it);
- `HERMESCRAFT_STUDIO_FLIGHT=1` (the host launcher sets it only for a studio session);
- the character's game mode is creative.

## What it does

- Flies to a hover within 4 blocks of the cell (`bot/lib/studio_flight.js`). Mineflayer's
  `creative.flyTo` moves through anything, so every leg is checked clear of blocks first.
- Never hovers in a cell any section of the design still has to fill, and prefers the outside
  of the structure.
- Takes each material from the creative inventory into an empty hotbar slot. It never overwrites
  a slot, and it hands the stacks back when the build ends.
- Places each block with native `placeBlock` and counts only matching world readback.
- Orders cells so each has a neighbour to be placed against; refuses a design with a floating
  cell; refuses to replace anything already standing in the design space.
- Re-places a missed block up to three times from a different stance.
- Lands beside the build when it ends.

It never issues a command, teleports, or breaks a block.

## Sections

A design may name contiguous runs of its block list:

```json
"sections": { "leg_ne": { "label": "north-east leg", "blocks": [0, 150] } }
```

`build_schematic` with `"section": "leg_ne"` builds only that run and says one line,
"I'm building the north-east leg by hand." Two characters can build different sections of the
same design at the same origin at the same time.

## Designs

- `flagpole`: 20 blocks, 17 high. The flight proof.
- `eiffel_tower`: 600 blocks, 30 high, four mirrored 150-block legs (`leg_ne`, `leg_se`,
  `leg_sw`, `leg_nw`), each standing alone from the ground to the tip. Regenerate with
  `node scripts/generate_eiffel_tower_schematic.mjs`.

## Measured (isolated Paper 1.21.11, flat, creative, `allow-flight=false`, no plugins)

Block counts are from the server console (`execute if block` per cell), not from the bot.

| Trial | Runs | Count | Time per run |
|---|---|---|---|
| `flagpole`, one character | 5 of 5 | 20 of 20 | 15.4 to 16.7 s |
| one tower leg, one character | 5 of 5 | 150 of 150 | 110 to 116 s |
| whole tower, two characters, two legs each | 3 of 3 | 600 of 600 | 218 to 238 s |

The server log for those sessions has no command, teleport, kick or movement-rejection line.

## Asking in chat

"Rosie build the eiffel tower" (also "eifel", "eifle", "a tower like the eiffel tower") names the
`eiffel_tower` design. The character that was asked runs the `studio_build` action
(`bot/lib/studio_cobuild.js`):

- Outside a studio session it says "I can only build the Eiffel Tower in the creative world."
  and changes nothing.
- In a studio session it puts the design on the ground 6 blocks east of the child, writes a plan
  file, and both characters work through the legs. Before each leg a character asks
  `Next: the north-east leg. Want to build it yourself? Say "mine"!` and waits 8 seconds.
  "mine" (or "me", "yes") leaves that leg to the child; "you do it" starts it at once.
- The character that was asked takes legs from the start of the list, the other from the far
  end. Only one offer is open at a time, so "mine" always means one leg.
- "Rosie stop" stops both characters. A character that reconnects finishes the leg it had begun.
- While a plan runs the characters make no idle remarks, and a character never reacts to a block
  that it or another character placed.

Characters are separate processes and agree through files in `HERMESCRAFT_STUDIO_PLAN_DIR`
(default `~/.hermescraft/studio-plans`), which both bodies must share.

A character needs one empty hotbar slot. Materials swap through the slot the build stocked
itself; nothing the character carries is overwritten.

Measured on the same isolated instance, with a third account standing in for the child and
counts from the server console:

| Trial | Result |
|---|---|
| "Rosie build the eiffel tower", child takes one leg | first block 11.5 s after the request; three legs 150 of 150, the child's leg left empty; 234 s |
| "Steve can you build the eifle tower", then "Rosie stop" after 45 s | both stopped within 3 s; no further blocks |
| the request while Rosie is in survival | one line, nothing built |
| "Rosie lets build the eiffel tower", eight carried items per character | 600 of 600 in 246 s; carried items untouched |

## Not done

- No creative world exists on the family server; these trials ran on a separate instance.
- Not seen on a Bedrock device, and not tried with a child.
- The child cannot yet pick a leg by name ("I want the north-west one"), only answer an offer.
