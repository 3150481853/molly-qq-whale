' heartbeat-hidden.vbs -- push Molly heartbeat to the relay server with ZERO visible window
'
' Same mechanism as watchdog-hidden.vbs; read that file's header for the full
' reasoning. The short version:
'   node.exe is a CONSOLE-subsystem program. Started directly by the Task
'   Scheduler (LogonType=InteractiveToken) it always gets a real console window,
'   which flashes on screen and steals focus. wscript.exe is GUI-subsystem and
'   never allocates a console, and WScript.Shell.Run(cmd, 0, True) starts node
'   with SW_HIDE -- so the console exists but is never shown.
'
' Argument 3 = True (wait): heartbeat-push.mjs reports through its exit code
'     0 = pushed ok   3 = relay unreachable   1 = internal error
'   Without waiting, the Task Scheduler's "Last Run Result" would always be 0
'   and we could not tell a real success from a silent failure.
'
' On Error Resume Next: an unhandled VBScript error makes wscript pop a MODAL
' DIALOG, which is far worse than a black box. Swallow everything, log, quit.
'
' Encoding: ASCII, no BOM. wscript reads this file using the system ANSI code
' page; a UTF-8 BOM would make the first line unparsable. Keep bytes < 128.
'
' NOTE: like the watchdog launcher, this file is a THIN SHELL and should be
' treated as frozen. Change behaviour in heartbeat-push.mjs, not here. If it
' must be replaced, write a .new.vbs next to it, run it once by hand to confirm
' exit 0, then swap -- a momentarily missing script makes wscript show a
' system-level "cannot find script file" dialog.

Option Explicit

Dim sh, nodeExe, scriptDir, scriptPath, logFile, cmd, rc, fso, ts

nodeExe    = "${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
scriptDir  = "${MOLLY_ROOT}\qq-whale\tools"
scriptPath = scriptDir & "\heartbeat-push.mjs"
logFile    = "${MOLLY_ROOT}\qq-whale\out\heartbeat-launcher.log"

On Error Resume Next

Set sh = CreateObject("WScript.Shell")
If Err.Number = 0 Then sh.CurrentDirectory = scriptDir

cmd = """" & nodeExe & """ """ & scriptPath & """"

rc = sh.Run(cmd, 0, True)

If Err.Number <> 0 Then
  Set fso = CreateObject("Scripting.FileSystemObject")
  Set ts = fso.OpenTextFile(logFile, 8, True)
  ts.WriteLine Now & " [LAUNCH_FAIL] " & Err.Number & " " & Err.Description
  ts.WriteLine "  cmd = " & cmd
  ts.Close
  WScript.Quit 4
End If

WScript.Quit rc
