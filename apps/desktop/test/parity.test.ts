import { describe, expect, it } from 'vitest';

import { decide } from '../src/main/agents/policy';
import { invokeChannels, type InvokeChannel } from '../src/shared/channels';

/**
 * Parity between the interface and the assistant: every action the interface sends to the main
 * process is something the assistant can do too (a tool, or an engine command through `execute`),
 * or it carries the reason it is the user's alone. A new channel does not compile until it is
 * placed here, and a policy change that takes a command away from the assistant fails the test.
 */
type Parity = { tool: string } | { command: string } | { reason: string };

const APP = 'app, window, settings and updates; not part of the design';
const READ = 'reads state for the interface; the assistant reads the design with inspect_design, measure and partbuddy_view';
const PROJECT = 'projects and their versions are files on disk, which the user manages; file commands are refused for the assistant';
const FILES = 'reads or writes a file the user picks or hands it to another program; the assistant has no file commands (ADR 0010)';
const ASSISTANT = 'drives the assistant itself';
const NOTES = 'notes are the user’s own; the assistant reads them with partbuddy_view and may not write them';
const PREVIEW = 'a trial for the user before applying; the assistant shows its work live in the view';
const PRINT = 'the print profile (printer, material) is the user’s setting; the assistant reads its check through partbuddy_view';

const PARITY: Record<InvokeChannel, Parity> = {
  [invokeChannels.appInfo]: { reason: APP },
  [invokeChannels.solidcraftStatus]: { reason: APP },
  [invokeChannels.solidcraftRetry]: { reason: APP },
  [invokeChannels.solidcraftStart]: { reason: APP },
  [invokeChannels.solidcraftEngine]: { reason: APP },
  [invokeChannels.solidcraftChooseEngine]: { reason: APP },
  [invokeChannels.appRelaunch]: { reason: APP },
  [invokeChannels.projectInfo]: { reason: PROJECT },
  [invokeChannels.projectNew]: { reason: PROJECT },
  [invokeChannels.projectOpen]: { reason: PROJECT },
  [invokeChannels.projectRename]: { reason: PROJECT },
  [invokeChannels.projectDuplicate]: { reason: PROJECT },
  [invokeChannels.projectReveal]: { reason: PROJECT },
  [invokeChannels.projectTrash]: { reason: PROJECT },
  [invokeChannels.projectList]: { reason: PROJECT },
  [invokeChannels.projectOpenFolder]: { reason: PROJECT },
  [invokeChannels.projectImport]: { reason: PROJECT },
  [invokeChannels.projectFromTemplate]: { reason: PROJECT },
  [invokeChannels.projectSavePreview]: { reason: PROJECT },
  [invokeChannels.projectVersions]: { reason: PROJECT },
  [invokeChannels.projectSaveVersion]: { reason: PROJECT },
  [invokeChannels.projectRestoreVersion]: { reason: PROJECT },
  [invokeChannels.projectCompareVersion]: { reason: PROJECT },
  [invokeChannels.projectNameVersion]: { reason: PROJECT },
  [invokeChannels.projectVersionAsProject]: { reason: PROJECT },
  [invokeChannels.projectTrashList]: { reason: PROJECT },
  [invokeChannels.projectParts]: { reason: PROJECT },
  [invokeChannels.projectSetPart]: { reason: 'the parts list is the user’s own record of what was printed; the assistant designs, it does not print' },
  [invokeChannels.projectSetMeta]: { reason: PROJECT },
  [invokeChannels.projectExportPackage]: { reason: FILES },
  [invokeChannels.projectTrashRestore]: { reason: PROJECT },
  [invokeChannels.projectTrashEmpty]: { reason: PROJECT },
  [invokeChannels.mirrorCurrent]: { reason: READ },
  [invokeChannels.agentStatus]: { reason: ASSISTANT },
  [invokeChannels.agentRefresh]: { reason: ASSISTANT },
  [invokeChannels.agentSend]: { reason: ASSISTANT },
  [invokeChannels.agentStop]: { reason: ASSISTANT },
  [invokeChannels.agentSignIn]: { reason: ASSISTANT },
  [invokeChannels.agentSignOut]: { reason: ASSISTANT },
  [invokeChannels.agentSelect]: { reason: ASSISTANT },
  [invokeChannels.agentAllowApiBilling]: { reason: ASSISTANT },
  [invokeChannels.agentChooseModel]: { reason: ASSISTANT },
  [invokeChannels.agentResearch]: { reason: ASSISTANT },
  [invokeChannels.agentSetResearch]: { reason: ASSISTANT },
  [invokeChannels.agentOllamaContext]: { reason: ASSISTANT },
  [invokeChannels.agentSetOllamaContext]: { reason: ASSISTANT },
  // What the user looks at, reported for the assistant.
  [invokeChannels.viewerState]: { tool: 'partbuddy_view' },
  [invokeChannels.windowTitleBar]: { reason: APP },
  [invokeChannels.windowTheme]: { reason: APP },
  [invokeChannels.windowSetTheme]: { reason: APP },
  [invokeChannels.settingsGeneral]: { reason: APP },
  [invokeChannels.settingsRevealLog]: { reason: APP },
  [invokeChannels.settingsSetLanguage]: { reason: APP },
  [invokeChannels.settingsChooseProjectsFolder]: { reason: APP },
  [invokeChannels.settingsResetProjectsFolder]: { reason: APP },
  [invokeChannels.settingsFinishSetup]: { reason: APP },
  [invokeChannels.settingsReset]: { reason: APP },
  [invokeChannels.settingsApp]: { reason: APP },
  [invokeChannels.settingsSetApp]: { reason: APP },
  [invokeChannels.updatesState]: { reason: APP },
  [invokeChannels.updatesCheck]: { reason: APP },
  [invokeChannels.updatesDownload]: { reason: APP },
  [invokeChannels.updatesInstall]: { reason: APP },
  [invokeChannels.designUndo]: { tool: 'undo' },
  [invokeChannels.designRedo]: { tool: 'redo' },
  [invokeChannels.designExport]: { reason: FILES },
  [invokeChannels.designSaveVideo]: { reason: FILES },
  [invokeChannels.designShare]: { reason: FILES },
  [invokeChannels.designOpenInSolidCraft]: { reason: 'opens SolidCraft’s own window for the user' },
  [invokeChannels.designProbeDimension]: { reason: PREVIEW },
  [invokeChannels.designApplyDimension]: { tool: 'set_parameter' },
  [invokeChannels.designPreviewAction]: { reason: PREVIEW },
  [invokeChannels.designApplyAction]: { command: 'solid.fillet' },
  [invokeChannels.designMeasure]: { tool: 'measure' },
  [invokeChannels.designClearance]: { command: 'inspect.clearance' },
  [invokeChannels.designDriveJoint]: { command: 'joint.drive' },
  [invokeChannels.designSweepJoints]: { command: 'joint.sweep' },
  [invokeChannels.designPartsLibrary]: { command: 'parts.library' },
  [invokeChannels.designPreviewBlock]: { reason: PREVIEW },
  [invokeChannels.designApplyBlock]: { command: 'plastic.snap_fit' },
  [invokeChannels.designLogoAt]: { reason: READ },
  [invokeChannels.designPreviewLogoMove]: { reason: PREVIEW },
  [invokeChannels.designMoveLogo]: { tool: 'partbuddy_move_drawing' },
  [invokeChannels.designSlicers]: { reason: FILES },
  [invokeChannels.designSendToSlicer]: { reason: FILES },
  [invokeChannels.designPrintFace]: { command: 'body.print_face' },
  [invokeChannels.designInsertPart]: { command: 'parts.insert' },
  [invokeChannels.designTimeline]: { command: 'timeline.roll_to' },
  [invokeChannels.designVisibility]: { command: 'browser.visibility' },
  [invokeChannels.designRenameBody]: { command: 'body.rename' },
  [invokeChannels.designInsert]: { reason: FILES },
  [invokeChannels.designRepair]: { command: 'mesh.convert' },
  [invokeChannels.designGoToStep]: { reason: 'the work log is PartBuddy’s own history; the assistant steps back with undo' },
  [invokeChannels.designDimensions]: { reason: READ },
  [invokeChannels.designProbeParameter]: { reason: PREVIEW },
  [invokeChannels.designParameters]: { tool: 'check_parameters' },
  [invokeChannels.chatLoad]: { reason: ASSISTANT },
  [invokeChannels.chatSave]: { reason: ASSISTANT },
  [invokeChannels.assemblyGet]: { tool: 'partbuddy_assembly' },
  [invokeChannels.designPrintFaces]: { reason: READ },
  [invokeChannels.sketchList]: { reason: ASSISTANT },
  [invokeChannels.sketchLoad]: { reason: ASSISTANT },
  [invokeChannels.notesCurrent]: { tool: 'partbuddy_view' },
  [invokeChannels.notesAdd]: { reason: NOTES },
  [invokeChannels.notesEdit]: { reason: NOTES },
  [invokeChannels.notesDelete]: { reason: NOTES },
  [invokeChannels.notesAccept]: { reason: NOTES },
  [invokeChannels.notesReattach]: { reason: NOTES },
  [invokeChannels.notesRestore]: { reason: NOTES },
  [invokeChannels.notesDismiss]: { reason: NOTES },
  [invokeChannels.printSettings]: { reason: PRINT },
  [invokeChannels.printSaveSettings]: { reason: PRINT },
  [invokeChannels.printPart]: { reason: PRINT },
  [invokeChannels.printSetMaterial]: { reason: PRINT },
  [invokeChannels.printReportCheck]: { reason: PRINT },
  [invokeChannels.printTestPiecesPicture]: { reason: PRINT },
  [invokeChannels.printTestPiecesExport]: { reason: FILES },
};

describe('parity between the interface and the assistant', () => {
  it.each(Object.entries(PARITY))('%s is the assistant’s too, or says why not', (_channel, parity) => {
    if ('reason' in parity) expect(parity.reason.length).toBeGreaterThan(20);
    else if ('tool' in parity) expect(decide(parity.tool, {})).toEqual({ allow: true });
    else expect(decide('execute', { command: parity.command, params: {} })).toEqual({ allow: true });
  });

  it('covers every channel', () => {
    expect(Object.keys(PARITY).sort()).toEqual(Object.values(invokeChannels).sort());
  });
});
