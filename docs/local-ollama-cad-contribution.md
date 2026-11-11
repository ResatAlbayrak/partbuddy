# Local Ollama CAD assistant: contribution notes and live test log

> **Status (2026-11-11):** Working notes for a future upstream PR, not a claim of full validation.
> Maintained on fork branch `fix/cad-command-guidance`, which is based on `feat/configurable-local-context`.
> No upstream pull request has been opened from these notes.

## Intent and scope

Improve PartBuddy's local Ollama workflow in two related but independently reviewable areas:

1. **Configurable context window:** 16K / 32K / 64K tokens for Ollama models, saved in settings and sent per model request as `num_ctx`.
2. **CAD tool reliability and observability:** Tool-use guidance for SolidCraft, opt-in display of actual failed-tool messages, body-name discovery, and descriptive body naming.

**Upstream PR recommendation:** Split context configuration from CAD tool guidance/diagnostics if practical. The CAD branch currently includes the context commit in its history; do not submit the whole branch as an unrelated single-purpose PR without reviewing the diff.

## Implemented changes

| Commit | Change | Principal files |
| --- | --- | --- |
| `f75de2d` | Persistent Ollama 16K/32K/64K selector and per-request context. | `local/ollama.ts`, `local/localAgent.ts`, settings, IPC, renderer, tests |
| `dc9f6a8` | Prompt notes: use `describe_command`, inspect current topology, diagnose errors. | `agents/toolNotes.ts` |
| `6ab02b2` | Opt-in **Tool debugging** setting (off by default), showing up to 500 characters of SolidCraft's failed-tool text in the tool card; a few focused tests added. | `agents/loop.ts`, `agents/gateProxy.ts`, settings, IPC, renderer, tests |
| `fda75f9` | Prompt notes: discover the actual body name with `inspect_design` before `body_topology`. | `agents/toolNotes.ts` |
| `fcf06ae` | Prompt notes: use `body.rename` to give new bodies unique, descriptive names, then verify the rename. | `agents/toolNotes.ts` |
| `3204399` | Configurable local-model round budget (25, 50, 100) in persisted settings; the limit used for the next request and the stop notice reflect the selected value. | `local/localAgent.ts`, settings, renderer, i18n, tests |

The last three prompt-guidance changes are **instructions to the model**, not enforced invariants. Body naming is not yet proven reliable in a live test.

## Live test observations (Windows, PartBuddy dev mode, local Ollama)

The tests below were performed interactively with `qwen3.6:27b-coding`. Observations come from the PartBuddy UI and reported SolidCraft tool outcomes, **not** a formal automated regression suite.

| Case | Result | Evidence / limitation |
| --- | --- | --- |
| Simple cuboid, 40 × 30 × 10 mm | **Pass** | Visible solid; reported volume 12,000 mm³. |
| Shell with 1.8 mm walls, open top | **Pass after one tool error** | Model tried unsupported `inset`, checked `describe_command`, then used `thickness`; visible open box. |
| Fillet on a single external vertical edge | **Pass after failed selection** | Initial `edges: [[40,15,5]]` was a point on a face, not a vertical edge; model corrected its interpretation. |
| Separate cuboid and fillet test | **Pass after body lookup failure** | `body_topology({body:"Quader"})` failed because the actual name was `Body1`; model recovered and rounded a selected edge. Debug mode displayed the exact message. |
| Open housing, 80 × 50 × 25 mm, 2 mm walls, four 1 mm corner fillets, four Ø3 holes | **Mostly pass** | 12 tool queries, one failed `solid.hole` call because `position` was an array of points instead of one point. Model recovered with four individual holes. Reported final volume around 19,514 mm³. |
| Two-part housing, 100 × 70 × 32 mm, bosses, USB opening, lid, vents | **Incomplete** | The assistant stopped after partial work without an explicit failure or continuation notice. UI showed 6 work steps, 19 queries, five bodies still named `Body1`–`Body5`, and multiple tool failures. No complete/verified two-part assembly was established. |

### Exact failures worth retaining for regression tests

- SolidCraft returned **invalid parameters for `model.edges`: no body `Quader`** when an intended feature name was used as the body name.
- `solid.hole` rejects `position: [[10,10,0],[70,10,0],[10,40,0],[70,40,0]]`; it requires one `[x,y,z]` position per invocation (or an appropriate sketch-based call).
- `floor` cannot be used as a parameter name because it is a function name. The subsequent `unknown parameter L` error was consistent with the preceding parameter-creation batch failing.
- `sketch.fillet` failed with `a must be a line` after the model chose incorrect sketch entities.
- A previous fillet attempt at `[40,15,5]` was 3.672 mm away from the closest qualifying edge according to the model's account of the SolidCraft error.

### What the tests demonstrate

- SolidCraft's command schemas and returned topology are useful, but the model sometimes guesses an argument name, a body name, or the meaning of an edge index.
- The debug toggle was **confirmed in the live UI**: failed calls displayed actual SolidCraft error text.
- Complex jobs benefit from small verified tool steps; a partially constructed body or a model's success statement does not prove a complete, printable assembly.
- The model's volume reasoning can be wrong: four Ø3 through-holes through a **2 mm floor** remove about 56.5 mm³, not the much larger volume obtained by multiplying by the housing's full height.

### Second complex housing run: repeat with naming guidance (2026-11-11)

**Status: incomplete, not a pass.** The user reran the same 100 × 70 × 32 mm two-part enclosure request. A visible model shows the housing, some screw bosses and a separate-looking lid, but the requested USB wall opening is **not present**. The model claimed the USB opening was created despite a failed tool invocation. The conversation again stopped after the reported 25-request/step threshold without a clear incomplete-task notice. The precise stopping reason is **not confirmed** by instrumented logs.

Captured failed tool calls:

- A parameter batch containing `set_parameter({ name: "floor", value: "3 mm" })` failed because `floor` is a reserved function name. A later `solid.box` failed with `unknown parameter L`. The model subsequently attempted to repair missing parameters.
- `solid.fillet` failed for sample points `[-25,-17.5,16]` (nearest edge 17.500 mm away). Another attempt used corner vertex `[-50,-35,16]`, where three edges meet, rather than a midpoint along one edge.
- `batch` received `commands` as a **string containing JSON**, rather than an actual array, when adding the screw bosses. It returned `argument commands must be of type "array"`.
- The same wrong `commands` string representation occurred in the USB opening sketch batch, which also failed. Consequently, the model's subsequent statement **"USB-Ausschnitt erstellt"** was not supported by a successful tool call or the visible geometry.
- Later narrative became internally inconsistent about lid height and guide-lip clearances. The lid was visible, but its attachment, fit and guide lip were not verified.

**Regression priority:** Distinguish observed geometric changes from tool-result text; show an explicit *incomplete* outcome when the step budget is exhausted; prevent claiming completion after tool errors; use actual JSON arrays for `batch.commands`; validate key features, including an actual through-cut, before reporting success. These are observations and proposed acceptance criteria, **not yet implemented fixes**.

### First deterministic CAD-tool validation pass

**Implemented (not yet verified in the Windows live build):**
- Added `agents/toolArguments.ts`: valid, stringified `batch.commands` arrays are decoded before forwarding to SolidCraft, for the local loop and the Claude Code gate. Invalid payloads remain invalid and are rejected.
- Added a policy preflight: `floor` as a `set_parameter` / `parameters.change` name is refused with a specific explanation before a whole batch can fail; `batch.commands` must be an actual array after normalization.
- Extended the effective tool descriptions and tool notes with concrete argument types, reserved parameter names, and midpoint-based fillet selection guidance.
- Failed SolidCraft tool results sent back to the **local model** are explicitly marked as failures, with an instruction to verify the design instead of claiming completion.
- Added targeted policy/normalization unit assertions to `apps/desktop/test/agent.test.ts`.

**Commits:** `f7edd62` (normalizer/helper), `26fe544` (wiring, policy checks, tests).

**Still open:** Prove with the live SolidCraft runtime that erroneous `batch.commands` calls reach the normalizer (schema validation may reject malformed model input earlier); test whether the failure marker reduces false claims; verify the full TypeScript build and unit tests. This does not validate arbitrary CAD geometry or automatically correct topology coordinates. The silent step-budget stop now has a proposed user-visible remedy, but requires a live test.

### Third tool-error report and 25-round limit (2026-11-11)

**User observation:** A local Ollama run stopped after exactly 25 SolidCraft calls, despite substantial context still being available. The implementation has `MAX_STEPS = 25` via `stepCountIs(MAX_STEPS)`. This counts model rounds (which can contain multiple tool calls), **not context tokens**. The correlation to exactly 25 SolidCraft calls is consistent with one call per round, but the precise provider-side termination was not instrumented.

**Captured errors:**
- `describe_command({id:"solid.round"})` → unknown command; the expected edge-rounding command is `solid.fillet`.
- `batch` with `solid.shell` and `faces: "[[50,35,32]]"` → `faces` must be an array of 3D points or face names, not a JSON string.
- `batch` with `solid.union` → unknown command; `solid.combine` is mentioned in the SolidCraft engineering notes, but the exact boolean parameters must still be queried rather than guessed.

**Implemented in `ce9456a` (unverified build):** Deterministic normalization of valid, stringified `solid.shell.faces` arrays for both `execute` and `batch`; validation of known nonexistent command names with actionable guidance; revised tool descriptions/notes and regression assertions; explicit reporting of an incomplete turn when the step budget ends with a tool call; a UI action to resume work on the existing model rather than resending the original construction request. An ordinary final text response at the exact step limit is not flagged as incomplete.

**Tests still required:** Type-check and unit test the final branch, confirm the AI SDK passes malformed arguments to the normalizer rather than rejecting them at schema validation, and reproduce/verify the end-of-budget notice and continuation button in the Windows dev UI. Verify the app does not duplicate geometry on continuation.

### Repeated USB-C sketch batch rejection (2026-11-11)

**Observed:** The local Qwen 27B CAD agent sent the same `batch` command three times with `commands` as a string containing heavily escaped JSON, and `sketch.rectangle.two_point` used a single string such as `p0: ["USBCOffset + WallThickness, USBCHeight / 2"]` instead of two coordinates. PartBuddy refused the batch three times and then correctly stopped the identical-call loop. No USB opening was made. This is distinct from the configured 25/50/100 model-round cap.

**Implemented in `4550629` (live test pending):**
- Decode the batch array only when the provided text is valid JSON, double JSON-encoded text, or an array whose JSON quotes have been unnecessarily escaped. Reject malformed or non-command arrays; all decoded commands still pass PartBuddy's existing policy.
- For `sketch.rectangle.two_point`, split a one-element `p0` or `p1` string into two expressions only when there is exactly one unambiguous top-level comma; preserve commas within parenthesized expressions such as `max(A,B)`.
- Update the batch tool description and model guidance with an explicit correct coordinate-array example.
- Add regression tests for the observed string encodings, point expressions, ambiguous input and unchanged policy rejection of prohibited file commands.

**Validation:** The JSON-decoding cases were independently checked in an isolated JavaScript test. A complete TypeScript test run and a live PartBuddy/SolidCraft replay are **not yet verified**. Not all invalid CAD commands, topology selections, or incorrect sketches can be automatically repaired.

## Open issues / follow-up work

1. **Step-budget stop (implemented, live verification pending):** The local agent now uses the configured 25/50/100 round limit, checks whether the last model round still requested tools, and reports that the design may be incomplete. The earlier 25-call correlation was observed in a live test; the exact AI-provider stop reason remains uninstrumented.
2. **Explicit continuation (implemented, live verification pending):** PartBuddy shows a continuation action after the configured step cap and submits a follow-up about the existing geometry. Check that it reliably resumes without duplicating features.
3. **Body naming:** The guidance was added after the test with five `BodyN` bodies; rerun a multi-body test and verify `body.rename` is actually executed and later used.
4. **Batch failure recovery:** Check each batch result, avoid reusing parameters from a failed parameter batch, and validate sketch-entity identifiers before fillets.
5. **Geometric verification:** Check actual volumes, measured dimensions, distinct bodies, holes, and fit instead of relying on the model's narrative.
6. **Diagnostics review:** Debug details are opt-in and truncated to 500 characters. Review whether additional sanitisation and tests are necessary before upstream submission.

### Local round-budget setting and continuation (implemented, not yet live-tested)

**Commit:** `3204399`

- A persisted `localStepLimit` setting restricts the local agent to `25`, `50`, or `100` model rounds; the default remains `25`.
- PartBuddy uses the selected limit for the next `streamText` request via `stepCountIs(limit)`.
- When the final model round still contains tool calls, PartBuddy flags the design as potentially unfinished and offers **Continue existing design** rather than silently reporting success.
- The continuation button submits a follow-up within the same project and conversation, instructing the model to inspect the current SolidCraft geometry and add only missing features.
- The user can choose a higher budget independently of the Ollama context window; these are different limits.
- Settings persistence and the round-stop helper received unit-test updates. A Windows app test and full typecheck are still required.

## Validation checklist before opening PR

- [x] Live Windows Electron dev server connected to SolidCraft and Ollama.
- [x] Live check that the tool-debug setting exposes actual failed-tool text.
- [x] Commit `f75de2d` passed local privacy and conventional-commit hooks when authored.
- [ ] Run `pnpm lint && pnpm typecheck && pnpm test && pnpm build` on the **final** branch.
- [ ] Run focused unit tests for tool error extraction, settings persistence, and stop-condition behaviour.
- [ ] Repeat multi-body body-rename test and document successful/failed commands.
- [ ] Confirm completion-limit UX and the 25/50/100 setting with a reproducible instrumented test.
- [ ] Review branch separation / PR scope, test evidence, security and licensing requirements.
- [ ] Follow `CONTRIBUTING.md` for signed-off commits (DCO), commit-signing expectations, and privacy scan.

## Draft PR overview

**Problem:** Local models can require a configurable context budget and make recoverable SolidCraft argument/topology mistakes. The UI previously hid failed-tool details, making diagnosis difficult. Multi-part designs also need stable, descriptive body references.

**Approach:** Persist Ollama's requested context size; add focused tool-use notes; optionally surface failed SolidCraft messages in the assistant UI without changing the normal compact presentation.

**Observed benefit:** 64K Ollama context was observed in a runtime check; the debug setting showed actual tool failures in live CAD tests, and the model could recover from selected schema/topology mistakes.

**Limitations:** Prompt guidance alone does not guarantee reliable geometry or naming. The local loop now emits an explicit incomplete status at its round limit with a continuation button, and a configurable 25/50/100 step budget has been implemented, but the full end-to-end continuation flow is not yet live-verified.

---

Update this log when a change is **implemented**, **tested**, or **rejected**. Keep those states separate. Do not add personal identifiers, machine-specific paths, secrets, or user project exports to the PR.
