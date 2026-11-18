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

## Not done

- Nothing routes a child's "build the Eiffel Tower" to this design yet.
- No creative world exists on the family server; these trials ran on a separate instance.
- Not seen on a Bedrock device.
