import { describe, expect, it } from 'vitest';
import {
  actionSummary,
  appKey,
  coordinateOf,
  HIGH_RISK_PROGRAMS,
  isBlockedKeyCombo,
  isComputerAction,
  isHighRiskApp,
  isHighRiskProgram,
  isReadAction,
  programName,
  READ_ACTIONS,
} from '../src/domain/computer-apps.js';

describe('computer apps', () => {
  it('keys an app by its full path, lower-cased, with one kind of separator', () => {
    expect(appKey('C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE')).toBe('c:\\program files\\microsoft office\\root\\office16\\excel.exe');
    expect(appKey('C:/Tools//Thing/App.exe')).toBe('c:\\tools\\thing\\app.exe');
    expect(appKey('  D:\\x.exe ')).toBe('d:\\x.exe');
    expect(appKey('\\\\server\\share\\App.exe')).toBe('\\\\server\\share\\app.exe');
    expect(programName('C:\\Windows\\System32\\cmd.exe')).toBe('cmd.exe');
  });

  it('treats a downloaded excel.exe as a different app from the installed one', () => {
    expect(appKey('C:\\Users\\Adam\\Downloads\\excel.exe')).not.toBe(appKey('C:\\Program Files\\Microsoft Office\\root\\Office16\\EXCEL.EXE'));
  });

  it('lists shells, Explorer, Settings and the admin tools as high-risk, by program name in any case', () => {
    const names = [
      'cmd.exe', 'powershell.exe', 'pwsh.exe', 'windowsterminal.exe', 'wt.exe', 'conhost.exe', 'openconsole.exe', 'wsl.exe', 'wslhost.exe',
      'bash.exe', 'mintty.exe', 'explorer.exe', 'systemsettings.exe', 'regedit.exe', 'mmc.exe', 'taskmgr.exe', 'control.exe', 'rundll32.exe',
    ];
    for (const name of names) expect(HIGH_RISK_PROGRAMS.has(name)).toBe(true);
    expect(HIGH_RISK_PROGRAMS.size).toBe(names.length);
    expect(isHighRiskProgram('C:\\WINDOWS\\Explorer.EXE')).toBe(true);
    expect(isHighRiskProgram('C:\\Program Files\\PowerShell\\7\\PWSH.exe')).toBe(true);
    expect(isHighRiskProgram('C:\\Windows\\System32\\notepad.exe')).toBe(false);
  });

  it('counts an app as high-risk from its program name or from the risk the tool worked out', () => {
    expect(isHighRiskApp({ app: 'c:\\windows\\system32\\cmd.exe' })).toBe(true);
    expect(isHighRiskApp({ app: 'c:\\tools\\x.exe', appRisk: 'high' })).toBe(true);
    expect(isHighRiskApp({ app: 'c:\\tools\\x.exe', appRisk: 'normal' })).toBe(false);
    expect(isHighRiskApp({})).toBe(false);
    expect(isHighRiskApp(null)).toBe(false);
  });

  it('blocks every key combination that uses the Windows key', () => {
    for (const keys of ['super+r', 'win+r', 'ctrl+super+d', 'Super_L', 'WIN+E', 'ctrl+c super', 'meta+x']) expect(isBlockedKeyCombo(keys)).toBe(true);
    for (const keys of ['ctrl+s', 'alt+Tab', 'Return', 'ctrl+shift+Escape', 'F5', 'ctrl+a ctrl+c']) expect(isBlockedKeyCombo(keys)).toBe(false);
  });

  it('knows the phase-1 actions, and which of them only look', () => {
    expect(READ_ACTIONS).toEqual(['screenshot', 'cursor_position', 'wait']);
    expect(isReadAction('screenshot')).toBe(true);
    expect(isReadAction('left_click')).toBe(false);
    expect(isComputerAction('triple_click')).toBe(true);
    for (const later of ['left_click_drag', 'zoom', 'middle_click', 'hold_key', 'left_mouse_down', 'left_mouse_up', 7, null]) {
      expect(isComputerAction(later)).toBe(false);
    }
  });

  it('reads a coordinate only as two finite, non-negative numbers, rounded to whole pixels', () => {
    expect(coordinateOf({ coordinate: [512, 300] })).toEqual([512, 300]);
    expect(coordinateOf({ coordinate: [512.6, 299.5] })).toEqual([513, 300]);
    for (const bad of [undefined, null, [1], [1, 2, 3], ['1', 2], [-1, 5], [Number.NaN, 1], [1, Number.POSITIVE_INFINITY], '512,300']) {
      expect(coordinateOf({ coordinate: bad })).toBeNull();
    }
    expect(coordinateOf(null)).toBeNull();
  });

  it('summarises an action for a card in one short line', () => {
    expect(actionSummary({ action: 'left_click', coordinate: [512, 300] })).toBe('click at 512, 300');
    expect(actionSummary({ action: 'double_click', coordinate: [1, 2] })).toBe('double-click at 1, 2');
    expect(actionSummary({ action: 'mouse_move', coordinate: [1, 2] })).toBe('move the mouse to 1, 2');
    expect(actionSummary({ action: 'key', text: 'ctrl+s' })).toBe('press ctrl+s');
    expect(actionSummary({ action: 'scroll', coordinate: [10, 20], scroll_direction: 'down', scroll_amount: 3 })).toBe('scroll down 3 at 10, 20');
    expect(actionSummary({ action: 'type', text: 'x'.repeat(50) })).toBe(`type "${'x'.repeat(40)}…"`);
    expect(actionSummary({ action: 'type', text: 'line one\nline two' })).toBe('type "line one line two"');
    expect(actionSummary({ action: 'screenshot' })).toBe('take a screenshot');
    expect(actionSummary({ action: 'wait', duration: 2 })).toBe('wait 2 s');
  });
});
