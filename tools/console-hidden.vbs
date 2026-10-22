' console-hidden.vbs -- run Molly console server (127.0.0.1:19392) with ZERO visible window
'
' Same mechanism as heartbeat-hidden.vbs / watchdog-hidden.vbs:
'   node.exe is a CONSOLE-subsystem program. Started directly by the Task
'   Scheduler (LogonType=InteractiveToken) it always gets a real console window,
'   which flashes on screen and steals focus. wscript.exe is GUI-subsystem and
'   never allocates a console, and WScript.Shell.Run(cmd, 0, True) starts node
'   with SW_HIDE -- so the console exists but is never shown.
'
' Unlike the heartbeat launcher this one WAITS (arg 3 = True) because
' console-server.mjs is a long-lived server: the scheduled task should stay in
' "Running" state and the RestartOnFailure policy can bring it back if node
' exits abnormally. console-server.mjs already guards against double starts
' (port probe -> "already running" -> exit 0), and MultipleInstancesPolicy
' IgnoreNew prevents a second instance from the scheduler side too.
'
' NOTE: this file is a THIN SHELL and should be treated as frozen. Change
' behaviour in console-server.mjs, not here. ASCII only, no BOM (wscript reads
' it with the system ANSI code page; a UTF-8 BOM would break the first line).
'
' 2026-10-22: set MOLLY_CONSOLE_LIVE=1 so the console's dangerous actions
' (restart / relogin / stop) actually run instead of dry-run. The console is
' bound to 127.0.0.1 and the buttons still ask for confirm in the UI, so this
' is the intended operator surface for the SnowLuma backend.

Option Explicit

Dim sh, nodeExe, scriptDir, scriptPath, cmd, rc

nodeExe    = "${HOME}\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
scriptDir  = "${MOLLY_ROOT}\qq-whale\tools"
scriptPath = scriptDir & "\console-server.mjs"

On Error Resume Next

Set sh = CreateObject("WScript.Shell")
If Err.Number = 0 Then sh.CurrentDirectory = scriptDir

cmd = "cmd.exe /c set MOLLY_CONSOLE_LIVE=1&& """ & nodeExe & """ """ & scriptPath & """"

rc = sh.Run(cmd, 0, True)

WScript.Quit rc
