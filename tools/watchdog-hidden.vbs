' watchdog-hidden.vbs -- launch Molly watchdog with ZERO visible window
'
' ============================ WHY THIS FILE EXISTS ============================
' Root cause (measured, not guessed):
'   Scheduled task Molly-Watchdog used to run node.exe directly. Its LogonType is
'   InteractiveToken, so it runs inside the user's own desktop session. node.exe is
'   a CONSOLE-subsystem program, so Windows always gives it a real console window.
'   Result: a black cmd-like box flashes every 10 minutes and steals focus,
'   interrupting fullscreen games.
'   Measured: 0.04s after Start-ScheduledTask a ConsoleWindowClass window appeared
'   whose title was the full path of node.exe.
'
' Why node's windowsHide option is not enough:
'   windowsHide:true only suppresses the flash when a parent process that ALREADY
'   has no window spawns a child. Here node.exe IS the top-level process started by
'   the Task Scheduler; no parent exists that could hide its console. We must change
'   the host process to one that does not own a console at all.
'
' Why wscript.exe:
'   wscript.exe is a GUI-subsystem program and never allocates a console.
'   It then calls WScript.Shell.Run(cmd, 0, ...) which uses SW_HIDE to start node,
'   so node's console window is created but never shown. This is the most reliable
'   approach on Windows -- far more deterministic than conhost --headless tricks or
'   -WindowStyle Hidden on a console-subsystem child.
'
' Why bWaitOnReturn must be True (the third argument):
'   watchdog.mjs communicates its verdict through the exit code:
'     0 = logged in, all good        1 = offline (notified)
'     2 = offline but quiet hours    3 = WebUI unreachable (NapCat down)
'     4 = config error
'   The task's "Last Run Result" comes from that exit code. If we do not wait,
'   the exit code is lost and Task Scheduler always reports 0.
'
' Why everything is wrapped in On Error Resume Next:
'   An unhandled VBScript runtime error makes wscript.exe pop a MODAL ERROR DIALOG.
'   That is worse than the black box. So swallow every error, log it, and quit.
'
' Encoding: this file must stay ANSI / ASCII with NO BOM. wscript reads it using the
'   system ANSI code page. A UTF-8 BOM would make the first line unparsable.
'   Keep every byte below 128 to be safe under any code page.
' ============================================================================

Option Explicit

Dim sh, nodeExe, scriptDir, scriptPath, logFile, cmd, rc, fso, ts

nodeExe    = "${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
scriptDir  = "${MOLLY_ROOT}\qq-whale\tools"
scriptPath = scriptDir & "\watchdog.mjs"
logFile    = "${MOLLY_ROOT}\qq-whale\out\watchdog-launcher.log"

On Error Resume Next

' Working directory: the task used to leave "Start in" empty. Pin it explicitly so
' watchdog.mjs resolves its relative paths the same way no matter who starts it.
Set sh = CreateObject("WScript.Shell")
If Err.Number = 0 Then sh.CurrentDirectory = scriptDir

' Quote every path so a future relocation with spaces in it cannot break us.
cmd = """" & nodeExe & """ """ & scriptPath & """ --once"

' Argument 2 = 0        -> SW_HIDE: this single number is what removes the black box.
' Argument 3 = True     -> wait for completion and capture the exit code.
rc = sh.Run(cmd, 0, True)

If Err.Number <> 0 Then
  ' Could not launch (node missing / path changed / permissions). Log and quit.
  ' Never let wscript raise a modal dialog.
  Set fso = CreateObject("Scripting.FileSystemObject")
  Set ts = fso.OpenTextFile(logFile, 8, True)
  ts.WriteLine Now & " [LAUNCH_FAIL] " & Err.Number & " " & Err.Description
  ts.WriteLine "  cmd = " & cmd
  ts.Close
  WScript.Quit 4
End If

WScript.Quit rc
