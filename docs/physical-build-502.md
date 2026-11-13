# Physical companion builds (#502)

Operator-approved outcome (2026-11-13): Rosie and Steve walk to each block and visibly place
it by hand; actual iPhone/Arsenyzzz verification with Codex, show both sequences, restore Kimi.
Parent issue502 is promoted; issue546 unsolicited continuation stays held.

## Design

The normal household launcher opts into `HERMESCRAFT_PHYSICAL_BUILDS=1`. The existing
`build_schematic` and `placeOne` pipeline then skips every setblock/auth-probe shortcut,
including planning. Legacy unopted command builds are not household co-play acceptance.
The current finite prepared starter kits supply real campfire materials; Foreman must count
inventory, and hand placement consumes it. Do not inject arbitrary materials during a build.

For each pending cell, select a loaded supported nearby standing cell, outside the target and
other actors, and require a real pathfinder arrival. Prefer a different stance from the last
placement so the character walks between targets. Use temporary conservative Movements:
no digging, scaffolding, towers, parkour, unsafe drops or opening doors. Reject unsafe/unknown
stances; stop on unreachable/timeout/stop, cancel only owned navigation, restore original policy.

After approach, recheck target/support/actors and stop generation, equip the actual material,
face the actual reference surface and call Mineflayer `placeBlock` (its native right-arm swing
and block-placement packet). Count only matching world readback. Keep brief phase chat truthful
and command-free, and log approach/equip/hand/readback receipts for native evidence correlation.
Campfire is last, after ring/seats, and paths avoid fire. An unsafe or unsupported placement
returns accurate partial progress; it never silently switches to a command or cosmetic swing.

The existing build-active flag owns the action between per-cell goals: follow-on-join,
background gaze and survival tasks must not teleport, turn or interrupt the builder then.

## Execution plan

- [ ] Baseline: run all bot tests at e1d5962 (584/584 pass).
- [ ] RED: exercise actual registered build/plan actions with op auth and physical launch;
  require no commands, per-cell movement before real placement, truthful inventory/readback.
  Cover missing material, unreachable/false arrival, stop/timeout, new obstruction, wrong readback,
  conservative movement policy/restoration and fire-last ordering.
- [ ] GREEN: integrate physical policy/approach into the existing skills, not a second placer.
- [ ] Independent background-ownership task: RED/GREEN follow/gaze/survival guards.
- [ ] Run focused then full bot checks; review exact-head behavior and failure/cancellation paths.
- [ ] Parent integration: RED/GREEN normal launcher physical mode and finite campfire kits;
  reviewed gitlink, parent ci-fast, normal mint-dev installation and console-pin audit.
- [ ] Actual phone: reuse only approved dedicated fixture through ordinary controls; one
  requested campfire each; native capture must show walking, held block/arm and resulting cell,
  with per-block body receipts and13/13 readback. Do not infer hand animation from timed cells.
- [ ] Preserve house/older fires/manual/recovered cells/supports/protection/fire0 and health;
  show both real sequences, exact Kimi restoration, normal verified-backup shutdown and dated SAVE.

No player teleport, destructive clearing, generated campfire support, remote fallback, world
reset, paid/permanent provider change or held unsolicited behavior is authorized by this design.
